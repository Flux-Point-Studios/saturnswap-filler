// Non-auth taker-fill builder (FULL FILLS). Produces an UNSIGNED Conway tx that an
// aggregator signs + submits. The 1%/4% fee is paid in the SELL asset to fee_address
// (the fees_paid branch — no authorize co-sign). Tx assembly + ex-unit evaluation use
// @lucid-evolution/lucid (CML); the load-bearing CBOR (datum/redeemer/script_data_hash)
// comes from this lib's own primitives so it is independently reproducible.
//
// Recipe: SPEC §7 (swap) + §8 (swap_split relist) — the saturn_swap validator's on-chain behavior.
// Handles FULL and PARTIAL fills (partial emits one §8 relist continuation).
// DEFERRED (not built here): cancel (§9), multi-order single-tx fills. See README.

import type { LucidEvolution, UTxO, Assets } from "@lucid-evolution/lucid";
import { credentialToAddress, getAddressDetails } from "@lucid-evolution/lucid";
import type { Order } from "./discovery.js";
import { unit } from "./discovery.js";
import { fillSellAndFee, swapSplitAmounts } from "./ratio.js";
import { paymentDatum, swapActionRedeemer, swapDatumToPlutusData } from "./datum.js";
import { plutusToHex } from "./plutus.js";
import { FEE_ADDRESS } from "./contract.js";
import { assertCollateralDisjoint, inputIndexOf, sortInputs } from "./sort.js";
import { computeScriptDataHashFromParts, bytesToHex } from "./scriptDataHash.js";
import { CborReader, hexToBytes, type CborValue } from "./cbor.js";
import { minUtxoLovelace, type SizingAssets } from "./minUtxo.js";

const ADA = "" as const;
export const MAINNET_COINS_PER_UTXO_BYTE = 4310n; // live utxoCostPerByte; overridable per build
const MINUTXO_SIZING_LOVELACE = 2_000_000n; // 4-byte-width placeholder coin for sizing token outputs

/** Relist continuation (one per spent order, partial fill only — SPEC §8 / swap_split). */
export interface RelistPlan {
  /** continuation goes back to the SAME order script address */
  scriptAddress: string;
  /** inline SwapDatum: prev owner/policies/names/valid_before, corrected amounts,
   *  output_reference = the SPENT ORDER's own input ref (the relist-chain link) */
  datumHex: string;
  /** continuation value (ADA-only for ADA-sell; sell-token + min-utxo ADA otherwise) */
  assets: Assets;
  newAmountSell: bigint;
  sellBuffer: bigint;
  correctedNewAmountSell: bigint;
  correctedNewAmountBuy: bigint;
}

export interface FillPlan {
  isFullFill: boolean;
  userSellAmount: bigint;
  /** proportional sell released this fill (full fill => amount_sell); the fee basis */
  newSwapAmountSell: bigint;
  /** fee in the SELL asset (1%) */
  totalFee: bigint;
  /** value the owner-payment output must carry (the buy asset + any required ADA) */
  ownerOutputAssets: Assets;
  /** value the fee output must carry (sell asset + min-utxo ADA) */
  feeOutputAssets: Assets;
  paymentDatumHex: string;
  ownerAddressBech32: string;
  /** present iff this is a partial fill */
  relist?: RelistPlan;
}

export interface BuildTakerFillOptions {
  lucid: LucidEvolution;
  order: Order;
  /** base-unit amount of the order's BUY asset the taker delivers (full fill => order.buy.amount) */
  userSellAmount: bigint;
  /** taker funding inputs (must cover the owner output + fee min-utxo + tx fee) */
  fundingUtxos: UTxO[];
  /** a pure-ADA collateral UTxO (>= ~5 ADA), excluded from the spend-input set */
  collateralUtxo: UTxO;
  /** change address (the taker / aggregator); defaults to the collateral's address */
  changeAddress?: string;
  /** override the PlutusV2 cost model used for the self-computed SDH cross-check */
  costModelV2?: bigint[];
  /** override coinsPerUtxoByte (else read from the provider's protocol params) */
  coinsPerUtxoByte?: bigint;
}

