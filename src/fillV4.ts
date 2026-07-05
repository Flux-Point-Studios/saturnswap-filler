// V4 taker-fill tx builder (one-way orders). Permissionless: no SaturnSwap
// co-sign, no authorize key.
//
// Split in two, mirroring V3's computeFillPlan / buildTakerFill:
//   planTakerFillV4Tx  — PURE. Turns an order + buyAmount + deployment into a
//                        serializable tx recipe (redeemer + index, every output
//                        with its tagged datum, the beacon burn / receipt mint).
//                        Fully offline-testable; this is where every builder
//                        decision lives.
//   buildTakerFillV4   — thin @lucid-evolution assembler: resolve UTxOs, feed
//                        the recipe into a TxBuilder, .complete(), re-check the
//                        input index against the finalized sort.
//
// The value flows come from computeFillPlanV4 (the pure, unit-tested planner).
// Targets the one-way book (the composable fill path); two-way swap, create,
// cancel and reprice are separate builders.

import type { LucidEvolution, UTxO, Assets, Network } from "@lucid-evolution/lucid";
import { credentialToAddress } from "@lucid-evolution/lucid";
import type { OrderDatumV4 } from "./datumV4.js";
import {
  fillRedeemer,
  paymentDatumV4,
  beaconBurnOnly,
  orderDatumToPlutusData,
  receiptTokenName,
  mintFillReceiptsRedeemer,
  fillReceiptDatumV4ToPlutusData,
} from "./datumV4.js";
import { computeFillPlanV4, type FillPlanV4 } from "./fillPlanV4.js";
import { pairBeaconName, offerBeaconName, askBeaconName } from "./beaconsV4.js";
import { plutusToHex } from "./plutus.js";
import type { ChainValue } from "./discovery.js";
import { inputIndexOf, sortInputs, type TxIn } from "./sort.js";
import { minUtxoLovelace } from "./minUtxo.js";
import type { OutputRef } from "./datum.js";

export const V4_MAINNET_COINS_PER_UTXO_BYTE = 4310n;

/** The applied V4 deployment the builder targets. */
export interface V4Deployment {
  network: Network;
  /** saturn_swap_v4 spend script hash (H_spend) */
  orderScriptHash: string;
  /** beacon_limit policy id (P_limit) */
  beaconPolicy: string;
  /** fee_address bech32 (only used when feePercentBps > 0 — Model A) */
  feeAddressBech32: string;
  /** deployment fee in basis points (0 = Model B) */
  feePercentBps: number;
  // NOTE: there is no single "order address" — each maker's order lives at a
  // PER-USER address (this shared script hash + the maker's own staking
  // credential). Continuations must return to the ORDER'S OWN address (carried
  // on the order being filled), never a global address.
  /** reference-script UTxO carrying the applied saturn_swap_v4 validator */
  spendRefUtxo: OutputRef;
  /** reference-script UTxO carrying beacon_limit (needed for full-fill burn) */
  beaconRefUtxo: OutputRef;
  /** reference-script UTxO carrying fill_receipt (only if mintReceipt) */
  receiptRefUtxo?: OutputRef;
  /** fill_receipt policy id (only if mintReceipt) */
  receiptPolicy?: string;
}

export type OutputRole = "owner" | "fee" | "coverage" | "continuation" | "receipt";

export interface RecipeOutput {
  role: OutputRole;
  addressBech32: string;
  assets: Assets;
  inlineDatumHex: string;
}
export interface RecipeMint {
  unit: string;
  quantity: bigint;
}
export interface RecipeMintGroup {
  redeemerHex: string;
  assets: RecipeMint[];
}

/** A fully-resolved, serializable description of the fill transaction. */
export interface TakerFillRecipe {
  kind: "full" | "partial";
  plan: FillPlanV4;
  /** spend inputs in submission order (order first, then funding) */
  spendInputs: TxIn[];
  inputIndex: number;
  spendRedeemerHex: string;
  outputs: RecipeOutput[];
  /** index of the owner payout in `outputs` (the Fill redeemer's output_index) */
  ownerOutputIndex: number;
  /** grouped by minting policy/redeemer (beacon burn, receipt mint) */
  mints: RecipeMintGroup[];
  /** reference-script UTxOs to read */
  refInputs: OutputRef[];
  /** POSIX ms upper bound (order expiry - 1), or null */
  validToUnixMs: number | null;
}

