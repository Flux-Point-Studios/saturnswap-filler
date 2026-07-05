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
import { V4_MAINNET_COINS_PER_UTXO_BYTE, type V4Deployment, type RecipeOutput, type RecipeMintGroup } from "./fillV4.js";
import { orderAddressFor, type LifecycleRecipe } from "./lifecycleV4.js";
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
  /** the two-way datum to post (beaconPolicy = deployment.beaconPolicy; the pair
   *  MUST be lexicographically sorted asset1 < asset2 — validated here) */
  datum: TwoWayOrderDatumV4;
  makerStake: Credential;
  /** initial reserves to lock (must include >= 1 of at least one paired asset) */
  reserves: ChainValue;
  depositLovelace?: bigint;
  coinsPerUtxoByte?: bigint;
}

export function planCreateTwoWayOrderV4Tx(args: PlanCreateTwoWayOrderV4Args): LifecycleRecipe {
  const { deployment, datum } = args;
  const cpb = args.coinsPerUtxoByte ?? V4_MAINNET_COINS_PER_UTXO_BYTE;
  if (datum.beaconPolicy !== deployment.beaconPolicy) throw new Error("datum.beaconPolicy must equal deployment.beaconPolicy");
  if (compareAsset(datum.policyId1, datum.assetName1, datum.policyId2, datum.assetName2) >= 0)
    throw new Error("pair must be strictly sorted (asset1 < asset2)");
  if (datum.price1Num <= 0n || datum.price1Den <= 0n || datum.price2Num <= 0n || datum.price2Den <= 0n)
    throw new Error("all prices must be > 0");

  const orderAddress = orderAddressFor(deployment, args.makerStake);
  const pairName = sortedPairBeaconName(datum.policyId1, datum.assetName1, datum.policyId2, datum.assetName2);
  const offer1 = offerBeaconName(datum.policyId1, datum.assetName1);
  const offer2 = offerBeaconName(datum.policyId2, datum.assetName2);

  // reserves + deposit + 3 beacons; require >=1 of at least one paired asset
  const value = chainValueToAssets(args.reserves);
  value["lovelace"] = (value["lovelace"] ?? 0n) + (args.depositLovelace ?? 2_000_000n);
  const has1 = qty(value, datum.policyId1, datum.assetName1) > 0n;
  const has2 = qty(value, datum.policyId2, datum.assetName2) > 0n;
  if (!has1 && !has2) throw new Error("two-way order needs non-zero inventory of at least one paired asset");
  value[deployment.beaconPolicy + pairName] = 1n;
  value[deployment.beaconPolicy + offer1] = 1n;
  value[deployment.beaconPolicy + offer2] = 1n;

  const datumHex = plutusToHex(twoWayDatumToPlutusData(datumForBuilder(datum)));
  return {
    action: "create",
    outputs: [{ role: "continuation", addressBech32: orderAddress, assets: floorMinUtxo(value, orderAddress, cpb, datumHex), inlineDatumHex: datumHex }],
    mints: [
      {
        redeemerHex: plutusToHex(beaconCreateOrClose),
        assets: [
          { unit: deployment.beaconPolicy + pairName, quantity: 1n },
          { unit: deployment.beaconPolicy + offer1, quantity: 1n },
          { unit: deployment.beaconPolicy + offer2, quantity: 1n },
        ],
      },
    ],
    refInputs: [deployment.beaconRefUtxo],
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
  const refInputs: OutputRef[] = [deployment.spendRefUtxo];

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
