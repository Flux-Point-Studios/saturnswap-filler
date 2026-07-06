import { describe, it, expect } from "vitest";
import { credentialToAddress } from "@lucid-evolution/lucid";
import {
  planCreateOrderV4Tx,
  planCancelOrderV4Tx,
  planRepriceOrderV4Tx,
  orderAddressFor,
  twoWayOrderAddressFor,
  SENTINEL_OUTREF,
} from "../../src/lifecycleV4.js";
import type { Credential } from "../../src/datum.js";
import { planCreateTwoWayOrderV4Tx, planTwoWaySwapV4Tx } from "../../src/swapV4.js";
import { addAsset } from "../../src/fillPlanV4.js";
import { pairBeaconName, offerBeaconName, askBeaconName, sortedPairBeaconName } from "../../src/beaconsV4.js";
import { decodeOrderDatumV4, decodeTwoWayDatumV4 } from "../../src/datumV4.js";
import { hexToBytes } from "../../src/cbor.js";
import { unit, type ChainValue } from "../../src/discovery.js";
import type { V4Deployment } from "../../src/fillV4.js";
import type { OrderDatumV4, TwoWayOrderDatumV4 } from "../../src/datumV4.js";
import type { OwnerAddress, OutputRef } from "../../src/datum.js";

const ORDER_SCRIPT_HASH = "11".repeat(28);
const BEACON = "22".repeat(28);
const TWOWAY_SCRIPT_HASH = "5a".repeat(28);
const AMM_POLICY = "5b".repeat(28);
const TOKEN_POLICY = "aa".repeat(28);
const TOKEN_NAME = "54455354";
const makerStake: Credential = { type: "key", hash: "33".repeat(28) };
const owner: OwnerAddress = { payment: { type: "key", hash: "44".repeat(28) }, stake: makerStake };
const orderRef: OutputRef = { txHash: "aa".repeat(32), outputIndex: 1 };
const funding: OutputRef[] = [{ txHash: "bb".repeat(32), outputIndex: 0 }];

const deployment: V4Deployment = {
  network: "Preprod",
  orderScriptHash: ORDER_SCRIPT_HASH,
  beaconPolicy: BEACON,
  feeAddressBech32: credentialToAddress("Preprod", { type: "Key", hash: "66".repeat(28) }),
  feePercentBps: 0,
  spendRefUtxo: { txHash: "cc".repeat(32), outputIndex: 0 },
  beaconRefUtxo: { txHash: "dd".repeat(32), outputIndex: 0 },
  twoWayScriptHash: TWOWAY_SCRIPT_HASH,
  ammPolicy: AMM_POLICY,
  twoWaySpendRefUtxo: { txHash: "5c".repeat(32), outputIndex: 0 },
  ammRefUtxo: { txHash: "5d".repeat(32), outputIndex: 0 },
};

const orderAddress = orderAddressFor(deployment, makerStake);

function adaOrder(): OrderDatumV4 {
  return {
    version: 4n, beaconPolicy: BEACON, owner, ownerRaw: { kind: "constr", alt: 0, fields: [] },
    policyIdSell: "", assetNameSell: "", amountSell: 100_000_000n,
    policyIdBuy: TOKEN_POLICY, assetNameBuy: TOKEN_NAME, amountBuy: 400n,
    validBeforeTime: null, minPartialFill: 0n, coverage: null, outputReference: SENTINEL_OUTREF,
  };
}
function orderValue(o: OrderDatumV4): ChainValue {
  let v: ChainValue = { lovelace: 2_000_000n, assets: {} };
  v = addAsset(v, o.policyIdSell, o.assetNameSell, o.amountSell);
  v = addAsset(v, o.beaconPolicy, pairBeaconName(o.policyIdSell, o.assetNameSell, o.policyIdBuy, o.assetNameBuy), 1n);
  v = addAsset(v, o.beaconPolicy, offerBeaconName(o.policyIdSell, o.assetNameSell), 1n);
  v = addAsset(v, o.beaconPolicy, askBeaconName(o.policyIdBuy, o.assetNameBuy), 1n);
  return v;
}

describe("planCreateOrderV4Tx (one-way)", () => {
  it("mints 3 beacons into a per-user order UTxO funded to amount_sell + deposit", () => {
    const r = planCreateOrderV4Tx({ deployment, datum: adaOrder(), makerStake });
    expect(r.action).toBe("create");
    expect(r.mints[0]!.assets.every((m) => m.quantity === 1n)).toBe(true);
    expect(r.mints[0]!.assets.length).toBe(3);
    const out = r.outputs[0]!;
    expect(out.addressBech32).toBe(orderAddress);
    // 2 ADA deposit + 100 ADA sell
    expect(out.assets["lovelace"]).toBe(102_000_000n);
    const decoded = decodeOrderDatumV4(hexToBytes(out.inlineDatumHex));
    expect(decoded.amountSell).toBe(100_000_000n);
    expect(decoded.beaconPolicy).toBe(BEACON);
  });

  it("rejects same-asset pair and wrong beacon policy", () => {
    const same: OrderDatumV4 = { ...adaOrder(), policyIdBuy: "", assetNameBuy: "" };
    expect(() => planCreateOrderV4Tx({ deployment, datum: same, makerStake })).toThrow(/differ/);
    const wrong: OrderDatumV4 = { ...adaOrder(), beaconPolicy: "99".repeat(28) };
    expect(() => planCreateOrderV4Tx({ deployment, datum: wrong, makerStake })).toThrow(/beaconPolicy/);
  });
});

