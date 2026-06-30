import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { koiosRowToRawUtxo, normalizeBook, decodeOrderUtxo, humanPrice } from "../../src/discovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../fixtures/live_1pct_book.json"), "utf8"));

describe("discovery: normalize the live 1% book from a real Koios fixture", () => {
  const utxos = fixture.map(koiosRowToRawUtxo);
  const book = normalizeBook(utxos);

  it("decodes every UTxO in the fixture into an order", () => {
    expect(book.length).toBe(fixture.length);
    expect(book.length).toBeGreaterThan(0);
  });

  it("resolves the 1% deployment (version + ref script) per order", () => {
    for (const o of book) {
      expect(o.version).toBe("1pct");
      expect(o.scriptHash).toBe("73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f");
      expect(o.refScript.txHash).toBe(
        "0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9",
      );
      expect(o.feePercentX100).toBe(100);
    }
  });

  it("decodes the worked order a28c54cc#0 to the exact spec values (base units)", () => {
    const o = book.find((x) => x.utxo.txHash.startsWith("a28c54cc"))!;
    expect(o).toBeTruthy();
    // SELL 25.000000 ADA (empty policy/name), WANT 125124.999999 cMATRA
    expect(o.sell.policyId).toBe("");
    expect(o.sell.assetName).toBe("");
    expect(o.sell.amount).toBe(25_000_000n);
    expect(o.buy.policyId).toBe("7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66");
    expect(Buffer.from(o.buy.assetName, "hex").toString()).toBe("cMATRA");
    expect(o.buy.amount).toBe(125_124_999_999n);
    expect(o.validBeforeTime).toBeNull();
    // sentinel output_reference on a fresh order
    expect(o.datum.outputReference.txHash).toBe("00");
    expect(o.datum.outputReference.outputIndex).toBe(0);
    // owner copied verbatim: base address, key payment + key stake
    expect(o.datum.owner.payment.type).toBe("key");
    expect(o.datum.owner.payment.hash).toBe("5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4");
    expect(o.datum.owner.stake?.hash).toBe("96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305");
    // human price ~0.00019980 ADA per cMATRA (cMATRA decimals = 6)
    const p = humanPrice(o, 6, 6);
    expect(p).toBeGreaterThan(0.0001998);
    expect(p).toBeLessThan(0.0002);
  });

  it("scriptValue captures the locked lovelace (25 ADA sold + ~1 ADA min-utxo)", () => {
    const o = book.find((x) => x.utxo.txHash.startsWith("a28c54cc"))!;
    expect(o.scriptValue.lovelace).toBe(26_000_000n);
  });

  it("ignores a non-script-address UTxO", () => {
    const fake = decodeOrderUtxo({
      txHash: "00".repeat(32),
      outputIndex: 0,
      address: "addr1qxnonsense",
      value: { lovelace: 1_000_000n, assets: {} },
      inlineDatumHex: undefined,
    });
    expect(fake).toBeUndefined();
  });
});
