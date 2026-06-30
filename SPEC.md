# SaturnSwap `saturn_swap` — Contract Integration Spec

**Status:** the addresses, baked parameters, `SwapDatum`/`SwapRedeemer`/`PaymentDatum` wire formats, and the Conway `script_data_hash` recipe are verified against Cardano mainnet (Koios, read-only) and the validator's on-chain behavior. The non-auth (sell-asset fee) aggregator path in §6/§7 is **proven on-chain on MAINNET** (the reference filler's non-auth fill, mainnet tx `aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab`, `valid_contract: True`; also preprod `90ddbf29…` full + `fdf5cab3…` partial). See §7.10.
**Audience:** DexHunter and any aggregator integrating the SaturnSwap central-limit-order-book (CLOB) **natively in their own router**.
**Naming:** this document uses SaturnSwap's own on-chain field names. It does **not** translate the CLOB into Dexter/Iris AMM-pool terms. (Forcing a CLOB into an AMM-pool abstraction is what broke the earlier Dexter/Iris fork — decimals were assumed, field names diverged. Both are fixed here by being explicit.)

---

## 1. Overview

SaturnSwap is a **synchronous central-limit-order-book on Cardano's eUTxO model**. It is not an AMM and has no batcher you must route through. Each resting order is a **single script UTxO** sitting at the validator's script address, carrying an **inline `SwapDatum`** that fully describes the order (who owns it, what they sell, what they want, how much, and an optional expiry).

You integrate by doing exactly two things on-chain, with **no SaturnSwap API and no Dexter dependency**:

1. **Read the book** — fetch the UTxOs at the order script address(es) and decode each inline `SwapDatum`.
2. **Build a taker fill** — construct a Cardano transaction that spends one or more order UTxOs (via the validator's reference script), pays the order owner the asset they want, pays SaturnSwap a **1% fee in the sell asset**, and (for partial fills) re-lists the remainder back to the script.

The maker who created the order **sells** `amount_sell` of `(policy_id_sell, asset_name_sell)` and **wants** `amount_buy` of `(policy_id_buy, asset_name_buy)`. The **taker** (your user) delivers the buy asset to the owner and takes the sell asset out of the script UTxO. There is no authorization key required for the aggregator path; the **1% non-auth fee in the sell asset is the contract-sanctioned aggregator path** (the validator's on-chain behavior; proven on-chain, §7.10).

---

## 2. Versions & addresses

SaturnSwap bakes its two configuration parameters (`fee_address`, `authorize_address`) into the compiled validator, so the **applied script hash differs per deployment**. The fee percentage is also **compiled in** as a source-level constant (`constants.fee_percent`, not a datum field and not an applied parameter).

**This spec covers the current 1% deployment only.** There is exactly one in-scope deployment, PlutusV2:

| Deployment | Fee | Applied script hash (payment cred) | Order script address | Reference-script UTxO | Plutus |
|---|---|---|---|---|---|
| **Current (1%)** | 1% | `73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f` | `addr1z9eejzm3qsww4hn0semp0akwnuv84dcsag4lrludklgzjt675jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsrfnae7` | `0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9#0` | v2 |

Notes:
- The order address is `0x11`-header (type-1: script payment + key stake, mainnet) with stake credential `5ea481523030b23a495286ca1a18bd141a493e9b5a19d889953f6cdb`.
- The reference-script UTxO `0e16cd00…#0` sits at the custody address `addr1q937xfkfn5y8gaupukgxlx8f8suglttykxhrrvlv2l05ttnxm3g8uxy36gwgg7s4xd69rf3czxcdwhrujs0j45wcsz5sy6zp5t`, holds no datum, and carries the validator as a reference script (5003 bytes). Spend orders using the **reference script** — in cardano-cli the flag that POINTS AT the ref-script UTxO is `--spending-tx-in-reference <refUtxo>`, accompanied by the qualifiers `--spending-plutus-script-v2`, `--spending-reference-tx-in-inline-datum-present`, `--spending-reference-tx-in-redeemer-file`, and `--spending-reference-tx-in-execution-units` (the `--spending-reference-tx-in-*` family are those datum/redeemer/exunits qualifiers, **not** the ref-UTxO pointer). lucid-evolution / Mesh / CSL have the equivalent. You do not need to attach the validator bytes.
- **In-scope check:** read the order UTxO's address → take its payment credential (script hash) → it MUST be `73990b71…`, which spends against ref-script UTxO `0e16cd00…#0`. **Skip any order whose payment credential is not `73990b71…`** (see "Out of scope" below).
- The plutus.json blueprint hash `2c601bb2e97cc9afd50717331f2bad58b5ebe0534e723ad6afa582f7` is the **un-applied template** (before the two Address params are applied). It is never the on-chain address — do not use it for discovery.

### Out of scope: legacy 4% run-off

A separate, older deployment — the **4% run-off book** — still has orders resting on-chain from before the 1% cutover, at script address `addr1zyd0sj57d9lpu7cy9g9qdurpazqc9l4eaxk6j59nd2gkh4275jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsqzf5tn` (script hash `1af84a9e697e1e7b042a0a06f061e88182feb9e9ada950b36a916bd5`, reference-script UTxO `86cdaeed2afa48821a229f09582ddc8a350fcea2f770875cd5ea92b230b7a0a8#0`). **These orders are OUT OF SCOPE for this spec.** That validator bakes `fee_percent = 400` (4%); a fill built with the 1% recipe below underpays the fee 4× → `is_fee_paid_to_address` is false → the validator **DENIES** the whole transaction.

**You MUST filter discovery to the 1% script address only and MUST NOT attempt to fill 4% orders.** When walking the book, confirm each order's payment credential is the 1% hash `73990b71…` and skip anything else.

### Baked parameters (informational)

These are compiled into the 1% validator and are read from the reference-script bytes:

- **`fee_address`** (where the 1% fee output must be paid):
  `addr1q8x4rlqhrq4rhqhnkamw3fdqmzqgum79yragg4gptcjpphmrc2rpt0exfch4s47fu32amr45vh9wg053hmcx9k7kkcrq6kxftd`
  payment VK cred `cd51fc17182a3b82f3b776e8a5a0d8808e6fc520fa8455015e2410df`, stake key `63c28615bf264e2f5857c9e455dd8eb465cae43e91bef062dbd6b606`. This is a real funded key address (non-auth fees land here).
- **`authorize_address`** (an authorization credential baked into the validator — aggregators never hold this key, so they take the sell-asset fee branch):
  `addr1q97zx2xmz2v8zjww3ldm42fjcy259cjdd0fdfpm2hla93wyps0cjn6l2djsqly2hyea4xp6ta9q0rkk45n5dt7xg2aqsjnteg8`
  payment VK cred `7c2328db12987149ce8fdbbaa932c11542e24d6bd2d4876abffa58b8`, stake key `8183f129ebea6ca00f9157267b53074be940f1dad5a4e8d5f8c85741`.

---

## 3. Order discovery

1. **Fetch by script address.** Query UTxOs at the **1% order script address** of section 2 (Koios `POST /address_utxos` with `_extended`, Kupo by-address, Blockfrost `/addresses/{addr}/utxos`, or a local Ogmios/chain follower). Every resting order is one UTxO with an **inline datum** and **no reference script**.
2. **Decode the inline `SwapDatum`** (section 4). All amounts are **base units** (section 6).
3. **Confirm each order is at the 1% address** (payment credential `73990b71…`, ref-script UTxO `0e16cd00…#0`; section 2). **Skip anything that is not** — in particular do NOT fetch or fill orders at the legacy 4% address (§2 "Out of scope"): filling a 4% order with the 1% recipe underpays the fee and the validator denies the tx.

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
   - `total_fee = new_swap_amount_sell * 100 / 10000` = **1%**, integer division (**rounds down**). `fee_percent = 100` is compiled into the 1% validator. (Legacy 4% orders bake `fee_percent = 400` and are **out of scope** — §2; never fill them with this 1% recipe, as the 4× underpayment denies.)
   - **The fee is paid in the SELL asset**, not ADA. If the sell asset is ADA the fee is lovelace; if it is a token the 1% is in that token.
   - **Min-UTxO on the fee output (do not skip).** The fee output is a real ledger UTxO and must satisfy min-UTxO (its inline `PaymentDatum` is counted in the size). For an **ADA-sell** order the output lovelace = `max(total_fee, min_utxo)` — when `total_fee < min_utxo` (small fills) you MUST top it up to min-UTxO (~1.2 ADA at current mainnet params) from taker funds, or the ledger rejects the tx with `OutputTooSmallUTxO`. For a **token-sell** order the output = `total_fee` of the token **+** `min_utxo` ADA. (`min_utxo` = `max(requested, ledger min-UTxO)`; compute the ledger min-UTxO from the live `utxoCostPerByte`.)
7. **Take the sell asset** released from the script UTxO to wherever you want (the taker keeps it; it funds the owner output's min-ADA, the fee, and tx fee). On a full fill the whole script value (`amount_sell` plus any bundled min-ADA) is freed.
8. **Partial fill only:** add exactly **one** relist continuation output back to the script (§8).

**Batching multiple fills (the aggregator's primary path)**

When you fill **several** resting orders in one transaction, each filled order is independent and gets its **own** outputs and its **own** redeemer:

- **One owner output per order AND one fee output per order** — each carrying inline `PaymentDatum{ that order's own tx_id#ix }`. The owner/fee outputs are located by `value_paid_to_with_datum`, which filters `tx.outputs` for `address == target && datum == PaymentDatum{this order's ref}` and **fails unless exactly one output matches** (zero or >1 ⇒ deny).
- **NEVER coalesce fee outputs.** A single merged fee output to `fee_address` carries one `PaymentDatum` and therefore satisfies at most one order; every other order in the batch sees zero matching outputs and denies. Fee outputs to the same `fee_address` are distinguished **solely** by their distinct `PaymentDatum`. The same per-order distinct-`PaymentDatum` rule keeps the owner outputs from cross-satisfying each other.
- **One `SwapAction` redeemer per spent order**, each with that order's own `input_index` (its position among the sorted spending inputs) and `output_index` (the position of *its* owner output in `tx.outputs`).
- Every order in the batch is a 1% order (§2/§3) spending against the single ref-script UTxO `0e16cd00…#0`, and each fee output uses the 1% rate. **Never include a legacy 4% order in a batch** (§2 "Out of scope") — it would deny the whole transaction.

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

> **On-chain proof (the §7.6 fee output).** The non-auth sell-asset fee path in §6/§7 — the only path an aggregator **without** the authorize key can use — is **proven on-chain on MAINNET** by the reference filler: mainnet tx `aea570815f2c3697873f4bef7e8aa8fa130ad4766ed627fd1349f647369e0eab` (block 13615420, `valid_contract: True`, against the live 1% deployment `73990b71…`), signed with the taker key **only — no `authorize` co-sign** — and the ledger confirmed the order spent, the maker paid, the **1% fee in the sell asset** (5,000 cMATRA) delivered to the baked `fee_address` (`cd51fc17…`), the **same** inline `PaymentDatum{spent order ref}` byte-identical on both the owner and fee outputs (double-satisfaction tag), and the filler's self-computed `script_data_hash` accepted. Also proven on preprod: full fill `90ddbf29…` + partial/relist `fdf5cab3…`. The non-auth aggregator fee path is fully validated on-chain end-to-end.

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
- `total_fee = 25000000 * 100 / 10000 = 250000` lovelace = **0.25 ADA**, paid in the **sell asset (ADA)**.

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
2. **Confirm in-scope** — each order's payment credential MUST be the 1% hash `73990b71…` (ref-script UTxO `0e16cd00…#0`); **skip legacy 4% orders** (§2 "Out of scope"). Spend via reference script, inline datum present.
3. **Redeemer** — `SwapAction(user_sell_amount, input_index, output_index)`. `input_index` = position among the canonically sorted **spending inputs** only (`tx.inputs`; reference inputs and collateral excluded); `output_index` = the position of the owner-payment output in `tx.outputs` (**author order — outputs are NOT sorted**).
4. **Outputs** — (a) owner output: owner Address from datum, ≥ `user_sell_amount` of the buy asset (+ min-ADA; for a **full-fill non-ADA-sell** order also satisfy `lovelace(owner) ≥ amount_buy + lovelace(script_utxo)`), inline `PaymentDatum{spent order ref}`; (b) fee output: `fee_address`, `≥ new_swap_amount_sell * 100 / 10000` (**1%**) in the **sell asset**, **floored to min-UTxO** (token fees carry min-ADA on top), inline **same** `PaymentDatum{spent order ref}`; (c) partial fill: one relist continuation back to the script (§8). **Batching:** one owner + one fee output **per order**, each with its own `PaymentDatum` — never merge fee outputs (§7 "Batching multiple fills").
5. **Validity** — honour `valid_before_time` (§7.9).
6. **Build PlutusV2** with current cost models; the integrity hash is automatic in standard builders (§7.10). Submit. **No SaturnSwap API and no authorize key required.**

---

## 12. Facts still needing confirmation

- The worked-order owner **stake** key hash is captured in full from the live datum (`96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305`); the prompt's truncated `96a62ca4…` is consistent. No open issue — copy `owner` verbatim from the datum regardless.
- Exact **min-UTxO ADA** to attach to the owner / relist outputs depends on the live `utxoCostPerByte` protocol parameter at build time — compute it from current protocol params, do not hard-code.
- `valid_before_time` is a POSIX timestamp in **milliseconds**; confirm your builder's `invalid_hereafter` slot↔POSIX conversion against current era `SystemStart`/slot-length when setting expiry-bounded fills. The on-chain check is `is_entirely_before(validity_range, t)`, which passes for `invalid_hereafter ≤ t` **only because Conway's `invalid_hereafter` is an exclusive upper bound**; set it strictly `< t` if your library produces an inclusive bound.