function chainValueToAssets(v: ChainValue): Assets {
  const out: Assets = { lovelace: v.lovelace };
  for (const [u, amt] of Object.entries(v.assets)) if (amt !== 0n) out[u] = amt;
  return out;
}

function floorMinUtxo(
  assets: Assets,
  addressBech32: string,
  coinsPerUtxoByte: bigint,
  inlineDatumHex?: string,
): Assets {
  const sizing: Record<string, bigint> = { ...assets };
  if (!sizing["lovelace"] || sizing["lovelace"] < 1_000_000n) sizing["lovelace"] = 2_000_000n;
  const floor = minUtxoLovelace({ addressBech32, assets: sizing, inlineDatumHex }, coinsPerUtxoByte);
  const current = assets["lovelace"] ?? 0n;
  return { ...assets, lovelace: current > floor ? current : floor };
}

function credToBech32(
  addr: { payment: { type: "key" | "script"; hash: string }; stake?: { type: "key" | "script"; hash: string } },
  network: Network,
): string {
  const payment = { type: addr.payment.type === "key" ? ("Key" as const) : ("Script" as const), hash: addr.payment.hash };
  if (!addr.stake) return credentialToAddress(network, payment);
  const stake = { type: addr.stake.type === "key" ? ("Key" as const) : ("Script" as const), hash: addr.stake.hash };
  return credentialToAddress(network, payment, stake);
}

export interface PlanTakerFillV4Args {
  deployment: V4Deployment;
  /** the order being filled: its datum, outref, current value, and its OWN
   *  per-user address (the continuation must return to exactly this address) */
  order: { datum: OrderDatumV4; utxo: OutputRef; scriptValue: ChainValue; address: string };
  buyAmount: bigint;
  /** funding input outrefs (for the canonical input sort / index) */
  fundingInputs: TxIn[];
  /** where a minted fill receipt lands (defaults to the order owner's address);
   *  receipts are transferable, so the taker typically sends them to itself */
  receiptAddressBech32?: string;
  mintReceipt?: boolean;
  coinsPerUtxoByte?: bigint;
}

/**
 * PURE: produce the full tx recipe for a one-way fill. No I/O, no Lucid — every
 * decision (redeemer, indices, tagged outputs, beacon burn, receipt mint) is
 * computed here so it can be unit-tested against the on-chain rules.
 */
