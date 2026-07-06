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
  // ---- two-way (beacon_amm) book slots. Distinct scripts/policies from the
  // one-way book: a two-way order lives at twoWayScriptHash and its beacons mint
  // under ammPolicy (P_amm). Required by the swapV4 two-way builders; a one-way-
  // only aggregator deployment may omit them.
  /** saturn_swap_v4 two-way spend script hash (H_spend for the AMM book) */
  twoWayScriptHash?: string;
  /** beacon_amm policy id (P_amm) */
  ammPolicy?: string;
  /** reference-script UTxO carrying the applied two-way validator (swap spend) */
  twoWaySpendRefUtxo?: OutputRef;
  /** reference-script UTxO carrying beacon_amm (create/close mint+burn) */
  ammRefUtxo?: OutputRef;
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
  /** index of the owner payout in `outputs`. The owner is found on-chain by a
   *  tagged-scan (utils.tagged_payment_value), so its position is free — this is
   *  NOT the Fill redeemer's output_index. */
  ownerOutputIndex: number;
  /** the output_index encoded in the Fill redeemer. PARTIAL: the CONTINUATION's
   *  index — validate_partial_fill reads output_at(output_index) and decodes it
   *  as the relisted OrderDatum, so it MUST point at the continuation, not the
   *  owner. FULL: unused on-chain (validate_full_fill ignores output_index), set
   *  to the owner index. */
  redeemerOutputIndex: number;
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
  /** COMPOSED fills only: the FULL Conway input set (all order spends + funding).
   *  Each leg's redeemer input_index is derived over THIS set, not the per-leg
   *  [orderRef, ...funding]. Defaults to [orderRef, ...fundingInputs]. */
  allInputs?: TxIn[];
  /** COMPOSED fills only: the index in the combined outputs list where THIS leg's
   *  outputs begin. Every output index the redeemer encodes (continuation, receipt)
   *  is offset by this base so it points at the global position. Defaults to 0. */
  outputBaseIndex?: number;
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

  const spendInputs: TxIn[] = args.allInputs ?? [orderRef, ...args.fundingInputs];
  const inputIndex = inputIndexOf(spendInputs, orderRef);
  if (inputIndex < 0) throw new Error("order input not in spend-input set");

  const outputBase = args.outputBaseIndex ?? 0;
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
  const ownerOutputIndex = outputBase;

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
  // The Fill redeemer's output_index. On a partial fill the validator reads it
  // as the CONTINUATION (output_at(output_index) decoded as OrderDatum), so it
  // must be the continuation's actual index — NOT ownerOutputIndex. On a full
  // fill it is ignored on-chain, so the owner index is a fine default.
  let redeemerOutputIndex = ownerOutputIndex;

  // continuation (partial) or beacon burn (full)
  if (plan.kind === "partial") {
    const contDatum: OrderDatumV4 = {
      ...order.datum,
      amountSell: plan.continuation!.newAmountSell,
      amountBuy: plan.continuation!.newAmountBuy,
      outputReference: orderRef,
    };
    redeemerOutputIndex = outputBase + outputs.length; // the continuation is appended next
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
    const receiptOutputIndex = outputBase + outputs.length;
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
    spendRedeemerHex: plutusToHex(fillRedeemer(args.buyAmount, inputIndex, redeemerOutputIndex)),
    outputs,
    ownerOutputIndex,
    redeemerOutputIndex,
    mints,
    refInputs,
    validToUnixMs: order.datum.validBeforeTime !== null ? Number(order.datum.validBeforeTime) - 1 : null,
  };
}

/** An order UTxO the tx spends, with its Plutus redeemer and canonical sort. */
export interface SpendLeg {
  orderRef: OutputRef;
  redeemerHex: string;
  inputIndex: number;
  spendInputs: TxIn[];
}

export interface AssembleV4TxArgs {
  lucid: LucidEvolution;
  changeAddress: string;
  collateralUtxo: UTxO;
  fundingUtxos: UTxO[];
  refInputs: OutputRef[];
  outputs: RecipeOutput[];
  mints: RecipeMintGroup[];
  validToUnixMs: number | null;
  /** stake key hash to add to required_signers (owner-authorized cancel/reprice) */
  requiredStakeKeyHash?: string;
  /** order spends: one leg per order UTxO consumed. Empty/absent for create.
   *  A single fill/cancel/reprice/two-way swap passes one leg; a composed
   *  multi-fill passes several (each with its own redeemer + full-set index). */
  spends?: SpendLeg[];
}

/**
 * The shared thin @lucid-evolution assembly step every V4 builder runs after its
 * PURE planner has produced the recipe: resolve the reference-script UTxOs (and,
 * for a spend, the order UTxO), attach the redeemer, pay each pre-floored output,
 * apply each mint group, sign-net-zero mint groups skipped, add owner-auth signer,
 * set the ttl, complete, and re-check the order input index against the finalized
 * input sort. Returns the unsigned CBOR the caller signs.
 */
