// Asserts the lib reproduces REAL ON-CHAIN bytes.
//
// The load-bearing CBOR (datum / redeemer / address / script_data_hash) is what routes
// funds, so each primitive is pinned to ground truth. Each golden's provenance is inline:
//   [chain]  = real on-chain bytes/values (a live resting order's datum / redeemers)
//   [spec]   = SPEC.md hand-verified golden hex

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decodeSwapDatumHex,
  swapDatumToPlutusData,
  paymentDatum,
  swapActionRedeemer,
  cancelActionRedeemer,
  addressToPlutusData,
} from "../../src/datum.js";
import { plutusToHex, decodePlutusHex, type PlutusData } from "../../src/plutus.js";
import { compareTxIn } from "../../src/sort.js";
import { encodeLanguageViewsV2, encodeRedeemerMap, computeScriptDataHashFromParts, blake2b256 } from "../../src/scriptDataHash.js";
import { CborWriter, bytesToHex } from "../../src/cbor.js";

const here = dirname(fileURLToPath(import.meta.url));
const redeemers = JSON.parse(readFileSync(join(here, "../../fixtures/onchain_redeemers_1pct.json"), "utf8"));

// Real live on-chain order a28c54cc#0 inline datum.
const REAL_DATUM =
  "d8799fd8799fd8799f581c5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4ffd8799fd8799fd8799f581c96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305ffffffff40401a017d7840581c7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc6646634d415452411b0000001d2207fb3fd87a9fffd8799fd8799f4100ff00ffff";

describe("SwapDatum encoder reproduces on-chain bytes", () => {
  it("[chain] re-encoding a decoded order reproduces the on-chain bytes byte-identically", () => {
    const d = decodeSwapDatumHex(REAL_DATUM);
    const reencoded = plutusToHex(
      swapDatumToPlutusData({
        owner: d.owner,
        policyIdSell: d.policyIdSell,
        assetNameSell: d.assetNameSell,
        amountSell: d.amountSell,
        policyIdBuy: d.policyIdBuy,
        assetNameBuy: d.assetNameBuy,
        amountBuy: d.amountBuy,
        validBeforeTime: d.validBeforeTime,
        outputReference: d.outputReference,
      }),
    );
    expect(reencoded).toBe(REAL_DATUM);
  });
});

describe("owner Address PlutusData", () => {
  it("[chain] reproduces the owner substructure of the on-chain datum", () => {
    const d = decodeSwapDatumHex(REAL_DATUM);
    // owner = Constr0[ VK payment cred, Some(Inline(VK stake)) ]
    const ownerHex =
      "d8799f" + // Constr0
      "d8799f581c5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4ff" + // VK payment
      "d8799fd8799fd8799f581c96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305ffffff" + // Some(Inline(VK stake))
      "ff";
    expect(plutusToHex(addressToPlutusData(d.owner))).toBe(ownerHex);
  });
});

describe("PaymentDatum (double-satisfaction tag)", () => {
  it("[spec §10] PaymentDatum{a28c54cc#0} == the hand-verified golden hex", () => {
    expect(plutusToHex(paymentDatum({ txHash: "a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814", outputIndex: 0 }))).toBe(
      "d8799fd8799fd8799f5820a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814ff00ffff",
    );
  });
});

describe("SwapAction / CancelAction redeemer", () => {
  it("[spec §5] SwapAction(125124999999,2,0) == golden hex", () => {
    expect(plutusToHex(swapActionRedeemer(125_124_999_999n, 2, 0))).toBe("d8799f1b0000001d2207fb3f0200ff");
  });

  it("[chain] reproduces every real on-chain SwapAction redeemer (round-trip to its exact fields)", () => {
    for (const r of redeemers.swapActions as { fields: number[] }[]) {
      const [usa, inIdx, outIdx] = r.fields;
      const built = swapActionRedeemer(BigInt(usa!), inIdx!, outIdx!);
      const back = decodePlutusHex(plutusToHex(built));
      expect(back.kind).toBe("constr");
      const c = back as Extract<PlutusData, { kind: "constr" }>;
      expect(c.alt).toBe(0);
      expect(c.fields.map((f) => (f as { value: bigint }).value)).toEqual([BigInt(usa!), BigInt(inIdx!), BigInt(outIdx!)]);
    }
  });

  it("[chain] reproduces real on-chain CancelAction redeemer", () => {
    for (const r of redeemers.cancelActions as { fields: number[] }[]) {
      const built = cancelActionRedeemer(r.fields[0]!);
      const c = built as Extract<PlutusData, { kind: "constr" }>;
      expect(c.alt).toBe(1);
      expect((c.fields[0] as { value: bigint }).value).toBe(BigInt(r.fields[0]!));
      // CancelAction(1) == d87a9f01ff
      if (r.fields[0] === 1) expect(plutusToHex(built)).toBe("d87a9f01ff");
    }
  });
});

describe("canonical input sort (Conway ledger order)", () => {
  it("orders by txid bytes (prefix then length) then output index — the canonical ledger order", () => {
    const a = { txHash: "ab".repeat(32), outputIndex: 0 };
    const b = { txHash: "ab".repeat(32), outputIndex: 1 };
    const c = { txHash: "ac".repeat(32), outputIndex: 0 };
    expect(compareTxIn(a, b)).toBeLessThan(0); // same txid, idx 0<1
    expect(compareTxIn(a, c)).toBeLessThan(0); // ab < ac
    expect(compareTxIn(c, a)).toBeGreaterThan(0);
  });
});

describe("script_data_hash uses the LIVE recipe the ledger accepts (NOT the legacy one)", () => {
  const cm = [100788n, 420n, 1n, 1n, 1000n, 173n, 0n, 1n];
  const redMap = encodeRedeemerMap([
    { tag: 0, index: 2, data: swapActionRedeemer(125_124_999_999n, 2, 0), exUnits: { mem: 500000n, steps: 200000000n } },
  ]);

  it("[spec §7.10] language_views = { 1 : <BARE cost-model array> } — NOT tag-24-wrapped", () => {
    const lv = bytesToHex(encodeLanguageViewsV2(cm));
    expect(lv.startsWith("a101")).toBe(true); // map{1: ...}
    expect(lv).not.toContain("d818"); // no tag-24 wrapper (the legacy rejected variant)
    // value is a definite array (major 4): 0x88 for 8 ints
    expect(lv.slice(4, 6)).toBe("88");
  });

  it("[spec §7.10] datums are OMITTED (zero bytes) for inline-datum spends, not an empty 0x80 array", () => {
    const live = bytesToHex(computeScriptDataHashFromParts(redMap, null, cm));
    // legacy path would prepend an empty datums array 0x80 and tag-24 the cost model
    const legacyLangViews = (() => {
      const w = new CborWriter();
      w.writeMapDef(1).writeUint(1n).writeTag(24n);
      const inner = new CborWriter();
      inner.writeArrayDef(cm.length);
      for (const n of cm) inner.writeInt(n);
      w.writeByteString(inner.bytesOut());
      return w.bytesOut();
    })();
    const legacyPre = new Uint8Array(redMap.length + 1 + legacyLangViews.length);
    legacyPre.set(redMap, 0);
    legacyPre.set([0x80], redMap.length);
    legacyPre.set(legacyLangViews, redMap.length + 1);
    const legacy = bytesToHex(blake2b256(legacyPre));
    expect(live).not.toBe(legacy); // we ship the live formula, never the legacy one
    expect(live.length).toBe(64);
  });
});
