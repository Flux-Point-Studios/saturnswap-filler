# saturnswap-filler

Standalone, optional reference filler library for aggregators (e.g. DexHunter, SteelSwap, etc.) to
discover SaturnSwap CLOB orders on-chain and build a **non-auth taker-fill**
transaction **without** the SaturnSwap API.

## Scope: two in-scope deployments (fee resolved per order)
This lib targets both `saturn_swap` deployments, which share the **same** baked
`fee_address` + authorize credential and differ **only** in `fee_percent`:

- **Current 1%** — hash `73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f`,
  addr `addr1z9eejzm3q…`, ref `0e16cd00…#0`, `fee_percent_x100 = 100`.
- **Legacy 4% run-off (optional)** — hash `1af84a9e697e1e7b042a0a06f061e88182feb9e9ada950b36a916bd5`,
  addr `addr1zyd0sj57d9l…`, ref `86cdaeed…#0`, `fee_percent_x100 = 400`.

Discovery returns orders from both; each order is tagged with its own version, ref script,
and `fee_percent`. The fee is resolved **per order** from the order's own script address:
`total_fee = new_swap_amount_sell * fee_percent_x100 / 10000`. A 4% order **must** be filled
at the 4% rate (the 1% recipe underpays 4× and the validator denies). A single tx **may mix**
1% and 4% orders as long as each fee output uses its own `fee_percent` and its own per-order
`PaymentDatum` (the shared `fee_address` never coalesces them).

## Isolation guarantees
- This package never imports `SaturnSwapBackend` or `SaturnSwapWeb`.
- The production backend never imports this package.
- Nothing in production depends on it. It is a separate git repo / artifact.

