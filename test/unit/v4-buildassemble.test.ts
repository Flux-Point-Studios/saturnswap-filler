// Thin @lucid-evolution assembler tests for the V4 order-lifecycle builders.
// Mirrors test/unit/v3-fill.test.ts: a stubbed LucidEvolution whose TxBuilder
// RECORDS the outputs / mints / signers it is fed, and whose .complete() returns
// a fake sign-builder (toCBOR/toHash) so the assembler runs end-to-end offline.
// We assert the assembler wires the already-tested planner recipe into the tx
// faithfully — beacon mint delta, continuation/owner outputs, min-utxo floor,
// and (create) the per-user address with a non-empty staking credential.
// No chain, no submission.

import { describe, it, expect } from "vitest";
import { credentialToAddress, getAddressDetails, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import {
  buildCreateOrderV4,
  buildCancelOrderV4,
  buildRepriceOrderV4,
  orderAddressFor,
  twoWayOrderAddressFor,
  SENTINEL_OUTREF,
} from "../../src/lifecycleV4.js";
import { buildCreateTwoWayOrderV4, buildTwoWaySwapV4 } from "../../src/swapV4.js";
import type { V4Deployment } from "../../src/fillV4.js";
import { V4_MAINNET_COINS_PER_UTXO_BYTE, buildComposedTakerFillsV4, planComposedTakerFillsV4Tx } from "../../src/fillV4.js";
import { inputIndexOf } from "../../src/sort.js";
import { minUtxoLovelace } from "../../src/minUtxo.js";
import { addAsset, computeSwapPlanV4 } from "../../src/fillPlanV4.js";
import { pairBeaconName, offerBeaconName, askBeaconName, sortedPairBeaconName } from "../../src/beaconsV4.js";
import { unit, type ChainValue } from "../../src/discovery.js";
import type { Credential } from "../../src/datum.js";
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
const twoWayOrderAddress = twoWayOrderAddressFor(deployment, makerStake);
const changeAddress = credentialToAddress("Preprod", { type: "Key", hash: "77".repeat(28) });
const collateralUtxo = {
  txHash: "ee".repeat(32),
  outputIndex: 0,
  address: changeAddress,
  assets: { lovelace: 5_000_000n },
} as UTxO;
const fundingUtxos = [
  { txHash: funding[0]!.txHash, outputIndex: funding[0]!.outputIndex, address: changeAddress, assets: { lovelace: 200_000_000n } } as UTxO,
];

interface Recorded {
  outputs: { addr: string; datum: { kind: string; value: string }; assets: Record<string, bigint> }[];
  mints: { bag: Record<string, bigint>; redeemer: string }[];
  refs: { txHash: string; outputIndex: number }[];
  collect: { utxos: UTxO[]; redeemer?: string }[];
  signers: string[];
  validTo: number[];
}

function recordingLucid(): { lucid: LucidEvolution; calls: Recorded } {
  const calls: Recorded = { outputs: [], mints: [], refs: [], collect: [], signers: [], validTo: [] };
  const b: Record<string, unknown> = {};
  b.collectFrom = (utxos: UTxO[], redeemer?: string) => {
    calls.collect.push({ utxos, redeemer });
    return b;
  };
  b.readFrom = (utxos: { txHash: string; outputIndex: number }[]) => {
    calls.refs.push(...utxos);
    return b;
  };
  b.mintAssets = (bag: Record<string, bigint>, redeemer: string) => {
    calls.mints.push({ bag, redeemer });
    return b;
  };
  b.addSignerKey = (kh: string) => {
    calls.signers.push(kh);
    return b;
  };
  b.validTo = (ms: number) => {
    calls.validTo.push(ms);
    return b;
  };
  b.pay = {
    ToAddressWithData: (addr: string, datum: { kind: string; value: string }, assets: Record<string, bigint>) => {
      calls.outputs.push({ addr, datum, assets });
      return b;
    },
  };
  b.complete = async () => ({ toCBOR: () => "00", toHash: () => "ab".repeat(32) });

  const resolve = (r: { txHash: string; outputIndex: number }): UTxO => {
    if (r.txHash === orderRef.txHash && r.outputIndex === orderRef.outputIndex) {
      return { txHash: r.txHash, outputIndex: r.outputIndex, address: orderAddress, assets: { lovelace: 2_000_000n }, datum: "d87980" } as unknown as UTxO;
    }
    return {
      txHash: r.txHash,
      outputIndex: r.outputIndex,
      address: orderAddress,
      assets: { lovelace: 20_000_000n },
      scriptRef: { type: "PlutusV3", script: "59" },
    } as unknown as UTxO;
  };

  const lucid = {
    config: () => ({ network: "Preprod" as const }),
    utxosByOutRef: async (refs: { txHash: string; outputIndex: number }[]) => refs.map(resolve),
    selectWallet: { fromAddress: () => {} },
    newTx: () => b,
  } as unknown as LucidEvolution;

  return { lucid, calls };
}

function mintDelta(calls: Recorded): bigint {
  let d = 0n;
  for (const m of calls.mints) for (const q of Object.values(m.bag)) d += q;
  return d;
}

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

describe("buildCreateOrderV4", () => {
  it("mints +3 beacons and pays the order to the per-user address (non-empty stake), floored to min-utxo", async () => {
    const { lucid, calls } = recordingLucid();
    const res = await buildCreateOrderV4({ lucid, deployment, datum: adaOrder(), makerStake, fundingUtxos, collateralUtxo, changeAddress });

    expect(res.unsignedCbor).toBe("00");
    expect(res.txHash).toBe("ab".repeat(32));

    // +3 beacon mint delta
    expect(mintDelta(calls)).toBe(3n);
    expect(calls.mints.length).toBe(1);
    for (const q of Object.values(calls.mints[0]!.bag)) expect(q).toBe(1n);
    expect(Object.keys(calls.mints[0]!.bag).every((u) => u.startsWith(BEACON))).toBe(true);

    // one output, to the per-user address, matching the planner recipe
    expect(calls.outputs.length).toBe(1);
    const out = calls.outputs[0]!;
    expect(out.addr).toBe(orderAddress);
    expect(out.addr).toBe(res.recipe.outputs[0]!.addressBech32);
    expect(out.assets).toEqual(res.recipe.outputs[0]!.assets);

    // per-user address carries a non-empty staking credential
    const det = getAddressDetails(out.addr);
    expect(det.stakeCredential).toBeDefined();
    expect(det.stakeCredential!.hash).toBe(makerStake.hash);
    expect(det.paymentCredential!.hash).toBe(ORDER_SCRIPT_HASH);

    // floored to min-utxo (2 ADA deposit + 100 ADA sell is above the floor)
    const floor = minUtxoLovelace({ addressBech32: out.addr, assets: out.assets, inlineDatumHex: out.datum.value }, V4_MAINNET_COINS_PER_UTXO_BYTE);
    expect(out.assets["lovelace"]).toBeGreaterThanOrEqual(floor);
    expect(out.assets["lovelace"]).toBe(102_000_000n);

    // no order spent on create
    expect(calls.collect.some((c) => c.redeemer !== undefined)).toBe(false);
  });
});

describe("buildRepriceOrderV4", () => {
  it("NET-ZERO beacon mint, continuation to the per-user address, owner/staking-cred authorized", async () => {
    const { lucid, calls } = recordingLucid();
    const o = adaOrder();
    const newDatum: OrderDatumV4 = { ...o, amountBuy: 500n, outputReference: orderRef };
    const res = await buildRepriceOrderV4({
      lucid, deployment,
      order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress },
      makerStake, newDatum, fundingUtxos, collateralUtxo, changeAddress,
    });

    expect(mintDelta(calls)).toBe(0n);
    expect(calls.mints.length).toBe(0); // net-zero → policy not invoked

    const cont = calls.outputs.find((x) => x.addr === orderAddress)!;
    expect(cont).toBeDefined();
    expect(cont.assets).toEqual(res.recipe.outputs[0]!.assets);

    // spends the order with the reprice redeemer + the owner's stake key is a required signer
    expect(calls.collect.some((c) => c.redeemer === res.recipe.spend!.redeemerHex)).toBe(true);
    expect(calls.signers).toContain(makerStake.hash);
    expect(res.unsignedCbor).toBe("00");
  });
});

