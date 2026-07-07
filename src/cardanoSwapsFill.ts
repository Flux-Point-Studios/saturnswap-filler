// Canonical cardano-swaps taker fill (permissionless): spend a resting swap UTxO
// with the nullary Swap / TakeAsset1 / TakeAsset2 redeemer and produce ONE
// continuation output to the SAME swap address, datum identical to the input's
// except prev_input = Some(input_ref), value = old - offer_taken + ask_given.
//
// There is NO mint, NO fee output, NO premium output, and the fill is INDEX-FREE
// (the validator finds the continuation by a datum-scan on prev_input, not by an
// index). cardanoSwapsComposable returns the { fill, tokenDelta, outflow } shape the
// guard router consumes for its Cardano-Swaps venue (guard-tx-builder ComposableFill).

import type { UTxO } from "@lucid-evolution/lucid";
import { type ChainValue, type RawUtxo, unit } from "./discovery.js";
import type { OutputRef } from "./datum.js";
import { askGivenFor, priceOk, type Rational } from "./cardanoSwapsRatio.js";
import {
  encodeOneWaySwapDatumHex,
  encodeTwoWaySwapDatumHex,
  SWAP_REDEEMER_HEX,
  TAKE_ASSET1_REDEEMER_HEX,
  TAKE_ASSET2_REDEEMER_HEX,
  type OneWaySwapDatum,
  type TwoWaySwapDatum,
} from "./cardanoSwapsDatum.js";

/** Accounting buffer for the maker/continuation min-UTxO the guard funds beyond the
 *  traded amount (parallels the guard's V3 delta headroom). */
export const CARDANO_SWAPS_MIN_UTXO_HEADROOM = 2_000_000n;

/**
 * One venue-agnostic fill in a composed guard tx — structurally the guard's
 * ComposableFill (guard-tx-builder.ts). A canonical fill uses a FIXED redeemer
 * (the nullary Swap / TakeAsset*) and never mints.
 */
export interface ComposableFill {
  input: UTxO;
  redeemer: string | ((inputIndex: number, firstOutputIndex: number) => string);
  outputs: Array<{ address: string; datum: string; value: Record<string, bigint> }>;
  mints?: Array<{ assets: Record<string, bigint>; redeemer: string }>;
}

export interface OneWayOrder {
  kind: "one-way";
  utxo: OutputRef;
  address: string; // the order's own swap address (continuation returns here)
  datum: OneWaySwapDatum;
  scriptValue: ChainValue;
  raw?: RawUtxo;
}

export interface TwoWayOrder {
  kind: "two-way";
  utxo: OutputRef;
  address: string;
  datum: TwoWaySwapDatum;
  scriptValue: ChainValue;
  raw?: RawUtxo;
}

// ---- value helpers ----

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

export function chainValueToAssets(v: ChainValue): Record<string, bigint> {
  const out: Record<string, bigint> = { lovelace: v.lovelace };
  for (const [u, amt] of Object.entries(v.assets)) if (amt !== 0n) out[u] = amt;
  return out;
}

export function assetsToChainValue(a: Record<string, bigint>): ChainValue {
  const assets: Record<string, bigint> = {};
  let lovelace = 0n;
  for (const [k, v] of Object.entries(a)) {
    if (k === "lovelace") lovelace = v;
    else if (v !== 0n) assets[k] = v;
  }
  return { lovelace, assets };
}

// ---- guard accounting ----

/**
 * The guard's net effect as the taker of a canonical swap: it GAINS `offerTaken` of
 * the offer asset and SPENDS `askGiven` of the ask asset. ADA legs fold into the net
 * ADA `outflow` (negative = a gain), token legs into `tokenDelta`. Reduces to the V3/V4
 * guard-delta model for ADA pairs and generalises to token↔token pairs.
 */
export function takerGuardDelta(
  offer: { policyId: string; assetName: string },
  offerTaken: bigint,
  ask: { policyId: string; assetName: string },
  askGiven: bigint,
  headroom: bigint = CARDANO_SWAPS_MIN_UTXO_HEADROOM,
): { tokenDelta: Record<string, bigint>; outflow: bigint } {
  const tokenDelta: Record<string, bigint> = {};
  if (offer.policyId !== "") tokenDelta[unit(offer.policyId, offer.assetName)] = offerTaken; // gained
  if (ask.policyId !== "") tokenDelta[unit(ask.policyId, ask.assetName)] = -askGiven; // spent
  const askAda = ask.policyId === "" ? askGiven : 0n;
  const offerAda = offer.policyId === "" ? offerTaken : 0n;
  return { tokenDelta, outflow: askAda - offerAda + headroom };
}

// ---- one-way fill ----

export interface OneWayFill {
  offerTaken: bigint;
  askGiven: bigint;
  continuationValue: ChainValue;
  continuationDatum: OneWaySwapDatum;
}

