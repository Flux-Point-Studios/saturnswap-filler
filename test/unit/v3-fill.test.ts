// computeFillPlanV3 — the V3 covered-order fill logic: the Aegis premium output, the
// min_partial_fill floor, and the coverage/floor carry-forward on the partial-fill relist.
// All amounts base units; pure (no chain/lucid provider needed).

import { describe, it, expect } from "vitest";
import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { buildTakerFillV3, computeFillPlanV3, computeFillReceipt } from "../../src/fillV3.js";
import { decodeFillReceiptDatum, decodeSwapDatumV3Hex, type Coverage } from "../../src/datumV3.js";
import { hexToBytes } from "../../src/cbor.js";
import { unit, type Order } from "../../src/discovery.js";
import { V3_FEE_ADDRESS_PREPROD, V3_FEE_PAYMENT_CRED_PREPROD } from "../../src/contract.js";

// Every order in this file rests on the preprod V3 deployment; wrap the (now network-required)
// pure planner at the preprod network. `max` optionally overrides the premium_bps bound.
const planPreprod = (o: Order, amt: bigint, max?: bigint) =>
  computeFillPlanV3(o, amt, "Preprod", undefined, max);

// Hardened V3 (ec457591…, supersedes 06ae8ee4…): receipt-forgery + premium under-collection fixed.
const V3_ADDR = "addr_test1wrky2av35n66krg8q9r9trjlzu5le3wqkgcywfphhcehvfg03jugc";
const V3_HASH = "ec457591a4f5ab0d070146558e5f1729fcc5c0b230472437be337625";
const V3_REF = "efb2c0dc789d9bdf0f3988c01c2ca24fe43f16706086252d7576a6a0ad25fa7e";
const VAULT_HASH = "f57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465";
const POLICY_REF = { txHash: "ce456261980c9d1c20ec74231080093ea2c65ed928dd7533e41b93a75bef5703", outputIndex: 0 };
const TOKEN = "0ff71ae2bdba25bb5e1805983c8e7924edfc77f808f4f8f6cc421ce4";
const NAME = "45445354"; // EDST
const OWNER = { payment: { type: "key" as const, hash: "5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4" } };

const coverage = (premiumBps: bigint): Coverage => ({
  vault: { payment: { type: "script", hash: VAULT_HASH } },
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
    const p = planPreprod(coveredAdaBuy, coveredAdaBuy.buy.amount);
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
    const p = planPreprod(coveredTokenBuy, coveredTokenBuy.buy.amount);
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
    const p = planPreprod(uncovered, uncovered.buy.amount);
    expect(p.premium).toBeUndefined();
    expect(p.coverage).toBeNull();
  });
});

describe("computeFillPlanV3 — min_partial_fill floor (V3 #4)", () => {
  it("a partial fill below the floor THROWS (the validator would deny)", () => {
    expect(() => planPreprod(coveredAdaBuy, 10_000_000n)).toThrow(/min_partial_fill/);
  });

  it("a partial fill at/above the floor is allowed", () => {
    const p = planPreprod(coveredAdaBuy, 60_000_000n);
    expect(p.isFullFill).toBe(false);
    expect(p.relist).toBeDefined();
    expect(p.premium!.required).toBe(600_000n); // 60M * 100 / 10000
  });

  it("a full fill is always allowed regardless of the floor", () => {
    const p = planPreprod(coveredAdaBuy, coveredAdaBuy.buy.amount);
    expect(p.isFullFill).toBe(true);
  });
});

describe("computeFillPlanV3 — partial-fill relist carries coverage + floor forward (V3 #3/#4)", () => {
  it("the relist continuation datum preserves coverage, min_partial_fill, and the relist link", () => {
    const p = planPreprod(coveredTokenBuy, 25_000_000n);
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
    expect(() => planPreprod(v2ish, v2ish.buy.amount)).toThrow(/requires a V3 order/);
  });

  it("rejects a coverage vault that collides with the owner address", () => {
    const bad = v3Order({
      txByte: "d4",
      sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
      buy: { policyId: "", assetName: "", amount: 300_000_000n },
      scriptLovelace: 2_047_250n,
      minPartialFill: 0n,
      coverage: { vault: OWNER, premiumBps: 100n, policyRef: POLICY_REF },
    });
    expect(() => planPreprod(bad, bad.buy.amount)).toThrow(/distinct/);
  });

  it("rejects a coverage vault that collides with the fee address", () => {
    const bad = v3Order({
      txByte: "e5",
      sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
      buy: { policyId: "", assetName: "", amount: 300_000_000n },
      scriptLovelace: 2_047_250n,
      minPartialFill: 0n,
      coverage: {
        vault: { payment: { type: "key", hash: V3_FEE_PAYMENT_CRED_PREPROD } },
        premiumBps: 100n,
        policyRef: POLICY_REF,
      },
    });
    expect(() => planPreprod(bad, bad.buy.amount)).toThrow(/distinct/);
  });
});