export function planTakerFillV4Tx(args: PlanTakerFillV4Args): TakerFillRecipe {
  const { deployment, order } = args;
  const coinsPerUtxoByte = args.coinsPerUtxoByte ?? V4_MAINNET_COINS_PER_UTXO_BYTE;
  const plan = computeFillPlanV4(order.datum, order.scriptValue, args.buyAmount, deployment.feePercentBps);
  const orderRef = order.utxo;

  const spendInputs: TxIn[] = [orderRef, ...args.fundingInputs];
  const inputIndex = inputIndexOf(spendInputs, orderRef);
  if (inputIndex < 0) throw new Error("order input not in spend-input set");

  const paymentDatumHex = plutusToHex(paymentDatumV4(orderRef));
  const ownerBech32 = credToBech32(order.datum.owner, deployment.network);

  const outputs: RecipeOutput[] = [];
  // [0] owner payout — the Fill redeemer's output_index
  outputs.push({
    role: "owner",
    addressBech32: ownerBech32,
    assets: floorMinUtxo(chainValueToAssets(plan.ownerPayout), ownerBech32, coinsPerUtxoByte, paymentDatumHex),
    inlineDatumHex: paymentDatumHex,
  });
  const ownerOutputIndex = 0;

  // fee (Model A)
  if (plan.fee) {
    outputs.push({
      role: "fee",
      addressBech32: deployment.feeAddressBech32,
      assets: floorMinUtxo(chainValueToAssets(plan.fee.value), deployment.feeAddressBech32, coinsPerUtxoByte, paymentDatumHex),
      inlineDatumHex: paymentDatumHex,
    });
  }

  // coverage vault
  if (plan.coverage) {
    const vaultBech32 = credToBech32(order.datum.coverage!.vault, deployment.network);
    outputs.push({
      role: "coverage",
      addressBech32: vaultBech32,
      assets: floorMinUtxo(chainValueToAssets(plan.coverage.premium), vaultBech32, coinsPerUtxoByte, paymentDatumHex),
      inlineDatumHex: paymentDatumHex,
    });
  }

  const mints: RecipeMintGroup[] = [];
  const refInputs: OutputRef[] = [deployment.spendRefUtxo];

  // continuation (partial) or beacon burn (full)
  if (plan.kind === "partial") {
    const contDatum: OrderDatumV4 = {
      ...order.datum,
      amountSell: plan.continuation!.newAmountSell,
      amountBuy: plan.continuation!.newAmountBuy,
      outputReference: orderRef,
    };
    outputs.push({
      role: "continuation",
      addressBech32: order.address, // MUST equal the order's own per-user address
      assets: chainValueToAssets(plan.continuation!.value),
      inlineDatumHex: plutusToHex(orderDatumToPlutusData(datumForBuilder(contDatum))),
    });
  } else {
    const pairName = pairBeaconName(order.datum.policyIdSell, order.datum.assetNameSell, order.datum.policyIdBuy, order.datum.assetNameBuy);
    const offerName = offerBeaconName(order.datum.policyIdSell, order.datum.assetNameSell);
    const askName = askBeaconName(order.datum.policyIdBuy, order.datum.assetNameBuy);
    mints.push({
      redeemerHex: plutusToHex(beaconBurnOnly),
      assets: [
        { unit: deployment.beaconPolicy + pairName, quantity: -1n },
        { unit: deployment.beaconPolicy + offerName, quantity: -1n },
        { unit: deployment.beaconPolicy + askName, quantity: -1n },
      ],
    });
    refInputs.push(deployment.beaconRefUtxo);
  }

  // optional receipt mint
  if (args.mintReceipt) {
    if (!deployment.receiptRefUtxo || !deployment.receiptPolicy)
      throw new Error("mintReceipt requires deployment.receiptRefUtxo + receiptPolicy");
    const receiptUnit = deployment.receiptPolicy + receiptTokenName(orderRef);
    const receiptOutputIndex = outputs.length;
    const receiptDatumHex = plutusToHex(
      fillReceiptDatumV4ToPlutusData({
        orderReference: orderRef,
        maker: order.datum.owner,
        policyIdSell: order.datum.policyIdSell,
        assetNameSell: order.datum.assetNameSell,
        sold: plan.released,
        policyIdBuy: order.datum.policyIdBuy,
        assetNameBuy: order.datum.assetNameBuy,
        bought: args.buyAmount,
      }),
    );
    const receiptAddr = args.receiptAddressBech32 ?? credToBech32(order.datum.owner, deployment.network);
    outputs.push({
      role: "receipt",
      addressBech32: receiptAddr,
      assets: floorMinUtxo({ [receiptUnit]: 1n } as Assets, receiptAddr, coinsPerUtxoByte, receiptDatumHex),
      inlineDatumHex: receiptDatumHex,
    });
    mints.push({
      redeemerHex: plutusToHex(mintFillReceiptsRedeemer([{ orderInputIndex: inputIndex, receiptOutputIndex }])),
      assets: [{ unit: receiptUnit, quantity: 1n }],
    });
    refInputs.push(deployment.receiptRefUtxo);
  }

  return {
    kind: plan.kind,
    plan,
    spendInputs,
    inputIndex,
    spendRedeemerHex: plutusToHex(fillRedeemer(args.buyAmount, inputIndex, ownerOutputIndex)),
    outputs,
    ownerOutputIndex,
    mints,
    refInputs,
    validToUnixMs: order.datum.validBeforeTime !== null ? Number(order.datum.validBeforeTime) - 1 : null,
  };
}

