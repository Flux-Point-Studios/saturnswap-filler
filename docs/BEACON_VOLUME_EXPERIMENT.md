# Beacon Book Volume Experiment — multi-swap composition, the real ceiling, and the 5M ADA loop

**Status:** analysis + experiment design. Grounded in this repo (`cardanoSwaps*` modules, the
2026-07-08 mainnet ceremony constants), `SaturnSwapContract/C_ARCHITECTURE.md` (Option C), and the
`SaturnSwapBackend` beacon indexer (`sync_beacon_order`). Numbers are labeled **[measured]**,
**[computed]** (arithmetic from wire formats / protocol params), or **[estimate]** (must be
benchmarked before being published anywhere).

---

## 1. The correction that reframes the whole experiment

**On Cardano's eUTxO ledger there is no such thing as "multi-hop" as a distinct transaction
capability.** A transaction is a single atomic value-balance equation: all inputs are consumed, all
outputs are created, and phase-2 runs each spent script's predicate against the whole tx. There is
no intra-tx ordering — no "hop 1's output feeds hop 2's input" dependency chain. That framing
imports an account-model/AMM-router mental model that does not apply here.

Concretely, for the canonical cardano-swaps fill (`cardanoSwapsFill.ts`, Option C §5.2): each spent
order validates **only**

1. its own continuation output — same swap address, datum identical except
   `prev_input = Some(spent ref)`, found by an **index-free datum scan** (unique per fill, so
   same-pair / same-address composition is unambiguous); and
2. its own price inequality — `offer_taken × price_num ≤ ask_given × price_den` (rounding-safe
   cross-mult), ask never withdrawn.

No validator cares where the taker sourced the ask asset. So inside one tx, the SATURN taken from
order X **is** the SATURN deposited into order Y — the ledger only checks the sums. Which means:

> **A flat batch of fills, a multi-hop route, and a closed arbitrage cycle are the SAME
> transaction shape.** The only difference is which fills you select — i.e. whether the summed
> `tokenDelta`/`outflow` legs net toward zero.

Worked 3-fill cycle, one tx, taker starts and ends holding **zero** SATURN and zero SNEK:

| leg | order (resting UTxO) | taker takes | taker gives |
|---|---|---|---|
| 1 | offers 10,000 SATURN, asks ADA @ 0.10 | 10,000 SATURN | 1,000 ADA |
| 2 | offers 500 SNEK, asks SATURN @ 20 | 500 SNEK | 10,000 SATURN |
| 3 | offers 1,010 ADA, asks SNEK @ 0.495 | 1,010 ADA | 500 SNEK |

Net: **+10 ADA minus ~2.6 ADA network fee**, three continuations relisted at unchanged prices.
The intermediate legs are funded entirely by the tx's own inputs — capital required ≈ the ADA leg
plus min-UTxO headroom, not the route's gross notional.

**Consequence for the stack as it exists today:** the on-chain capability is already live. Each
fill is a `ComposableFill` (fixed nullary redeemer, single continuation, **no mint, no fee output,
no signature check** — `cardanoSwapsComposable` / `cardanoSwapsTwoWayComposable`), and the guard
router (`agentComposeFills`, ADAM-OC) already composes arbitrary sets of them plus an optional
Aegis leg. What is *missing* is purely off-chain:

- a **route/cycle planner** — select fills whose summed deltas net (trivial for our own
  paired orders; graph search only if routing across third-party books);
- **verification that the guard funds the NET delta**, not each fill's gross legs (ADAM-OC:
  confirm `agentComposeFills` merges `tokenDelta` maps with sign before selecting funding
  inputs — a cycle must not require the taker to pre-hold intermediate tokens);
- an **ex-unit / tx-size bin-packer** (pack fills until the measured budget is full, emit tx,
  continue).

Nothing on-chain needs to change, and no new validator is needed.

## 2. What is actually live (inventory of the three repos)

