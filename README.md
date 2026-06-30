# saturnswap-filler

Standalone, optional reference filler library for aggregators (e.g. DexHunter) to
discover SaturnSwap CLOB orders on-chain and build a **non-auth (1% fee) taker-fill**
transaction **without** the SaturnSwap API.

## Scope: 1%-only
This lib targets **only** the current 1% `saturn_swap` deployment
(hash `73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f`,
addr `addr1z9eejzm3q…`, ref `0e16cd00…#0`). The legacy 4% run-off deployment
(`1af84a9e…`, ref `86cdaeed…#0`) is **out of scope**: those orders are not discovered
and must not be filled by this lib. `total_fee = new_swap_amount_sell * 100 / 10000`.

## Isolation guarantees
- This package never imports `SaturnSwapBackend` or `SaturnSwapWeb`.
- The production backend never imports this package.
- Nothing in production depends on it. It is a separate git repo / artifact.

## Aggregator path
The 1% non-auth fee is paid in the SELL asset to the contract's baked `fee_address`.
No SaturnSwap hot-key / authorize co-sign is involved. The aggregator signs and submits
the unsigned tx this lib produces.

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

## Status

| Feature | Status |
|---|---|
| Discovery (1% only) | Implemented (unit-tested on the live 1% book fixture) |
| Non-auth taker-fill builder | Implemented; proven on-chain (mainnet `aea570815f…`; preprod full fill `90ddbf29…`) |
| PARTIAL fill + §8 relist split | Implemented; proven on-chain (preprod `fdf5cab3…`) |
| Multi-order single-tx batching | Implemented (per-order owner + fee outputs, never coalesced) |
| `CancelAction` builder (owner-only, key-hash owner) | Implemented; script-owner cancels refused |
| Self-computed Conway SDH | Implemented; equals the builder's SDH and accepted by the ledger |
| Exact min-UTxO | Implemented — `(size+160)*coinsPerUtxoByte` over the output incl. its inline PaymentDatum |

On-chain proofs: mainnet non-auth fill `aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab`
(`valid_contract: True`, 1% fee in the sell asset to the baked `fee_address`); preprod full fill
`90ddbf29…` and partial/relist `fdf5cab3…`.