export async function assembleV4Tx(args: AssembleV4TxArgs): Promise<{ unsignedCbor: string; txHash: string }> {
  const { lucid } = args;

  const refUtxos = await lucid.utxosByOutRef(
    args.refInputs.map((r) => ({ txHash: r.txHash, outputIndex: r.outputIndex })),
  );
  if (refUtxos.length !== args.refInputs.length) throw new Error("one or more reference-script UTxOs not found");

  lucid.selectWallet.fromAddress(args.changeAddress, [args.collateralUtxo]);
  let tx = lucid.newTx();

  const spends = args.spends ?? [];
  for (const spend of spends) {
    const { orderRef } = spend;
    const [orderUtxo] = await lucid.utxosByOutRef([{ txHash: orderRef.txHash, outputIndex: orderRef.outputIndex }]);
    if (!orderUtxo) throw new Error(`order UTxO ${orderRef.txHash}#${orderRef.outputIndex} not found`);
    tx = tx.collectFrom([orderUtxo], spend.redeemerHex);
  }
  if (args.fundingUtxos.length > 0) tx = tx.collectFrom(args.fundingUtxos);
  tx = tx.readFrom(refUtxos);

  for (const out of args.outputs) {
    tx = tx.pay.ToAddressWithData(out.addressBech32, { kind: "inline", value: out.inlineDatumHex }, out.assets);
  }
  for (const group of args.mints) {
    if (group.assets.length === 0) continue; // net-zero: the policy does not run
    const bag: Assets = {};
    for (const m of group.assets) bag[m.unit] = m.quantity;
    tx = tx.mintAssets(bag, group.redeemerHex);
  }
  if (args.requiredStakeKeyHash) tx = tx.addSignerKey(args.requiredStakeKeyHash);
  if (args.validToUnixMs !== null) tx = tx.validTo(args.validToUnixMs);

  const signBuilder = await tx.complete({ changeAddress: args.changeAddress, setCollateral: 5_000_000n });
  const unsignedCbor = signBuilder.toCBOR();

  for (const { orderRef, inputIndex, spendInputs } of spends) {
    const finalIndex = sortInputs(spendInputs).findIndex(
      (i) => i.txHash === orderRef.txHash && i.outputIndex === orderRef.outputIndex,
    );
    if (finalIndex !== inputIndex) throw new Error(`spend input_index drift: ${inputIndex} vs ${finalIndex}`);
  }

  return { unsignedCbor, txHash: signBuilder.toHash() };
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
  const { deployment, order } = opts;
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

  const { unsignedCbor, txHash } = await assembleV4Tx({
    lucid: opts.lucid,
    changeAddress,
    collateralUtxo: opts.collateralUtxo,
    fundingUtxos: opts.fundingUtxos,
    refInputs: recipe.refInputs,
    outputs: recipe.outputs,
    mints: recipe.mints,
    validToUnixMs: recipe.validToUnixMs,
    spends: [
      {
        orderRef: order.utxo,
        redeemerHex: recipe.spendRedeemerHex,
        inputIndex: recipe.inputIndex,
        spendInputs: recipe.spendInputs,
      },
    ],
  });

  return { unsignedCbor, txHash, recipe };
}

// ---- composed multi-fill (several one-way order spends in ONE tx) ----
// Fills are permissionless and the pure planner is compose-ready: each leg's
// redeemer input_index is re-derived over the FULL Conway-sorted input set (all
// order spends + funding) and each leg's output indices are offset to their
// global position, so N orders settle atomically in a single transaction.

export interface ComposedFillLeg {
  order: { datum: OrderDatumV4; utxo: OutputRef; scriptValue: ChainValue; address: string };
  buyAmount: bigint;
  mintReceipt?: boolean;
  receiptAddressBech32?: string;
}

export interface PlanComposedTakerFillsV4Args {
  deployment: V4Deployment;
  legs: ComposedFillLeg[];
  /** funding input outrefs shared across all legs (for the full-set sort/index) */
  fundingInputs: TxIn[];
  coinsPerUtxoByte?: bigint;
}

/** A composed recipe: per-leg sub-recipes plus the flattened tx wiring. */
export interface ComposedTakerFillRecipe {
  legs: TakerFillRecipe[];
  /** full Conway input set (all order refs, then funding), pre-sort */
  allInputs: TxIn[];
  spends: SpendLeg[];
  /** every leg's outputs concatenated in leg order (owner/…/continuation) */
  outputs: RecipeOutput[];
  /** mint groups, merged by redeemer (two full-fill burns → one burn group) */
  mints: RecipeMintGroup[];
  refInputs: OutputRef[];
  /** tightest expiry across the legs (min of each leg's validTo), or null */
  validToUnixMs: number | null;
}

