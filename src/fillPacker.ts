// Ex-unit bin-packer for beacon-book multi-fills (BEACON_VOLUME_EXPERIMENT.md §6 — the
// event runner's foundational primitive). Given candidate fill legs, partition them into
// transactions each guaranteed within the mainnet tx budget, using the ON-CHAIN-measured
// per-fill cost (COMPOSE_CEILING_BENCHMARK.md).
//
// A batch's cost is NOT the sum of per-fill costs: each of K spend validators datum-scans
// all K continuation outputs, so mem/steps carry a K² term. The packer therefore projects
// the WHOLE-batch cost at each K and caps K where any budget (minus a safety margin) would
// be exceeded — then chunks the legs into batches of that size.

import type { OneWayFillLeg } from "./cardanoSwapsMultiFill.js";

/** Mainnet Conway per-tx and per-block limits. */
export const MAINNET_TX_BUDGET = {
  maxTxMem: 14_000_000n,
  maxTxSteps: 10_000_000_000n,
  maxTxSize: 16_384,
  maxBlockMem: 62_000_000n,
  maxBlockSteps: 20_000_000_000n,
  maxBlockSize: 90_112,
} as const;

/** Per-fill cost model fit on the on-chain preprod ladder (K=2 and K=26 anchor points,
 *  real deployed canonical validators). mem/steps are quadratic in K; size is linear. */
export const MEASURED_FILL_COST = {
  memPerK: 395_000n,
  memPerK2: 4_720n,
  stepsPerK: 122_600_000n,
  stepsPerK2: 4_062_000n,
  sizeBase: 1_758,
  sizePerFill: 537,
} as const;

export type FillCost = typeof MEASURED_FILL_COST;

export interface PackOptions {
  maxTxMem?: bigint;
  maxTxSteps?: bigint;
  maxTxSize?: number;
  /** headroom subtracted from each budget so real orders (bigger CBOR than the benchmark's)
   *  don't tip a maxed batch over on-chain. Default 500 = 5%. Set 0n for the K_max stunt. */
  safetyBps?: bigint;
  /** hard cap on fills per tx — e.g. the throughput-optimal K* (≈4), which beats K_max on
   *  fills-per-block. Omitted → the budget-derived ceiling (K_max). */
  maxFillsPerTx?: number;
  cost?: FillCost;
}

export interface ProjectedCost {
  mem: bigint;
  steps: bigint;
  size: number;
}

/** Projected whole-tx cost for a batch of K fills (K² for ex-units, linear for size). */
export function projectedCost(k: number, cost: FillCost = MEASURED_FILL_COST): ProjectedCost {
  const K = BigInt(k);
  return {
    mem: cost.memPerK * K + cost.memPerK2 * K * K,
    steps: cost.stepsPerK * K + cost.stepsPerK2 * K * K,
    size: cost.sizeBase + cost.sizePerFill * k,
  };
}

const withMargin = (budget: bigint, bps: bigint): bigint => (budget * (10_000n - bps)) / 10_000n;

/** The largest K whose projected cost fits every budget (after the safety margin) and the
 *  optional hard maxFillsPerTx cap. Always ≥ 1. */
export function maxFitK(opts: PackOptions = {}): number {
  const cost = opts.cost ?? MEASURED_FILL_COST;
  const bps = opts.safetyBps ?? 500n;
  const memCap = withMargin(opts.maxTxMem ?? MAINNET_TX_BUDGET.maxTxMem, bps);
  const stepCap = withMargin(opts.maxTxSteps ?? MAINNET_TX_BUDGET.maxTxSteps, bps);
  const sizeCap = Number(withMargin(BigInt(opts.maxTxSize ?? MAINNET_TX_BUDGET.maxTxSize), bps));
  const hardCap = opts.maxFillsPerTx ?? Number.MAX_SAFE_INTEGER;

  let k = 0;
  for (let cand = 1; cand <= hardCap; cand++) {
    const c = projectedCost(cand, cost);
    if (c.mem > memCap || c.steps > stepCap || c.size > sizeCap) break;
    k = cand;
  }
  return k >= 1 ? k : 1; // at least one fill per tx even if the model says it's tight
}

/** Partition legs into batches, each within the tx budget (maxFitK per batch), preserving
 *  order. Callers assemble each batch with planOneWayMultiFill + assembleOneWayMultiFillTx. */
export function packFills(legs: OneWayFillLeg[], opts: PackOptions = {}): OneWayFillLeg[][] {
  if (legs.length === 0) return [];
  const cap = maxFitK(opts);
  const batches: OneWayFillLeg[][] = [];
  for (let i = 0; i < legs.length; i += cap) batches.push(legs.slice(i, i + cap));
  return batches;
}
