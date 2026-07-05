import { describe, it, expect } from "vitest";
import {
  ratioReleased,
  requiredDeposit,
  feeAmount,
  coveragePremium,
} from "../../src/ratioV4.js";
import {
  computeFillPlanV4,
  computeSwapPlanV4,
  addAsset,
  quantityOf,
} from "../../src/fillPlanV4.js";
import { pairBeaconName, offerBeaconName, askBeaconName } from "../../src/beaconsV4.js";
import { unit, type ChainValue } from "../../src/discovery.js";
import type { OrderDatumV4, TwoWayOrderDatumV4 } from "../../src/datumV4.js";
import type { OwnerAddress, OutputRef } from "../../src/datum.js";

const BEACON = "22".repeat(28);
const TOKEN_POLICY = "aa".repeat(28);
const TOKEN_NAME = "54455354";
const owner: OwnerAddress = {
  payment: { type: "key", hash: "44".repeat(28) },
  stake: { type: "key", hash: "33".repeat(28) },
};
const orderRef: OutputRef = { txHash: "aa".repeat(32), outputIndex: 1 };
const DEPOSIT = 2_000_000n;

// ---- ratio helpers vs the on-chain vectors ----

describe("V4 ratio/deposit/fee arithmetic (mirrors Aiken)", () => {
  it("ratioReleased floors, maker-favorable", () => {
    expect(ratioReleased(100_000_000n, 400n, 400n)).toBe(100_000_000n); // full
    expect(ratioReleased(100_000_000n, 400n, 100n)).toBe(25_000_000n); // quarter
    expect(ratioReleased(100n, 3n, 1n)).toBe(33n); // 33.33 -> 33
    expect(ratioReleased(5n, 100n, 1n)).toBe(0n); // dust
  });
  it("requiredDeposit ceils, maker-favorable", () => {
    expect(requiredDeposit(100n, 21n, 1n)).toBe(2100n);
    expect(requiredDeposit(1n, 21n, 1_000_000n)).toBe(1n); // 0.000021 -> 1
    expect(requiredDeposit(7n, 3n, 2n)).toBe(11n); // 10.5 -> 11
    expect(requiredDeposit(100n, 50_000n, 1n)).toBe(5_000_000n);
    expect(requiredDeposit(1_000_000n, 21n, 1_000_000n)).toBe(21n);
  });
  it("feeAmount: 0 under Model B, max(1,...) under Model A", () => {
    expect(feeAmount(1000n, 0)).toBe(0n);
    expect(feeAmount(1000n, 100)).toBe(10n); // 1%
    expect(feeAmount(50n, 100)).toBe(1n); // floors to 0 -> max(1,...)=1
  });
  it("coveragePremium: max(1, buy*bps/10000) in buy asset", () => {
    expect(coveragePremium(100n, 500n)).toBe(5n);
    expect(coveragePremium(1n, 500n)).toBe(1n);
  });
});

// ---- one-way fill plans ----

function adaOrder(): OrderDatumV4 {
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
  };
}

function orderValue(o: OrderDatumV4): ChainValue {
  // deposit + sell asset + 3 beacons
  let v: ChainValue = { lovelace: DEPOSIT, assets: {} };
  v = addAsset(v, o.policyIdSell, o.assetNameSell, o.amountSell);
  v = addAsset(v, o.beaconPolicy, pairBeaconName(o.policyIdSell, o.assetNameSell, o.policyIdBuy, o.assetNameBuy), 1n);
  v = addAsset(v, o.beaconPolicy, offerBeaconName(o.policyIdSell, o.assetNameSell), 1n);
  v = addAsset(v, o.beaconPolicy, askBeaconName(o.policyIdBuy, o.assetNameBuy), 1n);
  return v;
}