describe("computeFillPlanV3 — premium ≥1 floor (V3 #6, red-team fix B)", () => {
  it("a covered order with premium_bps=0 STILL owes a floored premium of 1", () => {
    const zeroBps = v3Order({
      txByte: "f6",
      sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
      buy: { policyId: "", assetName: "", amount: 300_000_000n },
      scriptLovelace: 2_047_250n,
      minPartialFill: 0n,
      coverage: coverage(0n),
    });
    const p = planPreprod(zeroBps, zeroBps.buy.amount);
    // the on-chain floor is required = max(1, filled_buy * premium_bps / 10000) = max(1, 0) = 1
    expect(p.premium).toBeDefined();
    expect(p.premium!.required).toBe(1n);
    // buy=ADA: the output still clears min-utxo, well above the 1-lovelace requirement
    expect(p.premium!.assets["lovelace"]).toBeGreaterThan(1n);
  });

  it("a covered fill whose raw premium rounds DOWN to 0 is floored to 1", () => {
    // buy=TOKEN, premium 1 bps: a 5000-unit fill => 5000*1/10000 = 0 (rounds down) => floored to 1.
    const tinyBps = v3Order({
      txByte: "17",
      sell: { policyId: "", assetName: "", amount: 100_000_000n },
      buy: { policyId: TOKEN, assetName: NAME, amount: 50_000_000n },
      scriptLovelace: 102_000_000n,
      minPartialFill: 0n,
      coverage: coverage(1n),
    });
    const p = planPreprod(tinyBps, 5_000n);
    expect(p.premium!.required).toBe(1n);
    expect(p.premium!.assets[unit(TOKEN, NAME)]).toBe(1n);
  });
});

describe("computeFillReceipt — the fill-receipt binding (V3 #5, red-team fix A)", () => {
  it("full fill: sold = amount_sell, bought = the buy delivered to the owner output", () => {
    const plan = planPreprod(coveredAdaBuy, coveredAdaBuy.buy.amount);
    const r = computeFillReceipt(coveredAdaBuy, plan, coveredAdaBuy.sell.amount, 1_700_000_000_000n);
    expect(r.soldAmount).toBe(100_000_000n); // == order_datum.amount_sell
    // buy=ADA full fill: owner lovelace = amount_buy + script lovelace
    expect(r.boughtAmount).toBe(300_000_000n + 2_047_250n);
    expect(r.datum.maker).toEqual(OWNER);
    expect(r.datum.orderReference).toEqual(coveredAdaBuy.utxo);
    expect(r.datum.policyIdSell).toBe(TOKEN);
    expect(r.datum.policyIdBuy).toBe("");
    expect(r.datum.executedAt).toBe(1_700_000_000_000n);
    // datumHex round-trips through the codec
    expect(decodeFillReceiptDatum(hexToBytes(r.datumHex))).toEqual(r.datum);
  });

  it("partial fill: sold = script_input_sell − continuation_sell (ADA-sell)", () => {
    const plan = planPreprod(coveredTokenBuy, 25_000_000n);
    // sell is ADA; the spent order UTxO carries scriptLovelace on-chain
    const scriptInputSell = coveredTokenBuy.scriptValue.lovelace;
    const r = computeFillReceipt(coveredTokenBuy, plan, scriptInputSell, 1_700_000_000_000n);
    const continuationSell = plan.relist!.assets["lovelace"] ?? 0n;
    expect(r.soldAmount).toBe(scriptInputSell - continuationSell);
    // buy=TOKEN partial: owner receives user_sell_amount of the buy token
    expect(r.boughtAmount).toBe(25_000_000n);
    expect(r.datum.orderReference).toEqual(coveredTokenBuy.utxo);
  });

  it("covered partial, sell TOKEN → buy ADA: sold = input − continuation with the premium present", () => {
    // The mainnet crash case: a COVERED PARTIAL fill also minting the receipt. The premium output
    // sits between the fee and the relist, so `sold` must be derived from the sell delta
    // (script_input_sell − continuation_sell), NOT read off any premium-shifted output, and
    // `bought` must be the buy asset on the maker payout (owner output, index 0).
    const plan = planPreprod(coveredAdaBuy, 60_000_000n); // >= floor 50M
    expect(plan.premium).toBeDefined(); // covered ⇒ premium output present
    expect(plan.premium!.required).toBe(600_000n); // 60M * 100 / 10000
    expect(plan.relist).toBeDefined(); // partial ⇒ relist continuation present
    const scriptInputSell = coveredAdaBuy.sell.amount; // 100M TOKEN in the spent order UTxO
    const continuationSell = plan.relist!.assets[unit(TOKEN, NAME)] ?? 0n;
    const r = computeFillReceipt(coveredAdaBuy, plan, scriptInputSell, 1_700_000_000_000n);
    expect(r.soldAmount).toBe(scriptInputSell - continuationSell);
    expect(r.soldAmount).toBe(20_000_000n); // 100M − 80M relisted
    // bought = the ADA delivered to the maker payout, independent of the premium leg
    expect(r.boughtAmount).toBe(plan.ownerOutputAssets["lovelace"]);
    expect(r.boughtAmount).toBe(60_000_000n);
    expect(r.datum.orderReference).toEqual(coveredAdaBuy.utxo);
  });

  it("an uncovered order still mints a receipt (the receipt is coverage-independent)", () => {
    const plan = planPreprod(coveredTokenBuy, 25_000_000n);
    const uncoveredPlan = planPreprod(uncovered, 25_000_000n);
    const rCov = computeFillReceipt(coveredTokenBuy, plan, coveredTokenBuy.scriptValue.lovelace, 1n);
    const rUnc = computeFillReceipt(uncovered, uncoveredPlan, uncovered.scriptValue.lovelace, 1n);
    expect(rUnc.soldAmount).toBe(rCov.soldAmount);
    expect(rUnc.boughtAmount).toBe(rCov.boughtAmount);
  });

  it("rejects a V2 order", () => {
    const plan = planPreprod(uncovered, 25_000_000n);
    const v2ish = { ...uncovered, plutusVersion: "v2" as const };
    expect(() => computeFillReceipt(v2ish, plan, uncovered.scriptValue.lovelace, 1n)).toThrow(/requires a V3 order/);
  });
});