export interface TakerFillResult {
  /** unsigned Conway tx, hex CBOR — aggregator signs + submits */
  unsignedCbor: string;
  txHash: string;
  inputIndex: number;
  outputIndex: number;
  exUnits: { mem: bigint; steps: bigint };
  /** self-computed Conway script_data_hash (this lib's primitive) */
  selfScriptDataHash: string;
  /** script_data_hash CML embedded in the built tx body (key 11) */
  txScriptDataHash: string;
  /** true if the self-computed SDH equals the builder's SDH */
  scriptDataHashMatches: boolean;
  plan: FillPlan;
}

function isAda(policyId: string, assetName: string): boolean {
  return policyId === ADA && assetName === ADA;
}

/** Pure fill plan (full OR partial). On a partial fill it also computes the §8 relist
 *  continuation. Min-UTxO on token-bearing outputs is computed from `coinsPerUtxoByte`
 *  (the live `utxoCostPerByte`); token-bearing outputs are floored to the ledger min-UTxO. */
export function computeFillPlan(
  order: Order,
  userSellAmount: bigint,
  coinsPerUtxoByte: bigint = MAINNET_COINS_PER_UTXO_BYTE,
): FillPlan {
  if (userSellAmount <= 0n) throw new Error("userSellAmount must be positive");
  if (userSellAmount > order.buy.amount)
    throw new Error(`userSellAmount ${userSellAmount} exceeds order amount_buy ${order.buy.amount}`);
  const isFullFill = userSellAmount === order.buy.amount;
  const sellIsAda = isAda(order.sell.policyId, order.sell.assetName);
  const buyIsAda = isAda(order.buy.policyId, order.buy.assetName);

  // owner_value_has_correct_amount (SPEC §7.5, case c): a full fill of a non-ADA-sell order
  // demands lovelace(owner) >= amount_buy + lovelace(script_utxo), with amount_buy added as RAW
  // lovelace regardless of the buy asset's identity. For a token→token full fill that means
  // amount_buy-as-lovelace of ADA on the owner output — generally infeasible — so the validator
  // would DENY (cases (a)/(b) don't apply). Refuse to build the doomed tx; route via a partial.
  if (isFullFill && !buyIsAda && !sellIsAda)
    throw new Error(
      "token→token orders must be filled as a PARTIAL fill — a full fill requires " +
        "amount_buy-as-lovelace per validator case (c), which is infeasible; " +
        "use a partial fill (satisfies case (a)).",
    );

  const { newSwapAmountSell, totalFee } = fillSellAndFee(
    order.sell.amount,
    order.buy.amount,
    userSellAmount,
    order.feePercentX100,
  );

  const ownerAddressBech32 = ownerBech32(order);
  const paymentDatumHex = plutusToHex(paymentDatum(order.utxo));

  const split = isFullFill
    ? null
    : swapSplitAmounts(order.sell.amount, order.buy.amount, userSellAmount, sellIsAda);

  // ---- Owner-payment output (SPEC §7.5 / owner_value_has_correct_amount + §8 buffer) ----
  const ownerOutputAssets: Assets = {};
  if (buyIsAda) {
    // owner receives ADA. Full fill of a non-ADA-sell order needs lovelace >= amount_buy +
    // script lovelace; partial fill needs lovelace >= user_sell_amount (+ buffer, which is 0
    // when sell is a token). is_token_amount_correct: owner lovelace >= user_sell_amount.
    const required = isFullFill ? order.buy.amount + order.scriptValue.lovelace : userSellAmount + (split?.sellBuffer ?? 0n);
    const min = minUtxoLovelace(
      { addressBech32: ownerAddressBech32, assets: { lovelace: required }, inlineDatumHex: paymentDatumHex },
      coinsPerUtxoByte,
    );
    ownerOutputAssets["lovelace"] = required > min ? required : min;
  } else {
    // owner receives the buy TOKEN (amount_buy on full, user_sell_amount on partial). The §8
    // ADA-sell buffer (2 ADA) must land on the owner; otherwise just the output's min-utxo.
    const u = unit(order.buy.policyId, order.buy.assetName);
    const tokenAmt = isFullFill ? order.buy.amount : userSellAmount;
    ownerOutputAssets[u] = tokenAmt;
    const min = minUtxoLovelace(
      { addressBech32: ownerAddressBech32, assets: { lovelace: MINUTXO_SIZING_LOVELACE, [u]: tokenAmt }, inlineDatumHex: paymentDatumHex },
      coinsPerUtxoByte,
    );
    const buffer = split?.sellBuffer ?? 0n;
    ownerOutputAssets["lovelace"] = buffer > min ? buffer : min;
  }

  // ---- Fee output (SPEC §7.6): >= total_fee of the SELL asset, to fee_address, same datum ----
  const feeOutputAssets: Assets = {};
  if (sellIsAda) {
    const min = minUtxoLovelace(
      { addressBech32: FEE_ADDRESS, assets: { lovelace: MINUTXO_SIZING_LOVELACE }, inlineDatumHex: paymentDatumHex },
      coinsPerUtxoByte,
    );
    feeOutputAssets["lovelace"] = totalFee > min ? totalFee : min;
  } else {
    const u = unit(order.sell.policyId, order.sell.assetName);
    feeOutputAssets[u] = totalFee;
    feeOutputAssets["lovelace"] = minUtxoLovelace(
      { addressBech32: FEE_ADDRESS, assets: { lovelace: MINUTXO_SIZING_LOVELACE, [u]: totalFee }, inlineDatumHex: paymentDatumHex },
      coinsPerUtxoByte,
    );
  }

  const plan: FillPlan = {
    isFullFill,
    userSellAmount,
    newSwapAmountSell,
    totalFee,
    ownerOutputAssets,
    feeOutputAssets,
    paymentDatumHex,
    ownerAddressBech32,
  };

  if (split) plan.relist = buildRelist(order, split, sellIsAda, coinsPerUtxoByte);
  return plan;
}