describe("V4 one-way fill plan", () => {
  it("full fill: owner gets deposit + bought asset, no beacons/sell", () => {
    const o = adaOrder();
    const plan = computeFillPlanV4(o, orderValue(o), 400n, 0);
    expect(plan.kind).toBe("full");
    expect(plan.released).toBe(100_000_000n);
    // owner: 2 ADA deposit back + 400 TOKEN; no beacons, no sell ADA left
    expect(plan.ownerPayout.lovelace).toBe(DEPOSIT);
    expect(quantityOf(plan.ownerPayout, TOKEN_POLICY, TOKEN_NAME)).toBe(400n);
    expect(plan.ownerPayout.assets[unit(BEACON, pairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME))]).toBeUndefined();
    expect(plan.fee).toBeUndefined();
    expect(plan.continuation).toBeUndefined();
  });

  it("partial fill: continuation keeps beacons+deposit, drops released; owner gets buy", () => {
    const o = adaOrder();
    const plan = computeFillPlanV4(o, orderValue(o), 100n, 0);
    expect(plan.kind).toBe("partial");
    expect(plan.released).toBe(25_000_000n);
    expect(plan.continuation!.newAmountSell).toBe(75_000_000n);
    expect(plan.continuation!.newAmountBuy).toBe(300n);
    // continuation lovelace = deposit + remaining sell (100M-25M) = 77M
    expect(plan.continuation!.value.lovelace).toBe(DEPOSIT + 75_000_000n);
    // 3 beacons still present
    expect(quantityOf(plan.continuation!.value, BEACON, pairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME))).toBe(1n);
    // owner receives 100 TOKEN
    expect(quantityOf(plan.ownerPayout, TOKEN_POLICY, TOKEN_NAME)).toBe(100n);
  });

  it("Model-A fee: token-sell full fill pays 1% of released in the sell token", () => {
    const o: OrderDatumV4 = {
      ...adaOrder(),
      policyIdSell: TOKEN_POLICY,
      assetNameSell: TOKEN_NAME,
      amountSell: 1000n,
      policyIdBuy: "",
      assetNameBuy: "",
      amountBuy: 50_000_000n,
    };
    const plan = computeFillPlanV4(o, orderValue(o), 50_000_000n, 100);
    expect(plan.released).toBe(1000n);
    expect(quantityOf(plan.fee!.value, TOKEN_POLICY, TOKEN_NAME)).toBe(10n);
  });

  it("coverage: premium in buy asset to the vault", () => {
    const o: OrderDatumV4 = {
      ...adaOrder(),
      coverage: {
        vault: { payment: { type: "key", hash: "77".repeat(28) } },
        premiumBps: 500n,
        policyRef: { txHash: "00".repeat(32), outputIndex: 0 },
      },
    };
    const plan = computeFillPlanV4(o, orderValue(o), 100n, 0);
    expect(quantityOf(plan.coverage!.premium, TOKEN_POLICY, TOKEN_NAME)).toBe(5n);
  });

  it("rejects overfill, dust, and below-min-partial", () => {
    const o = adaOrder();
    expect(() => computeFillPlanV4(o, orderValue(o), 401n, 0)).toThrow(/exceeds/);
    const dust: OrderDatumV4 = { ...o, amountSell: 5n, amountBuy: 100n };
    expect(() => computeFillPlanV4(dust, orderValue(dust), 1n, 0)).toThrow(/dust/);
    const floored: OrderDatumV4 = { ...o, minPartialFill: 200n };
    expect(() => computeFillPlanV4(floored, orderValue(floored), 100n, 0)).toThrow(/min_partial_fill/);
  });
});

// ---- two-way swap plans ----

function ammOrder(): TwoWayOrderDatumV4 {
  return {
    version: 4n,
    beaconPolicy: BEACON,
    owner,
    ownerRaw: { kind: "constr", alt: 0, fields: [] },
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
}

function ammValue(): ChainValue {
  // 50 ADA reserve + deposit + 1000 TOKEN (beacons omitted; swap math doesn't need them here)
  let v: ChainValue = { lovelace: DEPOSIT + 50_000_000n, assets: {} };
  v = addAsset(v, TOKEN_POLICY, TOKEN_NAME, 1000n);
  return v;
}

describe("V4 two-way swap plan", () => {
  it("take TOKEN (asset2), deposit ADA at 50000 lovelace/token", () => {
    const plan = computeSwapPlanV4(ammOrder(), ammValue(), false, 100n, 0);
    expect(plan.deposit).toBe(5_000_000n);
    // continuation: -100 TOKEN, +5 ADA
    expect(quantityOf(plan.continuationValue, TOKEN_POLICY, TOKEN_NAME)).toBe(900n);
    expect(plan.continuationValue.lovelace).toBe(DEPOSIT + 55_000_000n);
  });

  it("take ADA (asset1), deposit TOKEN at 21/1e6", () => {
    const plan = computeSwapPlanV4(ammOrder(), ammValue(), true, 1_000_000n, 0);
    expect(plan.deposit).toBe(21n);
    expect(plan.continuationValue.lovelace).toBe(DEPOSIT + 49_000_000n);
    expect(quantityOf(plan.continuationValue, TOKEN_POLICY, TOKEN_NAME)).toBe(1021n);
  });

  it("rejects over-take beyond reserve", () => {
    expect(() => computeSwapPlanV4(ammOrder(), ammValue(), false, 1001n, 0)).toThrow(/exceeds/);
  });

  it("min-take enforced unless draining the whole side", () => {
    const o: TwoWayOrderDatumV4 = { ...ammOrder(), minTake2: 500n };
    expect(() => computeSwapPlanV4(o, ammValue(), false, 100n, 0)).toThrow(/min_take/);
    // draining all 1000 is exempt
    const plan = computeSwapPlanV4(o, ammValue(), false, 1000n, 0);
    expect(plan.deposit).toBe(50_000_000n);
  });
});
