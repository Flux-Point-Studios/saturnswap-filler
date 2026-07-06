// V4 two-way (market-maker) order recipe planners (PURE): create a two-way
// order, and take a two-way swap. Same recipe shape as the one-way builders.
//
// Two-way orders are reserve-based: a swap deposits the priced asset into the
// continuation (the maker's inventory) and withdraws the other — no payout
// outputs, and the datum is unchanged except its output_reference link.

import type { TwoWayOrderDatumV4 } from "./datumV4.js";
import { twoWayDatumToPlutusData, twoWaySwapRedeemer, beaconCreateOrClose, paymentDatumV4 } from "./datumV4.js";
import { sortedPairBeaconName, offerBeaconName, compareAsset } from "./beaconsV4.js";
import { plutusToHex } from "./plutus.js";
import { computeSwapPlanV4 } from "./fillPlanV4.js";
import type { ChainValue } from "./discovery.js";
import { inputIndexOf, type TxIn } from "./sort.js";
import { minUtxoLovelace } from "./minUtxo.js";
import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import {
  V4_MAINNET_COINS_PER_UTXO_BYTE,
  assembleV4Tx,
  type V4Deployment,
  type RecipeOutput,
  type RecipeMintGroup,
} from "./fillV4.js";
import { twoWayOrderAddressFor, type LifecycleRecipe } from "./lifecycleV4.js";
import type { OutputRef, Credential } from "./datum.js";

function chainValueToAssets(v: ChainValue): Record<string, bigint> {
  const out: Record<string, bigint> = { lovelace: v.lovelace };
  for (const [u, amt] of Object.entries(v.assets)) if (amt !== 0n) out[u] = amt;
  return out;
}
function floorMinUtxo(a: Record<string, bigint>, addr: string, cpb: bigint, datum?: string): Record<string, bigint> {
  const sizing: Record<string, bigint> = { ...a };
  if (!sizing["lovelace"] || sizing["lovelace"] < 1_000_000n) sizing["lovelace"] = 2_000_000n;
  const floor = minUtxoLovelace({ addressBech32: addr, assets: sizing, inlineDatumHex: datum }, cpb);
  const cur = a["lovelace"] ?? 0n;
  return { ...a, lovelace: cur > floor ? cur : floor };
}
function datumForBuilder(d: TwoWayOrderDatumV4) {
  return {
    beaconPolicy: d.beaconPolicy,
    owner: d.owner,
    policyId1: d.policyId1,
    assetName1: d.assetName1,
    policyId2: d.policyId2,
    assetName2: d.assetName2,
    price1Num: d.price1Num,
    price1Den: d.price1Den,
    price2Num: d.price2Num,
    price2Den: d.price2Den,
    validBeforeTime: d.validBeforeTime,
    minTake1: d.minTake1,
    minTake2: d.minTake2,
    outputReference: d.outputReference,
  };
}

// ---- create two-way order ----

export interface PlanCreateTwoWayOrderV4Args {
  deployment: V4Deployment;
  /** the two-way datum to post. Its beaconPolicy is OVERRIDDEN to the deployment's
   *  ammPolicy (P_amm) — two-way beacons live under the AMM policy, never P_limit.
   *  The pair MUST be lexicographically sorted asset1 < asset2 (validated here). */
  datum: TwoWayOrderDatumV4;
  makerStake: Credential;
  /** initial reserves to lock (must include >= 1 of at least one paired asset) */
  reserves: ChainValue;
  depositLovelace?: bigint;
  coinsPerUtxoByte?: bigint;
}

