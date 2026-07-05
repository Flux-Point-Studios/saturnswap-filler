import { describe, it, expect } from "vitest";
import { credentialToAddress } from "@lucid-evolution/lucid";
import { planTakerFillV4Tx, type V4Deployment } from "../../src/fillV4.js";
import { addAsset } from "../../src/fillPlanV4.js";
import { pairBeaconName, offerBeaconName, askBeaconName } from "../../src/beaconsV4.js";
import { decodeOrderDatumV4, receiptTokenName } from "../../src/datumV4.js";
import { hexToBytes } from "../../src/cbor.js";
import { unit, type ChainValue } from "../../src/discovery.js";
import type { OrderDatumV4 } from "../../src/datumV4.js";
import type { OwnerAddress, OutputRef } from "../../src/datum.js";

const BEACON = "22".repeat(28);
const RECEIPT_POLICY = "55".repeat(28);
const TOKEN_POLICY = "aa".repeat(28);
const TOKEN_NAME = "54455354";
const owner: OwnerAddress = {
  payment: { type: "key", hash: "44".repeat(28) },
  stake: { type: "key", hash: "33".repeat(28) },
};
const orderRef: OutputRef = { txHash: "aa".repeat(32), outputIndex: 1 };
const DEPOSIT = 2_000_000n;

const ORDER_SCRIPT_HASH = "11".repeat(28);
const orderAddressBech32 = credentialToAddress(
  "Preprod",
  { type: "Script", hash: ORDER_SCRIPT_HASH },
  { type: "Key", hash: "33".repeat(28) },
);
const feeAddressBech32 = credentialToAddress("Preprod", { type: "Key", hash: "66".repeat(28) });

const deployment: V4Deployment = {
  network: "Preprod",
  orderScriptHash: ORDER_SCRIPT_HASH,
  orderAddressBech32,
  beaconPolicy: BEACON,
  feeAddressBech32,
  feePercentBps: 0,
  spendRefUtxo: { txHash: "cc".repeat(32), outputIndex: 0 },
  beaconRefUtxo: { txHash: "dd".repeat(32), outputIndex: 0 },
  receiptRefUtxo: { txHash: "ee".repeat(32), outputIndex: 0 },
  receiptPolicy: RECEIPT_POLICY,
};

function adaOrder(over: Partial<OrderDatumV4> = {}): OrderDatumV4 {
  return {
    version: 4n,
    beaconPolicy: BEACON,
    owner,
    ownerRaw: { kind: "constr", alt: 0, fields: [] },
    policyIdSell: "",
    assetNameSell: "",
    amountSell: 100_000_000n,
    policyIdBuy: TOKEN_POLICY,
    assetNameBuy: TOKEN_NAME,
    amountBuy: 400n,
    validBeforeTime: null,
    minPartialFill: 0n,
    coverage: null,
    outputReference: orderRef,
    ...over,
  };
}

function orderValue(o: OrderDatumV4): ChainValue {
  let v: ChainValue = { lovelace: DEPOSIT, assets: {} };
  v = addAsset(v, o.policyIdSell, o.assetNameSell, o.amountSell);
  v = addAsset(v, o.beaconPolicy, pairBeaconName(o.policyIdSell, o.assetNameSell, o.policyIdBuy, o.assetNameBuy), 1n);
  v = addAsset(v, o.beaconPolicy, offerBeaconName(o.policyIdSell, o.assetNameSell), 1n);
  v = addAsset(v, o.beaconPolicy, askBeaconName(o.policyIdBuy, o.assetNameBuy), 1n);
  return v;
}

const funding: OutputRef[] = [{ txHash: "bb".repeat(32), outputIndex: 0 }];

describe("planTakerFillV4Tx — full fill", () => {
  const o = adaOrder();
  const recipe = planTakerFillV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o) }, buyAmount: 400n, fundingInputs: funding });

  it("spends the order with a Fill redeemer pointing at owner output 0", () => {
    expect(recipe.kind).toBe("full");
    expect(recipe.ownerOutputIndex).toBe(0);
    // redeemer decodes to Constr0[400, inputIndex, 0]
    // (we assert the plan + indices; redeemer hex is opaque here)
    expect(recipe.inputIndex).toBeGreaterThanOrEqual(0);
    expect(recipe.spendInputs[0]).toEqual(orderRef);
  });

  it("owner output carries deposit + bought asset, tagged with PaymentDatum", () => {
    const ownerOut = recipe.outputs[0]!;
    expect(ownerOut.role).toBe("owner");
    expect(ownerOut.assets[unit(TOKEN_POLICY, TOKEN_NAME)]).toBe(400n);
    expect(ownerOut.assets["lovelace"]).toBe(DEPOSIT); // deposit returned, above min-utxo
    expect(ownerOut.inlineDatumHex.length).toBeGreaterThan(0);
  });

  it("burns exactly the three beacons under the beacon policy", () => {
    expect(recipe.mints.length).toBe(1);
    const burn = recipe.mints[0]!;
    expect(burn.assets.length).toBe(3);
    for (const m of burn.assets) {
      expect(m.quantity).toBe(-1n);
      expect(m.unit.startsWith(BEACON)).toBe(true);
    }
    // reads the beacon ref script for the burn
    expect(recipe.refInputs.length).toBe(2);
  });

  it("no continuation output on a full fill", () => {
    expect(recipe.outputs.find((x) => x.role === "continuation")).toBeUndefined();
  });
});