describe("buildCancelOrderV4", () => {
  it("burns -3 beacons and reclaims to the datum owner (no beacons in the payout)", async () => {
    const { lucid, calls } = recordingLucid();
    const o = adaOrder();
    const res = await buildCancelOrderV4({
      lucid, deployment,
      order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress },
      makerStake, fundingUtxos, collateralUtxo, changeAddress,
    });

    expect(mintDelta(calls)).toBe(-3n);
    expect(calls.mints.length).toBe(1);
    for (const q of Object.values(calls.mints[0]!.bag)) expect(q).toBe(-1n);

    const ownerBech32 = credentialToAddress(
      "Preprod",
      { type: "Key", hash: owner.payment.hash },
      { type: "Key", hash: owner.stake!.hash },
    );
    const ownerOut = calls.outputs.find((x) => x.addr === ownerBech32)!;
    expect(ownerOut).toBeDefined();
    expect(ownerOut.assets).toEqual(res.recipe.outputs[0]!.assets);
    // reclaim carries the 102 ADA (deposit + sell) but none of the three beacons
    expect(ownerOut.assets["lovelace"]).toBe(102_000_000n);
    for (const u of Object.keys(ownerOut.assets)) expect(u.startsWith(BEACON)).toBe(false);

    // spend + owner-auth
    expect(calls.collect.some((c) => c.redeemer === res.recipe.spend!.redeemerHex)).toBe(true);
    expect(calls.signers).toContain(makerStake.hash);

    // min-utxo floor holds on the reclaim output
    const floor = minUtxoLovelace({ addressBech32: ownerBech32, assets: ownerOut.assets, inlineDatumHex: ownerOut.datum.value }, V4_MAINNET_COINS_PER_UTXO_BYTE);
    expect(ownerOut.assets["lovelace"]).toBeGreaterThanOrEqual(floor);
  });
});

