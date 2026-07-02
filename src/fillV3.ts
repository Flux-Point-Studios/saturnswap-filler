// Non-auth taker-fill for the V3 (PlutusV3) saturn_swap validator. Same recipe as the V2
// fill (SPEC §7/§8) plus the V3 conjuncts the validator enforces:
//   - min_partial_fill (#4): a PARTIAL fill must take >= min_partial_fill of the buy asset.
//   - coverage (#6): a COVERED order (coverage = Some) must emit a premium OUTPUT to the
//     coverage vault carrying >= max(1, filled_buy * premium_bps / 10000) of the BUY asset,
//     tagged with the same PaymentDatum. The vault must be DISTINCT from owner (payment
//     credential) and fee_address. A fill that omits/underpays the premium is DENIED.
//   - fill-receipt (#5): the fill ALSO mints a CIP-69 self-validating fill-receipt on the swap
//     script (receipt policy id == script hash). The hardened mint handler binds the receipt to
//     a REAL SwapAction fill: the SwapAction payout-index == the receipt's owner_output_index,
//     the maker payout carries InlineDatum(PaymentDatum{order_ref}), and sold_amount is DERIVED
//     on-chain (full = amount_sell; partial = script_input_sell − continuation_sell). We build
//     the receipt to match that binding exactly. (Minting is opt-out via mintReceipt: false.)
// The partial-fill relist must carry min_partial_fill AND the full coverage forward unchanged.
//
// Load-bearing bytes (datum / redeemer / script_data_hash) come from this lib's own V3
// primitives (flat OutputReference, language-views key 2); tx assembly + ex-unit evaluation
// use @lucid-evolution/lucid (CML). V3 is LIVE on mainnet (6023f59d…); the preprod build
// (ec457591…) backs the differential tests.
//
// PREMIUM IS OUT-OF-POCKET: for a covered order the premium output (plan.premium.required, in
// the BUY asset) is paid by the FILLER on top of the owner payout — it is NOT reflected in the
// order's sell/buy amounts or priceBaseUnits. Integrators MUST subtract plan.premium.required
// from their profitability/quote.

import type { LucidEvolution, UTxO, Assets, Network } from "@lucid-evolution/lucid";
import { credentialToAddress, slotToUnixTime } from "@lucid-evolution/lucid";
import type { Order } from "./discovery.js";
import { unit } from "./discovery.js";
import type { OwnerAddress } from "./datum.js";
import { swapActionRedeemer } from "./datum.js";
import type { Coverage, FillReceiptDatum } from "./datumV3.js";
import {
  FILL_RECEIPT_ASSET_NAME,
  fillReceiptDatumToPlutusData,
  mintFillReceiptRedeemer,
  paymentDatumV3,
  swapDatumV3ToPlutusData,
} from "./datumV3.js";
import { fillSellAndFee, premiumForFill, swapSplitAmounts } from "./ratio.js";
import { plutusToHex } from "./plutus.js";
import {
  feeOutputAssets,
  MINUTXO_SIZING_LOVELACE,
  ownerOutputAssets,
  premiumOutputAssets,
  relistContinuationAssets,
} from "./outputs.js";
import { minUtxoLovelace } from "./minUtxo.js";
import type { RelistPlan, FillPlan } from "./fill.js";
import { assertCollateralDisjoint, inputIndexOf, sortInputs } from "./sort.js";
import { computeScriptDataHashV3FromParts, bytesToHex } from "./scriptDataHash.js";
import { CborReader, hexToBytes, type CborValue } from "./cbor.js";

const ADA = "" as const;
export const PREPROD_COINS_PER_UTXO_BYTE = 4310n; // live utxoCostPerByte; overridable per build

function isAda(policyId: string, assetName: string): boolean {
  return policyId === ADA && assetName === ADA;
}

