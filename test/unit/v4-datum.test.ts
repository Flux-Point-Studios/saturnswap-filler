import { describe, it, expect } from "vitest";
import {
  orderDatumToPlutusData,
  decodeOrderDatumV4,
  twoWayDatumToPlutusData,
  decodeTwoWayDatumV4,
  fillRedeemer,
  cancelRedeemer,
  repriceRedeemer,
  twoWaySwapRedeemer,
  receiptTokenName,
  fillReceiptDatumV4ToPlutusData,
  type CoverageV4,
} from "../../src/datumV4.js";
import { plutusToBytes, plutusToHex } from "../../src/plutus.js";
import type { OwnerAddress, OutputRef } from "../../src/datum.js";

const owner: OwnerAddress = {
  payment: { type: "key", hash: "44".repeat(28) },
  stake: { type: "key", hash: "33".repeat(28) },
};
const orderRef: OutputRef = { txHash: "aa".repeat(32), outputIndex: 1 };
const TOKEN_POLICY = "aa".repeat(28);
const TOKEN_NAME = "54455354";

describe("V4 one-way OrderDatum round-trip", () => {
  const base = {
    beaconPolicy: "22".repeat(28),
    owner,
    policyIdSell: "",
    assetNameSell: "",
    amountSell: 100_000_000n,
    policyIdBuy: TOKEN_POLICY,
    assetNameBuy: TOKEN_NAME,
    amountBuy: 400n,
    validBeforeTime: null,
    minPartialFill: 0n,
    coverage: null as CoverageV4 | null,
    outputReference: orderRef,
  };

  it("encodes to a Constr0 with 13 fields and decodes back", () => {
    const bytes = plutusToBytes(orderDatumToPlutusData(base));
    const back = decodeOrderDatumV4(bytes);
    expect(back.version).toBe(4n);
    expect(back.beaconPolicy).toBe(base.beaconPolicy);
    expect(back.amountSell).toBe(100_000_000n);
    expect(back.amountBuy).toBe(400n);
    expect(back.policyIdBuy).toBe(TOKEN_POLICY);
    expect(back.owner.payment.hash).toBe(owner.payment.hash);
    expect(back.owner.stake?.hash).toBe(owner.stake?.hash);
    expect(back.validBeforeTime).toBeNull();
    expect(back.coverage).toBeNull();
    expect(back.outputReference).toEqual(orderRef);
  });

  it("round-trips with Some(expiry) and Some(coverage)", () => {
    const cov: CoverageV4 = {
      vault: { payment: { type: "key", hash: "77".repeat(28) } },
      premiumBps: 500n,
      policyRef: { txHash: "00".repeat(32), outputIndex: 0 },
    };
    const bytes = plutusToBytes(
      orderDatumToPlutusData({ ...base, validBeforeTime: 1_700_000_000_000n, minPartialFill: 50n, coverage: cov }),
    );
    const back = decodeOrderDatumV4(bytes);
    expect(back.validBeforeTime).toBe(1_700_000_000_000n);
    expect(back.minPartialFill).toBe(50n);
    expect(back.coverage?.premiumBps).toBe(500n);
    expect(back.coverage?.vault.payment.hash).toBe("77".repeat(28));
  });
});

describe("V4 two-way TwoWayOrderDatum round-trip", () => {
  it("encodes to a Constr0 with 15 fields and decodes back", () => {
    const d = {
      beaconPolicy: "22".repeat(28),
      owner,
      policyId1: "",
      assetName1: "",
      policyId2: TOKEN_POLICY,
      assetName2: TOKEN_NAME,
      price1Num: 21n,
      price1Den: 1_000_000n,
      price2Num: 50_000n,
      price2Den: 1n,
      validBeforeTime: null,
      minTake1: 0n,
      minTake2: 0n,
      outputReference: orderRef,
    };
    const back = decodeTwoWayDatumV4(plutusToBytes(twoWayDatumToPlutusData(d)));
    expect(back.version).toBe(4n);
    expect(back.policyId1).toBe("");
    expect(back.policyId2).toBe(TOKEN_POLICY);
    expect(back.price1Num).toBe(21n);
    expect(back.price2Num).toBe(50_000n);
    expect(back.outputReference).toEqual(orderRef);
  });
});

