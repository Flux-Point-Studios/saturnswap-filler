// Asserts the V3 codec reproduces REAL on-chain V3 bytes and the V3 script_data_hash recipe.
//
// Provenance of the golden datums:
//   [chain] = the exact definite-CBOR SwapDatum bytes read back from the ledger for the preprod
//             V3 create-order tx
//             477e2997326bc455ab10d20f373d2e7aed5013272e6e1861b50ee06c7f8e28b4 (public, on-chain).
//   [type]  = the Aiken SwapDatum/Coverage field order (11 fields; Coverage{vault, premium_bps,
//             policy_ref}); OutputReference is FLAT in the V3 stdlib (Constr0[bstr32, ix]).

import { describe, it, expect } from "vitest";
import {
  decodeSwapDatumV3Hex,
  swapDatumV3ToPlutusData,
  coverageToPlutusData,
  outputRefV3ToPlutusData,
  paymentDatumV3,
  fillReceiptDatumToPlutusData,
  decodeFillReceiptDatum,
  mintFillReceiptRedeemer,
  burnFillReceiptRedeemer,
  FILL_RECEIPT_ASSET_NAME,
  type FillReceiptDatum,
} from "../../src/datumV3.js";
import { paymentDatum } from "../../src/datum.js";
import { plutusToHex } from "../../src/plutus.js";
import { hexToBytes } from "../../src/cbor.js";
import {
  encodeLanguageViewsV2,
  encodeLanguageViewsV3,
  computeScriptDataHash,
  computeScriptDataHashV3,
  bytesToHex,
} from "../../src/scriptDataHash.js";
import { swapActionRedeemer, cancelActionRedeemer } from "../../src/datum.js";

// [chain] covered order: sell 10 ADA, buy 5_000_000 EDST, vkey owner, min_partial_fill=20_000_000,
// coverage = Some(vault=Script(f57e8c62…), premium_bps=100, policy_ref=ce456261…#0).
const COVERED =
  "d8798bd87982d87981581c5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4d87a8040401a00989680581c0ff71ae2bdba25bb5e1805983c8e7924edfc77f808f4f8f6cc421ce444454453541a004c4b40d87a80d8798258200000000000000000000000000000000000000000000000000000000000000000001a01312d00d87981d87983d87982d87a81581cf57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465d87a801864d879825820ce456261980c9d1c20ec74231080093ea2c65ed928dd7533e41b93a75bef570300";

// [chain] uncovered LP-emitted order: sell 10 ADA, buy 5_000_000 EDST, Script(LP) owner,
// min_partial_fill=0, coverage=None.
const UNCOVERED =
  "d8798bd87982d87a81581c14e38c1ff6fe56eba71531f5099ecb3cd802646d7bcebe779e132005d87a8040401a00989680581c0ff71ae2bdba25bb5e1805983c8e7924edfc77f808f4f8f6cc421ce444454453541a004c4b40d87a80d87982582000000000000000000000000000000000000000000000000000000000000000000000d87a80";

describe("V3 SwapDatum decodes real on-chain (definite-CBOR) bytes", () => {
  it("[chain] a covered order decodes to the 11 fields incl. min_partial_fill + Coverage", () => {
    const d = decodeSwapDatumV3Hex(COVERED);
    expect(d.amountSell).toBe(10_000_000n);
    expect(d.amountBuy).toBe(5_000_000n);
    expect(d.minPartialFill).toBe(20_000_000n);
    expect(d.coverage).not.toBeNull();
    expect(d.coverage!.premiumBps).toBe(100n);
    expect(d.coverage!.vault.payment).toEqual({ type: "script", hash: "f57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465" });
    expect(d.coverage!.vault.stake).toBeUndefined();
    expect(d.coverage!.policyRef).toEqual({ txHash: "ce456261980c9d1c20ec74231080093ea2c65ed928dd7533e41b93a75bef5703", outputIndex: 0 });
    // FLAT OutputReference: the fresh-order sentinel is 32 zero bytes (a Blake2b_256 hash width)
    expect(d.outputReference).toEqual({ txHash: "00".repeat(32), outputIndex: 0 });
  });

  it("[chain] an uncovered order decodes to min_partial_fill=0 + coverage=null", () => {
    const d = decodeSwapDatumV3Hex(UNCOVERED);
    expect(d.minPartialFill).toBe(0n);
    expect(d.coverage).toBeNull();
    expect(d.owner.payment).toEqual({ type: "script", hash: "14e38c1ff6fe56eba71531f5099ecb3cd802646d7bcebe779e132005" });
  });

  it("re-encoding a decoded V3 datum round-trips structurally (indefinite ⇄ definite are equivalent)", () => {
    const d = decodeSwapDatumV3Hex(COVERED);
    const reHex = plutusToHex(
      swapDatumV3ToPlutusData({
        owner: d.owner,
        policyIdSell: d.policyIdSell,
        assetNameSell: d.assetNameSell,
        amountSell: d.amountSell,
        policyIdBuy: d.policyIdBuy,
        assetNameBuy: d.assetNameBuy,
        amountBuy: d.amountBuy,
        validBeforeTime: d.validBeforeTime,
        outputReference: d.outputReference,
        minPartialFill: d.minPartialFill,
        coverage: d.coverage,
      }),
    );
    // filler emits indefinite arrays, so the bytes differ from the definite on-chain form…
    expect(reHex).not.toBe(COVERED);
    // …but both decode to the SAME structure, and the indefinite form is byte-stable.
    expect(decodeSwapDatumV3Hex(reHex)).toEqual(d);
    const reHex2 = plutusToHex(swapDatumV3ToPlutusData({ ...d, coverage: d.coverage }));
    expect(reHex2).toBe(reHex);
  });
});

