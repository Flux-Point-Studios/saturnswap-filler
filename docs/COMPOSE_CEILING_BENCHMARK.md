# Compose-Ceiling Benchmark — measured (emulator, ceremony script bytes)

**Companion to** `BEACON_VOLUME_EXPERIMENT.md` (§3/§6.1). This run replaces the folklore
"~25–27 swaps/tx" with measured numbers. **Method tier: emulator-measured against the exact
deployed mainnet script bytes** — one step above the canonical repo's emulator folklore (unknown
scripts/params), one step below an on-chain preprod submit (tracked follow-up).

## Headline results

| metric | measured value |
|---|---|
| **K_max — one-way fills in one tx** | **26** (K=27 fails phase-2 **over the 14M mem budget by ~30–141 units**; steps had ~3.7B of 10B remaining; size 14,330 of 16,384 B) — **mem-bound, not size-bound** |
| **Throughput-optimal batch** | **K=4 → ~146 fills/block** chain ceiling (36.5 such txs fit a block; steps & block-size near co-binding) |
| **Fee at K=26** | **~2.05 ADA/tx → ~0.079 ADA per fill** (mainnet fee formula incl. ref-script fee) |
| **Fee at K=1** | ~0.294 ADA — batching cuts per-fill cost ~3.7× |
| **Netting proof** | a **26-fill round-trip settled by a taker holding ONLY ADA** built, evaluated, and **submitted** in the emulator — 13 TOKEN→ADA legs fund 13 ADA→TOKEN legs entirely intra-tx (`netTokenDelta = {}`, `netAdaOutflow = 0`) |
| **Per-fill cost fit** | `mem(K) ≈ 384k·K + 5.0k·K²` — extrapolates to ~13.99M at K=27, i.e. the wall is exactly where the quadratic says |

## Method

`scripts/bench-compose-ceiling.ts` (run: `npx tsx scripts/bench-compose-ceiling.ts`; raw output:
`fixtures/compose-ceiling-results.json`):

1. Script bytes fetched from the 2026-07-08 ceremony reference-script UTxOs
   (`8ae2d109…#0` spend, `b6125af1…#0` beacon) via Koios, pinned in
   `fixtures/cardano-swaps-mainnet-scripts.json`, and hash-verified
   `blake2b224(0x02 ‖ bytes) == 1d6cff26… / c4d7d117…` in code and in CI
   (`test/unit/cardano-swaps-multi-fill.test.ts`).
2. Lucid Evolution `Emulator` whose default protocol parameters equal mainnet's
   (16,384 B tx / 14M mem / 10B steps / minFeeA 44 / minFeeB 155,381 / prices 0.0577 & 0.0000721 /
   coinsPerUtxoByte 4,310 / ref-script 15 lovelace/B).
3. Both scripts deployed as CIP-33 reference scripts; 34 one-way orders created through the
   **real beacon policy** (`CreateOrCloseSwaps` mint per create): 17 offer-TOKEN/ask-ADA +
   17 offer-ADA/ask-TOKEN at price 1:1, key-staked, 20M-unit reserves, `expiration = None`.
4. For K = 1…29: interleave directions, take 1M units per fill, plan with
   `planOneWayMultiFill`, build with `assembleOneWayMultiFillTx` (K `Swap` inputs via the spend
   ref script, K continuations, change; no mint, no withdrawals, no signers), record size +
   evaluated ex-units; fees computed with the mainnet formula (fills reference only the 4,502-B
   spend script → 67,530 lovelace ref fee).

## Full ladder

| K | size B | mem | steps | fee ≈ADA | fee/fill | fills/block* |
|---|---|---|---|---|---|---|
| 1 | 893 | 389,338 | 123.3M | 0.294 | 0.294 | 100.9 |
| 2 | 1,388 | 768,813 | 250.5M | 0.346 | 0.173 | 129.8 |
| 4 | 2,466 | 1,581,018 | 535.1M | 0.461 | 0.115 | **146.2** |
| 6 | 3,544 | 2,436,615 | 853.7M | 0.581 | 0.097 | 140.6 |
| 8 | 4,622 | 3,339,998 | 1.209B | 0.706 | 0.088 | 132.3 |
| 12 | 6,778 | 5,259,364 | 2.011B | 0.970 | 0.081 | 119.3 |
| 16 | 8,934 | 7,361,086 | 2.955B | 1.254 | 0.078 | 108.3 |
| 20 | 11,090 | 9,631,982 | 4.032B | 1.557 | 0.078 | 99.2 |
| 24 | 13,250 | 12,085,234 | 5.250B | 1.882 | 0.078 | 91.4 |
| **26** | **14,330** | **13,343,993** | **5.890B** | **2.048** | **0.079** | 88.3 |
| 27 | — | **over budget** (mem −30) | — | — | — | — |

\* fills/block = K × min(62M/mem, 20B/steps, 90,112/size) — the whole-chain ceiling if every
block slot were ours; a realistic event targets a fraction of it.

## What this settles for the experiment

- **The stunt tx is real: 26 orders settled atomically in one transaction**, including closed
  round-trip cycles funded purely by intra-tx netting. Say "26", not "27".
- **The two optima are confirmed and different.** Max-composition (26) is the capability
  headline and is also fee-per-fill optimal (≈0.078–0.079 ADA from K≈16 up). Throughput
  (fills/block) peaks at **K=4** because per-fill mem grows with K (the `5k·K²` term) while
  small txs pack the block's step/size budgets better.
- **Volume math, measured:** at one K=26 tx per ~20 s block → **26k ADA notional/block
  (1k ADA/fill) ≈ 4.7M ADA/hour on a single lane**; 5M ADA ≈ 193 txs ≈ **~395 ADA total network
  fees (~0.008% of volume)**. Racing the clock instead: K=4 lanes across more of the block
  budget reach the same 5M in a fraction of the time at ~0.115 ADA/fill.
- **Capital confirmation:** the ADA-only-taker proof means the loop's working capital is the
  resting maker inventory + one leg of float — intermediate tokens never need to be held.

## Caveats (honest edges)

- **Emulator, not chain.** Protocol params and evaluator match mainnet, but the preprod
  on-chain submit (BEACON_VOLUME_EXPERIMENT.md §6.7) is still the final word.
- Datum/value sizes shift with real policy ids/asset names/amounts — K_max can move ±1 for a
  given pair; the K=27 miss was ~30 mem units, so treat 26 as "this pair's" ceiling and
  re-run the ladder per launch pair.
- All orders shared one address (uniform stake cred); a mixed-owner book changes nothing
  structural (the datum-scan keys on `prev_input`, not address), but re-measure if paranoid.
- Two-way fills (`TakeAsset1/2`) and mixed baskets (V3 CLOB legs, Aegis coverage leg) consume
  budget differently — ladder them separately before composing them into event txs.