/**
 * PURE: compose N one-way fills into one tx recipe. Each leg is planned by
 * planTakerFillV4Tx over the SHARED full input set and a running output offset,
 * so every redeemer's input_index/output_index is globally correct. Mint groups
 * that share a redeemer are merged (net beacon delta preserved).
 */
export function planComposedTakerFillsV4Tx(args: PlanComposedTakerFillsV4Args): ComposedTakerFillRecipe {
  if (args.legs.length === 0) throw new Error("composed fill needs at least one leg");
  const seen = new Set<string>();
  for (const leg of args.legs) {
    const k = `${leg.order.utxo.txHash}#${leg.order.utxo.outputIndex}`;
    if (seen.has(k)) throw new Error(`duplicate order in composed fill: ${k}`);
    seen.add(k);
  }

  const allInputs: TxIn[] = [...args.legs.map((l) => l.order.utxo), ...args.fundingInputs];

  const legs: TakerFillRecipe[] = [];
  const spends: SpendLeg[] = [];
  const outputs: RecipeOutput[] = [];
  const refInputs: OutputRef[] = [args.deployment.spendRefUtxo];
  // group by redeemer, summing per unit: two full fills of the same pair burn -2
  const mintByRedeemer = new Map<string, Map<string, bigint>>();
  let outputBase = 0;
  let validToUnixMs: number | null = null;

  for (const leg of args.legs) {
    const r = planTakerFillV4Tx({
      deployment: args.deployment,
      order: leg.order,
      buyAmount: leg.buyAmount,
      fundingInputs: args.fundingInputs,
      allInputs,
      outputBaseIndex: outputBase,
      mintReceipt: leg.mintReceipt,
      receiptAddressBech32: leg.receiptAddressBech32,
      coinsPerUtxoByte: args.coinsPerUtxoByte,
    });
    legs.push(r);
    outputs.push(...r.outputs);
    spends.push({
      orderRef: leg.order.utxo,
      redeemerHex: r.spendRedeemerHex,
      inputIndex: r.inputIndex,
      spendInputs: allInputs,
    });
    for (const ref of r.refInputs) {
      if (!refInputs.some((x) => x.txHash === ref.txHash && x.outputIndex === ref.outputIndex)) refInputs.push(ref);
    }
    for (const group of r.mints) {
      const bag = mintByRedeemer.get(group.redeemerHex) ?? new Map<string, bigint>();
      for (const m of group.assets) bag.set(m.unit, (bag.get(m.unit) ?? 0n) + m.quantity);
      mintByRedeemer.set(group.redeemerHex, bag);
    }
    outputBase += r.outputs.length;
    if (r.validToUnixMs !== null)
      validToUnixMs = validToUnixMs === null ? r.validToUnixMs : Math.min(validToUnixMs, r.validToUnixMs);
  }

  const mints: RecipeMintGroup[] = [...mintByRedeemer.entries()].map(([redeemerHex, bag]) => ({
    redeemerHex,
    assets: [...bag.entries()].map(([unit, quantity]) => ({ unit, quantity })),
  }));

  return { legs, allInputs, spends, outputs, mints, refInputs, validToUnixMs };
}

export interface BuildComposedTakerFillsV4Options {
  lucid: LucidEvolution;
  deployment: V4Deployment;
  legs: ComposedFillLeg[];
  fundingUtxos: UTxO[];
  collateralUtxo: UTxO;
  changeAddress?: string;
  coinsPerUtxoByte?: bigint;
}

export interface ComposedTakerFillsV4Result {
  unsignedCbor: string;
  txHash: string;
  recipe: ComposedTakerFillRecipe;
}

/** Thin @lucid-evolution assembler over planComposedTakerFillsV4Tx: N atomic fills. */
export async function buildComposedTakerFillsV4(opts: BuildComposedTakerFillsV4Options): Promise<ComposedTakerFillsV4Result> {
  const changeAddress = opts.changeAddress ?? opts.collateralUtxo.address;
  const recipe = planComposedTakerFillsV4Tx({
    deployment: opts.deployment,
    legs: opts.legs,
    fundingInputs: opts.fundingUtxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
    coinsPerUtxoByte: opts.coinsPerUtxoByte,
  });
  const { unsignedCbor, txHash } = await assembleV4Tx({
    lucid: opts.lucid,
    changeAddress,
    collateralUtxo: opts.collateralUtxo,
    fundingUtxos: opts.fundingUtxos,
    refInputs: recipe.refInputs,
    outputs: recipe.outputs,
    mints: recipe.mints,
    validToUnixMs: recipe.validToUnixMs,
    spends: recipe.spends,
  });
  return { unsignedCbor, txHash, recipe };
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