/** §8 continuation: same script address, corrected amounts, output_reference = spent order ref. */
function buildRelist(
  order: Order,
  split: ReturnType<typeof swapSplitAmounts>,
  sellIsAda: boolean,
  coinsPerUtxoByte: bigint,
): RelistPlan {
  const datumHex = plutusToHex(
    swapDatumToPlutusData({
      owner: order.datum.owner,
      policyIdSell: order.sell.policyId,
      assetNameSell: order.sell.assetName,
      amountSell: split.correctedNewAmountSell,
      policyIdBuy: order.buy.policyId,
      assetNameBuy: order.buy.assetName,
      amountBuy: split.correctedNewAmountBuy,
      validBeforeTime: order.validBeforeTime,
      outputReference: order.utxo, // the SPENT order's own ref — the relist-chain link
    }),
  );

  const assets: Assets = {};
  if (sellIsAda) {
    // value_has_only_lovelace: ADA only. new_value_amount_sell(lovelace) >= corrected_new_amount_sell,
    // and the output must also clear the ledger min-utxo (a near-fully-filled order can leave a
    // remainder below ~1 ADA after the 2-ADA buffer).
    const min = minUtxoLovelace(
      { addressBech32: order.orderAddress, assets: { lovelace: split.correctedNewAmountSell || MINUTXO_SIZING_LOVELACE }, inlineDatumHex: datumHex },
      coinsPerUtxoByte,
    );
    assets["lovelace"] = split.correctedNewAmountSell > min ? split.correctedNewAmountSell : min;
  } else {
    // value_has_asset_and_lovelace: [ada, sellToken]. min_utxo_goes_back_to_script:
    // continuation lovelace >= the spent script UTxO's lovelace.
    const u = unit(order.sell.policyId, order.sell.assetName);
    assets[u] = split.correctedNewAmountSell;
    const min = minUtxoLovelace(
      { addressBech32: order.orderAddress, assets: { lovelace: MINUTXO_SIZING_LOVELACE, [u]: split.correctedNewAmountSell }, inlineDatumHex: datumHex },
      coinsPerUtxoByte,
    );
    assets["lovelace"] = order.scriptValue.lovelace > min ? order.scriptValue.lovelace : min;
  }

  return {
    scriptAddress: order.orderAddress,
    datumHex,
    assets,
    newAmountSell: split.newAmountSell,
    sellBuffer: split.sellBuffer,
    correctedNewAmountSell: split.correctedNewAmountSell,
    correctedNewAmountBuy: split.correctedNewAmountBuy,
  };
}