describe("planCancelOrderV4Tx", () => {
  const o = adaOrder();
  const r = planCancelOrderV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, makerStake, fundingInputs: funding });

  it("spends with Cancel, burns 3 beacons, pays reclaim to the owner (tagged)", () => {
    expect(r.action).toBe("cancel");
    expect(r.spend!.orderRef).toEqual(orderRef);
    expect(r.mints[0]!.assets.every((m) => m.quantity === -1n)).toBe(true);
    const ownerOut = r.outputs[0]!;
    expect(ownerOut.role).toBe("owner");
    // reclaim = order value minus beacons = 102 ADA (deposit + sell), no beacons
    expect(ownerOut.assets["lovelace"]).toBe(102_000_000n);
    expect(ownerOut.assets[unit(BEACON, pairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME))]).toBeUndefined();
    expect(r.requiredStakeKeyHash).toBe(makerStake.hash);
  });

  it("rejects when order.address doesn't match the maker's derived address", () => {
    expect(() =>
      planCancelOrderV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: "addr_test1wrong" }, makerStake, fundingInputs: funding }),
    ).toThrow(/does not match/);
  });
});

describe("planRepriceOrderV4Tx", () => {
  const o = adaOrder();
  it("net-zero beacons; continuation with new price, same owner+pair", () => {
    const newDatum: OrderDatumV4 = { ...o, amountBuy: 500n, outputReference: orderRef };
    const r = planRepriceOrderV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, makerStake, newDatum, fundingInputs: funding });
    expect(r.mints.length).toBe(0);
    const cont = r.outputs[0]!;
    expect(cont.addressBech32).toBe(orderAddress);
    const decoded = decodeOrderDatumV4(hexToBytes(cont.inlineDatumHex));
    expect(decoded.amountBuy).toBe(500n);
    expect(decoded.outputReference).toEqual(orderRef);
  });

  it("rejects owner change and pair change", () => {
    const ownerChange: OrderDatumV4 = { ...o, owner: { payment: { type: "key", hash: "99".repeat(28) } }, outputReference: orderRef };
    expect(() => planRepriceOrderV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, makerStake, newDatum: ownerChange, fundingInputs: funding })).toThrow(/owner/);
    const pairChange: OrderDatumV4 = { ...o, policyIdBuy: "", assetNameBuy: "", amountBuy: 50n, outputReference: orderRef };
    expect(() => planRepriceOrderV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, makerStake, newDatum: pairChange, fundingInputs: funding })).toThrow(/pair/);
  });
});

// ---- two-way ----

function ammDatum(): TwoWayOrderDatumV4 {
  return {
    version: 4n, beaconPolicy: AMM_POLICY, owner, ownerRaw: { kind: "constr", alt: 0, fields: [] },
    policyId1: "", assetName1: "", policyId2: TOKEN_POLICY, assetName2: TOKEN_NAME,
    price1Num: 21n, price1Den: 1_000_000n, price2Num: 50_000n, price2Den: 1n,
    validBeforeTime: null, minTake1: 0n, minTake2: 0n, outputReference: SENTINEL_OUTREF,
  };
}
function ammValue(): ChainValue {
  let v: ChainValue = { lovelace: 52_000_000n, assets: {} };
  v = addAsset(v, TOKEN_POLICY, TOKEN_NAME, 1000n);
  v = addAsset(v, AMM_POLICY, sortedPairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME), 1n);
  v = addAsset(v, AMM_POLICY, offerBeaconName("", ""), 1n);
  v = addAsset(v, AMM_POLICY, offerBeaconName(TOKEN_POLICY, TOKEN_NAME), 1n);
  return v;
}