function credAddr(network: Network, addr: OwnerAddress): string {
  const payment = { type: addr.payment.type === "key" ? ("Key" as const) : ("Script" as const), hash: addr.payment.hash };
  if (!addr.stake) return credentialToAddress(network, payment);
  const stake = { type: addr.stake.type === "key" ? ("Key" as const) : ("Script" as const), hash: addr.stake.hash };
  return credentialToAddress(network, payment, stake);
}

/** Aegis premium output plan (present iff the order is covered and the fill owes a premium). */
export interface PremiumPlan {
  vaultAddressBech32: string;
  /** premium in the BUY asset = filled_buy * premium_bps / 10000 */
  required: bigint;
  assets: Assets;
}

export interface FillPlanV3 extends FillPlan {
  minPartialFill: bigint;
  coverage: Coverage | null;
  /** present iff the order is covered AND the per-fill premium is > 0 */
  premium?: PremiumPlan;
}

/** Upper bound on a covered order's premium_bps. 10_000 bps = 100%: a premium >= the fill's buy
 *  amount is almost certainly malicious/malformed, so the planner refuses to build above it. */
export const DEFAULT_MAX_PREMIUM_BPS = 10_000n;

/** Pure V3 fill plan (full OR partial). Enforces the min_partial_fill floor, emits the Aegis
 *  premium output for covered orders, and (partial) carries coverage + floor forward. `network`
 *  is required (no default) so owner/vault addresses can never silently encode to the wrong
 *  network. `maxPremiumBps` bounds a covered order's premium (default 100%). */
