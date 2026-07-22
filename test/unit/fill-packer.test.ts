// The ex-unit bin-packer: partition candidate fills into transactions each within the
// mainnet tx budget, using the ON-CHAIN-measured per-fill cost (COMPOSE_CEILING_BENCHMARK).
// mem(K) is quadratic (each of K validators datum-scans all K outputs), so a batch's cost
// is NOT the sum of per-fill costs — the packer must project the whole-batch cost at each K.

import { describe, it, expect } from "vitest";
import {
  projectedCost,
  maxFitK,
  packFills,
  MAINNET_TX_BUDGET,
} from "../../src/fillPacker.js";
import type { OneWayFillLeg } from "../../src/cardanoSwapsMultiFill.js";

const legs = (n: number): OneWayFillLeg[] => Array.from({ length: n }, () => ({}) as OneWayFillLeg);

describe("projectedCost — matches the on-chain ladder", () => {
  it("K=26 mem ≈ 13.46M (measured 13,459,533), fits mainnet 14M", () => {
    const c = projectedCost(26);
    expect(Number(c.mem)).toBeGreaterThan(13_300_000);
    expect(Number(c.mem)).toBeLessThan(13_600_000);
    expect(c.mem).toBeLessThan(MAINNET_TX_BUDGET.maxTxMem);
  });
  it("K=27 mem exceeds mainnet 14M (the ceiling)", () => {
    expect(projectedCost(27).mem).toBeGreaterThan(MAINNET_TX_BUDGET.maxTxMem);
  });
  it("size grows linearly ~537 B/fill; K=26 ≈ 15.7 KB", () => {
    expect(projectedCost(26).size).toBeGreaterThan(15_000);
    expect(projectedCost(26).size).toBeLessThan(16_384);
  });
});

describe("maxFitK", () => {
  it("mem-bound at 26 with zero safety margin (mainnet)", () => {
    expect(maxFitK({ safetyBps: 0n })).toBe(26);
  });
  it("default 5% safety margin backs off below the hard ceiling", () => {
    const k = maxFitK();
    expect(k).toBeGreaterThanOrEqual(24);
    expect(k).toBeLessThanOrEqual(25);
  });
  it("honours a hard maxFillsPerTx cap (throughput K*)", () => {
    expect(maxFitK({ maxFillsPerTx: 4, safetyBps: 0n })).toBe(4);
  });
  it("never returns < 1", () => {
    expect(maxFitK({ maxTxMem: 100n, safetyBps: 0n })).toBe(1);
  });
});

describe("packFills", () => {
  it("empty legs → no batches", () => {
    expect(packFills([])).toEqual([]);
  });
  it("partitions 60 legs into ceiling-respecting batches that sum to 60", () => {
    const batches = packFills(legs(60), { safetyBps: 0n });
    expect(batches.flat()).toHaveLength(60);
    const cap = maxFitK({ safetyBps: 0n });
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(cap);
    // first batches are full
    expect(batches[0]!.length).toBe(cap);
  });
  it("respects maxFillsPerTx (throughput mode) → all batches ≤ K*", () => {
    const batches = packFills(legs(30), { maxFillsPerTx: 4 });
    expect(batches.flat()).toHaveLength(30);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(4);
    expect(batches).toHaveLength(Math.ceil(30 / 4));
  });
  it("fewer legs than the cap → a single batch", () => {
    expect(packFills(legs(3), { safetyBps: 0n })).toHaveLength(1);
  });
});
