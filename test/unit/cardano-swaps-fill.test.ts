import { describe, it, expect } from "vitest";
import { askGivenFor, priceOk, type Rational } from "../../src/cardanoSwapsRatio.js";
import {
  computeOneWayFill,
  computeTwoWayFill,
  cardanoSwapsComposable,
  cardanoSwapsTwoWayComposable,
  takerGuardDelta,
  addAsset,
  quantityOf,
  CARDANO_SWAPS_MIN_UTXO_HEADROOM,
  type OneWayOrder,
  type TwoWayOrder,
} from "../../src/cardanoSwapsFill.js";
import {
  encodeOneWaySwapDatumHex,
  encodeTwoWaySwapDatumHex,
  SWAP_REDEEMER_HEX,
  TAKE_ASSET1_REDEEMER_HEX,
  TAKE_ASSET2_REDEEMER_HEX,
  type OneWaySwapDatum,
  type TwoWaySwapDatum,
} from "../../src/cardanoSwapsDatum.js";
import { pairBeacon, offerBeacon, askBeacon, assetBeacon } from "../../src/cardanoSwapsBeacons.js";
import { unit, type ChainValue } from "../../src/discovery.js";
import type { OutputRef } from "../../src/datum.js";
import type { UTxO } from "@lucid-evolution/lucid";

const BEACON = "22".repeat(28);
const AA = "aa".repeat(28);
const NM = "54455354";
const DEPOSIT = 2_000_000n;
const orderRef: OutputRef = { txHash: "aa".repeat(32), outputIndex: 1 };
const fakeUtxo = { txHash: orderRef.txHash, outputIndex: orderRef.outputIndex, address: "x", assets: {} } as unknown as UTxO;

// ---- Rational cross-mult math ----

describe("canonical Rational fill math (mirrors valid_swap)", () => {
  const price: Rational = { num: 400n, den: 100_000_000n }; // ask/offer

  it("askGivenFor is the ceil of offer_taken * num / den (maker-favorable)", () => {
    expect(askGivenFor(25_000_000n, price)).toBe(100n);
    expect(askGivenFor(1n, price)).toBe(1n); // 0.000004 -> 1
    expect(askGivenFor(1000n, { num: 50_000_000n, den: 1000n })).toBe(50_000_000n);
    expect(askGivenFor(7n, { num: 3n, den: 2n })).toBe(11n); // 10.5 -> 11
  });

  it("priceOk is the rounding-safe cross-mult offer_taken*num <= ask_given*den", () => {
    expect(priceOk(25_000_000n, 100n, price)).toBe(true); // exact boundary
    expect(priceOk(25_000_000n, 99n, price)).toBe(false); // underpay rejected
    expect(priceOk(25_000_000n, 101n, price)).toBe(true); // overpay accepted
  });

  it("the ceil deposit always satisfies the on-chain cross-mult", () => {
    for (const ot of [1n, 7n, 25_000_000n, 99_999_999n]) {
      expect(priceOk(ot, askGivenFor(ot, price), price)).toBe(true);
    }
  });
});

// ---- one-way fill (offer = ADA, ask = TOKEN) ----

function oneWayDatum(): OneWaySwapDatum {
  return {
    beaconId: BEACON,
    pairBeacon: pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM }),
    offerId: "",
    offerName: "",
    offerBeacon: offerBeacon("", ""),
    askId: AA,
    askName: NM,
    askBeacon: askBeacon(AA, NM),
    price: { num: 400n, den: 100_000_000n },
    prevInput: null,
    expiration: null,
  };
}

function oneWayValue(d: OneWaySwapDatum): ChainValue {
  let v: ChainValue = { lovelace: DEPOSIT + 100_000_000n, assets: {} };
  v = addAsset(v, d.beaconId, d.pairBeacon, 1n);
  v = addAsset(v, d.beaconId, d.offerBeacon, 1n);
  v = addAsset(v, d.beaconId, d.askBeacon, 1n);
  return v;
}

