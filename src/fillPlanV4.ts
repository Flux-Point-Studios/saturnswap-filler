// V4 fill/swap planners — pure functions that compute the exact value flows a
// taker transaction must produce, matching the on-chain validators
// (lib/saturn_swap_v4/validation.ak, two_way_validation.ak). The planner does
// NOT assemble a Lucid tx (that is environment-specific); it returns the
// quantities and datums a builder needs, so it is fully unit-testable and can
// be cross-checked against the Aiken numbers.
//
// Value model reuses ChainValue { lovelace, assets: unit->qty } from discovery.

import type { ChainValue } from "./discovery.js";
import { unit } from "./discovery.js";
import type { OrderDatumV4, TwoWayOrderDatumV4 } from "./datumV4.js";
import {
  ratioReleased,
  requiredDeposit,
  feeAmount,
  coveragePremium,
} from "./ratioV4.js";
import { pairBeaconName, offerBeaconName, askBeaconName, sortedPairBeaconName } from "./beaconsV4.js";

// ---- value helpers ----

function emptyValue(): ChainValue {
  return { lovelace: 0n, assets: {} };
}
function cloneValue(v: ChainValue): ChainValue {
  return { lovelace: v.lovelace, assets: { ...v.assets } };
}
/** Add `qty` (may be negative) of an asset. ADA = empty policy => lovelace. */
export function addAsset(v: ChainValue, policyId: string, assetName: string, qty: bigint): ChainValue {
  const out = cloneValue(v);
  if (policyId === "") {
    out.lovelace += qty;
  } else {
    const u = unit(policyId, assetName);
    const next = (out.assets[u] ?? 0n) + qty;
    if (next === 0n) delete out.assets[u];
    else out.assets[u] = next;
  }
  return out;
}
export function quantityOf(v: ChainValue, policyId: string, assetName: string): bigint {
  if (policyId === "") return v.lovelace;
  return v.assets[unit(policyId, assetName)] ?? 0n;
}
function singletonValue(policyId: string, assetName: string, qty: bigint): ChainValue {
  return addAsset(emptyValue(), policyId, assetName, qty);
}

// ---- one-way fill plan ----

export interface FeeLeg {
  /** value to pay to the deployment's fee_address, tagged PaymentDatum(orderRef) */
  value: ChainValue;
}
export interface CoverageLeg {
  /** vault address hex (from the order's coverage) and the premium value (buy asset) */
  premium: ChainValue;
}

export interface FillPlanV4 {
  kind: "full" | "partial";
  /** sell asset released to the taker */
  released: bigint;
  /** buy asset the taker must deliver to the owner */
  buyAmount: bigint;
  /** minimum value the owner output must contain (tagged PaymentDatum(orderRef)).
   *  Floor to ledger min-UTxO before building. */
  ownerPayout: ChainValue;
  /** partial fill only: the continuation order back to the script */
  continuation?: { newAmountSell: bigint; newAmountBuy: bigint; value: ChainValue };
  /** Model-A protocol fee leg (absent when feePercentBps <= 0 / Model B) */
  fee?: FeeLeg;
  /** Aegis coverage premium leg (absent when the order has no coverage) */
  coverage?: CoverageLeg;
}

/**
 * Compute the value flows for filling a one-way order.
 *
 * @param order       the decoded on-chain order datum
 * @param scriptValue the order UTxO's current value (must hold the 3 beacons,
 *                    the deposit/min-ADA, and amount_sell of the sell asset)
 * @param buyAmount   buy asset the taker delivers (0 < buyAmount <= amount_buy)
 * @param feePercentBps deployment fee (0 = Model B); 100 = 1%
 */
