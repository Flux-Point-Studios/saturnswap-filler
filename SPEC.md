# SaturnSwap `saturn_swap` — Contract Integration Spec

**Status:** the addresses, baked parameters, `SwapDatum`/`SwapRedeemer`/`PaymentDatum` wire formats, and the Conway `script_data_hash` recipe are verified against Cardano mainnet (Koios, read-only) and the validator's on-chain behavior. The non-auth (sell-asset fee) aggregator path in §6/§7 is **proven on-chain on MAINNET** (the reference filler's non-auth fill, mainnet tx [`aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab`](https://cexplorer.io/tx/aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab), `valid_contract: True`; also preprod [`90ddbf29…`](https://preprod.cexplorer.io/tx/90ddbf29a847a08115ba4608a4fa9e951ef5d97a84f9a30aeaeeb9a3cbc0baad) full + [`fdf5cab3…`](https://preprod.cexplorer.io/tx/fdf5cab313e0242c677d09bf2890ecb4393d365bddf4eebfea21ea1c48e548eb) partial). See §7.10.
A third deployment — **V3 (PlutusV3)** — adds an optional Aegis-coverage premium, a minimum-partial-fill floor, and self-validating fill receipts. It is **LIVE on mainnet** at `6023f59dce0064f1d6d27594dbea25bc4305a9f6a10f3a064037553a` (order address `addr1z9sz8ava…`, ref `de19f6a9…#0`), baking the **same** production `fee_address` as the V2 deployments; its datum/redeemer/`script_data_hash` wire formats and the covered-order premium rule are **proven on-chain on MAINNET** (§12.8). The covered-order premium binds to a vault **distinct** from owner/fee (floored at 1 unit) and the CIP-69 fill-receipt mint binds to a real `SwapAction` fill with a derived `sold_amount`. A preprod build (`ec457591…`) backs the differential tests. See §12.
**Audience:** DexHunter and any aggregator integrating the SaturnSwap central-limit-order-book (CLOB) **natively in their own router**.
**Naming:** this document uses SaturnSwap's own on-chain field names. It does **not** translate the CLOB into Dexter/Iris AMM-pool terms. (Forcing a CLOB into an AMM-pool abstraction is what broke the earlier Dexter/Iris fork — decimals were assumed, field names diverged. Both are fixed here by being explicit.)

---

## 1. Overview

SaturnSwap is a **synchronous central-limit-order-book on Cardano's eUTxO model**. It is not an AMM and has no batcher you must route through. Each resting order is a **single script UTxO** sitting at the validator's script address, carrying an **inline `SwapDatum`** that fully describes the order (who owns it, what they sell, what they want, how much, and an optional expiry).

You integrate by doing exactly two things on-chain, with **no SaturnSwap API and no Dexter dependency**:

1. **Read the book** — fetch the UTxOs at the order script address(es) and decode each inline `SwapDatum`.
2. **Build a taker fill** — construct a Cardano transaction that spends one or more order UTxOs (via the validator's reference script), pays the order owner the asset they want, pays SaturnSwap a **fee in the sell asset** (1% or 4%, depending on which deployment the order rests at — §2), and (for partial fills) re-lists the remainder back to the script.

The maker who created the order **sells** `amount_sell` of `(policy_id_sell, asset_name_sell)` and **wants** `amount_buy` of `(policy_id_buy, asset_name_buy)`. The **taker** (your user) delivers the buy asset to the owner and takes the sell asset out of the script UTxO. There is no authorization key required for the aggregator path; the **non-auth fee in the sell asset is the contract-sanctioned aggregator path** (the validator's on-chain behavior; proven on-chain, §7.10). The fee rate is the order's own deployment rate (1% or 4%, §2).

---

## 2. Versions & addresses

SaturnSwap bakes its two configuration parameters (`fee_address`, `authorize_address`) into the compiled validator, so the **applied script hash differs per deployment**. The fee percentage is also **compiled in** as a source-level constant (`constants.fee_percent`, not a datum field and not an applied parameter), so it too **differs per deployment**.

**There are two in-scope deployments**, both PlutusV2, sharing the **same baked `fee_address` and `authorize_address`** and differing **only in `fee_percent`**. Resolve the fee rate **and** the reference-script UTxO **per order** from the order's own address:

| Deployment | Fee | `fee_percent_x100` | Applied script hash (payment cred) | Order script address | Reference-script UTxO | Plutus |
|---|---|---|---|---|---|---|
| **Current (1%)** | 1% | 100 | `73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f` | `addr1z9eejzm3qsww4hn0semp0akwnuv84dcsag4lrludklgzjt675jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsrfnae7` | `0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9#0` | v2 |
| **Legacy run-off (4%)** | 4% | 400 | `1af84a9e697e1e7b042a0a06f061e88182feb9e9ada950b36a916bd5` | `addr1zyd0sj57d9lpu7cy9g9qdurpazqc9l4eaxk6j59nd2gkh4275jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsqzf5tn` | `86cdaeed2afa48821a229f09582ddc8a350fcea2f770875cd5ea92b230b7a0a8#0` | v2 |
| **V3 (mainnet)** | 1% | 100 | `6023f59dce0064f1d6d27594dbea25bc4305a9f6a10f3a064037553a` | `addr1z9sz8avaecqxfuwk6f6efkl2yk7yxpdf76ss7wsxgqm42wh2l9cdyhc0eja9mxq0lgeer90edhlfymnxv2ym3szcetqsp0ume8` | `de19f6a99e0add4019b44f0bf0ad3fd35e59419e8639d5637e46b17c767bedb5#0` | **v3** |

**V3 is a distinct wire format** (§12): its `SwapDatum` has **11 fields** (adds `min_partial_fill` + optional Aegis `coverage`), its `OutputReference` is encoded **flat** (not the V2 nested form), and its `script_data_hash` uses language-views **key 2** (PlutusV3), not key 1. It is **live on mainnet** (`6023f59d…`), a **base** script address (type-1: script payment + key stake), and bakes the **same** production `fee_address` as the V2 deployments. Resolve V3 orders by the payment credential `6023f59d…` and use the V3 codec. A hardened **preprod** build `ec457591…` (order address `addr_test1wrky2av…`, ref `efb2c0dc…#0`, an enterprise/type-7 address whose baked `fee_address` is the preprod deployment's) is kept for the differential tests in `PREPROD_DEPLOYMENTS`; it is not scanned by production discovery.

Notes:
- The 1% order address is `0x11`-header (type-1: script payment + key stake, mainnet) with stake credential `5ea481523030b23a495286ca1a18bd141a493e9b5a19d889953f6cdb`. The 4% address is the same header type with the same stake credential.
- The reference-script UTxO `0e16cd00…#0` (1%) sits at the custody address `addr1q937xfkfn5y8gaupukgxlx8f8suglttykxhrrvlv2l05ttnxm3g8uxy36gwgg7s4xd69rf3czxcdwhrujs0j45wcsz5sy6zp5t`, holds no datum, and carries the validator as a reference script (5003 bytes). The 4% validator is at `86cdaeed…#0`. Spend each order against **its own** ref-script UTxO. In cardano-cli the flag that POINTS AT the ref-script UTxO is `--spending-tx-in-reference <refUtxo>`, accompanied by the qualifiers `--spending-plutus-script-v2`, `--spending-reference-tx-in-inline-datum-present`, `--spending-reference-tx-in-redeemer-file`, and `--spending-reference-tx-in-execution-units` (the `--spending-reference-tx-in-*` family are those datum/redeemer/exunits qualifiers, **not** the ref-UTxO pointer). lucid-evolution / Mesh / CSL have the equivalent. You do not need to attach the validator bytes.
- **Per-order resolution:** read the order UTxO's address → take its payment credential (script hash) → map it to a deployment: `73990b71…` ⇒ `fee_percent_x100 = 100` + ref `0e16cd00…#0`; `1af84a9e…` ⇒ `fee_percent_x100 = 400` + ref `86cdaeed…#0`. Use **that** order's resolved `fee_percent` for its fee output and **that** order's ref script to spend it. Skip any order whose payment credential is neither hash.
- The plutus.json blueprint hash `2c601bb2e97cc9afd50717331f2bad58b5ebe0534e723ad6afa582f7` is the **un-applied template** (before the two Address params are applied). It is never the on-chain address — do not use it for discovery.

### Optional: 4% run-off (in scope)

The **4% run-off book** still has orders resting on-chain from before the 1% cutover, at the legacy address `addr1zyd0sj57d9lpu7cy9g9qdurpazqc9l4eaxk6j59nd2gkh4275jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsqzf5tn` (script hash `1af84a9e697e1e7b042a0a06f061e88182feb9e9ada950b36a916bd5`, reference-script UTxO `86cdaeed2afa48821a229f09582ddc8a350fcea2f770875cd5ea92b230b7a0a8#0`). **These orders are fillable** — aggregators MAY fill them for extra depth — but that validator bakes `fee_percent = 400` (4%), so you **MUST** build the fee output at the 4% rate (`fee_percent_x100 = 400`). A fill built with the 1% recipe underpays the fee 4× → `is_fee_paid_to_address` is false → the validator **DENIES** the whole transaction. The rest of the recipe (§7) is identical; only `fee_percent` differs, and the `fee_address` is the same as the 1% deployment's.

**Mixing deployments in one transaction is fine** (§7 "Batching"): a single tx may fill 1% and 4% orders together as long as **each order's fee output uses its own `fee_percent`** and its own per-order `PaymentDatum`. The shared `fee_address` does not coalesce them — the distinct `PaymentDatum` (the spent order's own ref) keeps each fee output bound to its own order.

### Baked parameters (informational)

These are compiled into **both** validators (identical across the 1% and 4% deployments) and are read from the reference-script bytes:

- **`fee_address`** (where the 1% fee output must be paid):
  `addr1q8x4rlqhrq4rhqhnkamw3fdqmzqgum79yragg4gptcjpphmrc2rpt0exfch4s47fu32amr45vh9wg053hmcx9k7kkcrq6kxftd`
  payment VK cred `cd51fc17182a3b82f3b776e8a5a0d8808e6fc520fa8455015e2410df`, stake key `63c28615bf264e2f5857c9e455dd8eb465cae43e91bef062dbd6b606`. This is a real funded key address (non-auth fees land here).
- **`authorize_address`** (an authorization credential baked into the validator — aggregators never hold this key, so they take the sell-asset fee branch):
  `addr1q97zx2xmz2v8zjww3ldm42fjcy259cjdd0fdfpm2hla93wyps0cjn6l2djsqly2hyea4xp6ta9q0rkk45n5dt7xg2aqsjnteg8`
  payment VK cred `7c2328db12987149ce8fdbbaa932c11542e24d6bd2d4876abffa58b8`, stake key `8183f129ebea6ca00f9157267b53074be940f1dad5a4e8d5f8c85741`.

---

## 3. Order discovery

1. **Fetch by script address.** Query UTxOs at the in-scope order script address(es) of section 2 — the 1% address `addr1z9eejzm3q…`, and (optionally, for extra depth) the 4% address `addr1zyd0sj57d9l…` (Koios `POST /address_utxos` with `_extended`, Kupo by-address, Blockfrost `/addresses/{addr}/utxos`, or a local Ogmios/chain follower). Every resting order is one UTxO with an **inline datum** and **no reference script**.
2. **Decode the inline `SwapDatum`** (section 4). All amounts are **base units** (section 6).
3. **Resolve each order's deployment** from its address (§2): payment credential `73990b71…` ⇒ 1% (`fee_percent_x100 = 100`, ref `0e16cd00…#0`); `1af84a9e…` ⇒ 4% (`fee_percent_x100 = 400`, ref `86cdaeed…#0`). Tag each order with its `fee_percent` + ref script and **skip anything that resolves to neither**. You may scan the 1% address only, or both — but if you fill a 4% order you MUST use its 4% rate (§7.6), or the validator denies.

---

## 4. `SwapDatum` schema

`SwapDatum` is `Constr` alternative **0** (CBOR tag `121` = `0xD8 0x79`) with **9 positional fields, in this order**. It is always **inline** on a resting order. (The saturn_swap validator's on-chain `SwapDatum` type.)

| # | Field | Aiken type | On-chain meaning |
|---|---|---|---|
| 0 | `owner` | `Address` | order owner; receives the buy asset on fill, signs on cancel |
| 1 | `policy_id_sell` | `PolicyId` (bytes) | policy of the asset the maker sells; **empty `h''` = ADA** |
| 2 | `asset_name_sell` | `AssetName` (bytes) | asset name of the sell asset; **empty `h''` = ADA** |
| 3 | `amount_sell` | `Int` | quantity of the sell asset, **base units** |
| 4 | `policy_id_buy` | `PolicyId` (bytes) | policy of the asset the maker wants |
| 5 | `asset_name_buy` | `AssetName` (bytes) | asset name of the buy asset |
| 6 | `amount_buy` | `Int` | quantity of the buy asset the maker wants, **base units** |
| 7 | `valid_before_time` | `Option<Int>` | expiry; `Some(posix_ms)` or `None` |
| 8 | `output_reference` | `OutputReference` | relist-chain link (see §8); fresh orders carry a sentinel |

**Encoding rules** (confirmed against real on-chain order datums):

- `SwapDatum` = `Constr0` → tag `121` + array of the 9 fields. SaturnSwap emits **indefinite-length arrays** on the wire (`0x9f … 0xff`). A definite array decodes to the same Plutus `Data`; Plutus `Data` equality is structural, so either form is accepted by the validator. Match the indefinite form if you want byte-identical reproduction.
- `owner: Address` = `Constr0[ payment_credential, stake_credential ]`.
  - `payment_credential`: `VerificationKeyCredential(bytes28)` = `Constr0[bstr]` (key wallet) **or** `ScriptCredential(bytes28)` = `Constr1[bstr]` (script owner; tag `122`).
  - `stake_credential`: `Option<Referenced<Credential>>`. Present (base addr) → `Some(Inline(cred))` = `Constr0[ Constr0[ Constr0[bstr28] ] ]`. Absent (enterprise) → `None` = `Constr1[]` (tag `122`, empty).
  - All credential hashes are **28 bytes** (the validator enforces `is_key_length_valid == 28` on the owner). **When building the owner output you should copy the `owner` field verbatim from the datum** rather than re-deriving a bech32 — the validator compares `Address` structurally.
- `policy_id_*` / `asset_name_*` = plain bytestrings (CBOR major type 2). **ADA is empty policy AND empty name** → both encode as `0x40` (bstr length 0).
- `amount_sell` / `amount_buy` = unsigned ints (**base units**, §6).
- `valid_before_time`: `Some(t)` = `Constr0[uint]` (tag `121`); `None` = `Constr1[]` (tag `122`, empty).
- `output_reference`: `OutputReference` = `Constr0[ TransactionId, output_index ]` where `TransactionId` = `Constr0[ bstr(tx_hash) ]`; full shape `Constr0[ Constr0[bstr32], uint ]`. **Fresh orders carry a sentinel** `tx_hash = 0x00` (single byte), `index = 0` → `Constr0[ Constr0[ bstr(0x00) ], 0 ]`. This field is the relist-chain link (§8); **for a normal taker fill it is NOT the double-satisfaction tag** — see §7.

### Worked CBOR (a real live order)

UTxO `a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814#0` at the 1% address (value 26,000,000 lovelace), inline datum hex:

```
d8799f
  d8799f                                                  # owner: Address
    d8799f 581c 5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4 ff   # VK payment cred
    d8799f d8799f d8799f 581c 96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305 ff ff ff  # Some(Inline(VK stake))
  ff
  40                                                      # policy_id_sell = h'' (ADA)
  40                                                      # asset_name_sell = h'' (ADA)
  1a 017d7840                                             # amount_sell = 25000000  (25.000000 ADA)
  581c 7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66          # policy_id_buy
  46 634d41545241                                         # asset_name_buy = "cMATRA"
  1b 0000001d2207fb3f                                     # amount_buy = 125124999999  (125124.999999 cMATRA)
  d87a9f ff                                               # valid_before_time = None
  d8799f d8799f 4100 ff 00 ff                             # output_reference = sentinel (tx 0x00, ix 0)
ff
```

Decoded: maker **sells 25.000000 ADA**, **wants 125124.999999 cMATRA**, no expiry, fresh (sentinel) `output_reference`.

---

## 5. `SwapRedeemer` schema

`SwapRedeemer` (verified against real on-chain redeemers):

- **`SwapAction(user_sell_amount: Int, input_index: Int, output_index: Int)`** = `Constr` alternative **0** (tag `121`), 3 positional ints.
  - `user_sell_amount` — quantity of the order's **buy asset** the taker delivers into this order in this fill. Full fill ⇒ `user_sell_amount == amount_buy`; partial fill ⇒ `< amount_buy` (triggers a relist split, §8). The validator checks `token_amount_received_by_owner >= user_sell_amount`.
  - `input_index` — index of **this order's input** among the transaction's **spending inputs only** (`tx.inputs`), after Cardano's canonical sort (by `tx_id` asc, then `output_index` asc). **Reference inputs (including the ref-script UTxO added in §7 step 2) and collateral inputs live in separate context fields and do NOT count toward this index.** Consumed by `get_own_input_fast`; a wrong index reads the wrong input and fails.
  - `output_index` — index, in `tx.outputs`, of the **owner-payment output** (the one tagged with the `PaymentDatum`). **Outputs are NOT ledger-sorted** — they stay in the order you author them, so this is simply that output's position in the list you build. Consumed by `value_paid_to_with_datum_fast`; must be exact.
- **`CancelAction(input_index: Int)`** = `Constr` alternative **1** (tag `122`), 1 int: `input_index` of the order's input among the **spending inputs only** — same canonical sort and same ref-input/collateral exclusion as `SwapAction.input_index` above. See §9.

`PaymentDatum` (the validator's double-satisfaction tag) = `Constr0[ output_reference: OutputReference ]`. It is the **inline datum** placed on the owner-payment output **and** on the fee output, to defend against double satisfaction.

### CBOR examples

```
SwapAction(user_sell_amount=125124999999, input_index=2, output_index=0):
  d8799f 1b0000001d2207fb3f 02 00 ff

CancelAction(input_index=0):
  d87a9f 00 ff

PaymentDatum{ output_reference = a28c54cc…#0 }   (the SPENT order's own ref — see §7):
  d8799f d8799f d8799f 5820 a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814 ff 00 ff ff
```

---

## 6. Decimals & units — the #1 integration footgun

**Every on-chain amount in `SwapDatum` (`amount_sell`, `amount_buy`) and in every value (script UTxO, owner output, fee output, relist output) is a RAW BASE-UNIT INTEGER in that asset's own decimals. Decimals are NEVER encoded on-chain.**

- **ADA** is `lovelace` (6 decimals): `amount = 25000000` means **25.000000 ADA**.
- A token's base unit is its smallest indivisible unit. To convert to a human price you must look up **that token's decimals out-of-band**, e.g. from the Cardano Token Registry / Koios `POST /asset_info` → `token_registry_metadata.decimals`, or your own metadata source. In the worked order, cMATRA (`7ff33a55…adc66` + name `634d41545241`) has `decimals = 6`, so `amount_buy = 125124999999` means **125124.999999 cMATRA**.

**Do NOT assume a token's decimals (do not assume 6, do not assume 0).** Two assets in the same order can have different decimals. The implied price is computed **only after** dividing each leg by its own asset's decimals:

```
price (sell per buy) = (amount_sell / 10^dec_sell) / (amount_buy / 10^dec_buy)
example: (25000000/1e6) / (125124999999/1e6) = 25 / 125124.999999 ≈ 0.00019980 ADA per cMATRA
```

When you **build** a fill, do all ratio/fee/min-UTxO arithmetic in **base units** (integers). Only divide by decimals for display/pricing. Assuming decimals here is precisely the divergence that broke the prior Dexter/Iris fork.

---

## 7. The taker-fill recipe (load-bearing)

This is the exact transaction an aggregator builds to fill a resting order on the **non-auth (sell-asset fee) path**. The validator (the saturn_swap `swap` path) is an AND of eight checks; the recipe below satisfies all of them. Symbols come straight from the datum of the order being spent.

**Inputs / setup**

1. **Select order(s)** from the book and resolve each order's validator + reference-script UTxO from its own address (§2). Read its inline `SwapDatum`.
2. **Add the reference-script UTxO** as a reference input (read-only) and **spend the order UTxO via that reference script**, presenting the order's inline datum.
3. **Add taker funding inputs** for: the buy asset you deliver, min-ADA on the owner output, the fee, and the tx fee + collateral.

**The PaymentDatum tag — use the SPENT ORDER's OWN input ref**

> **CRITICAL.** Both the owner-payment output and the fee output must carry inline datum
> `PaymentDatum{ output_reference = <the resting order's own tx_id#ix being spent> }`.
> The validator binds `output_reference` from the **input it is spending** (`let Input { output_reference, .. } = own_input`), **not** from `SwapDatum.output_reference` (that datum field is ignored in `swap()` and only matters for the relist chain, §8). Using `SwapDatum.output_reference` here will fail.

For the worked order, `PaymentDatum` = `Constr0[ Constr0[ Constr0[bstr(a28c54cc…814)], 0 ] ]` (hex in §5).

**The redeemer**

4. `SwapAction(user_sell_amount, input_index, output_index)` (§5):
   - `user_sell_amount` = base-unit amount of the order's **buy asset** you deliver this fill (`≤ amount_buy`). Full fill ⇒ `= amount_buy`.
   - `input_index` = position of the order's input among the **spending inputs only** (`tx.inputs`), after canonical sort (`tx_id` asc, then `output_index` asc). Reference inputs (incl. the ref-script UTxO) and collateral do **not** count.
   - `output_index` = the position at which **you place** the owner-payment output in `tx.outputs`. **Outputs are NOT sorted by the ledger** — they stay in author order, so this is simply the index of that output in the list you build.

**Outputs**

5. **Owner output** → the order's `owner` Address (copied verbatim from the datum), containing **≥ `user_sell_amount`** of `(policy_id_buy, asset_name_buy)`, inline datum = the `PaymentDatum` above.
   - Add min-ADA to this output from your own funds.
   - **Owner-ADA rule** (`owner_value_has_correct_amount`): satisfied if **any** of — (a) this is a partial fill (`user_sell_amount < amount_buy`), or (b) the order's **sell asset is ADA**, or (c) `lovelace(owner_output) ≥ amount_buy + lovelace(script_utxo)` (`owner_paid_enough_ada_with_min_utxo`). Cases (a) and (b) cover the common paths. In case (c) `amount_buy` is added as a **raw lovelace integer regardless of the buy asset's identity** — so for a **token→token full fill** this would demand `amount_buy`-as-lovelace of ADA in the owner output, which is generally infeasible for large `amount_buy`; such orders must be filled as a **partial fill** (which then satisfies case (a)). The literal formula governs — it is correct as written.
6. **Fee output** → `fee_address` (§2), containing **≥ `total_fee`** of the **sell asset** `(policy_id_sell, asset_name_sell)`, inline datum = the **same** `PaymentDatum{spent order ref}`.
   - `new_swap_amount_sell = get_ratio_amount(amount_buy, user_sell_amount, amount_sell)` (the proportional sell released this fill; §8 for `get_ratio_amount`, which rounds **up**).
   - `total_fee = new_swap_amount_sell * fee_percent_x100 / 10000`, integer division (**rounds down**), using **this order's own deployment rate** (§2): `fee_percent_x100 = 100` (1%) for an order at `73990b71…`, or `fee_percent_x100 = 400` (4%) for an order at `1af84a9e…`. The rate is compiled into the validator, so a 4% order filled at the 1% rate underpays 4× and the validator **denies** (`is_fee_paid_to_address` false). Resolve `fee_percent` per order — never assume 1%.
   - **The fee is paid in the SELL asset**, not ADA. If the sell asset is ADA the fee is lovelace; if it is a token the 1% is in that token.
   - **Min-UTxO on the fee output (do not skip).** The fee output is a real ledger UTxO and must satisfy min-UTxO (its inline `PaymentDatum` is counted in the size). For an **ADA-sell** order the output lovelace = `max(total_fee, min_utxo)` — when `total_fee < min_utxo` (small fills) you MUST top it up to min-UTxO (~1.2 ADA at current mainnet params) from taker funds, or the ledger rejects the tx with `OutputTooSmallUTxO`. For a **token-sell** order the output = `total_fee` of the token **+** `min_utxo` ADA. (`min_utxo` = `max(requested, ledger min-UTxO)`; compute the ledger min-UTxO from the live `utxoCostPerByte`.)
7. **Take the sell asset** released from the script UTxO to wherever you want (the taker keeps it; it funds the owner output's min-ADA, the fee, and tx fee). On a full fill the whole script value (`amount_sell` plus any bundled min-ADA) is freed.
8. **Partial fill only:** add exactly **one** relist continuation output back to the script (§8).

**Batching multiple fills (the aggregator's primary path)**

When you fill **several** resting orders in one transaction, each filled order is independent and gets its **own** outputs and its **own** redeemer:

- **One owner output per order AND one fee output per order** — each carrying inline `PaymentDatum{ that order's own tx_id#ix }`. The owner/fee outputs are located by `value_paid_to_with_datum`, which filters `tx.outputs` for `address == target && datum == PaymentDatum{this order's ref}` and **fails unless exactly one output matches** (zero or >1 ⇒ deny).
- **NEVER coalesce fee outputs.** A single merged fee output to `fee_address` carries one `PaymentDatum` and therefore satisfies at most one order; every other order in the batch sees zero matching outputs and denies. Fee outputs to the same `fee_address` are distinguished **solely** by their distinct `PaymentDatum`. The same per-order distinct-`PaymentDatum` rule keeps the owner outputs from cross-satisfying each other.
- **One `SwapAction` redeemer per spent order**, each with that order's own `input_index` (its position among the sorted spending inputs) and `output_index` (the position of *its* owner output in `tx.outputs`).
- **A batch MAY mix 1% and 4% orders.** Resolve each order's deployment (§2): a 1% order spends against ref-script UTxO `0e16cd00…#0` and its fee output uses the 1% rate; a 4% order spends against `86cdaeed…#0` and its fee output uses the 4% rate. `readFrom` both ref-script UTxOs when the batch spans both deployments. Each order's fee output **must** carry its own `fee_percent` (mixing the rate up — a 4% order with a 1%-rate fee output — denies that order and the whole tx). Because the two deployments share the same `fee_address`, the per-order distinct `PaymentDatum` is what keeps the fee outputs from coalescing — never merge them.

**Validity & order activity**

9. If `valid_before_time = Some(t)`, the tx `validity_range` must be **entirely before** `t` (`is_entirely_before`). Set `invalid_hereafter ≤ t` (POSIX ms domain); the `≤` is admissible **only because Conway's `invalid_hereafter` is an exclusive upper bound**. A library that emits an inclusive upper bound would fail at `invalid_hereafter == t` (it would need strict `<`), so conservative integrators may set `invalid_hereafter` strictly `< t` to avoid the exact-boundary edge. `None` ⇒ no constraint.

**Other invariants the validator enforces (satisfied automatically by the above):**
- `script_utxo_has_enough_asset`: the spent UTxO holds `≥ amount_sell` of the sell asset.
- `is_asset_valid`: the owner output's buy-asset name matches `asset_name_buy`. The validator reads the owner output's tokens for `policy_id_buy` and expects exactly one asset name under that policy — **the owner output must not bundle a second, unrelated asset under `policy_id_buy`**.
- `is_owner_valid`: owner credentials are 28 bytes (true for any real address).
- `is_fee_correct`: the validator's fee check accepts EITHER the `authorize_address` co-signature (which aggregators do not hold) OR the sell-asset fee output — aggregators always take the fee-output branch (step 6).

**Script integrity hash (`script_data_hash`, body key 11)**

10. Any standard Conway builder (cardano-cli `transaction build`/`build-raw`, lucid-evolution, Mesh, cardano-serialization-lib) computes the integrity hash **automatically** from the redeemers + datums + the protocol's language views. **The validator imposes no custom integrity-hash requirement** — there is nothing special to do here for the common case.
    For **hand-rolled** builders only (e.g. `build-raw`, whose own language-views encoding the ledger rejects with `PPViewHashesDontMatch`), the live recipe the ledger accepts is:
    ```
    script_data_hash = blake2b256( cbor(redeemers) ‖ cbor(datums) ‖ cbor(language_views) )
      language_views = { 1 : <PlutusV2 cost-model integer array, BARE> }   # key 1 = PlutusV2; cost model is the array directly, NOT tag24-wrapped
      datums         = ZERO bytes for inline-datum swaps (no witness datums present)
      redeemers      = the Conway redeemer encoding from the witness set (key 5)
    ```
    A legacy variant that tag24-wraps the cost model and uses an empty `0x80` datums array is **rejected** by the ledger (`PPViewHashesDontMatch`); do not copy it.

> **On-chain proof (the §7.6 fee output).** The non-auth sell-asset fee path in §6/§7 — the only path an aggregator **without** the authorize key can use — is **proven on-chain on MAINNET** by the reference filler: mainnet tx [`aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab`](https://cexplorer.io/tx/aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab) (block 13615420, `valid_contract: True`, against the live 1% deployment `73990b71…`), signed with the taker key **only — no `authorize` co-sign** — and the ledger confirmed the order spent, the maker paid, the **1% fee in the sell asset** (5,000 cMATRA) delivered to the baked `fee_address` (`cd51fc17…`), the **same** inline `PaymentDatum{spent order ref}` byte-identical on both the owner and fee outputs (double-satisfaction tag), and the filler's self-computed `script_data_hash` accepted. Also proven on preprod: full fill [`90ddbf29a847a08115ba4608a4fa9e951ef5d97a84f9a30aeaeeb9a3cbc0baad`](https://preprod.cexplorer.io/tx/90ddbf29a847a08115ba4608a4fa9e951ef5d97a84f9a30aeaeeb9a3cbc0baad) (block 4880554) + partial/relist [`fdf5cab313e0242c677d09bf2890ecb4393d365bddf4eebfea21ea1c48e548eb`](https://preprod.cexplorer.io/tx/fdf5cab313e0242c677d09bf2890ecb4393d365bddf4eebfea21ea1c48e548eb) (block 4880596). The **4% non-auth fee branch** (the legacy `1af84a9e…` validator, §2 "Optional: 4% run-off") is **build- and UPLC-eval-proven** by the reference filler — a non-auth fill against the mainnet FRENCHIE 4% order, fee output at the **4% rate** to the shared `fee_address`, ex-units mem 331449 / steps 112,716,586 — but **not yet submitted on-chain**. Its construction is byte-identical to the proven 1% path except the validator's compiled `fee_percent` constant (400 vs 100); a live 4% submit is the only step not yet performed for that rate.

11. Build as **PlutusV2** with current protocol cost models, balance, sign with taker keys, submit. No SaturnSwap API call and no authorize key are involved.

---

## 8. Partial fills / relist (`swap_split`)

If `user_sell_amount < amount_buy`, the validator requires **exactly one** continuation output back to the same script (one split per tx — this is the double-satisfaction defence; the matcher `fail`s on zero or many matches). (The validator's `swap_split` path.)

The continuation output:
- goes to the **same script** (matched by **payment-credential equality**, `is_payment_key_equal`; the same full order address works);
- carries an inline `SwapDatum` with:
  - `owner`, `policy_id_sell`, `asset_name_sell`, `policy_id_buy`, `asset_name_buy`, `valid_before_time` — **unchanged** from the spent order;
  - **`output_reference` = the spent order's own input ref** (this is the relist-chain link; the matcher finds the continuation by `continuation.SwapDatum.output_reference == spent_order_ref`). Note this differs from the `PaymentDatum` usage in §7 only in role, not in value — both reference the spent order's own input ref;
  - `amount_buy` (call it `next_amount_buy`) in `[corrected_new_amount_buy, amount_buy − user_sell_amount]`;
  - `amount_sell` (call it `next_amount_sell`) in `[corrected_new_amount_sell, new_amount_sell]`;
- holds **exactly two value entries: ADA + the sell asset only** — `value_has_asset_and_lovelace` requires exactly two policy entries, so bundling any third asset denies — with **at least `corrected_new_amount_sell` of the sell asset**. For a **non-ADA-sell** order the continuation's lovelace must be **≥ the spent script UTxO's lovelace** (`min_utxo_goes_back_to_script → owner_paid_enough_ada_with_min_utxo(swap_value, script_value, 0)` ⇒ `lovelace(continuation) ≥ lovelace(original script UTxO)`): **preserve the original bundled ADA** (e.g. 2 ADA), do **not** attach a freshly-computed smaller min-UTxO (~1.2 ADA) — that underpays and denies. (For the ADA-sell case the 2-ADA buffer logic below applies instead.)

**Ratio math** (the validator's ratio helpers), scale = `1_000_000_000_000` (1e12), **all roundings UP** (protocol-favourable):
```
calculate_ratio(divisor, dividend, scale) = (divisor*scale + dividend - 1) / dividend          # rounds up
calculate_from_ratio(amount, ratio, scale) = (amount*ratio + scale - 1) / scale                 # rounds up
get_ratio_amount(old_token, new_token, old_amount) =
    calculate_from_ratio(old_amount, calculate_ratio(new_token, old_token, scale), scale)

remaining_buy   = amount_buy - user_sell_amount
new_amount_sell = get_ratio_amount(amount_buy, remaining_buy, amount_sell)   # proportional sell still owed
```

**ADA-sell buffer special case:** if the order's **sell asset is ADA** and `new_amount_sell > 2_000_000` lovelace, a `2_000_000`-lovelace buffer is subtracted from **both** legs to ease the relist's min-UTxO burden:
```
corrected_new_amount_sell = new_amount_sell - 2_000_000
corrected_new_amount_buy  = get_ratio_amount(amount_sell, corrected_new_amount_sell, amount_buy)
```
and that 2-ADA buffer **must be paid to the owner** (`owner_lovelace ≥ buffer`). Otherwise (`sell asset not ADA`, or `≤ 2 ADA`) `corrected_* = new_*` and there is no buffer.

So a valid relist sets `next_amount_sell`/`next_amount_buy` anywhere in the corrected..uncorrected ranges and places ≥ `corrected_new_amount_sell` of the sell asset in the continuation output. The owner output and fee output rules from §7 still apply for the portion filled this tx.

---

## 9. Cancel (`CancelAction`)

To cancel an order (maker-side; not normally an aggregator action but documented for completeness — the validator's `cancel` path):

- Redeemer `CancelAction(input_index)` (§5).
- The tx must be **signed by the owner** (`tx_signed_by_address`):
  - **Key-hash owner** → the owner's key hash must be in `tx.extra_signatories`.
  - **Script owner** → the tx must contain an input from the same script (credential match).
- If the owner is a **script**, the funds must return to the owner with the `PaymentDatum{spent order ref}` tag, and the returned value must equal the spent UTxO's value (`contract_owner_value_return_to_owner`). For a key-hash owner there is no value-routing constraint beyond the signature.

---

## 10. Worked example (concrete, base units)

**Resting order** `a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814#0` at the 1% address (datum decoded in §4):

| Field | Value (base units) | Human |
|---|---|---|
| `owner` | VK `5fce5921…616effc4` + stake `96a62ca4…912cc305` | maker's base address |
| sell | ADA (`h''`/`h''`), `amount_sell = 25000000` | sells 25.000000 ADA |
| buy | `7ff33a55…adc66` / `634d41545241`, `amount_buy = 125124999999` | wants 125124.999999 cMATRA |
| `valid_before_time` | `None` | no expiry |
| script UTxO value | 26000000 lovelace | 25 ADA sold + ~1 ADA bundled min-UTxO |

**Full taker fill** (your user delivers all the cMATRA, takes the ADA):

- `user_sell_amount = 125124999999` (deliver full `amount_buy` of cMATRA).
- `new_swap_amount_sell = get_ratio_amount(125124999999, 125124999999, 25000000) = 25000000` lovelace (whole sell leg released).
- `total_fee = 25000000 * 100 / 10000 = 250000` lovelace = **0.25 ADA**, paid in the **sell asset (ADA)**. (This order rests at the 1% address. An otherwise-identical order at the 4% run-off address — §2 — would take `25000000 * 400 / 10000 = 1000000` lovelace = 1 ADA; resolve `fee_percent` from the order's own address.)

Transaction:
1. **Reference input:** `0e16cd00…#0` (1% reference script). **Spend** order `a28c54cc…#0` via that reference script, inline datum presented.
2. **Redeemer:** `SwapAction(125124999999, <input_index>, <output_index>)` — `input_index` over the canonically sorted **spending inputs** (ref-script input and collateral excluded); `output_index` = the position at which you place the owner output in `tx.outputs` (**author order, NOT sorted**). CBOR (indices 2/0 shown): `d8799f1b0000001d2207fb3f0200ff`.
3. **Owner output** → owner Address (copied from datum), value = `125124999999` cMATRA + min-ADA, inline datum `PaymentDatum{a28c54cc…814#0}` (`d8799fd8799fd8799f5820a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814ff00ffff`).
4. **Fee output** → `fee_address` (`addr1q8x4rl…6kxftd`), value = `max(250000, min_utxo)` lovelace — the raw 1% fee is 0.25 ADA but that is **below min-UTxO**, so this output must actually carry ~min-UTxO (~1.2 ADA at current mainnet params, including its inline datum) or the ledger rejects the tx (`OutputTooSmallUTxO`). Inline datum = the **same** `PaymentDatum{a28c54cc…814#0}`. The min-UTxO top-up is taker-funded from the freed script value.
5. **Taker takes** the 26,000,000 lovelace from the script UTxO (funds the owner min-ADA + the 0.25 ADA fee + tx fee; keeps the rest).
6. Build PlutusV2, balance, integrity hash auto-computed by the builder, sign, submit.

**Net economics (approximate):** maker receives 125124.999999 cMATRA; taker receives ~25 ADA, less tx costs and less the fee output. The 1% protocol fee is only 0.25 ADA, but the fee output must be floored to ~min-UTxO, so the taker effectively forwards ~1.2 ADA to `fee_address` on a fill this small (on larger fills the 1% exceeds the floor and dominates). All amounts in the math above are base-unit-exact; the ADA net is approximate because min-UTxO depends on live protocol params.

**Partial fill** (e.g. deliver `user_sell_amount = 62562499999` cMATRA, ~half): owner output gets ≥ 62562499999 cMATRA; fee output gets 1% of `get_ratio_amount(125124999999, 62562499999, 25000000)` in lovelace; and **one** relist continuation goes back to the script per §8 (ADA-sell ⇒ the 2-ADA buffer applies if the remaining sell leg exceeds 2 ADA, and that buffer is paid to the owner). All amounts computed in base units, roundings up per §8.

---

## 11. Integration checklist (neutral)

1. **Read the book** — fetch UTxOs at the order script address(es) (§2/§3), decode inline `SwapDatum` (§4). Treat all amounts as **base units**; divide by each asset's own decimals (§6) only for display/pricing.
2. **Resolve the deployment per order** — map each order's payment credential to a rate + ref script (§2): `73990b71…` ⇒ 1% (`fee_percent_x100 = 100`, ref `0e16cd00…#0`); `1af84a9e…` ⇒ 4% (`fee_percent_x100 = 400`, ref `86cdaeed…#0`); skip anything else. Spend each order via **its own** reference script, inline datum present.
3. **Redeemer** — `SwapAction(user_sell_amount, input_index, output_index)`. `input_index` = position among the canonically sorted **spending inputs** only (`tx.inputs`; reference inputs and collateral excluded); `output_index` = the position of the owner-payment output in `tx.outputs` (**author order — outputs are NOT sorted**).
4. **Outputs** — (a) owner output: owner Address from datum, ≥ `user_sell_amount` of the buy asset (+ min-ADA; for a **full-fill non-ADA-sell** order also satisfy `lovelace(owner) ≥ amount_buy + lovelace(script_utxo)`), inline `PaymentDatum{spent order ref}`; (b) fee output: `fee_address`, `≥ new_swap_amount_sell * fee_percent_x100 / 10000` (use **this order's own rate** — 100 for `73990b71…`, 400 for `1af84a9e…`) in the **sell asset**, **floored to min-UTxO** (token fees carry min-ADA on top), inline **same** `PaymentDatum{spent order ref}`; (c) partial fill: one relist continuation back to the script (§8). **Batching (1% and/or 4%):** one owner + one fee output **per order**, each with its own `PaymentDatum` and its own `fee_percent` — never merge fee outputs (§7 "Batching multiple fills").
5. **Validity** — honour `valid_before_time` (§7.9).
6. **Build PlutusV2** with current cost models; the integrity hash is automatic in standard builders (§7.10). Submit. **No SaturnSwap API and no authorize key required.**

---

## 12. V3 (PlutusV3): Aegis coverage, partial-fill floor, fill receipts

The V3 `saturn_swap` validator is a superset of V2: the same swap/cancel/relist logic plus three
additions. It is **live on mainnet** (§2, `6023f59d…`), a base script address, `fee_percent = 100`
(1%, same rate as the mainnet 1% deployment, and the fee is still paid in the sell asset to the
**same** production `fee_address`). Everything in §6–§11 still applies; the V3-specific deltas:

### 12.1 The FLAT `OutputReference` (the load-bearing V3 ≠ V2 difference)

V3's stdlib defines `TransactionId` as a **bytes alias** (`Hash<Blake2b_256>`), not a record, so an
`OutputReference` is **flat**:

```
V3:  OutputReference = Constr0[ bstr32(tx_id), uint(output_index) ]
V2:  OutputReference = Constr0[ Constr0[ bstr32(tx_id) ], uint(output_index) ]   # extra wrapper
```

This flat form is used **everywhere** an `OutputReference` appears in V3: `SwapDatum.output_reference`
(field 8), `Coverage.policy_ref`, and — critically — the **`PaymentDatum`** double-satisfaction tag
on the owner / fee / premium / relist outputs. A V3 `PaymentDatum{a28c54cc…#0}` is
`d8799fd8799f5820a28c54cc…814 00 ff ff` (vs the V2 `d8799fd8799fd8799f5820…814 ff 00 ff ff`). Using
the V2 nesting on a V3 fill makes the datum mismatch and the validator denies. Fresh V3 orders carry
a **32-byte-zero** sentinel `tx_id` (a Blake2b_256 width), not the V2 single `0x00` byte.

### 12.2 `SwapDatum` (V3, 11 fields)

`Constr0` with the 9 V2 fields (§4) followed by:

| # | Field | Aiken type | Meaning |
|---|---|---|---|
| 9 | `min_partial_fill` | `Int` | minimum buy-asset size of any **partial** fill; `0` = no floor (V2 parity) |
| 10 | `coverage` | `Option<Coverage>` | `Some` ⇒ Aegis-covered (premium output required); `None` ⇒ uncovered / inert |

`Coverage = Constr0[ vault: Address, premium_bps: Int, policy_ref: OutputReference ]`. `vault` is the
Aegis vault address (the premium destination); `premium_bps` sets the per-fill premium; `policy_ref`
pins the on-chain Aegis policy/coverage UTxO (the "Aegis-covered" truth for indexers).

### 12.3 `min_partial_fill` (V3 #4)

A **partial** fill (`user_sell_amount < amount_buy`) must satisfy `user_sell_amount >= min_partial_fill`
or the validator denies (`is_fill_above_floor`). A **full** fill is always allowed. The partial-fill
relist (§8) must carry `min_partial_fill` forward **unchanged** (`is_correct_min_partial_fill`).

### 12.4 Coverage / the premium output (V3 #6)

When `coverage = Some(cov)`, the fill **must** emit a premium **output** (NOT a `treasury_donation` —
Conway key 22 only reaches the chain treasury) to `cov.vault`, carrying **≥ `required`** of the
**buy asset**, where:

```
required = max(1, user_sell_amount * cov.premium_bps / 10000)   # base rounds DOWN, then floor at 1
```

> **The premium is OUT OF POCKET for the filler.** `required` (in the **buy** asset) is paid to the
> vault **on top of** the owner payout — it is **NOT** reflected in the order's `amount_sell`/`amount_buy`
> or in `priceBaseUnits`. Integrators **MUST subtract `plan.premium.required`** from their
> profitability/quote for a covered order. The reference filler also **bounds** `premium_bps`
> (`maxPremiumBps`, default `10_000` = 100%) and refuses to build a covered order above it — a premium
> `>=` the fill's buy amount is almost certainly malicious/malformed. For an **ADA-buy** covered order
> the premium output must itself clear the ledger min-UTxO, so it carries an unavoidable ~1 ADA floor
> even when the raw `premium_bps` premium is tiny.

The base rounds down, and the validator then **floors `required` at 1** so a covered fill can **never
owe zero** — a premium output is therefore emitted for **every** covered order, regardless of
`premium_bps` (even `0`). The premium output is tagged with the **same `PaymentDatum{spent order ref}`**
as the owner/fee outputs and is located by `value_paid_to_with_datum` (**exactly one** output to
`vault` with that datum — zero or many ⇒ deny). The vault **must be distinct** — the validator
**enforces this on-chain** (`is_vault_distinct`): `vault.payment_credential != owner.payment_credential`
**and** `vault != fee_address`. The owner check is on the **payment credential only**, so a vault that
shares the owner's payment credential collides even if the stake part differs; the filler mirrors this
exactly and refuses to build a doomed tx. The relist (§8) must carry the **whole `coverage` forward
unchanged** (`is_correct_coverage`) — a filler cannot strip coverage, redirect the premium, or lower
the floor on the continuation. `treasury_donation` is inert for both covered and uncovered orders
(`swap` never reads it), so a donation may be present but is never the premium mechanism.

### 12.5 Redeemers

`SwapAction(user_sell_amount, input_index, output_index)` and `CancelAction(input_index)` are
**byte-identical to V2** (§5). Only the datum + `script_data_hash` differ.

### 12.6 `script_data_hash` (PlutusV3)

For hand-rolled builders the live recipe is the §7.10 recipe with **language-views key 2** and the
**bare PlutusV3 cost model** (a definite integer array, NOT tag-24-wrapped):

```
script_data_hash = blake2b256( cbor(redeemers) ‖ cbor(datums) ‖ cbor(language_views) )
  language_views = { 2 : <PlutusV3 cost-model integer array, BARE> }   # key 2 = PlutusV3
  datums         = ZERO bytes for inline-datum spends
```

Do **not** use the V2 key-1 recipe for a V3 order (the ledger rejects the mismatch,
`PPViewHashesDontMatch`). Standard builders (cardano-cli, lucid-evolution, Mesh, CSL) compute key 11
automatically from the protocol's PlutusV3 cost model.

### 12.7 Fill receipts (optional, minted by default)

The V3 validator also has a CIP-69 **mint** handler on the same script (receipt policy id == the swap
script hash). The `spend` handler does **not** require the receipt, but `buildTakerFillV3` mints one by
default (pass `mintReceipt: false` to opt out). `MintFillReceipt(order_input_index,
owner_output_index, receipt_output_index)` = `Constr0[int,int,int]`; `BurnFillReceipt` = `Constr1[]`.
The receipt's inline `FillReceiptDatum` records `maker`, `order_reference`, `sold_amount`,
`bought_amount`, the sell/buy asset ids, and `executed_at` (the tx's finite lower validity bound —
**POSIXTime in milliseconds**, not a slot). Its existence is oracle-free proof of a real fill.

> **The raw `bought_amount / sold_amount` ratio is NOT the executed price for an ADA-buy fill.** When
> the buy asset is ADA the owner output carries `amount_buy` **plus the maker's returned script
> min-UTxO deposit**, so `bought_amount` overstates the ADA actually bought. The true price is
> `(bought_amount − script_input_deposit_lovelace) / sold_amount`, and the **authoritative** rate is
> the datum's `amount_buy / amount_sell` (the limit the maker set), not the raw receipt ratio. For a
> token-buy fill the returned ADA lands on a separate output, so `bought_amount / sold_amount` is exact.

The receipt token **name is filler-chosen** (the handler requires exactly one token of quantity 1
under the policy but does not constrain the name — it binds the datum); this lib uses the UTF-8 bytes
of `"SaturnFillReceipt"`. `mintReceipt` defaults **true** and parks ~1.2–1.7 ADA (reclaimable by
later spending the receipt UTxO — surfaced as `receiptLovelace` in the fill result) per fill plus a
marginal minting fee; high-volume fillers that will not use the receipts should pass `mintReceipt: false`.

The V3 validator makes the receipt unforgeable — it can only mint alongside a *real* fill.
`buildTakerFillV3` satisfies the binding exactly:

1. **`SwapAction` bind.** The order input is spent with `SwapAction(user_sell, input_index,
   output_index)`; the mint handler reads that redeemer at `Spend(order_ref)` and requires
   `output_index == owner_output_index`. A `CancelAction`-mint or a receipt riding an unrelated spend
   fails. The builder sets both to the owner-output index `0`.
2. **`PaymentDatum`-bound payout.** The maker payout at that index is bound by `address == owner` **and**
   `InlineDatum(PaymentDatum{order_ref})`; `bought_amount` is read there — the payout the `spend` itself
   enforced (index 0 in this builder).
3. **Derived `sold_amount`.** `sold` is derived on-chain and *compared*, not asserted: a **full** fill ⇒
   `amount_sell`; a **partial** fill ⇒ `script_input_sell − continuation_sell` (the sell asset in the
   spent order UTxO minus the sell asset re-listed on the continuation). The builder computes the
   identical value (`computeFillReceipt`), so the minted receipt validates; a fabricated price is denied.

`executed_at` is the tx's finite lower validity bound in POSIXTime ms. The builder snaps the desired
`validFrom` to its slot boundary so `executed_at` equals the POSIXTime the ledger derives from
`invalid_before` (the slot↔POSIX round-trip is stable at slot boundaries).

### 12.8 On-chain proof (mainnet)

V3 is proven end-to-end on **mainnet** at `6023f59d…` (order address `addr1z9sz8ava…`, ref script
`de19f6a9…#0`). Mainnet tx ids (abbreviated):

- **Create V3 orders:** `b6bcaeb69401127ed650fea550c87464c7fed8aeef05f25950738db6ece754cc`.
- **Fill + fill-receipt mint:** `bda03d5624466ed0d3838ed53c514b392e7bde6418bde08b159c959d135c7b98` — order spent with `SwapAction`, owner paid
  PaymentDatum-tagged, a receipt mints under the swap policy id bound to the real fill (`sold` derived,
  `bought` = owner payout, `executed_at` = ledger POSIXTime).
- **Insured (covered) fill:** `fe17fb88fe4282e133e980808b9e11fc92aa0f7fe1ee3f89f3ab7a77abe4d784` — covered fill + premium output to the distinct Aegis vault.
- **Partial fill + relist:** `ad182bcd7273ed7130ac22568ee9ddb0890f90db7040dd68e2bafa69342805b3` — the relisted remainder carries `min_partial_fill` AND the
  full `coverage` forward.
- **Cancel (owner):** `dfe44a63ea8ba326d15562608e6ab2c5d30718414006fcabc58c542237e66813`.
- **LP add:** `eee72c22b0482043da8ac46576e42ea5f3091888aa27f16902dc49ac78a45561`; **LP withdraw / emit:** `18a0133987f8f2f308b5f62fb319d64a5276896585d35beab7efd8ea1edfd14e`.

---

## 13. Facts still needing confirmation

- The worked-order owner **stake** key hash is captured in full from the live datum (`96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305`); the prompt's truncated `96a62ca4…` is consistent. No open issue — copy `owner` verbatim from the datum regardless.
- Exact **min-UTxO ADA** to attach to the owner / relist outputs depends on the live `utxoCostPerByte` protocol parameter at build time — compute it from current protocol params, do not hard-code.
- `valid_before_time` is a POSIX timestamp in **milliseconds**; confirm your builder's `invalid_hereafter` slot↔POSIX conversion against current era `SystemStart`/slot-length when setting expiry-bounded fills. The on-chain check is `is_entirely_before(validity_range, t)`, which passes for `invalid_hereafter ≤ t` **only because Conway's `invalid_hereafter` is an exclusive upper bound**; set it strictly `< t` if your library produces an inclusive bound.