function oneWayOrder(): OneWayOrder {
  const datum = oneWayDatum();
  return { kind: "one-way", utxo: orderRef, address: "addr_test1_swap", datum, scriptValue: oneWayValue(datum) };
}

describe("canonical one-way fill continuation (datum-scan + value conservation)", () => {
  it("partial: offer leaves, ask deposited, beacons + price preserved, prev_input = Some(ref)", () => {
    const order = oneWayOrder();
    const f = computeOneWayFill(order, 25_000_000n);
    expect(f.askGiven).toBe(100n);
    // continuation value = old - 25 ADA (offer) + 100 TOKEN (ask)
    expect(f.continuationValue.lovelace).toBe(DEPOSIT + 75_000_000n);
    expect(quantityOf(f.continuationValue, AA, NM)).toBe(100n);
    // three beacons survive
    expect(quantityOf(f.continuationValue, BEACON, order.datum.pairBeacon)).toBe(1n);
    expect(quantityOf(f.continuationValue, BEACON, order.datum.offerBeacon)).toBe(1n);
    expect(quantityOf(f.continuationValue, BEACON, order.datum.askBeacon)).toBe(1n);
    // datum identical except prev_input = Some(input_ref)
    expect(f.continuationDatum.prevInput).toEqual(orderRef);
    expect({ ...f.continuationDatum, prevInput: null }).toEqual(order.datum);
    // and the on-chain price check holds
    expect(priceOk(25_000_000n, f.askGiven, order.datum.price)).toBe(true);
  });

  it("rejects taking more offer than the UTxO holds and non-positive takes", () => {
    const order = oneWayOrder(); // holds deposit + 100 ADA offer = 102 ADA
    expect(() => computeOneWayFill(order, 0n)).toThrow(/> 0/);
    expect(() => computeOneWayFill(order, 102_000_001n)).toThrow(/exceeds/);
  });
});

describe("cardanoSwapsComposable (one-way Swap adapter)", () => {
  it("produces ONE continuation output, the nullary Swap redeemer, and no mint", () => {
    const order = oneWayOrder();
    const { fill } = cardanoSwapsComposable({ order, orderUtxo: fakeUtxo, offerTaken: 25_000_000n });
    expect(fill.input).toBe(fakeUtxo);
    expect(fill.redeemer).toBe(SWAP_REDEEMER_HEX);
    expect(fill.outputs.length).toBe(1);
    expect(fill.outputs[0]!.address).toBe(order.address);
    expect(fill.outputs[0]!.value.lovelace).toBe(DEPOSIT + 75_000_000n);
    expect(fill.outputs[0]!.value[unit(AA, NM)]).toBe(100n);
    expect(fill.outputs[0]!.value[unit(BEACON, order.datum.pairBeacon)]).toBe(1n);
    expect(fill.mints).toBeUndefined();
    // the datum is the continuation datum with prev_input = Some(ref)
    const f = computeOneWayFill(order, 25_000_000n);
    expect(fill.outputs[0]!.datum).toBe(encodeOneWaySwapDatumHex(f.continuationDatum));
  });

  it("guard delta: offer=ADA/ask=TOKEN → guard SELLS token, GAINS ADA (negative outflow)", () => {
    const order = oneWayOrder();
    const { tokenDelta, outflow } = cardanoSwapsComposable({ order, orderUtxo: fakeUtxo, offerTaken: 25_000_000n });
    expect(tokenDelta).toEqual({ [unit(AA, NM)]: -100n });
    expect(outflow).toBe(-(25_000_000n - CARDANO_SWAPS_MIN_UTXO_HEADROOM));
  });
});

describe("takerGuardDelta accounting (both ADA orientations)", () => {
  it("ask=ADA (maker sells a token for ADA) → guard BUYS token, PAYS ADA", () => {
    const { tokenDelta, outflow } = takerGuardDelta(
      { policyId: AA, assetName: NM }, 1000n, // offer token taken
      { policyId: "", assetName: "" }, 50_000_000n, // ask ADA given
    );
    expect(tokenDelta).toEqual({ [unit(AA, NM)]: 1000n });
    expect(outflow).toBe(50_000_000n + CARDANO_SWAPS_MIN_UTXO_HEADROOM);
  });
});