export function computeFillPlanV3(
  order: Order,
  userSellAmount: bigint,
  network: Network,
  coinsPerUtxoByte: bigint = PREPROD_COINS_PER_UTXO_BYTE,
  maxPremiumBps: bigint = DEFAULT_MAX_PREMIUM_BPS,
): FillPlanV3 {
  if (order.plutusVersion !== "v3") throw new Error("computeFillPlanV3 requires a V3 order");
  if (userSellAmount <= 0n) throw new Error("userSellAmount must be positive");
  if (userSellAmount > order.buy.amount)
    throw new Error(`userSellAmount ${userSellAmount} exceeds order amount_buy ${order.buy.amount}`);

  const isFullFill = userSellAmount === order.buy.amount;
  const sellIsAda = isAda(order.sell.policyId, order.sell.assetName);
  const buyIsAda = isAda(order.buy.policyId, order.buy.assetName);

  // V3 #4: a PARTIAL fill must take at least min_partial_fill of the buy asset (a full fill is
  // always allowed). The validator denies a sub-floor partial (is_fill_above_floor).
  if (!isFullFill && userSellAmount < order.minPartialFill)
    throw new Error(
      `partial fill ${userSellAmount} is below the order's min_partial_fill ${order.minPartialFill} — ` +
        `fill at least min_partial_fill of the buy asset, or fill in full`,
    );

  // owner_value_has_correct_amount case (c): a token→token full fill demands amount_buy-as-lovelace
  // (infeasible) — route via a partial fill (which satisfies case (a)). Same rule as V2.
  if (isFullFill && !buyIsAda && !sellIsAda)
    throw new Error(
      "token→token orders must be filled as a PARTIAL fill — a full fill requires " +
        "amount_buy-as-lovelace per validator case (c), which is infeasible; use a partial fill.",
    );

  const { newSwapAmountSell, totalFee } = fillSellAndFee(
    order.sell.amount,
    order.buy.amount,
    userSellAmount,
    order.feePercentX100,
  );

  const ownerAddressBech32 = credAddr(network, order.datum.owner);
  const paymentDatumHex = plutusToHex(paymentDatumV3(order.utxo));

  const split = isFullFill
    ? null
    : swapSplitAmounts(order.sell.amount, order.buy.amount, userSellAmount, sellIsAda);

  const ownerAssets = ownerOutputAssets({
    buyIsAda,
    buyUnit: unit(order.buy.policyId, order.buy.assetName),
    amountBuy: order.buy.amount,
    isFullFill,
    userSellAmount,
    scriptLovelace: order.scriptValue.lovelace,
    sellBuffer: split?.sellBuffer ?? 0n,
    ownerAddressBech32,
    paymentDatumHex,
    coinsPerUtxoByte,
  });

  const feeAssets = feeOutputAssets({
    sellIsAda,
    sellUnit: unit(order.sell.policyId, order.sell.assetName),
    totalFee,
    feeAddress: order.feeAddress,
    paymentDatumHex,
    coinsPerUtxoByte,
  });

  const plan: FillPlanV3 = {
    isFullFill,
    userSellAmount,
    newSwapAmountSell,
    totalFee,
    ownerOutputAssets: ownerAssets,
    feeOutputAssets: feeAssets,
    paymentDatumHex,
    ownerAddressBech32,
    minPartialFill: order.minPartialFill,
    coverage: order.coverage,
  };

  // V3 #6: covered order ⇒ a premium output to the coverage vault (buy asset). filled_buy = the
  // buy asset delivered this fill = user_sell_amount. The hardened validator enforces this for
  // EVERY covered fill (there is no zero-premium escape): the vault must be distinct and the
  // required premium is floored at 1.
  if (order.coverage) {
    // Bound the premium BEFORE computing it: premium_bps is maker-directed and the premium is
    // paid out of the filler's pocket, so an uncapped/oversized value is a fund-loss vector.
    if (order.coverage.premiumBps > maxPremiumBps)
      throw new Error(
        `coverage premium_bps ${order.coverage.premiumBps} exceeds max ${maxPremiumBps} — a premium ` +
          `>= the fill's buy amount is almost certainly malicious/malformed; refusing to build`,
      );
    const vaultAddressBech32 = credAddr(network, order.coverage.vault);
    // is_vault_distinct: vault.payment_credential != owner.payment_credential AND vault != fee.
    // The owner check is on the PAYMENT CREDENTIAL only (a shared payment cred collides even if
    // the stake part differs), matching the on-chain check exactly.
    const ownerPay = order.datum.owner.payment;
    const vaultPay = order.coverage.vault.payment;
    const collidesOwner = vaultPay.type === ownerPay.type && vaultPay.hash === ownerPay.hash;
    if (collidesOwner || vaultAddressBech32 === order.feeAddress)
      throw new Error(
        "coverage vault must be distinct from the owner (payment credential) and the fee address — " +
          "a shared destination collapses the double-satisfaction guard; the validator's is_vault_distinct denies it",
      );
    // ≥1 floor (on-chain required = max(1, filled_buy * premium_bps / 10000)): a covered fill
    // can NEVER owe zero, so a premium output is ALWAYS emitted for a covered order.
    const base = premiumForFill(userSellAmount, order.coverage.premiumBps);
    const required = base > 1n ? base : 1n;
    const assets = premiumOutputAssets({
      buyIsAda,
      buyUnit: unit(order.buy.policyId, order.buy.assetName),
      required,
      vaultAddressBech32,
      paymentDatumHex,
      coinsPerUtxoByte,
    });
    plan.premium = { vaultAddressBech32, required, assets };
  }

  if (split) plan.relist = buildRelistV3(order, split, sellIsAda, coinsPerUtxoByte);
  return plan;
}

