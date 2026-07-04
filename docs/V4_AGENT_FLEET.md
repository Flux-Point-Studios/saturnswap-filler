# saturnswap-filler — V4 Beacon Discovery + AI Agent Fleet

**Companion to** `SaturnSwapContract/docs/V4_DISTRIBUTED_DAPP_DESIGN.md` (authoritative V4 design). This doc scopes what changes **in this library** and the new reference bots it should ship for V4. Read the master doc first.

## Where V4 plugs into what already exists here

This library is already the right foundation for the V4 agent fleet:
- Fill path is **fully permissionless and mainnet‑proven** (taker‑key‑only fill tx `aea570815f2c…`); no protocol authorization change is needed.
- Discovery is behind a `ChainProvider` seam (`discovery.ts`) — the natural place to add beacon queries.
- `SwapDatumV3` already models `minPartialFill` + Aegis `coverage`, and `MintFillReceipt`/`BurnFillReceipt` already model CIP‑69 fill receipts. V4 **promotes these from spec to first‑class primitives** (reputation, insurance premium, honest maker‑mining input).
- The strategy layer (order selection, profitability, contention racing) is **greenfield** — this is where the agents live.

## 1. Beacon discovery (replaces address‑scan)

- **Today:** `discoverOrders` iterates `DEPLOYMENTS` and calls `provider.utxosAtAddress(dep.orderAddress)` — a per‑address scan.
- **V4:** add a `BeaconProvider` implementing the existing `ChainProvider` interface that queries **by beacon asset** instead:
  - whole book for a pair → `pair_beacon = sha2_256(offer_id ++ offer_name ++ ask_id ++ ask_name)`
  - orders offering X → `offer_beacon = sha2_256("01" ++ X)`
  - orders asking X → `ask_beacon = sha2_256("02" ++ X)`
  - across both policies (`beacon_limit`, `beacon_amm`).