describe("V4 redeemer constructor indices", () => {
  it("Fill = Constr0[int,int,int]", () => {
    const d = fillRedeemer(100n, 0, 1);
    expect(d.kind).toBe("constr");
    if (d.kind === "constr") {
      expect(d.alt).toBe(0);
      expect(d.fields.length).toBe(3);
    }
  });
  it("Cancel = Constr1[int], Reprice = Constr2[int,int]", () => {
    expect(cancelRedeemer(0)).toMatchObject({ kind: "constr", alt: 1 });
    expect(repriceRedeemer(0, 1)).toMatchObject({ kind: "constr", alt: 2 });
  });
  it("two-way Swap encodes Bool as Constr0/1", () => {
    const takeAsset1True = twoWaySwapRedeemer(true, 100n, 0, 1);
    const takeAsset1False = twoWaySwapRedeemer(false, 100n, 0, 1);
    if (takeAsset1True.kind === "constr" && takeAsset1False.kind === "constr") {
      expect(takeAsset1True.fields[0]).toMatchObject({ kind: "constr", alt: 1 });
      expect(takeAsset1False.fields[0]).toMatchObject({ kind: "constr", alt: 0 });
    }
  });
});

describe("V4 fill-receipt token name (cross-checked vs on-chain vector)", () => {
  it("matches sha2_256(cbor(OutputReference)) pinned in receipt_test.ak", () => {
    // order_ref() = (aa*32, index 1) — same vector the Aiken test pins
    expect(receiptTokenName(orderRef)).toBe(
      "feb569f652252c9e3afca8a223332807cc01336c0ca4399e064d8af9519125ee",
    );
  });

  it("sentinel (00*32, 0) matches its pinned vector", () => {
    expect(receiptTokenName({ txHash: "00".repeat(32), outputIndex: 0 })).toBe(
      "69120acaa9f82845cc85c0cf11def4fe582c3107c39d36796fd4848afc4a9149",
    );
  });

  it("FillReceiptDatum encodes to Constr0 with 8 fields", () => {
    const d = fillReceiptDatumV4ToPlutusData({
      orderReference: orderRef,
      maker: owner,
      policyIdSell: "",
      assetNameSell: "",
      sold: 100_000_000n,
      policyIdBuy: TOKEN_POLICY,
      assetNameBuy: TOKEN_NAME,
      bought: 400n,
    });
    expect(d).toMatchObject({ kind: "constr", alt: 0 });
    if (d.kind === "constr") expect(d.fields.length).toBe(8);
  });
});

describe("V4 datum determinism", () => {
  it("re-encoding a decoded datum is byte-identical (canonical form)", () => {
    const base = {
      beaconPolicy: "22".repeat(28),
      owner,
      policyIdSell: TOKEN_POLICY,
      assetNameSell: TOKEN_NAME,
      amountSell: 1000n,
      policyIdBuy: "",
      assetNameBuy: "",
      amountBuy: 50_000_000n,
      validBeforeTime: 1_700_000_000_000n,
      minPartialFill: 10n,
      coverage: null,
      outputReference: orderRef,
    };
    const hex1 = plutusToHex(orderDatumToPlutusData(base));
    const decoded = decodeOrderDatumV4(plutusToBytes(orderDatumToPlutusData(base)));
    const hex2 = plutusToHex(
      orderDatumToPlutusData({
        beaconPolicy: decoded.beaconPolicy,
        owner: decoded.owner,
        policyIdSell: decoded.policyIdSell,
        assetNameSell: decoded.assetNameSell,
        amountSell: decoded.amountSell,
        policyIdBuy: decoded.policyIdBuy,
        assetNameBuy: decoded.assetNameBuy,
        amountBuy: decoded.amountBuy,
        validBeforeTime: decoded.validBeforeTime,
        minPartialFill: decoded.minPartialFill,
        coverage: decoded.coverage,
        outputReference: decoded.outputReference,
      }),
    );
    expect(hex2).toBe(hex1);
  });
});