export interface BuildTakerFillV4Options {
  lucid: LucidEvolution;
  deployment: V4Deployment;
  order: { datum: OrderDatumV4; utxo: OutputRef; scriptValue: ChainValue; address: string };
  buyAmount: bigint;
  fundingUtxos: UTxO[];
  collateralUtxo: UTxO;
  changeAddress?: string;
  receiptAddressBech32?: string;
  mintReceipt?: boolean;
  coinsPerUtxoByte?: bigint;
}

export interface TakerFillV4Result {
  unsignedCbor: string;
  txHash: string;
  recipe: TakerFillRecipe;
}

/** Thin @lucid-evolution assembler over planTakerFillV4Tx. */
export async function buildTakerFillV4(opts: BuildTakerFillV4Options): Promise<TakerFillV4Result> {
  const { lucid, deployment, order } = opts;
  const changeAddress = opts.changeAddress ?? opts.collateralUtxo.address;

  const recipe = planTakerFillV4Tx({
    deployment,
    order,
    buyAmount: opts.buyAmount,
    fundingInputs: opts.fundingUtxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
    receiptAddressBech32: opts.receiptAddressBech32,
    mintReceipt: opts.mintReceipt,
    coinsPerUtxoByte: opts.coinsPerUtxoByte,
  });

  const [orderUtxo] = await lucid.utxosByOutRef([{ txHash: order.utxo.txHash, outputIndex: order.utxo.outputIndex }]);
  if (!orderUtxo) throw new Error(`order UTxO ${order.utxo.txHash}#${order.utxo.outputIndex} not found`);
  const refUtxos = await lucid.utxosByOutRef(
    recipe.refInputs.map((r) => ({ txHash: r.txHash, outputIndex: r.outputIndex })),
  );
  if (refUtxos.length !== recipe.refInputs.length) throw new Error("one or more reference-script UTxOs not found");

  lucid.selectWallet.fromAddress(changeAddress, [opts.collateralUtxo]);

  let tx = lucid
    .newTx()
    .collectFrom([orderUtxo], recipe.spendRedeemerHex)
    .collectFrom(opts.fundingUtxos)
    .readFrom(refUtxos);

  for (const out of recipe.outputs) {
    tx = tx.pay.ToAddressWithData(out.addressBech32, { kind: "inline", value: out.inlineDatumHex }, out.assets);
  }
  for (const group of recipe.mints) {
    const bag: Assets = {};
    for (const m of group.assets) bag[m.unit] = m.quantity;
    tx = tx.mintAssets(bag, group.redeemerHex);
  }
  if (recipe.validToUnixMs !== null) tx = tx.validTo(recipe.validToUnixMs);

  const signBuilder = await tx.complete({ changeAddress, setCollateral: 5_000_000n });
  const unsignedCbor = signBuilder.toCBOR();

  // input-index safety net against the finalized sort
  const finalIndex = sortInputs(recipe.spendInputs).findIndex(
    (i) => i.txHash === order.utxo.txHash && i.outputIndex === order.utxo.outputIndex,
  );
  if (finalIndex !== recipe.inputIndex) throw new Error(`fill input_index drift: ${recipe.inputIndex} vs ${finalIndex}`);

  return { unsignedCbor, txHash: signBuilder.toHash(), recipe };
}

// the orderDatumToPlutusData builder wants a plain object (no ownerRaw)
function datumForBuilder(d: OrderDatumV4) {
  return {
    beaconPolicy: d.beaconPolicy,
    owner: d.owner,
    policyIdSell: d.policyIdSell,
    assetNameSell: d.assetNameSell,
    amountSell: d.amountSell,
    policyIdBuy: d.policyIdBuy,
    assetNameBuy: d.assetNameBuy,
    amountBuy: d.amountBuy,
    validBeforeTime: d.validBeforeTime,
    minPartialFill: d.minPartialFill,
    coverage: d.coverage,
    outputReference: d.outputReference,
  };
}