describe("computeFillPlanV3 — the premium is bounded (V3FS-01, fund-loss guard)", () => {
  // A covered order whose premium_bps forces a premium >= the fill's buy amount is malicious/
  // malformed: the premium is paid OUT OF the filler's pocket, so the planner must refuse it.
  const evil = v3Order({
    txByte: "28",
    sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
    buy: { policyId: "", assetName: "", amount: 300_000_000n },
    scriptLovelace: 2_047_250n,
    minPartialFill: 0n,
    coverage: coverage(10_001n), // > 100%
  });
  const edge = v3Order({
    txByte: "39",
    sell: { policyId: TOKEN, assetName: NAME, amount: 100_000_000n },
    buy: { policyId: "", assetName: "", amount: 300_000_000n },
    scriptLovelace: 2_047_250n,
    minPartialFill: 0n,
    coverage: coverage(10_000n), // exactly 100%
  });

  it("throws when premium_bps exceeds the default max (10_000 = 100%)", () => {
    expect(() => planPreprod(evil, evil.buy.amount)).toThrow(/exceeds max 10000/);
  });

  it("builds at exactly the max: a 100% premium equals the whole buy amount", () => {
    const p = planPreprod(edge, edge.buy.amount);
    expect(p.premium!.required).toBe(300_000_000n); // 300M * 10000 / 10000
  });

  it("honours a custom lower maxPremiumBps (refuses an otherwise-valid 100 bps order)", () => {
    expect(() => planPreprod(coveredAdaBuy, coveredAdaBuy.buy.amount, 50n)).toThrow(/exceeds max 50/);
    // …and still builds when the bound is at/above the order's premium
    expect(planPreprod(coveredAdaBuy, coveredAdaBuy.buy.amount, 100n).premium!.required).toBe(3_000_000n);
  });
});