export function planCreateTwoWayOrderV4Tx(args: PlanCreateTwoWayOrderV4Args): LifecycleRecipe {
  const { deployment } = args;
  const cpb = args.coinsPerUtxoByte ?? V4_MAINNET_COINS_PER_UTXO_BYTE;
  if (!deployment.twoWayScriptHash || !deployment.ammPolicy || !deployment.ammRefUtxo)
    throw new Error("two-way create requires deployment.twoWayScriptHash + ammPolicy + ammRefUtxo");
  // Two-way beacons mint under the AMM policy — pin the datum's beaconPolicy to it
  // so the posted order self-describes the P_amm book (never the P_limit slot).
  const ammPolicy = deployment.ammPolicy;
  const datum: TwoWayOrderDatumV4 = { ...args.datum, beaconPolicy: ammPolicy };
  if (compareAsset(datum.policyId1, datum.assetName1, datum.policyId2, datum.assetName2) >= 0)
    throw new Error("pair must be strictly sorted (asset1 < asset2)");
  if (datum.price1Num <= 0n || datum.price1Den <= 0n || datum.price2Num <= 0n || datum.price2Den <= 0n)
    throw new Error("all prices must be > 0");

  const orderAddress = twoWayOrderAddressFor(deployment, args.makerStake);
  const pairName = sortedPairBeaconName(datum.policyId1, datum.assetName1, datum.policyId2, datum.assetName2);
  const offer1 = offerBeaconName(datum.policyId1, datum.assetName1);
  const offer2 = offerBeaconName(datum.policyId2, datum.assetName2);

  // reserves + deposit + 3 beacons; require >=1 of at least one paired asset
  const value = chainValueToAssets(args.reserves);
  value["lovelace"] = (value["lovelace"] ?? 0n) + (args.depositLovelace ?? 2_000_000n);
  const has1 = qty(value, datum.policyId1, datum.assetName1) > 0n;
  const has2 = qty(value, datum.policyId2, datum.assetName2) > 0n;
  if (!has1 && !has2) throw new Error("two-way order needs non-zero inventory of at least one paired asset");
  value[ammPolicy + pairName] = 1n;
  value[ammPolicy + offer1] = 1n;
  value[ammPolicy + offer2] = 1n;

  const datumHex = plutusToHex(twoWayDatumToPlutusData(datumForBuilder(datum)));
  return {
    action: "create",
    outputs: [{ role: "continuation", addressBech32: orderAddress, assets: floorMinUtxo(value, orderAddress, cpb, datumHex), inlineDatumHex: datumHex }],
    mints: [
      {
        redeemerHex: plutusToHex(beaconCreateOrClose),
        assets: [
          { unit: ammPolicy + pairName, quantity: 1n },
          { unit: ammPolicy + offer1, quantity: 1n },
          { unit: ammPolicy + offer2, quantity: 1n },
        ],
      },
    ],
    refInputs: [deployment.ammRefUtxo],
    validToUnixMs: null,
  };
}

function qty(v: Record<string, bigint>, policy: string, name: string): bigint {
  return policy === "" ? v["lovelace"] ?? 0n : v[policy + name] ?? 0n;
}

// ---- two-way swap (taker) ----

export interface TwoWaySwapRecipe {
  action: "swap";
  outputs: RecipeOutput[];
  mints: RecipeMintGroup[];
  refInputs: OutputRef[];
  spend: { orderRef: OutputRef; redeemerHex: string; inputIndex: number; spendInputs: TxIn[] };
  validToUnixMs: number | null;
}

export interface PlanTwoWaySwapV4Args {
  deployment: V4Deployment;
  order: { datum: TwoWayOrderDatumV4; utxo: OutputRef; scriptValue: ChainValue; address: string };
  /** true = withdraw asset1, deposit asset2; false = the reverse */
  takeAsset1: boolean;
  takeAmount: bigint;
  fundingInputs: TxIn[];
  coinsPerUtxoByte?: bigint;
}

/**
 * PURE: recipe to take a two-way swap. Spends the order (Swap), returns a
 * continuation with reserves rebalanced by computeSwapPlanV4 (out-asset
 * withdrawn, priced deposit added), datum unchanged bar the output_reference.
 */
