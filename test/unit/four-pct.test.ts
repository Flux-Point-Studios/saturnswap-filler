// Legacy 4% run-off deployment (hash 1af84a9e…, ref 86cdaeed…#0, fee_percent_x100 = 400).
// Re-added as an OPTIONAL in-scope target: aggregators MAY fill 4% orders for extra depth.
// These tests pin the ONE 4%-specific variable — the fee the validator's is_fee_paid_to_address
// check reads — and confirm per-order resolution, discovery of both versions, a 4% fill plan,
// and a MIXED 1%+4% batch where each fee output carries its OWN rate + OWN PaymentDatum.
//
// The mechanism itself is on-chain-proven: the reference filler landed a NON-AUTH 4% fill
// against the live 1af84a9e validator earlier (the FRENCHIE order, preprod), and the non-auth
// 1% path is mainnet-proven (aea570815f…). Only the compiled fee_percent constant differs
// between the two validators, so a correct 400-rate fee output is the whole confirmation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEPLOYMENTS,
  MAINNET_DEPLOYMENTS,
  PREPROD_DEPLOYMENTS,
  deploymentByScriptHash,
  deploymentByOrderAddress,
  FEE_ADDRESS,
  LEGACY_FEE_PERCENT_X100,
  V3_SCRIPT_HASH_MAINNET,
  V3_SCRIPT_HASH_PREPROD,
  V3_REF_SCRIPT_MAINNET,
} from "../../src/contract.js";
import {
  koiosRowToRawUtxo,
  normalizeBook,
  discoverOrders,
  unit,
  type ChainProvider,
  type RawUtxo,
  type Order,
} from "../../src/discovery.js";
import { calculateFee, fillSellAndFee } from "../../src/ratio.js";
import { computeFillPlan } from "../../src/fill.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../fixtures/live_1pct_book.json"), "utf8"));

const ADDR_1PCT = DEPLOYMENTS.find((d) => d.version === "1pct")!.orderAddress;
const ADDR_4PCT = DEPLOYMENTS.find((d) => d.version === "4pct")!.orderAddress;
const HASH_4PCT = "1af84a9e697e1e7b042a0a06f061e88182feb9e9ada950b36a916bd5";
const REF_4PCT = "86cdaeed2afa48821a229f09582ddc8a350fcea2f770875cd5ea92b230b7a0a8";

// A 4% order: the live worked Koios row re-homed at the 4% address (the SwapDatum wire format
// is identical across deployments — only the script address / payment credential differ).
const worked4pctRow = {
  ...fixture.find((u: any) => u.tx_hash.startsWith("a28c54cc")),
  address: ADDR_4PCT,
  payment_cred: HASH_4PCT,
};

const TOKEN = "50cd0a2d8f2cc2092bbc5fb87c2c9488afee3d6fc4458fc8a0e89f8e";
const NAME = "4652454e43484945205749464620"; // "FRENCHIE WIFU "
const OWNER = {
  payment: { type: "key" as const, hash: "5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4" },
  stake: { type: "key" as const, hash: "96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305" },
};

// 4% token-sell order (SELL a token, BUY ADA) — full fill releases the whole sell leg, so the
// 4% fee in the SELL TOKEN is exact (not floored by ADA min-utxo). 1% would be 4x smaller.
function tokenSellOrder(feePercentX100: number, version: Order["version"], scriptHash: string, ref: string, addr: string, txByte: string): Order {
  return {
    utxo: { txHash: txByte.repeat(32), outputIndex: 0 },
    orderAddress: addr,
    version,
    plutusVersion: "v2",
    scriptHash,
    refScript: { txHash: ref, outputIndex: 0 },
    feePercentX100,
    feeAddress: FEE_ADDRESS,
    datum: {
      owner: OWNER,
      ownerRaw: { kind: "constr", alt: 0, fields: [] },
      policyIdSell: TOKEN,
      assetNameSell: NAME,
      amountSell: 100_000_000n,
      policyIdBuy: "",
      assetNameBuy: "",
      amountBuy: 300_000_000n,
      validBeforeTime: null,
      outputReference: { txHash: "00", outputIndex: 0 },
    },
    scriptValue: { lovelace: 2_047_250n, assets: { [unit(TOKEN, NAME)]: 100_000_000n } },
    sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
    buy: { policyId: "", assetName: "", amount: 300_000_000n },
    priceBaseUnits: 100_000_000 / 300_000_000,
    validBeforeTime: null,
    minPartialFill: 0n,
    coverage: null,
  };
}