| capability | where | status |
|---|---|---|
| Canonical cardano-swaps **one-way** protocol on mainnet (spend `1d6cff26…`, beacon `c4d7d117…`, refs `8ae2d109…#0` / `b6125af1…#0`) | `cardanoSwapsMainnet.ts` | **live**, chain-verified 2026-07-08 ceremony |
| `maker_stake` inventory owner (withdraw-0, ADAM bot co-sign), reward addr registered | `SaturnSwapContract/maker_stake`, ref `aa19c205…#0`, reg tx `c220af41…` | **live** |
| Permissionless single-fill primitive + delta accounting | `cardanoSwapsFill.ts` | built + unit-tested |
| Maker lifecycle create / reprice / cancel (batch, one bot sig) | `cardanoSwapsLifecycle.ts` | built + unit-tested |
| Beacon discovery (CIP-0089, keyless Koios default) | `cardanoSwapsDiscovery.ts` | built |
| Insured-swap tx-cart (V2 fill ⊗ V3 Aegis, no Conway key 22) | `insuredSwap.ts` | built |
| **Two-way** swaps (the natural ping-pong primitive) | codecs + fill built (`cardanoSwapsDatum/Fill`) | **no mainnet deployment** — one-way only is live |
| Multi-fill composition (`agentComposeFills`, `GuardTxBuilder`) | ADAM-OC (separate repo) | live for mixed baskets; netting + bin-packing unverified |
| Read-only beacon indexer (`sync_beacon_order`, GraphQL `BeaconOrders`, chain-follow + backfill + drain) | `SaturnSwapBackend` Monitor + Beacon module | **live** (mainnet), index-only — this is the dashboard's data source |
| Fees on the beacon book | — | **0% by construction**: canonical has no fee output, no authorized taker, no batcher. Not a "Model B deploy decision" — the validator has no fee path at all |

Known external proof-of-life: at least one real third-party order rests on the mainnet book
(stake `392773b1…`, 188,339 cMATRA @ 11/5000 — the backend LOOP.md runtime proof). The book is
otherwise thin (C_ARCHITECTURE §7 R1) — which is exactly why the experiment is framed as an
infrastructure demonstration, not organic demand.

## 3. Where "~27 swaps per tx" comes from, and what the ceiling actually is

The figure in circulation is **"25 swaps/tx" — an *emulator* benchmark from the canonical
cardano-swaps research, never measured on-chain** (C_ARCHITECTURE §7 R1 says this verbatim). No
repo in this stack contains a measured number for the deployed ceremony scripts. Treat 25–27 as
folklore until benchmarked. What we can pin down:

**Size bound [computed].** Per one-way fill, with both scripts as CIP-33 reference inputs (zero
validator bytes in the tx):

- input side: outref (~36 B) + nullary redeemer + ex-unit declaration ≈ **~55 B**
- continuation output: script+stake address (57 B) + value (3 beacon assets ≈ ~140 B + traded
  asset ~35–70 B + lovelace) + inline 11-field datum (**~280 B**: 6×28-B hashes/ids, 3×32-B
  beacon names, rational, `Some(prev_input)` ≈ 44 B) ≈ **~560–600 B**

≈ **~630 B per fill** → (16,384 B − ~1.2 KB overhead for collateral/change/fee/refs/witness) /
630 ≈ **~24 fills, size-bound**. ADA-offer orders are slightly cheaper (empty policy id).

**Ex-unit bound [estimate — the one number to measure].** Each of K validator executions
(a) deserializes a script context whose size grows with K and (b) datum-scans up to K
continuation outputs. Per-fill cost is therefore ≈ `a + b·K`; whole-tx cost ≈ `a·K + b·K²`.
Whether the 14M-mem / 10B-step tx budget caps K below or above the ~24 size bound is exactly what
the emulator's "25" suggests but nothing here has measured. **Both constraints converge in the
mid-20s; "27" is optimistic by a hair; the real K_max needs one benchmark run.**

**The non-obvious consequence of the quadratic term — two different optima:**