describe("planCreateTwoWayOrderV4Tx", () => {
  it("mints sorted-pair + 2 offer beacons under P_amm into the two-way per-user address", () => {
    const reserves: ChainValue = { lovelace: 50_000_000n, assets: { [unit(TOKEN_POLICY, TOKEN_NAME)]: 1000n } };
    const r = planCreateTwoWayOrderV4Tx({ deployment, datum: ammDatum(), makerStake, reserves });
    expect(r.mints[0]!.assets.length).toBe(3);
    // beacons mint under P_amm (NOT P_limit)
    expect(r.mints[0]!.assets.every((m) => m.unit.startsWith(AMM_POLICY))).toBe(true);
    expect(r.mints[0]!.assets.every((m) => m.unit.startsWith(BEACON))).toBe(false);
    // ref input is the AMM beacon script, not the one-way beacon script
    expect(r.refInputs).toEqual([deployment.ammRefUtxo]);
    // order lands at the two-way script address (H_twoWay + maker stake)
    expect(r.outputs[0]!.addressBech32).toBe(twoWayOrderAddressFor(deployment, makerStake));
    const decoded = decodeTwoWayDatumV4(hexToBytes(r.outputs[0]!.inlineDatumHex));
    expect(decoded.policyId1).toBe("");
    expect(decoded.policyId2).toBe(TOKEN_POLICY);
    // the posted datum self-describes the AMM book
    expect(decoded.beaconPolicy).toBe(AMM_POLICY);
  });

  it("pins the datum beaconPolicy to P_amm even when the caller passes P_limit", () => {
    const reserves: ChainValue = { lovelace: 50_000_000n, assets: { [unit(TOKEN_POLICY, TOKEN_NAME)]: 1000n } };
    const wrong: TwoWayOrderDatumV4 = { ...ammDatum(), beaconPolicy: BEACON };
    const r = planCreateTwoWayOrderV4Tx({ deployment, datum: wrong, makerStake, reserves });
    const decoded = decodeTwoWayDatumV4(hexToBytes(r.outputs[0]!.inlineDatumHex));
    expect(decoded.beaconPolicy).toBe(AMM_POLICY);
    expect(r.mints[0]!.assets.every((m) => m.unit.startsWith(AMM_POLICY))).toBe(true);
  });

  it("throws when the deployment carries no two-way slots", () => {
    const oneWayOnly: V4Deployment = {
      network: "Preprod", orderScriptHash: ORDER_SCRIPT_HASH, beaconPolicy: BEACON,
      feeAddressBech32: deployment.feeAddressBech32, feePercentBps: 0,
      spendRefUtxo: deployment.spendRefUtxo, beaconRefUtxo: deployment.beaconRefUtxo,
    };
    const reserves: ChainValue = { lovelace: 50_000_000n, assets: { [unit(TOKEN_POLICY, TOKEN_NAME)]: 1000n } };
    expect(() => planCreateTwoWayOrderV4Tx({ deployment: oneWayOnly, datum: ammDatum(), makerStake, reserves })).toThrow(/two-way/);
  });

  it("rejects unsorted pair", () => {
    const unsorted: TwoWayOrderDatumV4 = { ...ammDatum(), policyId1: TOKEN_POLICY, assetName1: TOKEN_NAME, policyId2: "", assetName2: "" };
    expect(() => planCreateTwoWayOrderV4Tx({ deployment, datum: unsorted, makerStake, reserves: { lovelace: 50_000_000n, assets: {} } })).toThrow(/sorted/);
  });

  it("rejects zero inventory of a token/token pair (ghost order)", () => {
    // both assets non-ADA (0b.. < aa..), reserves hold only the ADA deposit —
    // neither paired token is present, so it's a ghost
    const TOKEN1_POLICY = "0b".repeat(28);
    const tokenPair: TwoWayOrderDatumV4 = {
      ...ammDatum(),
      policyId1: TOKEN1_POLICY, assetName1: "01",
      policyId2: TOKEN_POLICY, assetName2: TOKEN_NAME,
    };
    expect(() => planCreateTwoWayOrderV4Tx({ deployment, datum: tokenPair, makerStake, reserves: { lovelace: 0n, assets: {} } })).toThrow(/inventory/);
  });
});

describe("planTwoWaySwapV4Tx", () => {
  const o = ammDatum();
  it("take TOKEN, deposit ADA; continuation rebalanced, datum unchanged bar the ref", () => {
    const r = planTwoWaySwapV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: ammValue(), address: orderAddress }, takeAsset1: false, takeAmount: 100n, fundingInputs: funding });
    expect(r.action).toBe("swap");
    // reads the two-way spend reference script, not the one-way spendRefUtxo
    expect(r.refInputs).toEqual([deployment.twoWaySpendRefUtxo]);
    const cont = r.outputs[0]!;
    expect(cont.addressBech32).toBe(orderAddress);
    // -100 TOKEN, +5 ADA
    expect(cont.assets[unit(TOKEN_POLICY, TOKEN_NAME)]).toBe(900n);
    expect(cont.assets["lovelace"]).toBe(57_000_000n);
    const decoded = decodeTwoWayDatumV4(hexToBytes(cont.inlineDatumHex));
    expect(decoded.outputReference).toEqual(orderRef);
    expect(decoded.price2Num).toBe(50_000n); // unchanged
  });

  it("rejects over-take beyond reserve", () => {
    expect(() => planTwoWaySwapV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: ammValue(), address: orderAddress }, takeAsset1: false, takeAmount: 1001n, fundingInputs: funding })).toThrow(/exceeds/);
  });
});