function ownerBech32(order: Order): string {
  const o = order.datum.owner;
  const payment = { type: o.payment.type === "key" ? ("Key" as const) : ("Script" as const), hash: o.payment.hash };
  if (!o.stake) return credentialToAddress("Mainnet", payment);
  const stake = { type: o.stake.type === "key" ? ("Key" as const) : ("Script" as const), hash: o.stake.hash };
  return credentialToAddress("Mainnet", payment, stake);
}

/** Extract the sorted key-0 inputs from a Conway tx body CBOR. */
function txInputs(unsignedCbor: string): { txHash: string; outputIndex: number }[] {
  const top = new CborReader(hexToBytes(unsignedCbor)).decode();
  if (top.t !== "array") throw new Error("tx is not a CBOR array");
  let body = top.v[0]!;
  // body may be a tagged set wrapper in some encodings — unwrap to map
  if (body.t === "tag") body = body.v;
  if (body.t !== "map") throw new Error("tx body is not a map");
  const inputsEntry = body.v.find(([k]) => k.t === "uint" && k.v === 0n);
  if (!inputsEntry) throw new Error("tx body has no inputs (key 0)");
  let inputs = inputsEntry[1];
  if (inputs.t === "tag") inputs = inputs.v; // set(258) wrapper
  if (inputs.t !== "array") throw new Error("tx inputs not an array");
  return inputs.v.map((i) => {
    if (i.t !== "array" || i.v[0]!.t !== "bytes" || i.v[1]!.t !== "uint")
      throw new Error("malformed input");
    return { txHash: bytesToHex((i.v[0] as { v: Uint8Array }).v), outputIndex: Number((i.v[1] as { v: bigint }).v) };
  });
}

function txScriptDataHash(unsignedCbor: string): string | null {
  const top = new CborReader(hexToBytes(unsignedCbor)).decode();
  if (top.t !== "array") return null;
  let body = top.v[0]!;
  if (body.t === "tag") body = body.v;
  if (body.t !== "map") return null;
  const e = body.v.find(([k]) => k.t === "uint" && k.v === 11n);
  if (!e || e[1].t !== "bytes") return null;
  return bytesToHex(e[1].v);
}