describe("V3 uses a FLAT OutputReference everywhere (the load-bearing V3≠V2 difference)", () => {
  const ref = { txHash: "a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814", outputIndex: 0 };

  it("OutputReference is Constr0[bstr32, ix] (flat) — not the V2 Constr0[Constr0[bstr32], ix]", () => {
    expect(plutusToHex(outputRefV3ToPlutusData(ref))).toBe(
      "d8799f5820a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c81400ff",
    );
  });

  it("PaymentDatum(V3) nests one fewer constructor than PaymentDatum(V2)", () => {
    expect(plutusToHex(paymentDatumV3(ref))).toBe(
      "d8799fd8799f5820a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c81400ffff",
    );
    // V2 wraps the tx_id in a TransactionId constructor: an extra d8799f…ff around the bytes.
    expect(plutusToHex(paymentDatum(ref))).toBe(
      "d8799fd8799fd8799f5820a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814ff00ffff",
    );
    expect(plutusToHex(paymentDatumV3(ref))).not.toBe(plutusToHex(paymentDatum(ref)));
  });
});

describe("Coverage codec (Aegis)", () => {
  it("round-trips a Coverage through encode→SwapDatum→decode", () => {
    const cov = {
      vault: { payment: { type: "script" as const, hash: "f57e8c62095c26e3b69ec5b809ea1014a11aa06b396a5a40235e6465" } },
      premiumBps: 100n,
      policyRef: { txHash: "ce456261980c9d1c20ec74231080093ea2c65ed928dd7533e41b93a75bef5703", outputIndex: 0 },
    };
    // encode a full datum carrying the coverage and decode it back
    const hex = plutusToHex(
      swapDatumV3ToPlutusData({
        owner: { payment: { type: "key", hash: "5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4" } },
        policyIdSell: "", assetNameSell: "", amountSell: 1n,
        policyIdBuy: "", assetNameBuy: "", amountBuy: 1n,
        validBeforeTime: null, outputReference: { txHash: "00".repeat(32), outputIndex: 0 },
        minPartialFill: 0n, coverage: cov,
      }),
    );
    const back = decodeSwapDatumV3Hex(hex).coverage!;
    expect(back.premiumBps).toBe(100n);
    expect(back.vault.payment).toEqual(cov.vault.payment);
    expect(back.policyRef).toEqual(cov.policyRef);
    // the coverage substructure encodes to the same bytes standalone
    expect(plutusToHex(coverageToPlutusData(cov))).toContain("1864"); // premium_bps = 100
  });
});

describe("V3 script_data_hash uses language-views key 2 (PlutusV3), NOT the V2 key-1 recipe", () => {
  const cm = [100788n, 420n, 1n, 1n, 1000n, 173n, 0n, 1n];

  it("[spec §7.10] language_views(V3) = { 2 : <BARE cost-model array> } — key 2, no tag-24", () => {
    const lv = bytesToHex(encodeLanguageViewsV3(cm));
    expect(lv.startsWith("a102")).toBe(true); // map{2: ...}
    expect(lv).not.toContain("d818"); // no tag-24 wrapper
    expect(lv.slice(4, 6)).toBe("88"); // definite array of 8 ints
    // V2 uses key 1 (a101); V3 uses key 2 (a102) — same body, different key.
    expect(bytesToHex(encodeLanguageViewsV2(cm)).startsWith("a101")).toBe(true);
    expect(encodeLanguageViewsV3(cm)).not.toEqual(encodeLanguageViewsV2(cm));
  });

  // The V3 script_data_hash is covered here by the V3(key-2)-vs-V2(key-1) language-views
  // differential and by the honest-fill on-chain proofs cited in SPEC §12.8. A byte-exact
  // golden-SDH assertion would require pinning one specific on-chain V3 tx's full redeemer set,
  // datum set, and the protocol's PlutusV3 cost model at that epoch; those witness bytes are not
  // vendored in this repo, so that assertion is intentionally left out rather than approximated.
  it("the V3 hash differs from the V2 hash for identical redeemers + cost model", () => {
    const reds = [
      { tag: 0, index: 0, data: swapActionRedeemer(5_000_000n, 0, 0), exUnits: { mem: 500000n, steps: 200000000n } },
    ];
    const v3 = bytesToHex(computeScriptDataHashV3(reds, cm));
    const v2 = bytesToHex(computeScriptDataHash(reds, cm));
    expect(v3).not.toBe(v2);
    expect(v3.length).toBe(64);
  });
});