const fourPctTokenSell = tokenSellOrder(LEGACY_FEE_PERCENT_X100, "4pct", HASH_4PCT, REF_4PCT, ADDR_4PCT, "44");

describe("4% fee math (calculate_fee with fee_percent_x100 = 400, rounds DOWN)", () => {
  it("calculateFee uses the 400 rate: sell * 400 / 10000", () => {
    expect(calculateFee(100_000_000n, 400)).toBe(4_000_000n); // 4% of 100M = 4M
    expect(calculateFee(100_000_000n, 100)).toBe(1_000_000n); // contrast: 1% = 1M
    expect(calculateFee(4_235_165n, 400)).toBe(169_406n); // 4235165*400/10000 = 169406.6 -> 169406
  });

  it("fillSellAndFee takes 4% of the proportional released sell", () => {
    const { newSwapAmountSell, totalFee } = fillSellAndFee(
      fourPctTokenSell.sell.amount,
      fourPctTokenSell.buy.amount,
      fourPctTokenSell.buy.amount, // full fill
      400,
    );
    expect(newSwapAmountSell).toBe(100_000_000n);
    expect(totalFee).toBe(4_000_000n); // 100M * 400 / 10000
  });

  it("4% dust guard: a released sell < 25 base units floors the fee to 0 -> throws", () => {
    expect(() => fillSellAndFee(100_000_000n, 300_000_000n, 1n, 400)).toThrow(/dust fill/);
  });
});

describe("per-order deployment resolution knows BOTH versions", () => {
  it("DEPLOYMENTS carries the 1%, 4%, and V3 deployments", () => {
    expect(DEPLOYMENTS.map((d) => d.version).sort()).toEqual(["1pct", "4pct", "v3"]);
  });

  it("deploymentByScriptHash(1af84a9e…) -> 4pct, fee 400, ref 86cdaeed…#0", () => {
    const d = deploymentByScriptHash(HASH_4PCT)!;
    expect(d.version).toBe("4pct");
    expect(d.feePercentX100).toBe(400);
    expect(d.refScript.txHash).toBe(REF_4PCT);
    expect(d.refScript.outputIndex).toBe(0);
  });

  it("deploymentByOrderAddress(4% addr) -> the same 4% deployment", () => {
    const d = deploymentByOrderAddress(ADDR_4PCT)!;
    expect(d.version).toBe("4pct");
    expect(d.feePercentX100).toBe(400);
  });

  it("the 4% deployment shares the SAME baked fee_address as the 1%", () => {
    // ground truth: identical fee_address (payment cred cd51fc17…) across both deployments
    expect(FEE_ADDRESS).toBe(
      "addr1q8x4rlqhrq4rhqhnkamw3fdqmzqgum79yragg4gptcjpphmrc2rpt0exfch4s47fu32amr45vh9wg053hmcx9k7kkcrq6kxftd",
    );
  });

  it("deploymentByScriptHash(6023f59d…) -> the LIVE mainnet V3 (fee_percent 100, mainnet fee_address, ref de19f6a9…#0)", () => {
    const d = deploymentByScriptHash(V3_SCRIPT_HASH_MAINNET)!;
    expect(d.version).toBe("v3");
    expect(d.plutusVersion).toBe("v3");
    expect(d.network).toBe("mainnet");
    expect(d.feePercentX100).toBe(100);
    expect(d.feeAddress).toBe(FEE_ADDRESS); // mainnet V3 bakes the SAME production fee_address
    expect(d.refScript).toEqual(V3_REF_SCRIPT_MAINNET);
    // it is the one carried in the production discovery registry
    expect(MAINNET_DEPLOYMENTS).toContain(d);
    expect(DEPLOYMENTS).toContain(d);
  });

  it("the preprod V3 (ec457591…) stays resolvable but is NOT in the production registry", () => {
    const d = deploymentByScriptHash(V3_SCRIPT_HASH_PREPROD)!;
    expect(d.network).toBe("preprod");
    expect(PREPROD_DEPLOYMENTS).toContain(d);
    expect(DEPLOYMENTS).not.toContain(d); // production discovery never scans preprod
  });
});