export async function buildTakerFill(opts: BuildTakerFillOptions): Promise<TakerFillResult> {
  const { lucid, order, userSellAmount } = opts;

  // One protocol-params fetch feeds both min-UTxO (coinsPerUtxoByte) and the SDH cost model.
  const pp = await lucid.config().provider!.getProtocolParameters();
  const coinsPerUtxoByte = opts.coinsPerUtxoByte ?? BigInt((pp as { coinsPerUtxoByte: number | bigint }).coinsPerUtxoByte);
  const costModelV2 = opts.costModelV2 ?? cmFromPp(pp);

  const plan = computeFillPlan(order, userSellAmount, coinsPerUtxoByte);

  // Resolve the order UTxO (inline datum) + the per-version reference-script UTxO from chain.
  const [orderUtxo] = await lucid.utxosByOutRef([
    { txHash: order.utxo.txHash, outputIndex: order.utxo.outputIndex },
  ]);
  if (!orderUtxo) throw new Error(`order UTxO ${order.utxo.txHash}#${order.utxo.outputIndex} not found on-chain`);
  const [refUtxo] = await lucid.utxosByOutRef([
    { txHash: order.refScript.txHash, outputIndex: order.refScript.outputIndex },
  ]);
  if (!refUtxo?.scriptRef)
    throw new Error(`reference-script UTxO ${order.refScript.txHash}#${order.refScript.outputIndex} missing scriptRef`);

  // input_index = order's position in the canonically-sorted spend inputs (order + funding).
  // Collateral is a separate body field and is excluded.
  const spendInputs = [
    order.utxo,
    ...opts.fundingUtxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
  ];
  const inputIndex = inputIndexOf(spendInputs, order.utxo);
  if (inputIndex < 0) throw new Error("order input not found in spend-input set");
  const outputIndex = 0; // owner-payment output is added first

  const redeemerHex = plutusToHex(swapActionRedeemer(userSellAmount, inputIndex, outputIndex));

  const changeAddress = opts.changeAddress ?? opts.collateralUtxo.address;
  assertCollateralDisjoint(opts.collateralUtxo, opts.fundingUtxos);
  // Only the dedicated collateral goes in the wallet pool; funding is supplied explicitly via
  // collectFrom below. Lucid's collateral selection picks the LARGEST wallet UTxO and does NOT
  // exclude already-collected inputs, so leaving the funding UTxOs in the pool lets a funding
  // UTxO with more ADA than the collateral get pledged as collateral AND spent as an input
  // (input/collateral overlap -> invalid tx). Callers must size fundingUtxos to cover the outputs.
  lucid.selectWallet.fromAddress(changeAddress, [opts.collateralUtxo]);

  let tx = lucid
    .newTx()
    .collectFrom([orderUtxo], redeemerHex)
    .collectFrom(opts.fundingUtxos)
    .readFrom([refUtxo])
    .pay.ToAddressWithData(plan.ownerAddressBech32, { kind: "inline", value: plan.paymentDatumHex }, plan.ownerOutputAssets)
    .pay.ToAddressWithData(FEE_ADDRESS, { kind: "inline", value: plan.paymentDatumHex }, plan.feeOutputAssets);

  if (plan.relist) {
    // exactly ONE continuation back to the order script (SPEC §8 — one split per tx)
    tx = tx.pay.ToAddressWithData(
      plan.relist.scriptAddress,
      { kind: "inline", value: plan.relist.datumHex },
      plan.relist.assets,
    );
  }

  if (order.validBeforeTime !== null) {
    // honour expiry: validity must be entirely before t (POSIX ms). Stay 1 ms under.
    tx = tx.validTo(Number(order.validBeforeTime) - 1);
  }

  const signBuilder = await tx.complete({ changeAddress, setCollateral: 5_000_000n });
  const unsignedCbor = signBuilder.toCBOR();
  const txHash = signBuilder.toHash();

  // NOTES (latent, not asserted — left as-is by design):
  //  - output_index: outputs stay in author order (the ledger never sorts them), so the owner
  //    output is always at index 0 here; no drift check is needed (unlike input_index).
  //  - buildRelist re-encodes the continuation owner from the parsed credentials via
  //    swapDatumToPlutusData, not from the verbatim on-chain bytes (datum.ownerRaw); this is
  //    inert because the encoding is canonical for any real Address.
  // Safety net: the build must not have re-shuffled the spend-input set out from under
  // our redeemer index (local UPLC eval would already have failed, but assert anyway).
  const finalSorted = sortInputs(txInputs(unsignedCbor));
  const finalIndex = finalSorted.findIndex(
    (i) => i.txHash === order.utxo.txHash && i.outputIndex === order.utxo.outputIndex,
  );
  if (finalIndex !== inputIndex)
    throw new Error(`input_index drift: redeemer says ${inputIndex}, final tx sorts order at ${finalIndex}`);

  // Self-compute the Conway script_data_hash exactly as the live recipe the ledger accepts:
  // blake2b256( cbor(redeemers, key 5) || cbor(datums, key 4 — omitted for inline) ||
  // cbor({1: bare PlutusV2 cost model}) ), hashing the tx's ACTUAL witness bytes (the
  // builder's redeemer encoding, whatever form). Cross-checked against CML's own SDH.
  const { redeemersRaw, datumsRaw, exUnitsList } = extractWitness(unsignedCbor);
  const selfSdh = bytesToHex(computeScriptDataHashFromParts(redeemersRaw, datumsRaw, costModelV2));
  const txSdh = txScriptDataHash(unsignedCbor) ?? "";

  return {
    unsignedCbor,
    txHash,
    inputIndex,
    outputIndex,
    exUnits: exUnitsList[0] ?? { mem: 0n, steps: 0n },
    selfScriptDataHash: selfSdh,
    txScriptDataHash: txSdh,
    scriptDataHashMatches: selfSdh === txSdh,
    plan,
  };
}