// ---- two-way ----

function ammDatum(): TwoWayOrderDatumV4 {
  return {
    version: 4n, beaconPolicy: BEACON, owner, ownerRaw: { kind: "constr", alt: 0, fields: [] },
    policyId1: "", assetName1: "", policyId2: TOKEN_POLICY, assetName2: TOKEN_NAME,
    price1Num: 21n, price1Den: 1_000_000n, price2Num: 50_000n, price2Den: 1n,
    validBeforeTime: null, minTake1: 0n, minTake2: 0n, outputReference: SENTINEL_OUTREF,
  };
}
function ammValue(): ChainValue {
  let v: ChainValue = { lovelace: 52_000_000n, assets: {} };
  v = addAsset(v, TOKEN_POLICY, TOKEN_NAME, 1000n);
  v = addAsset(v, BEACON, sortedPairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME), 1n);
  v = addAsset(v, BEACON, offerBeaconName("", ""), 1n);
  v = addAsset(v, BEACON, offerBeaconName(TOKEN_POLICY, TOKEN_NAME), 1n);
  return v;
}

describe("buildCreateTwoWayOrderV4", () => {
  it("mints the +3 two-way beacon set (under P_amm) into the two-way per-user reserve UTxO", async () => {
    const { lucid, calls } = recordingLucid();
    const reserves: ChainValue = { lovelace: 50_000_000n, assets: { [unit(TOKEN_POLICY, TOKEN_NAME)]: 1000n } };
    const res = await buildCreateTwoWayOrderV4({ lucid, deployment, datum: ammDatum(), makerStake, reserves, fundingUtxos, collateralUtxo, changeAddress });

    expect(mintDelta(calls)).toBe(3n);
    expect(calls.mints.length).toBe(1);
    for (const q of Object.values(calls.mints[0]!.bag)) expect(q).toBe(1n);
    // beacons mint under P_amm (NOT P_limit) — Finding 1
    expect(Object.keys(calls.mints[0]!.bag).every((u) => u.startsWith(AMM_POLICY))).toBe(true);
    expect(Object.keys(calls.mints[0]!.bag).some((u) => u.startsWith(BEACON))).toBe(false);
    // reads the AMM beacon ref script, not the one-way beaconRefUtxo
    expect(calls.refs.some((r) => r.txHash === deployment.ammRefUtxo!.txHash && r.outputIndex === deployment.ammRefUtxo!.outputIndex)).toBe(true);

    const out = calls.outputs[0]!;
    expect(out.addr).toBe(twoWayOrderAddress);
    expect(out.assets).toEqual(res.recipe.outputs[0]!.assets);
    const det = getAddressDetails(out.addr);
    expect(det.stakeCredential!.hash).toBe(makerStake.hash);
    expect(det.paymentCredential!.hash).toBe(TWOWAY_SCRIPT_HASH);

    const floor = minUtxoLovelace({ addressBech32: out.addr, assets: out.assets, inlineDatumHex: out.datum.value }, V4_MAINNET_COINS_PER_UTXO_BYTE);
    expect(out.assets["lovelace"]).toBeGreaterThanOrEqual(floor);
  });
});

describe("buildTwoWaySwapV4", () => {
  it("net-zero mint; continuation value == computeSwapPlanV4(...).continuationValue", async () => {
    const { lucid, calls } = recordingLucid();
    const o = ammDatum();
    const res = await buildTwoWaySwapV4({
      lucid, deployment,
      order: { datum: o, utxo: orderRef, scriptValue: ammValue(), address: orderAddress },
      takeAsset1: false, takeAmount: 100n, fundingUtxos, collateralUtxo, changeAddress,
    });

    expect(mintDelta(calls)).toBe(0n);
    expect(calls.mints.length).toBe(0);

    const cont = calls.outputs.find((x) => x.addr === orderAddress)!;
    expect(cont).toBeDefined();

    const plan = computeSwapPlanV4(o, ammValue(), false, 100n, deployment.feePercentBps);
    const expected: Record<string, bigint> = { lovelace: plan.continuationValue.lovelace, ...plan.continuationValue.assets };
    expect(cont.assets).toEqual(expected);
    expect(cont.assets).toEqual(res.recipe.outputs[0]!.assets);

    // taker action — no owner-auth signer required
    expect(calls.signers.length).toBe(0);
    expect(calls.collect.some((c) => c.redeemer === res.recipe.spend.redeemerHex)).toBe(true);
    expect(res.txHash).toBe("ab".repeat(32));
  });
});