export function computeFillPlanV4(
  order: OrderDatumV4,
  scriptValue: ChainValue,
  buyAmount: bigint,
  feePercentBps: number,
): FillPlanV4 {
  if (buyAmount <= 0n) throw new Error("buyAmount must be > 0");
  if (buyAmount > order.amountBuy) throw new Error("buyAmount exceeds amount_buy");

  const released = ratioReleased(order.amountSell, order.amountBuy, buyAmount);
  if (released < 1n) throw new Error("fill releases nothing (dust); increase buyAmount");
  if (buyAmount < order.amountBuy && buyAmount < order.minPartialFill)
    throw new Error("partial fill below min_partial_fill");

  const isFull = buyAmount === order.amountBuy;

  const pairName = pairBeaconName(order.policyIdSell, order.assetNameSell, order.policyIdBuy, order.assetNameBuy);
  const offerName = offerBeaconName(order.policyIdSell, order.assetNameSell);
  const askName = askBeaconName(order.policyIdBuy, order.assetNameBuy);

  const fee: FeeLeg | undefined =
    feePercentBps > 0
      ? { value: singletonValue(order.policyIdSell, order.assetNameSell, feeAmount(released, feePercentBps)) }
      : undefined;

  const coverage: CoverageLeg | undefined = order.coverage
    ? { premium: singletonValue(order.policyIdBuy, order.assetNameBuy, coveragePremium(buyAmount, order.coverage.premiumBps)) }
    : undefined;

  if (isFull) {
    // owner receives everything except the sold asset and the 3 beacons,
    // plus buyAmount of the buy asset (validator: value_geq(owner_paid,
    // own_value - amount_sell(sell) - 3 beacons + buy_amount(buy)))
    let ownerPayout = cloneValue(scriptValue);
    ownerPayout = addAsset(ownerPayout, order.policyIdSell, order.assetNameSell, -order.amountSell);
    ownerPayout = addAsset(ownerPayout, order.beaconPolicy, pairName, -1n);
    ownerPayout = addAsset(ownerPayout, order.beaconPolicy, offerName, -1n);
    ownerPayout = addAsset(ownerPayout, order.beaconPolicy, askName, -1n);
    ownerPayout = addAsset(ownerPayout, order.policyIdBuy, order.assetNameBuy, buyAmount);
    return { kind: "full", released, buyAmount, ownerPayout, fee, coverage };
  }

  // partial: continuation returns to script minus the released sell asset;
  // beacons + deposit stay. Owner gets buyAmount of the buy asset.
  const continuationValue = addAsset(scriptValue, order.policyIdSell, order.assetNameSell, -released);
  const ownerPayout = singletonValue(order.policyIdBuy, order.assetNameBuy, buyAmount);
  return {
    kind: "partial",
    released,
    buyAmount,
    ownerPayout,
    continuation: {
      newAmountSell: order.amountSell - released,
      newAmountBuy: order.amountBuy - buyAmount,
      value: continuationValue,
    },
    fee,
    coverage,
  };
}

// ---- two-way swap plan ----

export interface SwapPlanV4 {
  /** true = taker withdraws asset1 and deposits asset2; false = the reverse */
  takeAsset1: boolean;
  /** asset withdrawn from the reserves */
  takeAmount: bigint;
  /** asset the taker must deposit (priced, ceil-rounded toward the maker) */
  deposit: bigint;
  /** continuation reserves back to the script (datum unchanged bar the ref) */
  continuationValue: ChainValue;
  /** Model-A fee leg on the TAKEN asset (absent under Model B) */
  fee?: FeeLeg;
}

/**
 * Compute the value flow for a two-way (market-maker) swap.
 *
 * @param order       decoded two-way datum
 * @param scriptValue the reserve UTxO's current value
 * @param takeAsset1  direction
 * @param takeAmount  amount of the out-asset to withdraw
 * @param feePercentBps deployment fee (0 = Model B)
 */
export function computeSwapPlanV4(
  order: TwoWayOrderDatumV4,
  scriptValue: ChainValue,
  takeAsset1: boolean,
  takeAmount: bigint,
  feePercentBps: number,
): SwapPlanV4 {
  if (takeAmount <= 0n) throw new Error("takeAmount must be > 0");

  const outPolicy = takeAsset1 ? order.policyId1 : order.policyId2;
  const outName = takeAsset1 ? order.assetName1 : order.assetName2;
  const inPolicy = takeAsset1 ? order.policyId2 : order.policyId1;
  const inName = takeAsset1 ? order.assetName2 : order.assetName1;
  const num = takeAsset1 ? order.price1Num : order.price2Num;
  const den = takeAsset1 ? order.price1Den : order.price2Den;
  const minTake = takeAsset1 ? order.minTake1 : order.minTake2;

  const available = quantityOf(scriptValue, outPolicy, outName);
  if (takeAmount > available) throw new Error("takeAmount exceeds available reserve");
  if (takeAmount < minTake && takeAmount !== available)
    throw new Error("takeAmount below min_take (and not a full drain)");

  const deposit = requiredDeposit(takeAmount, num, den);
  if (deposit < 1n) throw new Error("deposit rounds to zero; increase takeAmount");

  let continuationValue = addAsset(scriptValue, outPolicy, outName, -takeAmount);
  continuationValue = addAsset(continuationValue, inPolicy, inName, deposit);

  const fee: FeeLeg | undefined =
    feePercentBps > 0
      ? { value: singletonValue(outPolicy, outName, feeAmount(takeAmount, feePercentBps)) }
      : undefined;

  return { takeAsset1, takeAmount, deposit, continuationValue, fee };
}

// ---- discovery of the sorted two-way beacon (helper for builders) ----

export function twoWayBeaconNames(order: TwoWayOrderDatumV4): {
  pair: string;
  offer1: string;
  offer2: string;
} {
  return {
    pair: sortedPairBeaconName(order.policyId1, order.assetName1, order.policyId2, order.assetName2),
    offer1: offerBeaconName(order.policyId1, order.assetName1),
    offer2: offerBeaconName(order.policyId2, order.assetName2),
  };
}