describe("V3 redeemers are byte-identical to V2 (SwapAction / CancelAction unchanged)", () => {
  it("SwapAction / CancelAction encode the same as V2", () => {
    expect(plutusToHex(swapActionRedeemer(125_124_999_999n, 2, 0))).toBe("d8799f1b0000001d2207fb3f0200ff");
    expect(plutusToHex(cancelActionRedeemer(1))).toBe("d87a9f01ff");
  });
});

describe("V3 fill-receipt wire form (hardened CIP-69 mint on the swap script; policy id == hash)", () => {
  // [type] FillReceiptDatum = Constr0[ maker: Address, order_reference: OutputReference(FLAT),
  //   sold_amount, bought_amount, policy_id_sell, asset_name_sell, policy_id_buy, asset_name_buy,
  //   executed_at ] — 9 positional fields; order_reference uses the FLAT V3 OutputReference.
  // GOLDEN-HEX with per-field-UNIQUE markers: every positionally-adjacent same-typed field
  // (sold≠bought, policy_sell≠policy_buy, name_sell≠name_buy) carries a DISTINCT value, so any
  // positional swap in fillReceiptDatumToPlutusData changes these bytes and the golden catches it.
  const receipt: FillReceiptDatum = {
    maker: { payment: { type: "key", hash: "11".repeat(28) } },
    orderReference: { txHash: "22".repeat(32), outputIndex: 7 },
    soldAmount: 111_111n,
    boughtAmount: 222_222n,
    policyIdSell: "33".repeat(28),
    assetNameSell: "44",
    policyIdBuy: "55".repeat(28),
    assetNameBuy: "66",
    executedAt: 1_700_000_000_123n,
  };
  const GOLDEN =
    "d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a9fffffd8799f5820222222222222222222222222222222222222222222222222222222222222222207ff1a0001b2071a0003640e581c333333333333333333333333333333333333333333333333333333334144581c5555555555555555555555555555555555555555555555555555555541661b0000018bcfe5687bff";

  it("FillReceiptDatum encodes to the golden hex (per-field markers catch a positional swap)", () => {
    expect(plutusToHex(fillReceiptDatumToPlutusData(receipt))).toBe(GOLDEN);
    // …and it round-trips structurally.
    expect(decodeFillReceiptDatum(hexToBytes(GOLDEN))).toEqual(receipt);
    // FLAT OutputReference tag: Constr0[ bstr32(22..22), 7 ] — no nested TransactionId wrapper.
    expect(GOLDEN).toContain("d8799f5820" + "22".repeat(32) + "07ff");
    // sold (111111 = 0x1b207) and bought (222222 = 0x3640e) are DISTINCT ⇒ a sold/bought swap shows.
    expect(GOLDEN).toContain("1a0001b207");
    expect(GOLDEN).toContain("1a0003640e");
  });

  it("MintFillReceipt(order_input_index, owner_output_index, receipt_output_index) = Constr0[int,int,int]", () => {
    expect(plutusToHex(mintFillReceiptRedeemer(0, 0, 4))).toBe("d8799f000004ff");
    expect(plutusToHex(mintFillReceiptRedeemer(2, 0, 5))).toBe("d8799f020005ff");
    // BurnFillReceipt = Constr1[]
    expect(plutusToHex(burnFillReceiptRedeemer())).toBe("d87a9fff");
  });

  it("the receipt token name is the UTF-8 bytes of \"SaturnFillReceipt\" (filler-chosen)", () => {
    expect(FILL_RECEIPT_ASSET_NAME).toBe("53617475726e46696c6c52656365697074");
    expect(Buffer.from(FILL_RECEIPT_ASSET_NAME, "hex").toString("utf8")).toBe("SaturnFillReceipt");
  });
});