// ---- Finding 2: composed multi-spend fill ----

describe("buildComposedTakerFillsV4 (two fills in ONE tx)", () => {
  const orderRef2: OutputRef = { txHash: "cd".repeat(32), outputIndex: 2 };

  it("plans two partial fills: [ownerA, contA, ownerB, contB], indices over the FULL input set, net-zero beacons", () => {
    const o = adaOrder();
    const fundingIn = fundingUtxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex }));
    const legs = [
      { order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 200n },
      { order: { datum: o, utxo: orderRef2, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 200n },
    ];
    const recipe = planComposedTakerFillsV4Tx({ deployment, legs, fundingInputs: fundingIn });

    // full Conway input set = both order spends + shared funding
    const allInputs = [orderRef, orderRef2, ...fundingIn];
    expect(recipe.allInputs).toEqual(allInputs);
    // each leg's redeemer input_index is re-derived over the FULL sorted set
    expect(recipe.spends[0]!.inputIndex).toBe(inputIndexOf(allInputs, orderRef));
    expect(recipe.spends[1]!.inputIndex).toBe(inputIndexOf(allInputs, orderRef2));

    // output layout and per-leg continuation index (validate_partial_fill reads output_at)
    expect(recipe.outputs.map((x) => x.role)).toEqual(["owner", "continuation", "owner", "continuation"]);
    expect(recipe.legs[0]!.redeemerOutputIndex).toBe(1);
    expect(recipe.legs[1]!.redeemerOutputIndex).toBe(3);
    // continuations return to each order's OWN address
    expect(recipe.outputs[1]!.addressBech32).toBe(orderAddress);
    expect(recipe.outputs[3]!.addressBech32).toBe(orderAddress);

    // both partial → beacons stay on the continuations, nothing minted
    expect(recipe.mints.length).toBe(0);
  });

  it("merges two FULL fills of the same pair into a single burn group of -2 per beacon (owner-only outputs)", () => {
    const o = adaOrder();
    const fundingIn = fundingUtxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex }));
    const legs = [
      { order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 400n },
      { order: { datum: o, utxo: orderRef2, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 400n },
    ];
    const recipe = planComposedTakerFillsV4Tx({ deployment, legs, fundingInputs: fundingIn });

    expect(recipe.outputs.map((x) => x.role)).toEqual(["owner", "owner"]);
    expect(recipe.mints.length).toBe(1); // one merged BurnOnly group
    const burn = recipe.mints[0]!;
    expect(burn.assets.length).toBe(3); // pair/offer/ask, summed across both legs
    for (const a of burn.assets) expect(a.quantity).toBe(-2n);
    expect(burn.assets.every((a) => a.unit.startsWith(BEACON))).toBe(true);
  });

  it("rejects a duplicate order in the leg set", () => {
    const o = adaOrder();
    const legs = [
      { order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 200n },
      { order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 200n },
    ];
    expect(() => planComposedTakerFillsV4Tx({ deployment, legs, fundingInputs: [] })).toThrow(/duplicate/);
  });

  it("assembles: two collectFrom(order,redeemer) legs + one funding collect, 4 outputs, drift-checked", async () => {
    const { lucid, calls } = recordingLucid();
    const o = adaOrder();
    const legs = [
      { order: { datum: o, utxo: orderRef, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 200n },
      { order: { datum: o, utxo: orderRef2, scriptValue: orderValue(o), address: orderAddress }, buyAmount: 200n },
    ];
    const res = await buildComposedTakerFillsV4({ lucid, deployment, legs, fundingUtxos, collateralUtxo, changeAddress });

    expect(res.unsignedCbor).toBe("00"); // completed → the input-index drift re-check passed
    // exactly two order spends carry a redeemer; funding is collected without one
    const spendCollects = calls.collect.filter((c) => c.redeemer !== undefined);
    expect(spendCollects.length).toBe(2);
    expect(spendCollects.map((c) => c.redeemer).sort()).toEqual(res.recipe.spends.map((s) => s.redeemerHex).sort());
    expect(calls.outputs.length).toBe(4);
    // the shared spend reference script is read
    expect(calls.refs.some((r) => r.txHash === deployment.spendRefUtxo.txHash && r.outputIndex === deployment.spendRefUtxo.outputIndex)).toBe(true);
  });
});