- Providers: Kupo (asset pattern), Blockfrost `assets/{asset}/addresses`, Koios `asset_utxos` (what cardano‑swaps' CLI uses), or Ogmios for real‑time. Keep the keyless‑Koios default for zero‑config.
- **Union V2/V3/V4** in the normalized book via the datum `version` field — the per‑deployment registry already supports this; V4 orders just come from a beacon query instead of an address scan.

## 2. Datum/codec work
- Add `datumV4.ts`: `OrderDatumV4` (version, kind, `beacon_policy`, one‑way + two‑way rational prices, `min_partial_fill`, `coverage`, `output_reference`) + `Fill`/`Cancel`/`Reprice` redeemers, mirroring the master doc §3.
- Extend `computeFillPlan*` to enforce the **on‑chain fee output** and, when `coverage = Some`, the **premium vault output** (the V3 planner already handles the premium — carry it forward).
- Beacon mint/burn: fills that fully close an order **burn** beacons; partial‑fill continuations are **net‑zero**; `Reprice` is net‑zero. Add these to the tx builders.

## 3. Reference **maker** bot (new — `bots/maker/`)
Two‑way beacon quotes. Copy the robust GY mechanisms, beat the weak ones (master doc §6.1–6.3):
- **Copy:** dual‑oracle weighted price + relative‑stddev **circuit breaker** (cancel‑all‑and‑exit "spooked" state, N healthy cycles to re‑enter, escalation tier); **budget‑based inventory bounds** (`budget − value locked in live orders`, floor‑split into equal orders, min‑vol floor); **liquidity‑existence gating** (skip a side if book depth within `k·spread` already exceeds a threshold); batched cancels, kill switch (cancel‑all mode), reserved pure‑ADA collateral UTxO, per‑cycle equity + ADA‑normalized‑equity logging.
- **Beat:** **event‑driven** reprice (Ogmios chain‑sync / backend websocket) not a 2‑min poll; **batch** placements/reprices per tx using the `Reprice` redeemer + ~25‑op composition; **inventory‑skew** spread (reservation price `r = m − q·γ·σ²·T`); **volatility‑adaptive** width; **robust multi‑DEX depth‑weighted mid/TWAP** with median‑of‑N aggregation instead of a single 5‑min OHLC close.
- **Spread floor (critical, [design inference]):** half‑spread ≳ `k·σ·√(Δt_refresh) + fee_bps + min_utxo_amortization`, `k ≥ 2`, `Δt_refresh` in **blocks** (quotes cannot reprice intra‑block; stale quotes get picked off). Validate with paper trading before risking capital.
- **Config vocabulary:** reuse GY's parameter surface (spreads, budgets, thresholds, cancel triggers) so an adaptive/AI controller can drive it. Ship a **paper‑trading/backtest mode** against recorded books and a **Prometheus** endpoint.
- **Hedged variant (`bots/maker-hedged/`, [design inference]):** quote on SaturnSwap, hedge inventory delta on a CEX with deep ADA books; earns DEX spread while delta‑neutral, so it can quote tighter. Off‑protocol; document as a reference strategy.

## 4. Reference **filler** bot (extend this lib into `bots/filler/`)
Model on GY's Smart Order Router (master doc §6.6):
- Multi‑pair in‑memory book from beacon queries; matching starts with `OneSellToManyBuy` + **cross‑DEX arbitrage** (fill a maker order that crosses Minswap/Sundae/Splash) + **multi‑hop routing** (chain beacon orders across pairs in one ~25‑op tx).
- **Profitability invariant (copy verbatim):** fill only if no token balance is lost and the ADA‑equiv of arbitraged tokens covers tx fees; value unpriced tokens at zero. Expose a **min‑profitable‑fill‑size** gate (fixed floors — fee‑output min‑UTxO ~1.2 ADA, receipt ADA ~1.2–1.7 ADA reclaimable — dominate small fills; the `FillPlan` already surfaces these costs).
- Contention: `randomizeMatchesFound` to avoid colliding with competing fillers on the best order; rely on the UTxO contention market otherwise (per‑user addresses; pay up for a less‑contended order).
- Cap matches/tx (~5–8, tx‑size bound) and txs/iteration.

## 5. Rewards & reputation
- Fill receipts (§2) are the tamper‑evident record of executed price/fill. Build reward‑claim tooling keyed to receipts / stake‑key (transparent, on‑chain — explicitly better than GY's opaque off‑repo program).
- Feed receipts into the backend's on‑chain‑ified maker mining (backend companion doc §F).

## Keep the isolation guarantee
This package must stay free of any `SaturnSwapBackend`/`SaturnSwapWeb` import — the whole point is that the agent fleet needs no SaturnSwap API, only a chain data source and a funded wallet + collateral. The reference bots inherit that property.

## ADAM‑OC: where these bots live first (master doc §3.5/§6.7 — reconciled against the repo, 2026‑07‑04)

Flux Point's **ADAM‑OC** already **vendors this library** as `@adam/saturnswap-filler` (workspace fork) and fills live mainnet V2/V3 orders with it; its sibling `@adam/cardano-swaps` package implements the CIP‑0089 beacon order book (preprod). Ground truth for the integration:

- **The integration seam already exists: `ComposableFill` → `agentComposeFills`.** ADAM's guard router composes SaturnSwap V3 fills and cardano‑swaps beacon fills atomically in one guard transaction. **V4 beacon orders become a third composable venue behind that same interface** — implement `discover + computeFillPlan → ComposableFill` for the V4 script and the router picks it up.
- **The maker bot is net‑new, in both repos.** ADAM today is taker/filler‑only — `StrategyId.MarketMaker` is a dangling unused enum, and the only "maker" is a preprod keeper test script (`scripts/preprod-keeper.mjs`) that seeds the book. The §maker‑bot above *implements* that enum; do not describe it as a port.
- **Config vocabulary: extend, don't assume.** None of the A‑S/XEMM params (γ, `inventory_target_base_pct`, `order_refresh_time`, `min_profitability`, `slippage_buffer`) exist in ADAM. Its real vocabulary is risk rails: `minNativeReservePct`, `maxPositions`, `maxTokenExposurePct`, `maxSlippageBps`, `cycleIntervalSeconds`, `dailyLossLimitPct`, `consecutiveLossPause`. Plan: add the MM parameter set to ADAM's `StrategyConstraints`‑style schema so risk rails *bound* the strategy while A‑S params *drive* it — and keep the standalone bots on the identical extended schema, so a self‑hoster and a subscriber run the same logic. Self‑hosting stays free; the paid product is hosting/ops/strategy quality (runtime credits are metered per live LLM decision tick), never protocol access.
- **Also to‑build in ADAM:** the dual‑oracle divergence circuit breaker (ADAM's breaker is loss‑based today; price feeds are TapTools/CoinGecko — no Charli3/Orcfax yet).
- **Borrow the spending guard.** ADAM's Plutus V3 spending‑guard (bounded session key + on‑chain rolling‑window caps: `perTxCap`, `dailyCap`, `minPrincipal`, `maxSpends`, `expiry`; owner key never leaves the device) should be the recommended custody model for *any* operator running these bots hot — it is the agent‑layer version of the protocol's own trust‑minimization story.
- ADAM‑OC agents are the **day‑one market makers** for launch pairs and the **default graduation makers** for Liftoff tokens (master doc §7.6): at graduation, curve reserves convert into two‑way beacon orders laddered around the terminal curve price, and the agents take over quoting.
- Under the recommended **0%‑protocol‑fee model**, drop `protocol_fee` from the operator P&L formula (§ filler bot) — fills cost only tx fee + min‑UTxO floors (+ coverage premium when applicable), which widens the set of profitable fills and shrinks the min‑profitable‑fill gate.
- Hard rule, restated: **no ADAM‑OC‑only privileges** in this library or the bots — everything here must work identically for any operator, or the trust wedge dies.

## Follow‑up research (verified 2026 data → master doc §10–§13)
Concrete params/choices now backed by the follow‑up research pass, for the bots above:
- **Oracles (maker price feed):** use **Charli3** (PULL/on‑demand for active quoting) + **Orcfax** ($FACT, ~5‑min heartbeat) as a **multi‑oracle read**, not a single 5‑min AMM OHLC. Set staleness tolerance per the subscribed feed instance.
- **Spread floor (now cited):** half‑spread ≳ `k·σ·√τ` with `τ` in blocks — moving from an L2 to ~20 s Cardano blocks needs **~9× wider** spread for equal pickoff protection (LVR + microstructure literature). Measure ADA 20 s‑horizon σ before quoting live capital.
- **A‑S implementation caveat:** Hummingbot multiplies by σ (std dev) where the paper uses σ² (variance) — reconcile before calibrating `γ`. Hand‑tune only `γ`, `inventory_target_base_pct`, `order_amount`, `order_refresh_time`, size‑skew `η`; σ/A/k are auto‑estimated.
- **Hedged variant:** **Binance** is the primary ADA hedge venue (Bybit/OKX secondary; **not** Coinbase). Latency budget is **seconds** (block‑dominated), not sub‑ms — optimize for reliable fill‑detection + hedge‑confirmation. Model perp funding as a P&L line; cap leverage. Verified Hummingbot XEMM defaults: `slippage_buffer` 5%, `order_size_taker_balance_factor` 99.5%, `conversion_rate_mode` oracle.
- **Gas abstraction:** integrate **FluidTokens Aquarium** babel fees so the bot holds only its trading token, not an ADA gas buffer.
- **Distribution:** the filler/quote interface should be **DexHunter‑routable** (aggregators carry a large share of Cardano flow). Publish the agent on **Sokosumi** (Masumi marketplace) for discovery; expose **MIP‑003** endpoints for A2A/MCP interop.