// ------------------------------------------------------------------
// Multi-order single-tx fills (batching — DexHunter's primary path).
// Each filled order contributes its OWN owner output + its OWN fee output (fee outputs
// are NEVER coalesced — each carries that order's own PaymentDatum), and its own
// SwapAction redeemer with its own input_index (ledger-sorted SPEND inputs only) and
// output_index (the position of THAT order's owner output, in author order). Partial
// fills additionally emit one relist continuation each.
// ------------------------------------------------------------------

export interface MultiFillItem {
  order: Order;
  userSellAmount: bigint;
}

export interface BuildMultiTakerFillOptions {
  lucid: LucidEvolution;
  fills: MultiFillItem[];
  fundingUtxos: UTxO[];
  collateralUtxo: UTxO;
  changeAddress?: string;
  costModelV2?: bigint[];
  coinsPerUtxoByte?: bigint;
}

export interface MultiTakerFillResult {
  unsignedCbor: string;
  txHash: string;
  /** per-fill { inputIndex, outputIndex } in author order */
  indices: { inputIndex: number; outputIndex: number }[];
  exUnitsList: { mem: bigint; steps: bigint }[];
  selfScriptDataHash: string;
  txScriptDataHash: string;
  scriptDataHashMatches: boolean;
  plans: FillPlan[];
}

interface OutputSpec {
  address: string;
  datumHex?: string;
  assets: Assets;
}

/** [owner, fee, relist?] for one fill, in author order. */
function fillOutputSpecs(plan: FillPlan): OutputSpec[] {
  const specs: OutputSpec[] = [
    { address: plan.ownerAddressBech32, datumHex: plan.paymentDatumHex, assets: plan.ownerOutputAssets },
    { address: FEE_ADDRESS, datumHex: plan.paymentDatumHex, assets: plan.feeOutputAssets },
  ];
  if (plan.relist)
    specs.push({ address: plan.relist.scriptAddress, datumHex: plan.relist.datumHex, assets: plan.relist.assets });
  return specs;
}