describe("planTakerFillV4Tx — partial fill", () => {
  const o = adaOrder();
  const recipe = planTakerFillV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o) }, buyAmount: 100n, fundingInputs: funding });

  it("relists a continuation with reduced amounts and the same pair, no mint", () => {
    expect(recipe.kind).toBe("partial");
    expect(recipe.mints.length).toBe(0); // net-zero beacons — policy not invoked
    const cont = recipe.outputs.find((x) => x.role === "continuation")!;
    expect(cont.addressBech32).toBe(orderAddressBech32);
    const decoded = decodeOrderDatumV4(hexToBytes(cont.inlineDatumHex));
    expect(decoded.amountSell).toBe(75_000_000n);
    expect(decoded.amountBuy).toBe(300n);
    expect(decoded.outputReference).toEqual(orderRef); // relist-chain link
    expect(decoded.owner.payment.hash).toBe(owner.payment.hash);
  });

  it("owner receives the bought asset", () => {
    const ownerOut = recipe.outputs[0]!;
    expect(ownerOut.assets[unit(TOKEN_POLICY, TOKEN_NAME)]).toBe(100n);
  });

  it("only the spend ref is read (no beacon burn)", () => {
    expect(recipe.refInputs.length).toBe(1);
  });
});

describe("planTakerFillV4Tx — Model A fee + coverage + receipt", () => {
  it("adds a fee output in the sell asset under Model A", () => {
    const o = adaOrder({ policyIdSell: TOKEN_POLICY, assetNameSell: TOKEN_NAME, amountSell: 1000n, policyIdBuy: "", assetNameBuy: "", amountBuy: 50_000_000n });
    const dep: V4Deployment = { ...deployment, feePercentBps: 100 };
    const recipe = planTakerFillV4Tx({ deployment: dep, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o) }, buyAmount: 50_000_000n, fundingInputs: funding });
    const fee = recipe.outputs.find((x) => x.role === "fee")!;
    expect(fee.addressBech32).toBe(feeAddressBech32);
    expect(fee.assets[unit(TOKEN_POLICY, TOKEN_NAME)]).toBe(10n); // 1% of 1000 released
  });

  it("adds a coverage vault output in the buy asset", () => {
    const o = adaOrder({
      coverage: { vault: { payment: { type: "key", hash: "77".repeat(28) } }, premiumBps: 500n, policyRef: { txHash: "00".repeat(32), outputIndex: 0 } },
    });
    const recipe = planTakerFillV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o) }, buyAmount: 100n, fundingInputs: funding });
    const cov = recipe.outputs.find((x) => x.role === "coverage")!;
    expect(cov.assets[unit(TOKEN_POLICY, TOKEN_NAME)]).toBe(5n); // 5% of 100
  });

  it("mints a receipt bound to the fill (bought == buy_amount), name = sha256(cbor(orderRef))", () => {
    const o = adaOrder();
    const recipe = planTakerFillV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o) }, buyAmount: 400n, fundingInputs: funding, mintReceipt: true });
    const receiptUnit = RECEIPT_POLICY + receiptTokenName(orderRef);
    const receiptMint = recipe.mints.find((g) => g.assets.some((m) => m.unit === receiptUnit))!;
    expect(receiptMint).toBeDefined();
    expect(receiptMint.assets[0]!.quantity).toBe(1n);
    const receiptOut = recipe.outputs.find((x) => x.role === "receipt")!;
    expect(receiptOut.assets[receiptUnit]).toBe(1n);
    // full fill: beacon burn group + receipt group
    expect(recipe.mints.length).toBe(2);
    expect(recipe.refInputs.length).toBe(3); // spend + beacon + receipt
  });
});

describe("planTakerFillV4Tx — expiry + guards", () => {
  it("sets validTo to expiry-1 when the order has a deadline", () => {
    const o = adaOrder({ validBeforeTime: 1_700_000_000_000n });
    const recipe = planTakerFillV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o) }, buyAmount: 400n, fundingInputs: funding });
    expect(recipe.validToUnixMs).toBe(1_699_999_999_999);
  });

  it("propagates planner guards (overfill / dust)", () => {
    const o = adaOrder();
    expect(() => planTakerFillV4Tx({ deployment, order: { datum: o, utxo: orderRef, scriptValue: orderValue(o) }, buyAmount: 401n, fundingInputs: funding })).toThrow(/exceeds/);
  });
});