export function planTwoWaySwapV4Tx(args: PlanTwoWaySwapV4Args): TwoWaySwapRecipe {
  const { deployment, order } = args;
  const cpb = args.coinsPerUtxoByte ?? V4_MAINNET_COINS_PER_UTXO_BYTE;
  if (!deployment.twoWaySpendRefUtxo) throw new Error("two-way swap requires deployment.twoWaySpendRefUtxo");
  const orderRef = order.utxo;

  const plan = computeSwapPlanV4(order.datum, order.scriptValue, args.takeAsset1, args.takeAmount, deployment.feePercentBps);

  const spendInputs: TxIn[] = [orderRef, ...args.fundingInputs];
  const inputIndex = inputIndexOf(spendInputs, orderRef);
  if (inputIndex < 0) throw new Error("order input not in spend-input set");

  // continuation datum: identical bar the relist-chain link
  const contDatum: TwoWayOrderDatumV4 = { ...order.datum, outputReference: orderRef };
  const contDatumHex = plutusToHex(twoWayDatumToPlutusData(datumForBuilder(contDatum)));
  const contAssets = chainValueToAssets(plan.continuationValue);

  const outputs: RecipeOutput[] = [
    { role: "continuation", addressBech32: order.address, assets: contAssets, inlineDatumHex: contDatumHex },
  ];

  const mints: RecipeMintGroup[] = [];
  const refInputs: OutputRef[] = [deployment.twoWaySpendRefUtxo];

  // Model-A fee leg (in the TAKEN asset) — the two-way validator checks it via
  // a tagged fee output; deployment feePercentBps=0 (Model B) omits it.
  if (plan.fee) {
    const feeDatumHex = plutusToHex(paymentDatumV4(orderRef));
    const feeAssets = floorMinUtxo(chainValueToAssets(plan.fee.value), deployment.feeAddressBech32, cpb, feeDatumHex);
    outputs.push({ role: "fee", addressBech32: deployment.feeAddressBech32, assets: feeAssets, inlineDatumHex: feeDatumHex });
  }

  return {
    action: "swap",
    outputs,
    mints,
    refInputs,
    spend: {
      orderRef,
      redeemerHex: plutusToHex(twoWaySwapRedeemer(args.takeAsset1, args.takeAmount, inputIndex, 0)),
      inputIndex,
      spendInputs,
    },
    validToUnixMs: order.datum.validBeforeTime !== null ? Number(order.datum.validBeforeTime) - 1 : null,
  };
}

// ---- thin @lucid-evolution assemblers over the two-way planners ----

export interface BuildCreateTwoWayOrderV4Options {
  lucid: LucidEvolution;
  deployment: V4Deployment;
  datum: TwoWayOrderDatumV4;
  makerStake: Credential;
  reserves: ChainValue;
  fundingUtxos: UTxO[];
  collateralUtxo: UTxO;
  changeAddress?: string;
  depositLovelace?: bigint;
  coinsPerUtxoByte?: bigint;
}

export interface CreateTwoWayOrderV4Result {
  unsignedCbor: string;
  txHash: string;
  recipe: LifecycleRecipe;
}

/** Assemble a create-two-way-order tx (mints the sorted-pair + 2 offer beacons). */
export async function buildCreateTwoWayOrderV4(opts: BuildCreateTwoWayOrderV4Options): Promise<CreateTwoWayOrderV4Result> {
  const changeAddress = opts.changeAddress ?? opts.collateralUtxo.address;
  const recipe = planCreateTwoWayOrderV4Tx({
    deployment: opts.deployment,
    datum: opts.datum,
    makerStake: opts.makerStake,
    reserves: opts.reserves,
    depositLovelace: opts.depositLovelace,
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
    requiredStakeKeyHash: recipe.requiredStakeKeyHash,
  });
  return { unsignedCbor, txHash, recipe };
}

export interface BuildTwoWaySwapV4Options {
  lucid: LucidEvolution;
  deployment: V4Deployment;
  order: { datum: TwoWayOrderDatumV4; utxo: OutputRef; scriptValue: ChainValue; address: string };
  takeAsset1: boolean;
  takeAmount: bigint;
  fundingUtxos: UTxO[];
  collateralUtxo: UTxO;
  changeAddress?: string;
  coinsPerUtxoByte?: bigint;
}

export interface TwoWaySwapV4Result {
  unsignedCbor: string;
  txHash: string;
  recipe: TwoWaySwapRecipe;
}

/** Assemble a two-way swap tx (net-zero beacons; reserves rebalanced per the plan). */
export async function buildTwoWaySwapV4(opts: BuildTwoWaySwapV4Options): Promise<TwoWaySwapV4Result> {
  const changeAddress = opts.changeAddress ?? opts.collateralUtxo.address;
  const recipe = planTwoWaySwapV4Tx({
    deployment: opts.deployment,
    order: opts.order,
    takeAsset1: opts.takeAsset1,
    takeAmount: opts.takeAmount,
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
    spends: [recipe.spend],
  });
  return { unsignedCbor, txHash, recipe };
}