describe("discovery normalizes 4% orders (tagged with version/ref/feePercentX100)", () => {
  it("a UTxO at the 4% address resolves to version 4pct / fee 400 / ref 86cdaeed", () => {
    const [o] = normalizeBook([koiosRowToRawUtxo(worked4pctRow)]);
    expect(o).toBeTruthy();
    expect(o!.version).toBe("4pct");
    expect(o!.scriptHash).toBe(HASH_4PCT);
    expect(o!.feePercentX100).toBe(400);
    expect(o!.refScript.txHash).toBe(REF_4PCT);
    // datum decodes identically to the 1% worked order (same wire format)
    expect(o!.sell.amount).toBe(25_000_000n);
    expect(o!.buy.amount).toBe(125_124_999_999n);
  });
});

describe("discoverOrders returns BOTH 1% and 4% orders, each correctly tagged", () => {
  const provider: ChainProvider = {
    async utxosAtAddress(address: string): Promise<RawUtxo[]> {
      if (address === ADDR_1PCT) return fixture.map(koiosRowToRawUtxo);
      if (address === ADDR_4PCT) return [koiosRowToRawUtxo(worked4pctRow)];
      return [];
    },
  };

  it("the book spans both deployments with per-version fee_percent", async () => {
    const book = await discoverOrders({ provider });
    const versions = new Set(book.map((o) => o.version));
    expect(versions).toEqual(new Set(["1pct", "4pct"]));
    for (const o of book) {
      if (o.version === "1pct") expect(o.feePercentX100).toBe(100);
      if (o.version === "4pct") expect(o.feePercentX100).toBe(400);
    }
    // every 1% order points at the 1% ref script; every 4% order at the 4% ref script
    expect(book.filter((o) => o.version === "1pct").every((o) => o.refScript.txHash.startsWith("0e16cd00"))).toBe(true);
    expect(book.filter((o) => o.version === "4pct").every((o) => o.refScript.txHash.startsWith("86cdaeed"))).toBe(true);
  });

  it("a single-version scan still works (versions filter)", async () => {
    const onlyFour = await discoverOrders({ provider, versions: ["4pct"] });
    expect(onlyFour.length).toBeGreaterThan(0);
    expect(onlyFour.every((o) => o.version === "4pct")).toBe(true);
  });
});