export function computeOneWayFill(order: OneWayOrder, offerTaken: bigint): OneWayFill {
  if (offerTaken <= 0n) throw new Error("offerTaken must be > 0");
  const d = order.datum;
  const available = quantityOf(order.scriptValue, d.offerId, d.offerName);
  if (offerTaken > available) throw new Error("offerTaken exceeds the offer held by the swap UTxO");

  const askGiven = askGivenFor(offerTaken, d.price);
  if (!priceOk(offerTaken, askGiven, d.price)) throw new Error("computed askGiven fails the on-chain price check");

  let continuationValue = addAsset(order.scriptValue, d.offerId, d.offerName, -offerTaken);
  continuationValue = addAsset(continuationValue, d.askId, d.askName, askGiven);
  const continuationDatum: OneWaySwapDatum = { ...d, prevInput: order.utxo };
  return { offerTaken, askGiven, continuationValue, continuationDatum };
}

export interface CardanoSwapsComposableArgs {
  order: OneWayOrder;
  orderUtxo: UTxO;
  offerTaken: bigint;
}

export interface CardanoSwapsComposableResult {
  fill: ComposableFill;
  tokenDelta: Record<string, bigint>;
  outflow: bigint;
}

/** One-way canonical fill → ComposableFill (single continuation, nullary Swap, no mint). */
export function cardanoSwapsComposable(args: CardanoSwapsComposableArgs): CardanoSwapsComposableResult {
  const { order, orderUtxo, offerTaken } = args;
  const f = computeOneWayFill(order, offerTaken);
  const fill: ComposableFill = {
    input: orderUtxo,
    redeemer: SWAP_REDEEMER_HEX,
    outputs: [
      {
        address: order.address,
        datum: encodeOneWaySwapDatumHex(f.continuationDatum),
        value: chainValueToAssets(f.continuationValue),
      },
    ],
  };
  const { tokenDelta, outflow } = takerGuardDelta(
    { policyId: order.datum.offerId, assetName: order.datum.offerName },
    f.offerTaken,
    { policyId: order.datum.askId, assetName: order.datum.askName },
    f.askGiven,
  );
  return { fill, tokenDelta, outflow };
}

// ---- two-way fill ----

export interface TwoWayFill {
  takingAsset2: boolean;
  takeAmount: bigint;
  deposit: bigint;
  continuationValue: ChainValue;
  continuationDatum: TwoWaySwapDatum;
}

/** Take one side of a two-way order: takingAsset2 → take asset2, deposit asset1 at
 *  asset2_price; else take asset1, deposit asset2 at asset1_price. */
export function computeTwoWayFill(order: TwoWayOrder, takingAsset2: boolean, takeAmount: bigint): TwoWayFill {
  if (takeAmount <= 0n) throw new Error("takeAmount must be > 0");
  const d = order.datum;
  const offer = takingAsset2
    ? { policyId: d.asset2Id, assetName: d.asset2Name }
    : { policyId: d.asset1Id, assetName: d.asset1Name };
  const ask = takingAsset2
    ? { policyId: d.asset1Id, assetName: d.asset1Name }
    : { policyId: d.asset2Id, assetName: d.asset2Name };
  const price: Rational = takingAsset2 ? d.asset2Price : d.asset1Price;

  const available = quantityOf(order.scriptValue, offer.policyId, offer.assetName);
  if (takeAmount > available) throw new Error("takeAmount exceeds the reserve held by the swap UTxO");

  const deposit = askGivenFor(takeAmount, price);
  if (!priceOk(takeAmount, deposit, price)) throw new Error("computed deposit fails the on-chain price check");

  let continuationValue = addAsset(order.scriptValue, offer.policyId, offer.assetName, -takeAmount);
  continuationValue = addAsset(continuationValue, ask.policyId, ask.assetName, deposit);
  const continuationDatum: TwoWaySwapDatum = { ...d, prevInput: order.utxo };
  return { takingAsset2, takeAmount, deposit, continuationValue, continuationDatum };
}

export interface CardanoSwapsTwoWayComposableArgs {
  order: TwoWayOrder;
  orderUtxo: UTxO;
  takingAsset2: boolean;
  takeAmount: bigint;
}

/** Two-way canonical fill → ComposableFill (single continuation, nullary TakeAsset*, no mint). */
export function cardanoSwapsTwoWayComposable(args: CardanoSwapsTwoWayComposableArgs): CardanoSwapsComposableResult {
  const { order, orderUtxo, takingAsset2, takeAmount } = args;
  const f = computeTwoWayFill(order, takingAsset2, takeAmount);
  const d = order.datum;
  const offer = takingAsset2
    ? { policyId: d.asset2Id, assetName: d.asset2Name }
    : { policyId: d.asset1Id, assetName: d.asset1Name };
  const ask = takingAsset2
    ? { policyId: d.asset1Id, assetName: d.asset1Name }
    : { policyId: d.asset2Id, assetName: d.asset2Name };
  const fill: ComposableFill = {
    input: orderUtxo,
    redeemer: takingAsset2 ? TAKE_ASSET2_REDEEMER_HEX : TAKE_ASSET1_REDEEMER_HEX,
    outputs: [
      {
        address: order.address,
        datum: encodeTwoWaySwapDatumHex(f.continuationDatum),
        value: chainValueToAssets(f.continuationValue),
      },
    ],
  };
  const { tokenDelta, outflow } = takerGuardDelta(offer, f.takeAmount, ask, f.deposit);
  return { fill, tokenDelta, outflow };
}
