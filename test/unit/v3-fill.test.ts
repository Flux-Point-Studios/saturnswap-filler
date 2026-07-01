// computeFillPlanV3 — the V3 covered-order fill logic: the Aegis premium output, the
// min_partial_fill floor, and the coverage/floor carry-forward on the partial-fill relist.
// All amounts base units; pure (no chain/lucid provider needed).

import { describe, it, expect } from "vitest";
import { computeFillPlanV3 } from "../../src/fillV3.js";
import { decodeSwapDatumV3Hex, type Coverage } from "../../src/datumV3.js";
import { unit, type Order } from "../../src/discovery.js";
import { V3_FEE_ADDRESS_PREPROD } from "../../src/contract.js";

const V3_ADDR = "addr_test1wqr2arhy80hmudh64zkj89pn5sgjq8wtux8kwgdkpjfhnwczwmwqk";
const V3_HASH = "06ae8ee43befbe36faa8ad239433a411201dcbe18f6721b60c9379bb";
const V3_REF = "8523aaaf17eb302905bf16dc9b8a53f920bd8a9771e6eb374ce1fc18cf5b50a0";
const VAULT_HASH = "f57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465";
const POLICY_REF = { txHash: "ce456261980c9d1c20ec74231080093ea2c65ed928dd7533e41b93a75bef5703", outputIndex: 0 };
const TOKEN = "0ff71ae2bdba25bb5e1805983c8e7924edfc77f808f4f8f6cc421ce4";
const NAME = "45445354"; // EDST
const OWNER = { payment: { type: "key" as const, hash: "5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4" } };

const coverage = (premiumBps: bigint): Coverage => ({
  vault: { payment: { type: "script", hash: VAULT_HASH } },
  vaultRaw: { kind: "constr", alt: 0, fields: [] },
  premiumBps,
  policyRef: POLICY_REF,
});

function v3Order(o: {
  txByte: string;
  sell: { policyId: string; assetName: string; amount: bigint };
  buy: { policyId: string; assetName: string; amount: bigint };
  scriptLovelace: bigint;
  minPartialFill: bigint;
  coverage: Coverage | null;
}): Order {
  return {
    utxo: { txHash: o.txByte.repeat(32), outputIndex: 0 },
    orderAddress: V3_ADDR,
    version: "v3",
    plutusVersion: "v3",
    scriptHash: V3_HASH,
    refScript: { txHash: V3_REF, outputIndex: 0 },
    feePercentX100: 100,
    feeAddress: V3_FEE_ADDRESS_PREPROD,
    datum: {
      owner: OWNER,
      ownerRaw: { kind: "constr", alt: 0, fields: [] },
      policyIdSell: o.sell.policyId,
      assetNameSell: o.sell.assetName,
      amountSell: o.sell.amount,
      policyIdBuy: o.buy.policyId,
      assetNameBuy: o.buy.assetName,
      amountBuy: o.buy.amount,
      validBeforeTime: null,
      outputReference: { txHash: "00".repeat(32), outputIndex: 0 },
    },
    scriptValue: {
      lovelace: o.scriptLovelace,
      assets: o.sell.policyId === "" ? {} : { [unit(o.sell.policyId, o.sell.assetName)]: o.sell.amount },
    },
    sell: o.sell,
    buy: o.buy,
    priceBaseUnits: Number(o.sell.amount) / Number(o.buy.amount),
    validBeforeTime: null,
    minPartialFill: o.minPartialFill,
    coverage: o.coverage,
  };
}

// covered, sell TOKEN → buy ADA, premium 1% (100 bps), floor 50M
const coveredAdaBuy = v3Order({
  txByte: "a1",
  sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
  buy: { policyId: "", assetName: "", amount: 300_000_000n },
  scriptLovelace: 2_047_250n,
  minPartialFill: 50_000_000n,
  coverage: coverage(100n),
});

// covered, sell ADA → buy TOKEN, premium 2% (200 bps), no floor
const coveredTokenBuy = v3Order({
  txByte: "b2",
  sell: { policyId: "", assetName: "", amount: 100_000_000n },
  buy: { policyId: TOKEN, assetName: NAME, amount: 50_000_000n },
  scriptLovelace: 102_000_000n,
  minPartialFill: 0n,
  coverage: coverage(200n),
});

// uncovered twin of coveredTokenBuy
const uncovered = v3Order({
  txByte: "c3",
  sell: { policyId: "", assetName: "", amount: 100_000_000n },
  buy: { policyId: TOKEN, assetName: NAME, amount: 50_000_000n },
  scriptLovelace: 102_000_000n,
  minPartialFill: 0n,
  coverage: null,
});