// ---- two-way fill (asset1 = ADA, asset2 = TOKEN) ----

function twoWayDatum(): TwoWaySwapDatum {
  return {
    beaconId: BEACON,
    pairBeacon: pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM }),
    asset1Id: "",
    asset1Name: "",
    asset1Beacon: assetBeacon("", ""),
    asset2Id: AA,
    asset2Name: NM,
    asset2Beacon: assetBeacon(AA, NM),
    asset1Price: { num: 400n, den: 100_000_000n }, // Asset2/Asset1
    asset2Price: { num: 100_000_000n, den: 400n }, // Asset1/Asset2
    prevInput: null,
    expiration: null,
  };
}

function twoWayOrder(): TwoWayOrder {
  const datum = twoWayDatum();
  let v: ChainValue = { lovelace: DEPOSIT + 50_000_000n, assets: {} };
  v = addAsset(v, AA, NM, 1000n);
  v = addAsset(v, datum.beaconId, datum.pairBeacon, 1n);
  v = addAsset(v, datum.beaconId, datum.asset1Beacon, 1n);
  v = addAsset(v, datum.beaconId, datum.asset2Beacon, 1n);
  return { kind: "two-way", utxo: orderRef, address: "addr_test1_amm", datum, scriptValue: v };
}

describe("canonical two-way fill (TakeAsset1 / TakeAsset2)", () => {
  it("TakeAsset2: take TOKEN, deposit ADA at asset2_price", () => {
    const order = twoWayOrder();
    const f = computeTwoWayFill(order, true, 100n);
    expect(f.deposit).toBe(25_000_000n);
    expect(quantityOf(f.continuationValue, AA, NM)).toBe(900n);
    expect(f.continuationValue.lovelace).toBe(DEPOSIT + 75_000_000n);
    expect(f.continuationDatum.prevInput).toEqual(orderRef);
  });

  it("TakeAsset1: take ADA, deposit TOKEN at asset1_price", () => {
    const order = twoWayOrder();
    const f = computeTwoWayFill(order, false, 1_000_000n);
    expect(f.deposit).toBe(4n);
    expect(f.continuationValue.lovelace).toBe(DEPOSIT + 49_000_000n);
    expect(quantityOf(f.continuationValue, AA, NM)).toBe(1004n);
  });

  it("composable uses TakeAsset2 redeemer, one continuation output, no mint", () => {
    const order = twoWayOrder();
    const { fill, tokenDelta, outflow } = cardanoSwapsTwoWayComposable({
      order,
      orderUtxo: fakeUtxo,
      takingAsset2: true,
      takeAmount: 100n,
    });
    expect(fill.redeemer).toBe(TAKE_ASSET2_REDEEMER_HEX);
    expect(fill.outputs.length).toBe(1);
    expect(fill.mints).toBeUndefined();
    const f = computeTwoWayFill(order, true, 100n);
    expect(fill.outputs[0]!.datum).toBe(encodeTwoWaySwapDatumHex(f.continuationDatum));
    // guard takes TOKEN (gain), pays 25 ADA
    expect(tokenDelta).toEqual({ [unit(AA, NM)]: 100n });
    expect(outflow).toBe(25_000_000n + CARDANO_SWAPS_MIN_UTXO_HEADROOM);
  });

  it("composable uses TakeAsset1 redeemer for the other direction", () => {
    const order = twoWayOrder();
    const { fill } = cardanoSwapsTwoWayComposable({
      order,
      orderUtxo: fakeUtxo,
      takingAsset2: false,
      takeAmount: 1_000_000n,
    });
    expect(fill.redeemer).toBe(TAKE_ASSET1_REDEEMER_HEX);
  });
});