/** §8 continuation carrying min_partial_fill + coverage forward unchanged (V3 swap_split). */
function buildRelistV3(
  order: Order,
  split: ReturnType<typeof swapSplitAmounts>,
  sellIsAda: boolean,
  coinsPerUtxoByte: bigint,
): RelistPlan {
  const datumHex = plutusToHex(
    swapDatumV3ToPlutusData({
      owner: order.datum.owner,
      policyIdSell: order.sell.policyId,
      assetNameSell: order.sell.assetName,
      amountSell: split.correctedNewAmountSell,
      policyIdBuy: order.buy.policyId,
      assetNameBuy: order.buy.assetName,
      amountBuy: split.correctedNewAmountBuy,
      validBeforeTime: order.validBeforeTime,
      outputReference: order.utxo, // the SPENT order's own ref — the relist-chain link
      minPartialFill: order.minPartialFill, // carried forward unchanged (is_correct_min_partial_fill)
      coverage: order.coverage, // carried forward unchanged (is_correct_coverage)
    }),
  );

  const assets = relistContinuationAssets({
    sellIsAda,
    sellUnit: unit(order.sell.policyId, order.sell.assetName),
    correctedNewAmountSell: split.correctedNewAmountSell,
    scriptLovelace: order.scriptValue.lovelace,
    orderAddress: order.orderAddress,
    datumHex,
    coinsPerUtxoByte,
  });

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

/** The fill-receipt the CIP-69 mint handler binds to (V3 #5). `sold`/`bought` are DERIVED exactly
 *  as the hardened validator derives them, so the minted receipt validates:
 *    - bought = the buy asset actually delivered to the owner output (index 0 in this builder)
 *    - sold   = full fill: amount_sell; partial: script_input_sell − continuation_sell
 *  `scriptInputSell` is the sell-asset quantity in the SPENT order UTxO's on-chain value;
 *  `executedAtMs` is the tx's finite lower validity bound (POSIXTime ms) the receipt anchors to. */
export interface ReceiptPlan {
  /** filler-chosen receipt token name (hex); the mint handler binds the datum, not the name */
  assetNameHex: string;
  datum: FillReceiptDatum;
  /** inline FillReceiptDatum carried on the receipt output */
  datumHex: string;
  soldAmount: bigint;
  boughtAmount: bigint;
}

export function computeFillReceipt(
  order: Order,
  plan: FillPlanV3,
  scriptInputSell: bigint,
  executedAtMs: bigint,
): ReceiptPlan {
  if (order.plutusVersion !== "v3") throw new Error("computeFillReceipt requires a V3 order");
  const sellIsAda = isAda(order.sell.policyId, order.sell.assetName);
  const buyIsAda = isAda(order.buy.policyId, order.buy.assetName);
  const sellUnit = unit(order.sell.policyId, order.sell.assetName);
  const buyUnit = unit(order.buy.policyId, order.buy.assetName);

  // bought = quantity_of(owner_output.value, buy) — the payout `swap` enforced at output_index 0.
  const boughtAmount = buyIsAda
    ? plan.ownerOutputAssets["lovelace"] ?? 0n
    : plan.ownerOutputAssets[buyUnit] ?? 0n;

  // sold = the actual sell-asset delta that left the script.
  let soldAmount: bigint;
  if (plan.isFullFill) {
    soldAmount = order.sell.amount; // == order_datum.amount_sell
  } else {
    if (!plan.relist) throw new Error("partial fill without a relist continuation — cannot derive sold");
    const continuationSell = sellIsAda
      ? plan.relist.assets["lovelace"] ?? 0n
      : plan.relist.assets[sellUnit] ?? 0n;
    soldAmount = scriptInputSell - continuationSell;
  }
  if (soldAmount <= 0n || boughtAmount <= 0n)
    throw new Error(
      `fill-receipt would carry a non-positive amount (sold=${soldAmount}, bought=${boughtAmount}); ` +
        "the validator requires sold_amount > 0 and bought_amount > 0",
    );

  const datum: FillReceiptDatum = {
    maker: order.datum.owner,
    orderReference: order.utxo,
    soldAmount,
    boughtAmount,
    policyIdSell: order.sell.policyId,
    assetNameSell: order.sell.assetName,
    policyIdBuy: order.buy.policyId,
    assetNameBuy: order.buy.assetName,
    executedAt: executedAtMs,
  };
  return {
    assetNameHex: FILL_RECEIPT_ASSET_NAME,
    datum,
    datumHex: plutusToHex(fillReceiptDatumToPlutusData(datum)),
    soldAmount,
    boughtAmount,
  };
}

export interface BuildTakerFillV3Options {
  lucid: LucidEvolution;
  order: Order;
  userSellAmount: bigint;
  fundingUtxos: UTxO[];
  collateralUtxo: UTxO;
  changeAddress?: string;
  network?: Network;
  /** override the PlutusV3 cost model used for the self-computed SDH cross-check */
  costModelV3?: bigint[];
  coinsPerUtxoByte?: bigint;
  /** upper bound on a covered order's premium_bps (default 100% = 10_000); a covered order above
   *  this is refused as malicious/malformed */
  maxPremiumBps?: bigint;
  /** mint a CIP-69 fill-receipt alongside the fill (default true); false skips the receipt */
  mintReceipt?: boolean;
  /** desired lower validity bound (POSIX ms) the receipt's executed_at anchors to; defaults to
   *  ~60s in the past so the tx is immediately valid. Snapped to the slot boundary. */
  validFromUnixMs?: number;
}

export interface TakerFillV3Result {
  unsignedCbor: string;
  txHash: string;
  inputIndex: number;
  outputIndex: number;
  exUnits: { mem: bigint; steps: bigint };
  /** self-computed Conway script_data_hash via the PlutusV3 (key-2) recipe */
  selfScriptDataHash: string;
  txScriptDataHash: string;
  scriptDataHashMatches: boolean;
  plan: FillPlanV3;
  /** BUY-asset premium the filler pays OUT OF POCKET to the coverage vault (0 when uncovered).
   *  NOT reflected in the order's sell/buy amounts — subtract it from profitability/quotes. */
  premiumRequired: bigint;
  /** lovelace parked on the minted fill-receipt output (reclaimable; 0 when mintReceipt false) */
  receiptLovelace: bigint;
  /** the minted fill-receipt (undefined when mintReceipt is false) */
  receipt?: {
    /** author-order index of the receipt output = the redeemer's receipt_output_index */
    outputIndex: number;
    /** receipt asset unit (policy id == swap script hash) ‖ asset name hex */
    unit: string;
    datum: FillReceiptDatum;
    /** the tx's finite lower validity bound (POSIX ms) the receipt anchors to */
    executedAt: bigint;
    soldAmount: bigint;
    boughtAmount: bigint;
  };
}

export async function buildTakerFillV3(opts: BuildTakerFillV3Options): Promise<TakerFillV3Result> {
  const { lucid, order, userSellAmount } = opts;
  const network = opts.network ?? lucid.config().network;
  if (!network)
    throw new Error("network could not be derived from lucid.config(); pass opts.network explicitly");

  const pp = await lucid.config().provider!.getProtocolParameters();
  const coinsPerUtxoByte = opts.coinsPerUtxoByte ?? BigInt((pp as { coinsPerUtxoByte: number | bigint }).coinsPerUtxoByte);
  const costModelV3 = opts.costModelV3 ?? cmV3FromPp(pp);

  const plan = computeFillPlanV3(order, userSellAmount, network, coinsPerUtxoByte, opts.maxPremiumBps);

  const [orderUtxo] = await lucid.utxosByOutRef([
    { txHash: order.utxo.txHash, outputIndex: order.utxo.outputIndex },
  ]);
  if (!orderUtxo) throw new Error(`order UTxO ${order.utxo.txHash}#${order.utxo.outputIndex} not found on-chain`);
  const [refUtxo] = await lucid.utxosByOutRef([
    { txHash: order.refScript.txHash, outputIndex: order.refScript.outputIndex },
  ]);
  if (!refUtxo?.scriptRef)
    throw new Error(`reference-script UTxO ${order.refScript.txHash}#${order.refScript.outputIndex} missing scriptRef`);

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
  lucid.selectWallet.fromAddress(changeAddress, [opts.collateralUtxo]);

  let tx = lucid
    .newTx()
    .collectFrom([orderUtxo], redeemerHex)
    .collectFrom(opts.fundingUtxos)
    .readFrom([refUtxo])
    // owner output MUST be index 0 (the redeemer output_index); fee + premium + relist follow
    .pay.ToAddressWithData(plan.ownerAddressBech32, { kind: "inline", value: plan.paymentDatumHex }, plan.ownerOutputAssets)
    .pay.ToAddressWithData(order.feeAddress, { kind: "inline", value: plan.paymentDatumHex }, plan.feeOutputAssets);

  if (plan.premium) {
    tx = tx.pay.ToAddressWithData(
      plan.premium.vaultAddressBech32,
      { kind: "inline", value: plan.paymentDatumHex },
      plan.premium.assets,
    );
  }

  if (plan.relist) {
    tx = tx.pay.ToAddressWithData(
      plan.relist.scriptAddress,
      { kind: "inline", value: plan.relist.datumHex },
      plan.relist.assets,
    );
  }

  // V3 #5: mint a CIP-69 fill-receipt bound to this fill. The receipt output is LAST in author
  // order; its index is the mint redeemer's receipt_output_index. The mint reads `bought` off
  // the owner output (index 0 = the SwapAction output_index) and derives `sold` from the sell
  // delta, so the receipt datum must match computeFillReceipt exactly. The multi-purpose swap
  // script (spend + mint under the same hash) is resolved from the reference script read above.
  let receiptResult: TakerFillV3Result["receipt"];
  let receiptLovelaceOut = 0n;
  const mintReceipt = opts.mintReceipt ?? true;
  if (mintReceipt) {
    // Snap the desired lower bound to its slot boundary so executed_at == the POSIXTime the
    // ledger derives from invalid_before (round-trips through unixTimeToSlot ⇄ slotToUnixTime).
    const validFromMs = opts.validFromUnixMs ?? Date.now() - 60_000;
    const slot = lucid.unixTimeToSlot(validFromMs);
    const executedAt = BigInt(slotToUnixTime(network, slot));

    const sellIsAda = isAda(order.sell.policyId, order.sell.assetName);
    const scriptInputSell = sellIsAda
      ? orderUtxo.assets["lovelace"] ?? 0n
      : orderUtxo.assets[unit(order.sell.policyId, order.sell.assetName)] ?? 0n;
    const receipt = computeFillReceipt(order, plan, scriptInputSell, executedAt);
    const receiptUnit = order.scriptHash + receipt.assetNameHex;
    const receiptOutputIndex = 2 + (plan.premium ? 1 : 0) + (plan.relist ? 1 : 0);

    const receiptLovelace = minUtxoLovelace(
      {
        addressBech32: changeAddress,
        assets: { lovelace: MINUTXO_SIZING_LOVELACE, [receiptUnit]: 1n },
        inlineDatumHex: receipt.datumHex,
      },
      coinsPerUtxoByte,
    );
    receiptLovelaceOut = receiptLovelace;
    const receiptAssets: Assets = { [receiptUnit]: 1n, lovelace: receiptLovelace };

    tx = tx
      .pay.ToAddressWithData(changeAddress, { kind: "inline", value: receipt.datumHex }, receiptAssets)
      .mintAssets(
        { [receiptUnit]: 1n },
        plutusToHex(mintFillReceiptRedeemer(inputIndex, outputIndex, receiptOutputIndex)),
      )
      .validFrom(Number(executedAt));

    receiptResult = {
      outputIndex: receiptOutputIndex,
      unit: receiptUnit,
      datum: receipt.datum,
      executedAt,
      soldAmount: receipt.soldAmount,
      boughtAmount: receipt.boughtAmount,
    };
  }

  if (order.validBeforeTime !== null) {
    tx = tx.validTo(Number(order.validBeforeTime) - 1);
  }

  // Fund-sufficiency guard. The collateral is reserved as the sole coin-selection UTxO (see
  // selectWallet above), so if the funding UTxOs plus the order's own lovelace cannot cover the
  // fill's outputs, lucid pulls the collateral in as a SPENDING input to balance. That both
  // shifts the order's canonical input index — the SwapAction / MintFillReceipt redeemers then
  // read the wrong input via get_own_input_fast and the validator crashes ("Spend[N] the
  // validator crashed") — and leaves the tx with no collateral. A COVERED PARTIAL fill trips
  // this first: it already carries the most outputs (owner + fee + premium + relist), so adding
  // the fill-receipt's ~min-UTxO output is what pushes the funding short. Fail fast, actionably.
  const outputLovelace =
    (plan.ownerOutputAssets["lovelace"] ?? 0n) +
    (plan.feeOutputAssets["lovelace"] ?? 0n) +
    (plan.premium?.assets["lovelace"] ?? 0n) +
    (plan.relist?.assets["lovelace"] ?? 0n) +
    receiptLovelaceOut;
  const fundingLovelace = opts.fundingUtxos.reduce((s, u) => s + (u.assets["lovelace"] ?? 0n), 0n);
  const orderLovelace = orderUtxo.assets["lovelace"] ?? 0n;
  if (fundingLovelace + orderLovelace < outputLovelace)
    throw new Error(
      `insufficient funding: the fill's outputs need ${outputLovelace} lovelace but funding + the order ` +
        `UTxO only provide ${fundingLovelace + orderLovelace} (funding ${fundingLovelace}, order ${orderLovelace})` +
        (mintReceipt ? `, incl. ~${receiptLovelaceOut} for the fill-receipt output` : "") +
        " — add funding UTxOs so the reserved collateral is not consumed as a spending input",
    );

  const signBuilder = await tx.complete({ changeAddress, setCollateral: 5_000_000n });
  const unsignedCbor = signBuilder.toCBOR();
  const txHash = signBuilder.toHash();

  const finalSorted = sortInputs(txInputs(unsignedCbor));
  const finalIndex = finalSorted.findIndex(
    (i) => i.txHash === order.utxo.txHash && i.outputIndex === order.utxo.outputIndex,
  );
  if (finalIndex !== inputIndex)
    throw new Error(`input_index drift: redeemer says ${inputIndex}, final tx sorts order at ${finalIndex}`);

  const { redeemersRaw, datumsRaw, exUnitsList } = extractWitness(unsignedCbor);
  const selfSdh = bytesToHex(computeScriptDataHashV3FromParts(redeemersRaw, datumsRaw, costModelV3));
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
    premiumRequired: plan.premium?.required ?? 0n,
    receiptLovelace: receiptLovelaceOut,
    receipt: receiptResult,
  };
}