describe("computeFillPlanV3 — covered full fill emits the Aegis premium output", () => {
  it("buy=ADA: premium is lovelace to the vault (filled_buy * premium_bps / 10000)", () => {
    const p = computeFillPlanV3(coveredAdaBuy, coveredAdaBuy.buy.amount);
    expect(p.premium).toBeDefined();
    expect(p.premium!.required).toBe(3_000_000n); // 300M * 100 / 10000
    expect(Object.keys(p.premium!.assets)).toEqual(["lovelace"]);
    expect(p.premium!.assets["lovelace"]).toBe(3_000_000n); // > min-utxo, not floored
    expect(p.premium!.vaultAddressBech32.startsWith("addr_test1w")).toBe(true); // preprod enterprise script
    // owner (ADA-buy, non-ADA-sell full fill): lovelace >= amount_buy + script lovelace
    expect(p.ownerOutputAssets["lovelace"]).toBe(300_000_000n + 2_047_250n);
    // fee: 1% in the SELL token
    expect(p.feeOutputAssets[unit(TOKEN, NAME)]).toBe(1_000_000n);
  });

  it("buy=TOKEN: premium is the buy token to the vault + min-utxo ADA", () => {
    const p = computeFillPlanV3(coveredTokenBuy, coveredTokenBuy.buy.amount);
    expect(p.premium!.required).toBe(1_000_000n); // 50M * 200 / 10000
    expect(p.premium!.assets[unit(TOKEN, NAME)]).toBe(1_000_000n);
    expect(p.premium!.assets["lovelace"]).toBeGreaterThan(1_000_000n); // min-utxo ADA on the token output
    // owner gets the buy token; sell is ADA so owner ADA is just min-utxo
    expect(p.ownerOutputAssets[unit(TOKEN, NAME)]).toBe(50_000_000n);
    // fee in the SELL asset (ADA), floored to min-utxo (1% of 100M = 1M < the ledger min-utxo)
    expect(Object.keys(p.feeOutputAssets)).toEqual(["lovelace"]);
    expect(p.feeOutputAssets["lovelace"]).toBeGreaterThan(1_000_000n); // floored above the raw 1% fee
    expect(p.feeOutputAssets["lovelace"]).toBeLessThan(1_200_000n);
  });
});

describe("computeFillPlanV3 — uncovered orders never emit a premium", () => {
  it("no coverage ⇒ plan.premium is undefined", () => {
    const p = computeFillPlanV3(uncovered, uncovered.buy.amount);
    expect(p.premium).toBeUndefined();
    expect(p.coverage).toBeNull();
  });
});

describe("computeFillPlanV3 — min_partial_fill floor (V3 #4)", () => {
  it("a partial fill below the floor THROWS (the validator would deny)", () => {
    expect(() => computeFillPlanV3(coveredAdaBuy, 10_000_000n)).toThrow(/min_partial_fill/);
  });

  it("a partial fill at/above the floor is allowed", () => {
    const p = computeFillPlanV3(coveredAdaBuy, 60_000_000n);
    expect(p.isFullFill).toBe(false);
    expect(p.relist).toBeDefined();
    expect(p.premium!.required).toBe(600_000n); // 60M * 100 / 10000
  });

  it("a full fill is always allowed regardless of the floor", () => {
    const p = computeFillPlanV3(coveredAdaBuy, coveredAdaBuy.buy.amount);
    expect(p.isFullFill).toBe(true);
  });
});

describe("computeFillPlanV3 — partial-fill relist carries coverage + floor forward (V3 #3/#4)", () => {
  it("the relist continuation datum preserves coverage, min_partial_fill, and the relist link", () => {
    const p = computeFillPlanV3(coveredTokenBuy, 25_000_000n);
    expect(p.relist).toBeDefined();
    expect(p.premium!.required).toBe(500_000n); // 25M * 200 / 10000
    const relisted = decodeSwapDatumV3Hex(p.relist!.datumHex);
    expect(relisted.coverage).not.toBeNull();
    expect(relisted.coverage!.premiumBps).toBe(200n);
    expect(relisted.coverage!.vault.payment).toEqual({ type: "script", hash: VAULT_HASH });
    expect(relisted.coverage!.policyRef).toEqual(POLICY_REF);
    expect(relisted.minPartialFill).toBe(0n);
    // output_reference = the SPENT order's own ref (the relist-chain link)
    expect(relisted.outputReference).toEqual(coveredTokenBuy.utxo);
  });
});

describe("computeFillPlanV3 — guards", () => {
  it("rejects a V2 order", () => {
    const v2ish = { ...uncovered, plutusVersion: "v2" as const };
    expect(() => computeFillPlanV3(v2ish, v2ish.buy.amount)).toThrow(/requires a V3 order/);
  });

  it("rejects a coverage vault that collides with the owner address", () => {
    const bad = v3Order({
      txByte: "d4",
      sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
      buy: { policyId: "", assetName: "", amount: 300_000_000n },
      scriptLovelace: 2_047_250n,
      minPartialFill: 0n,
      coverage: { vault: OWNER, vaultRaw: { kind: "constr", alt: 0, fields: [] }, premiumBps: 100n, policyRef: POLICY_REF },
    });
    expect(() => computeFillPlanV3(bad, bad.buy.amount)).toThrow(/distinct/);
  });
});