describe("buildTakerFillV3 — fund-sufficiency guard (covered × partial × receipt crash prevention)", () => {
  // A covered partial fill that also mints the receipt carries the most outputs (owner + fee +
  // premium + relist + receipt). If the funding can't cover them, lucid pulls the reserved
  // collateral in as a spending input — shifting the order's canonical input index (⇒ the
  // validator reads the wrong input via get_own_input_fast and crashes) and leaving no collateral.
  // The guard fails fast with an actionable message instead of that cryptic on-chain crash.
  const orderUtxo = {
    txHash: coveredAdaBuy.utxo.txHash,
    outputIndex: 0,
    address: V3_ADDR,
    assets: { lovelace: coveredAdaBuy.scriptValue.lovelace, [unit(TOKEN, NAME)]: coveredAdaBuy.sell.amount },
    datum: "d87980",
  } as unknown as UTxO;
  const refUtxo = {
    txHash: V3_REF,
    outputIndex: 0,
    address: V3_ADDR,
    assets: { lovelace: 20_000_000n },
    scriptRef: { type: "PlutusV3", script: "59" },
  } as unknown as UTxO;
  function mockLucid(): LucidEvolution {
    const pp = { coinsPerUtxoByte: 4310, costModels: { PlutusV3: [100788, 420, 1, 1] } };
    const b: Record<string, unknown> = {};
    const ret = () => b;
    Object.assign(b, { collectFrom: ret, readFrom: ret, mintAssets: ret, validFrom: ret, validTo: ret });
    b.pay = { ToAddressWithData: () => b };
    b.complete = async () => {
      throw new Error("__COMPLETE_REACHED__");
    };
    const cfg = { network: "Mainnet" as const, provider: { getProtocolParameters: async () => pp } };
    return {
      config: () => cfg,
      utxosByOutRef: async (refs: { txHash: string; outputIndex: number }[]) =>
        refs.map((r) => (r.txHash === orderUtxo.txHash ? orderUtxo : refUtxo)),
      selectWallet: { fromAddress: () => {} },
      unixTimeToSlot: (_ms: number) => 100_000_000,
      newTx: () => b,
    } as unknown as LucidEvolution;
  }
  const collateral = { txHash: "ee".repeat(32), outputIndex: 0, address: V3_ADDR, assets: { lovelace: 5_000_000n } } as UTxO;
  const fund = (lovelace: bigint): UTxO[] => [
    { txHash: "ff".repeat(32), outputIndex: 0, address: V3_ADDR, assets: { lovelace } } as UTxO,
  ];

  it("throws a clear insufficient-funding error instead of cannibalizing the collateral", async () => {
    await expect(
      buildTakerFillV3({
        lucid: mockLucid(),
        order: coveredAdaBuy,
        userSellAmount: 60_000_000n, // owner alone needs 60M lovelace
        fundingUtxos: fund(5_000_000n), // far too little
        collateralUtxo: collateral,
        network: "Mainnet",
        mintReceipt: true,
      }),
    ).rejects.toThrow(/insufficient funding[\s\S]*fill-receipt/);
  });

  it("passes the guard when funding is adequate (proceeds to tx completion)", async () => {
    await expect(
      buildTakerFillV3({
        lucid: mockLucid(),
        order: coveredAdaBuy,
        userSellAmount: 60_000_000n,
        fundingUtxos: fund(100_000_000n), // covers every output
        collateralUtxo: collateral,
        network: "Mainnet",
        mintReceipt: true,
      }),
    ).rejects.toThrow(/__COMPLETE_REACHED__/);
  });
});

describe("computeFillPlanV3 / buildTakerFillV3 — network is required, never defaulted (V3FS-02)", () => {
  it("a mainnet network yields addr1 owner + vault; preprod yields addr_test1", () => {
    const m = computeFillPlanV3(coveredAdaBuy, coveredAdaBuy.buy.amount, "Mainnet");
    expect(m.ownerAddressBech32.startsWith("addr1")).toBe(true);
    expect(m.premium!.vaultAddressBech32.startsWith("addr1")).toBe(true);
    const p = computeFillPlanV3(coveredAdaBuy, coveredAdaBuy.buy.amount, "Preprod");
    expect(p.ownerAddressBech32.startsWith("addr_test1")).toBe(true);
    expect(p.premium!.vaultAddressBech32.startsWith("addr_test1")).toBe(true);
  });

  it("buildTakerFillV3 refuses to build when the network cannot be derived from lucid.config()", async () => {
    const lucid = { config: () => ({}) } as unknown as LucidEvolution;
    const collateralUtxo: UTxO = { txHash: "00".repeat(32), outputIndex: 0, address: V3_ADDR, assets: {} };
    await expect(
      buildTakerFillV3({
        lucid,
        order: coveredAdaBuy,
        userSellAmount: coveredAdaBuy.buy.amount,
        fundingUtxos: [],
        collateralUtxo,
      }),
    ).rejects.toThrow(/network could not be derived/);
  });
});