- **The stunt tx** (do once, screenshot): one K_max tx — "~25 orders settled atomically in a
  single Cardano transaction, including closed multi-hop cycles." This is the composability
  headline no AMM-batcher venue can produce.
- **The volume record** (the 5M number): the metric is **fills per BLOCK**, and because per-fill
  ex-unit cost *rises* with K, medium batches likely maximize sustained throughput. Block budget
  is 62M mem / 20B steps / 90,112 B [protocol params]: two maxed compose txs already exhaust the
  step budget, while ~4–6 medium txs (K ≈ 8–12) can settle *more total fills* per block for
  *fewer* ex-units per fill. The benchmark (§6) resolves the optimal K*.

Do both. Don't conflate them — the 27-in-one-tx is a capability proof; the volume record is a
throughput proof, and it probably doesn't want maximal txs.

## 4. The volume loop (how 5M ADA actually happens)

**Topology.** Paired opposite **one-way** orders in SaturnSwap's own `maker_stake` inventory
(two-way would halve the UTxO count but isn't deployed; not blocking):

- N orders: offer TOKEN, ask ADA at price p
- N orders: offer ADA, ask TOKEN at price q, with p·q set a hair under 1

so every round-trip nets ≥ 0 for the taker before network fees. Both sides are SaturnSwap
inventory; the "spread loss" is an internal transfer. The only real cost of the entire experiment
is network fees.

**Loop physics — the property that makes it work:** a fill's continuation returns to the *same
address* at the *same price*, immediately re-fillable, with **no maker action**. The taker agent
just chases continuations block after block. Partial fills are native, so fill sizes never need to
match order sizes. Reprice/cancel (the only ops needing the ADAM bot key) are not in the loop at
all — **the taker fleet never touches the bot key**.

**One tx = the literal "back and forth":** 12 TOKEN→ADA fills + 13 ADA→TOKEN fills in a single
transaction; the taker ends ≈ flat, ~25 orders' notional settles, all 25 relist automatically.

**Arithmetic [computed from protocol params; fill count per tx is §3's estimate]:**

| lever | value |
|---|---|
| avg fill notional | 1,000 ADA (tunable — volume scales linearly) |
| fills per tx | ~25 (stunt) / K* ≈ 8–12 (sustained, to be measured) |
| gross volume per tx (K=25) | ~25,000 ADA |
| cadence, conservative | 1 compose tx per ~20 s block |
| **volume per hour** | **~4.5M ADA** (≈180 blocks × 25k) — 5M in ~67 min; 2 txs/block or intra-block continuation-chaining halves that |
| working capital | ~25–50k ADA equivalent (25 orders × ~1k + headroom). **Velocity ≈ 180 inventory turns/hour** — that's the headline mechanic: volume = inventory × turns |
| network fee per maxed tx | ≤ ~2.6 ADA (size 16,384×44 + 155,381 base + 14M mem × 0.0577 + 10B steps × 0.0000721 + ~0.15 ref-script fee) |
| **total fees for 5M ADA** | **~200 txs × ~2.6 ≈ ~520 ADA ≈ 0.01% of volume** |
| protocol fee | 0 — the validator has no fee path |

**Planner guardrails (needed, small):**

- cap `offerTaken` on ADA-offering orders so the continuation stays above its min-UTxO floor
  (the ledger enforces it phase-1; `computeOneWayFill` doesn't — the planner must);
- ceil-div rounding gives the maker ≤ 1 ask-unit per fill — it accrues to our own inventory,
  immaterial, but model it so the loop doesn't drift;
- per-agent cumulative-loss kill-switch (a mispriced ladder bleeds spread to outsiders).

**On "UTxO contention is the hard engineering problem":** for the disclosed single-operator
experiment it isn't — one orchestrator partitions order pairs across taker agents, so nothing
ever collides. External fills of our orders aren't failures; they're bonus volume — the agent
re-discovers the continuation and carries on. A lease/assignment layer only matters for the open
"community agents" variant, and belongs in that later phase, not on the critical path.

## 5. Disclosure is on-chain, not just a blog post

Every experiment order rests at `Address(dapp_hash, maker_stake)` — reward address
`stake17xxc78gghtyfu4f02fy27yntl00qn7gal3uwyx8jdft966qdrjl4u`. **The experiment's inventory is
cryptographically labeled on-chain**: anyone can partition "experiment volume" from external
volume with one stake-credential filter, forever. Lead with that in the announcement — it's a
stronger honesty artifact than any disclaimer. The backend indexer already keys
`sync_beacon_order` by owner stake credential, and LOOP.md's proposed `is_planted` flag is the
right surfacing mechanism: implement it as `is_experiment` derived from the maker_stake
credential, and badge it in the API + dashboard.

Headline framing that survives scrutiny: *"Our agents moved N ADA through an on-chain order book
in one hour on ~X k ADA of working capital — every fill a mainnet tx, every experiment order
labeled on-chain, total cost ~Y hundred ADA in network fees, 0% protocol fee. Here's the stake
credential; audit us."*

## 6. Build/measure list (in order)

1. **Ceiling benchmark — the gating number.** No preprod `CardanoSwapsDeployment` exists in this
   repo, so either (a) run a preprod ceremony (ref scripts + maker_stake reg, mirroring
   `deployment.mainnet.json`) or (b) benchmark in an emulator against the ceremony script bytes
   fetched from the mainnet ref UTxOs. Seed ~30 mini orders, build K = 1, 2, 4, 8, 12, 16, 20,
   24, 28 fill txs, evaluate (Ogmios `evaluateTx` / `aiken tx simulate`), record mem/steps/bytes.
   Deliverables: K_max, the per-fill cost fit `a + b·K`, fee(K), and fills-per-block-optimal K*.
2. **Multi-fill assembler in this repo.** `assembleCardanoSwapsTx` covers create/reprice/cancel;
   fills currently compose only via ADAM-OC's guard router. Add a standalone
   `assembleCardanoSwapsFills(fills: ComposableFill[])` (N `collectFrom` + N continuations +
   change; no withdrawals, no signers) with the §4 guardrails and K-cap from (1) — keeps the
   experiment runnable by any operator, per the no-ADAM-privileges rule.
3. **Netting check in ADAM-OC** (out of this repo's scope, tracked here): confirm
   `agentComposeFills` funds the merged signed `tokenDelta`, not per-fill gross; add the
   bin-packer against the measured budget.
4. **Loop orchestrator** (taker agent): discover via `sync_beacon_order` or Ogmios chain-sync,
   chase continuations, partition order pairs across agents, kill-switch, metrics.
5. **Dashboard + disclosure**: backend fills rollup (fills/block, ADA volume, fee per fill,
   failure rate, experiment vs external split by stake cred), cexplorer links, `is_experiment`
   badge.
6. **Infra headroom**: paid Blockfrost/Koios or self-hosted Ogmios + submit-api (the keyless
   Koios default 429s under swarm load).
7. **Then the event**: preprod dress rehearsal → mainnet stunt tx (K_max) → the disclosed
   volume window with measured numbers. Optional sequels: two-way deployment (halves resting
   UTxOs), cross-venue cycles through third-party books, community-agent open round (this is
   where the assignment/lease layer finally earns its keep).

## 7. Honest risks

- **Self-trading optics** — mitigated only by the up-front disclosure + on-chain labeling (§5);
  never present the number as organic demand.
- **Publishing an unmeasured ceiling** — do not say "27" (or any K) publicly before §6.1 runs.
- **Unaudited v2 expiration surface** — keep `expiration = None` on all experiment orders
  (C_ARCHITECTURE §4.2/§7).
- **Ref-script UTxOs are load-bearing infra** — a spent/moved ref UTxO breaks every fill mid-event.
- **Bot-key custody** — the loop never needs the ADAM key; keep it out of taker agents entirely.
- **Provider throttling mid-event** — §6.6 before mainnet, not after.