// ---- tx-body / witness readers (shared shape with fill.ts; PlutusV3 SDH cross-check) ----

function txInputs(unsignedCbor: string): { txHash: string; outputIndex: number }[] {
  const top = new CborReader(hexToBytes(unsignedCbor)).decode();
  if (top.t !== "array") throw new Error("tx is not a CBOR array");
  let body = top.v[0]!;
  if (body.t === "tag") body = body.v;
  if (body.t !== "map") throw new Error("tx body is not a map");
  const inputsEntry = body.v.find(([k]) => k.t === "uint" && k.v === 0n);
  if (!inputsEntry) throw new Error("tx body has no inputs (key 0)");
  let inputs = inputsEntry[1];
  if (inputs.t === "tag") inputs = inputs.v;
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

function extractWitness(unsignedCbor: string): {
  redeemersRaw: Uint8Array;
  datumsRaw: Uint8Array | null;
  exUnitsList: { mem: bigint; steps: bigint }[];
} {
  const buf = hexToBytes(unsignedCbor);
  const r = new CborReader(buf);
  r.readArrayHeader();
  r.decode();
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

function cmV3FromPp(pp: { costModels?: { PlutusV3?: number[] } }): bigint[] {
  const cm = pp.costModels?.PlutusV3;
  if (!cm) throw new Error("provider returned no PlutusV3 cost model");
  return cm.map((n) => BigInt(n));
}