## Aggregator path
The non-auth fee (the order's own rate — 1% or 4%) is paid in the SELL asset to the contract's
baked `fee_address`. No SaturnSwap hot-key / authorize co-sign is involved. The aggregator signs
and submits the unsigned tx this lib produces.

See the in-repo ground truth: [`./SPEC.md`](./SPEC.md) (and machine-readable [`./spec.json`](./spec.json)).

## API surface

Discovery
- `KoiosProvider` / `ChainProvider` — keyless mainnet UTxO source (or plug Kupo/Ogmios/Blockfrost).
- `discoverOrders({ provider, versions? })` → `Order[]` (live).
- `decodeOrderUtxo(rawUtxo)` / `normalizeBook(rawUtxos[])` — pure decode + per-order version/ref resolution.
- `decodeSwapDatum(bytes)` / `decodeSwapDatumHex(hex)` — inline SwapDatum decode.
- `humanPrice(order, decimalsSell, decimalsBuy)` — apply decimals out-of-band (SPEC §6).

Fill (FULL and PARTIAL fills, non-auth)
- `computeFillPlan(order, userSellAmount, coinsPerUtxoByte?)` → `FillPlan` (pure; partial fills carry a
  `relist` continuation per SPEC §8).
- `buildTakerFill({ lucid, order, userSellAmount, fundingUtxos, collateralUtxo, changeAddress?, coinsPerUtxoByte?, costModelV2? })`
  → `{ unsignedCbor, txHash, inputIndex, outputIndex, exUnits, selfScriptDataHash, txScriptDataHash, scriptDataHashMatches, plan }`.
  When `userSellAmount < amount_buy` it emits exactly one §8 relist continuation back to the order script.
- `buildMultiTakerFill({ lucid, fills: {order, userSellAmount}[], fundingUtxos, collateralUtxo, changeAddress?, ... })`
  → `{ unsignedCbor, txHash, indices: {inputIndex, outputIndex}[], exUnitsList, selfScriptDataHash, txScriptDataHash, scriptDataHashMatches, plans }`.
  Fills N orders in one tx: each order gets its OWN owner + fee output (fee outputs NEVER coalesced — each
  tagged with that order's own PaymentDatum) and its own SwapAction redeemer (input_index over the
  ledger-sorted spend inputs; output_index = that order's owner output, in author order).
- `swapSplitAmounts(amountSell, amountBuy, userSellAmount, isLimitSellAda)` — the §8 relist amounts.

Cancel (OWNER-ONLY — built for completeness, not an aggregator action)
- `buildCancel({ lucid, order, fundingUtxos, collateralUtxo, changeAddress? })`
  → `{ unsignedCbor, txHash, inputIndex, ownerKeyHash, ownerAddressBech32 }`. The ORDER OWNER must sign
  (key-hash owner ⇒ owner pkh in `required_signers`). Script-owner orders are refused (they need an input
  from the owner's own script, which only the owner's infrastructure can supply).

Primitives (independently testable / reusable)
- `encodePlutusData` / `decodePlutusData`, `swapActionRedeemer`, `cancelActionRedeemer`, `paymentDatum`,
  `swapDatumToPlutusData`, `addressToPlutusData`.
- `getRatioAmount` / `calculateFee` / `fillSellAndFee` (BigInt; roundings match the contract).
- `sortInputs` / `inputIndexOf` (canonical ledger txid-then-index sort).
- `computeScriptDataHash` / `encodeLanguageViewsV2` / `encodeRedeemerMap` — self-computed Conway SDH.
- `DEPLOYMENTS`, `deploymentByOrderAddress`, `deploymentByScriptHash`, `FEE_ADDRESS`.

V3 (PlutusV3 — Aegis coverage + partial-fill floor + fill receipts; SPEC §12). **LIVE on mainnet**
(`6023f59dce0064f1d6d27594dbea25bc4305a9f6a10f3a064037553a`, ref `de19f6a9…#0`, order address
`addr1z9sz8ava…`) — the default V3 discovery target, baking the **same** production `fee_address` as
the V2 deployments. The preprod build (`ec457591…`, ref `efb2c0dc…#0`) is retained for the
differential tests. The V3 validator enforces the covered-order **premium output** (to a vault
**distinct** from owner/fee, floored at 1 unit) and binds the CIP-69 **fill-receipt** mint to a real
`SwapAction` fill (SPEC §12.4/§12.7).
- Discovery decodes V3 orders automatically (resolved by the V3 script hash) and surfaces
  `order.minPartialFill` + `order.coverage` (`null` when uncovered).
- `computeFillPlanV3(order, userSellAmount, network, coinsPerUtxoByte?, maxPremiumBps?)` → `FillPlanV3`
  — the V2 plan plus the **Aegis premium output** (`plan.premium`, buy asset to `coverage.vault`, floored
  at 1 unit and refused unless the vault is distinct from owner/fee), the `min_partial_fill` floor, and
  the coverage/floor carry-forward on the relist. `network` is **required** (never defaulted). A covered
  order whose `premium_bps` exceeds `maxPremiumBps` (default `10_000` = 100%) is **refused** as
  malicious/malformed.
- `buildTakerFillV3({ lucid, order, userSellAmount, fundingUtxos, collateralUtxo, network?, maxPremiumBps?, mintReceipt?, validFromUnixMs?, ... })`
  — assembles the unsigned V3 tx (owner + fee + premium + relist + **fill-receipt mint**), cross-checked
  against the self-computed PlutusV3 `script_data_hash`. `network` is derived from `lucid.config().network`
  when `opts.network` is omitted (it throws if neither is available — no silent default). It mints a
  CIP-69 fill-receipt by default (`mintReceipt: false` opts out), satisfying the binding: `SwapAction`
  output-index == receipt `owner_output_index`, PaymentDatum-tagged owner payout, and an on-chain-derived
  `sold_amount`. The result exposes `premiumRequired` (BUY asset, out of pocket — see below) and
  `receiptLovelace` (parked on the receipt output).
- `computeFillReceipt(order, plan, scriptInputSell, executedAtMs)` → `ReceiptPlan` — the pure
  `FillReceiptDatum` derivation (`bought` = owner payout; `sold` = full → `amount_sell`, partial →
  `script_input_sell − continuation_sell`).
- V3 codec: `decodeSwapDatumV3` / `swapDatumV3ToPlutusData`, `coverageToPlutusData`, `paymentDatumV3`
  and `outputRefV3ToPlutusData` (**flat** `OutputReference`), plus `fillReceiptDatum*` /
  `mintFillReceiptRedeemer` / `FILL_RECEIPT_ASSET_NAME` for the CIP-69 receipt. SDH:
  `computeScriptDataHashV3` / `encodeLanguageViewsV3` (language-views key 2).
  `premiumForFill(filledBuy, premiumBps)`.

#### V3 covered-order economics (read before quoting)
- **The premium is OUT OF POCKET.** A covered fill pays `plan.premium.required` (in the **BUY** asset)
  to the coverage vault **on top of** the owner payout. It is **NOT** reflected in the order's
  `sell`/`buy` amounts or `priceBaseUnits`. Integrators **MUST subtract `plan.premium.required`** from
  their profitability/quote for a covered order, or they will overquote and lose the premium.
- **ADA-buy covered orders carry a ~1 ADA floor.** When the buy asset is ADA the premium output must
  itself clear the ledger min-UTxO, so a covered ADA-buy fill incurs an unavoidable ~1 ADA premium
  floor even when the raw `premium_bps` premium is tiny.
- **The fill-receipt parks reclaimable ADA.** `mintReceipt` defaults **true** and parks
  ~1.2–1.7 ADA (`receiptLovelace`, reclaimable by later spending the receipt UTxO) per fill, plus a
  marginal minting fee. For high-volume fillers that will not use the receipts, pass `mintReceipt: false`.

## Status

| Feature | Status |
|---|---|
| Discovery (1% + optional 4%) | Implemented (unit-tested on the live 1% book fixture + a 4% order) |
| Per-order fee resolution (100 / 400) | Implemented (resolved from the order's own script address) |
| Non-auth taker-fill builder | Implemented; **proven on-chain** — mainnet 1% + preprod 1% (txs linked below). The 4% branch is build+eval-proven (FRENCHIE), not yet submitted on-chain |
| PARTIAL fill + §8 relist split | Implemented; **proven on-chain** (preprod, linked below) |
| Multi-order single-tx batching (may mix 1% + 4%) | Implemented (per-order owner + fee outputs at their own rate, never coalesced) |
| `CancelAction` builder (owner-only, key-hash owner) | Implemented; script-owner cancels refused |
| Self-computed Conway SDH | Implemented; equals the builder's SDH and accepted by the ledger |
| Exact min-UTxO | Implemented — `(size+160)*coinsPerUtxoByte` over the output incl. its inline PaymentDatum |
| **V3 codec** (11-field datum, flat `OutputReference`, `Coverage`) | Implemented; differential-tested against real on-chain datums |
| **V3 script_data_hash** (language-views key 2, bare PlutusV3 cost model) | Implemented; distinct from the V2 key-1 recipe |
| **V3 covered-order fill** (`computeFillPlanV3`: premium output + `min_partial_fill` floor + coverage carry-forward + bounded premium) | Implemented; unit-proven. **LIVE on mainnet** (`6023f59d…`, txs linked below) |
| **V3 receipt + premium binding**: premium ≥1 floor + vault-distinctness; fill-receipt mint bound to a real `SwapAction` fill (derived `sold_amount`) | Implemented; unit-proven. Proven on **mainnet** (fill+receipt, insured/covered fill, partial+relist, cancel — txs below) |

### On-chain proofs (non-auth taker fills built by this library)

- **Mainnet — 1% full fill:** [`aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab`](https://cexplorer.io/tx/aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab) — block 13615420, `valid_contract: True`, 1% fee in the sell asset to the baked `fee_address`, signed with the taker key only (no `authorize` co-sign).
- **Preprod — 1% full fill:** [`90ddbf29a847a08115ba4608a4fa9e951ef5d97a84f9a30aeaeeb9a3cbc0baad`](https://preprod.cexplorer.io/tx/90ddbf29a847a08115ba4608a4fa9e951ef5d97a84f9a30aeaeeb9a3cbc0baad) — block 4880554.
- **Preprod — 1% partial fill + §8 relist:** [`fdf5cab313e0242c677d09bf2890ecb4393d365bddf4eebfea21ea1c48e548eb`](https://preprod.cexplorer.io/tx/fdf5cab313e0242c677d09bf2890ecb4393d365bddf4eebfea21ea1c48e548eb) — block 4880596.

The **4% branch** is build- and UPLC-eval-proven (a non-auth fill against the mainnet FRENCHIE 4% order, fee output at the 4% rate to the shared `fee_address`, ex-units mem 331449 / steps 112,716,586) but **not yet submitted on-chain**. Its construction is byte-identical to the proven 1% path except the validator's compiled `fee_percent` constant (400 vs 100).

### V3 on-chain proofs (mainnet)

V3 is **live on mainnet** at `6023f59dce0064f1d6d27594dbea25bc4305a9f6a10f3a064037553a` (order address
`addr1z9sz8ava…`, ref script `de19f6a9…#0`). The covered-order premium, the fill-receipt binding, the
`min_partial_fill` floor + coverage carry-forward, cancels, and the LP emit/withdraw path are all
proven on mainnet (mainnet tx ids, abbreviated):

- **Create V3 orders:** `b6bcaeb69401127ed650fea550c87464c7fed8aeef05f25950738db6ece754cc`
- **Fill + fill-receipt mint:** `bda03d5624466ed0d3838ed53c514b392e7bde6418bde08b159c959d135c7b98` — owner paid PaymentDatum-tagged, a fill-receipt mints under the swap policy id bound to the real fill (`sold` derived, `bought` = owner payout, `executed_at` = ledger POSIXTime).
- **Insured (covered) fill:** `fe17fb88fe4282e133e980808b9e11fc92aa0f7fe1ee3f89f3ab7a77abe4d784` — covered fill + premium output to the distinct Aegis vault.
- **Partial fill + relist:** `ad182bcd7273ed7130ac22568ee9ddb0890f90db7040dd68e2bafa69342805b3` — the relisted remainder carries `min_partial_fill` AND the full `coverage` forward.
- **Cancel (owner):** `dfe44a63ea8ba326d15562608e6ab2c5d30718414006fcabc58c542237e66813`
- **LP add:** `eee72c22b0482043da8ac46576e42ea5f3091888aa27f16902dc49ac78a45561` — adds liquidity (emits orders).
- **LP withdraw / emit:** `18a0133987f8f2f308b5f62fb319d64a5276896585d35beab7efd8ea1edfd14e`