export async function buildMultiTakerFill(opts: BuildMultiTakerFillOptions): Promise<MultiTakerFillResult> {
  const { lucid, fills } = opts;
  if (fills.length === 0) throw new Error("no fills provided");

  const pp = await lucid.config().provider!.getProtocolParameters();
  const coinsPerUtxoByte = opts.coinsPerUtxoByte ?? BigInt((pp as { coinsPerUtxoByte: number | bigint }).coinsPerUtxoByte);
  const costModelV2 = opts.costModelV2 ?? cmFromPp(pp);

  const plans = fills.map((f) => computeFillPlan(f.order, f.userSellAmount, coinsPerUtxoByte));

  // Resolve every order UTxO + the (deduped) reference scripts.
  const orderUtxos = await Promise.all(
    fills.map(async (f) => {
      const [u] = await lucid.utxosByOutRef([{ txHash: f.order.utxo.txHash, outputIndex: f.order.utxo.outputIndex }]);
      if (!u) throw new Error(`order UTxO ${f.order.utxo.txHash}#${f.order.utxo.outputIndex} not found on-chain`);
      return u;
    }),
  );
  const refRefs = dedupeRefs(fills.map((f) => f.order.refScript));
  const refUtxos = await lucid.utxosByOutRef(refRefs);
  for (const r of refUtxos) if (!r.scriptRef) throw new Error("a reference-script UTxO is missing its scriptRef");

  // Spend-input set = all order UTxOs + funding (collateral + reference inputs excluded).
  const spendInputs = [
    ...fills.map((f) => f.order.utxo),
    ...opts.fundingUtxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
  ];
  const sortedSpend = sortInputs(spendInputs);

  // Output layout (author order): concat each fill's [owner, fee, relist?]. Track owner index.
  const outputSpecs: OutputSpec[] = [];
  const indices: { inputIndex: number; outputIndex: number }[] = [];
  for (let i = 0; i < fills.length; i++) {
    const ownerOutputIndex = outputSpecs.length;
    const inputIndex = sortedSpend.findIndex(
      (x) => x.txHash === fills[i]!.order.utxo.txHash && x.outputIndex === fills[i]!.order.utxo.outputIndex,
    );
    if (inputIndex < 0) throw new Error("order input not found in spend-input set");
    indices.push({ inputIndex, outputIndex: ownerOutputIndex });
    outputSpecs.push(...fillOutputSpecs(plans[i]!));
  }

  const changeAddress = opts.changeAddress ?? opts.collateralUtxo.address;
  assertCollateralDisjoint(opts.collateralUtxo, opts.fundingUtxos);
  // Only the dedicated collateral in the wallet pool (see buildTakerFill): funding is supplied
  // via collectFrom, so a funding UTxO larger than the collateral can't be pledged as collateral
  // AND spent as an input.
  lucid.selectWallet.fromAddress(changeAddress, [opts.collateralUtxo]);

  let tx = lucid.newTx();
  for (let i = 0; i < fills.length; i++) {
    const redeemerHex = plutusToHex(
      swapActionRedeemer(fills[i]!.userSellAmount, indices[i]!.inputIndex, indices[i]!.outputIndex),
    );
    tx = tx.collectFrom([orderUtxos[i]!], redeemerHex);
  }
  tx = tx.collectFrom(opts.fundingUtxos).readFrom(refUtxos);
  for (const o of outputSpecs) {
    tx = o.datumHex
      ? tx.pay.ToAddressWithData(o.address, { kind: "inline", value: o.datumHex }, o.assets)
      : tx.pay.ToAddress(o.address, o.assets);
  }

  // honour the tightest expiry across the batch
  const expiries = fills.map((f) => f.order.validBeforeTime).filter((t): t is bigint => t !== null);
  if (expiries.length > 0) tx = tx.validTo(Number(expiries.reduce((a, b) => (a < b ? a : b))) - 1);

  const signBuilder = await tx.complete({ changeAddress, setCollateral: 5_000_000n });
  const unsignedCbor = signBuilder.toCBOR();

  // safety net: each order's input_index must match the final sorted spend inputs
  const finalInputs = sortInputs(txInputs(unsignedCbor));
  for (let i = 0; i < fills.length; i++) {
    const fi = finalInputs.findIndex(
      (x) => x.txHash === fills[i]!.order.utxo.txHash && x.outputIndex === fills[i]!.order.utxo.outputIndex,
    );
    if (fi !== indices[i]!.inputIndex)
      throw new Error(`input_index drift for fill ${i}: redeemer ${indices[i]!.inputIndex}, final ${fi}`);
  }

  const { redeemersRaw, datumsRaw, exUnitsList } = extractWitness(unsignedCbor);
  const selfSdh = bytesToHex(computeScriptDataHashFromParts(redeemersRaw, datumsRaw, costModelV2));
  const txSdh = txScriptDataHash(unsignedCbor) ?? "";

  return {
    unsignedCbor,
    txHash: signBuilder.toHash(),
    indices,
    exUnitsList,
    selfScriptDataHash: selfSdh,
    txScriptDataHash: txSdh,
    scriptDataHashMatches: selfSdh === txSdh,
    plans,
  };
}

