import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { koiosRowToRawUtxo, decodeOrderUtxo, unit } from "../../src/discovery.js";
import { computeFillPlan } from "../../src/fill.js";
import { swapSplitAmounts } from "../../src/ratio.js";
import { decodeSwapDatumHex } from "../../src/datum.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../fixtures/live_1pct_book.json"), "utf8"));
const worked = decodeOrderUtxo(koiosRowToRawUtxo(fixture.find((u: any) => u.tx_hash.startsWith("a28c54cc"))))!;
const CMATRA = unit(worked.buy.policyId, worked.buy.assetName);
const U = 500_000n;

describe("swap_split ratio math (the validator's swap_split path)", () => {
  const s = swapSplitAmounts(worked.sell.amount, worked.buy.amount, U, true);
  it("computes the corrected ADA-sell relist amounts with the 2-ADA buffer", () => {
    expect(s.remainingBuy).toBe(125_124_499_999n);
    expect(s.newAmountSell).toBe(24_999_901n);
    expect(s.sellBuffer).toBe(2_000_000n); // ADA-sell, new_amount_sell > 2 ADA
    expect(s.correctedNewAmountSell).toBe(22_999_901n);
    expect(s.correctedNewAmountBuy).toBe(115_114_504_505n);
  });
  it("corrected amounts sit inside the validator's accepted ranges", () => {
    expect(s.correctedNewAmountSell).toBeLessThanOrEqual(s.newAmountSell);
    expect(s.correctedNewAmountBuy).toBeLessThanOrEqual(s.remainingBuy);
  });
});

describe("computeFillPlan — partial fill of the 1% worked order (deliver 500000 cMATRA)", () => {
  const plan = computeFillPlan(worked, U);

  it("is a partial fill with a relist continuation", () => {
    expect(plan.isFullFill).toBe(false);
    expect(plan.relist).toBeDefined();
    expect(plan.userSellAmount).toBe(U);
  });

  it("owner output = delivered cMATRA + the 2-ADA buffer (is_correct_owner_ada_amount)", () => {
    expect(plan.ownerOutputAssets[CMATRA]).toBe(U);
    expect(plan.ownerOutputAssets["lovelace"]).toBe(2_000_000n); // == sell_amount_buffer
  });

  it("fee = 1% of the FILLED proportional sell (100 lovelace -> 1), floored to min-utxo", () => {
    expect(plan.newSwapAmountSell).toBe(100n);
    expect(plan.totalFee).toBe(1n);
    expect(plan.feeOutputAssets["lovelace"]).toBe(1_211_110n); // min-utxo dominates the 1-lovelace fee
  });

  it("relist continuation: ADA-only value == corrected_new_amount_sell, back to the order script", () => {
    expect(plan.relist!.scriptAddress).toBe(worked.orderAddress);
    expect(plan.relist!.assets["lovelace"]).toBe(22_999_901n);
    expect(Object.keys(plan.relist!.assets)).toEqual(["lovelace"]); // value_has_only_lovelace
    expect(plan.relist!.assets["lovelace"]).toBeGreaterThanOrEqual(plan.relist!.correctedNewAmountSell);
  });

  it("relist datum: prev owner/policies/names/valid_before preserved; corrected amounts; output_reference = SPENT order ref", () => {
    const d = decodeSwapDatumHex(plan.relist!.datumHex);
    expect(d.amountSell).toBe(22_999_901n);
    expect(d.amountBuy).toBe(115_114_504_505n);
    expect(d.owner.payment.hash).toBe(worked.datum.owner.payment.hash);
    expect(d.owner.stake?.hash).toBe(worked.datum.owner.stake?.hash);
    expect(d.policyIdSell).toBe(worked.sell.policyId);
    expect(d.policyIdBuy).toBe(worked.buy.policyId);
    expect(d.assetNameBuy).toBe(worked.buy.assetName);
    expect(d.validBeforeTime).toBe(worked.validBeforeTime);
    // the relist-chain link: continuation.output_reference == the spent order's own input ref
    expect(d.outputReference.txHash).toBe(worked.utxo.txHash);
    expect(d.outputReference.outputIndex).toBe(worked.utxo.outputIndex);
  });

  it("a near-full partial still relists: continuation lovelace floored at min-utxo", () => {
    // delivering almost everything leaves a tiny remaining sell; the continuation must still
    // clear the ledger min-utxo rather than carry sub-min lovelace.
    const near = computeFillPlan(worked, worked.buy.amount - 1n);
    expect(near.relist).toBeDefined();
    expect(near.relist!.assets["lovelace"]).toBeGreaterThan(900_000n);
  });
});
