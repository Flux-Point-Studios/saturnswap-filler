import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { koiosRowToRawUtxo, normalizeBook } from "../../src/discovery.js";
import { computeFillPlan } from "../../src/fill.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../fixtures/live_1pct_book.json"), "utf8"));
const book = normalizeBook(fixture.map(koiosRowToRawUtxo));

describe("multi-order batching invariants", () => {
  it("each order's PaymentDatum is keyed by its OWN tx_id#ix, so fee outputs are never coalescible", () => {
    const a = computeFillPlan(book[0]!, 500_000n);
    const b = computeFillPlan(book[1]!, 500_000n);
    // distinct spent-order refs => distinct PaymentDatum => two separate fee outputs are mandatory
    expect(a.paymentDatumHex).not.toBe(b.paymentDatumHex);
    expect(a.relist!.datumHex).not.toBe(b.relist!.datumHex); // distinct relist-chain links too
  });

  it("output_index math (author order): [ownerA, feeA, relistA?, ownerB, feeB, relistB?]", () => {
    // mirror buildMultiTakerFill's layout to lock the owner-output indices
    const plans = [computeFillPlan(book[0]!, 500_000n), computeFillPlan(book[1]!, 500_000n)];
    let count = 0;
    const ownerIdx: number[] = [];
    for (const p of plans) {
      ownerIdx.push(count);
      count += 2 + (p.relist ? 1 : 0); // owner + fee (+ relist)
    }
    expect(ownerIdx).toEqual([0, 3]); // both partial => 3 outputs each
  });
});