function dedupeRefs(refs: { txHash: string; outputIndex: number }[]): { txHash: string; outputIndex: number }[] {
  const seen = new Set<string>();
  const out: { txHash: string; outputIndex: number }[] = [];
  for (const r of refs) {
    const k = `${r.txHash}#${r.outputIndex}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** Extract the witness redeemers (raw key-5 bytes), datums (raw key-4 bytes, if any), and
 *  every redeemer's ex-units from the built tx. Handles both the Conway redeemer MAP form
 *  { [tag,index] => [data,[mem,steps]] } and the legacy ARRAY form [[tag,index,data,[mem,steps]]]. */
function extractWitness(unsignedCbor: string): {
  redeemersRaw: Uint8Array;
  datumsRaw: Uint8Array | null;
  exUnitsList: { mem: bigint; steps: bigint }[];
} {
  const buf = hexToBytes(unsignedCbor);
  const r = new CborReader(buf);
  r.readArrayHeader(); // top tx array
  r.decode(); // body (skip; offsets advance)
  const witStart = r.offset;

  const r2 = new CborReader(buf.subarray(witStart));
  const n = r2.readMapHeader();
  let redeemersRaw: Uint8Array | null = null;
  let datumsRaw: Uint8Array | null = null;
  let redVal: CborValue | null = null;
  for (let i = 0; i < n; i++) {
    const key = r2.decode();
    const val = r2.decodeTracked();
    if (key.t === "uint" && key.v === 5n) {
      redeemersRaw = val.raw;
      redVal = val.value;
    } else if (key.t === "uint" && key.v === 4n) {
      datumsRaw = val.raw;
    }
  }
  if (!redeemersRaw || !redVal) throw new Error("built tx has no redeemers (witness key 5)");
  return { redeemersRaw, datumsRaw, exUnitsList: exUnitsListFrom(redVal) };
}

function exUnitsListFrom(reds: CborValue): { mem: bigint; steps: bigint }[] {
  const asEx = (ex: CborValue | undefined) => {
    if (!ex || ex.t !== "array") throw new Error("bad ex-units");
    const mem = ex.v[0];
    const steps = ex.v[1];
    if (!mem || mem.t !== "uint" || !steps || steps.t !== "uint") throw new Error("bad ex-units");
    return { mem: mem.v, steps: steps.v };
  };
  if (reds.t === "map") return reds.v.map(([, v]) => (v.t === "array" ? asEx(v.v[1]) : (() => { throw new Error("bad redeemer value"); })()));
  if (reds.t === "array") return reds.v.map((r0) => (r0.t === "array" ? asEx(r0.v[3]) : (() => { throw new Error("bad redeemer entry"); })()));
  throw new Error("unrecognized redeemer encoding");
}

function cmFromPp(pp: { costModels?: { PlutusV2?: number[] } }): bigint[] {
  const cm = pp.costModels?.PlutusV2;
  if (!cm) throw new Error("provider returned no PlutusV2 cost model");
  return cm.map((n) => BigInt(n));
}

export { getAddressDetails };