describe("computeFillPlan — 4% fill plan (the validator's is_fee_paid_to_address basis)", () => {
  const plan = computeFillPlan(fourPctTokenSell, fourPctTokenSell.buy.amount); // full fill

  it("takes 4% in the SELL token (vs 1% would be 1,000,000)", () => {
    expect(plan.newSwapAmountSell).toBe(100_000_000n);
    expect(plan.totalFee).toBe(4_000_000n);
    expect(plan.feeOutputAssets[unit(TOKEN, NAME)]).toBe(4_000_000n);
  });

  it("fee output goes to the shared fee_address with the per-order PaymentDatum (spent ref)", () => {
    // PaymentDatum is keyed by THIS order's own tx_id#ix — distinguishes it even though the
    // fee_address is shared with 1% orders.
    expect(plan.paymentDatumHex).toContain("4444444444444444"); // tx byte 0x44 repeated (spent ref)
    expect(plan.feeOutputAssets["lovelace"]).toBeGreaterThan(1_000_000n); // token-sell fee carries min-utxo ADA
  });

  it("owner (ADA-buy) output = amount_buy + script lovelace (owner_paid_enough)", () => {
    expect(plan.ownerOutputAssets["lovelace"]).toBe(300_000_000n + 2_047_250n);
    expect(Object.keys(plan.ownerOutputAssets)).toEqual(["lovelace"]);
  });

  it("an ADA-sell 4% order pays 4% lovelace when it clears min-utxo", () => {
    // 100 ADA sell, buy a token; full fill releases 100 ADA, 4% = 4 ADA > min-utxo.
    const adaSell4: Order = {
      ...fourPctTokenSell,
      utxo: { txHash: "55".repeat(32), outputIndex: 0 },
      datum: { ...fourPctTokenSell.datum, policyIdSell: "", assetNameSell: "", amountSell: 100_000_000n, policyIdBuy: TOKEN, assetNameBuy: NAME, amountBuy: 50_000_000n },
      scriptValue: { lovelace: 102_000_000n, assets: {} },
      sell: { policyId: "", assetName: "", amount: 100_000_000n },
      buy: { policyId: TOKEN, assetName: NAME, amount: 50_000_000n },
    };
    const p = computeFillPlan(adaSell4, adaSell4.buy.amount);
    expect(p.totalFee).toBe(4_000_000n); // 100M lovelace * 400 / 10000 = 4 ADA
    expect(p.feeOutputAssets["lovelace"]).toBe(4_000_000n); // 4 ADA > min-utxo -> not floored
  });

  it("keeps the token->token full-fill safety throw for 4% orders", () => {
    const tokToTok4: Order = {
      ...fourPctTokenSell,
      utxo: { txHash: "66".repeat(32), outputIndex: 0 },
      datum: { ...fourPctTokenSell.datum, policyIdBuy: TOKEN, assetNameBuy: "53554e444145" },
      buy: { policyId: TOKEN, assetName: "53554e444145", amount: 300_000_000n },
    };
    expect(() => computeFillPlan(tokToTok4, tokToTok4.buy.amount)).toThrow(/token→token orders must be filled as a PARTIAL fill/);
  });

  it("a 4% partial fill still emits a relist continuation", () => {
    const partial = computeFillPlan(fourPctTokenSell, 100_000_000n);
    expect(partial.isFullFill).toBe(false);
    expect(partial.relist).toBeDefined();
    // partial token-sell fee is still 4% of the released proportional sell
    expect(partial.totalFee).toBe(calculateFee(partial.newSwapAmountSell, 400));
  });
});

describe("MIXED 1%+4% multi-fill: each fee output carries its OWN rate + OWN PaymentDatum", () => {
  // order A = a 1% token-sell; order B = a 4% token-sell. Mirror buildMultiTakerFill's layout.
  const orderA = tokenSellOrder(100, "1pct", "73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f", "0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9", ADDR_1PCT, "aa");
  const orderB = fourPctTokenSell; // 4%, tx byte 0x44
  const planA = computeFillPlan(orderA, orderA.buy.amount);
  const planB = computeFillPlan(orderB, orderB.buy.amount);

  it("the 1% fee output uses the 100 rate; the 4% fee output uses the 400 rate", () => {
    expect(planA.totalFee).toBe(calculateFee(planA.newSwapAmountSell, 100));
    expect(planB.totalFee).toBe(calculateFee(planB.newSwapAmountSell, 400));
    // same released sell (both 100M token), so the 4% fee is exactly 4x the 1% fee
    expect(planA.newSwapAmountSell).toBe(planB.newSwapAmountSell);
    expect(planA.feeOutputAssets[unit(TOKEN, NAME)]).toBe(1_000_000n);
    expect(planB.feeOutputAssets[unit(TOKEN, NAME)]).toBe(4_000_000n);
  });

  it("fee outputs to the SHARED fee_address are NEVER coalescible (distinct PaymentDatum per order)", () => {
    // both fee outputs go to FEE_ADDRESS but carry distinct PaymentDatum (distinct spent refs),
    // so value_paid_to_with_datum matches exactly one per order — a merged fee output would deny.
    expect(planA.paymentDatumHex).not.toBe(planB.paymentDatumHex);
  });

  it("author-order output layout [ownerA, feeA, ownerB, feeB] (both full fills, no relist)", () => {
    const plans = [planA, planB];
    let count = 0;
    const ownerIdx: number[] = [];
    for (const p of plans) {
      ownerIdx.push(count);
      count += 2 + (p.relist ? 1 : 0);
    }
    expect(ownerIdx).toEqual([0, 2]);
  });
});
