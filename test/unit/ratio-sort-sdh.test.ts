import { describe, it, expect } from "vitest";
import { calculateRatio, calculateFromRatio, getRatioAmount, calculateFee, fillSellAndFee } from "../../src/ratio.js";
import { compareTxIn, sortInputs, inputIndexOf } from "../../src/sort.js";
import {
  encodeLanguageViewsV2,
  encodeRedeemerMap,
  computeScriptDataHash,
  computeScriptDataHashFromParts,
  blake2b256,
} from "../../src/scriptDataHash.js";
import { swapActionRedeemer } from "../../src/datum.js";
import { bytesToHex } from "../../src/cbor.js";

describe("ratio math (Aiken port, rounds UP / fee rounds DOWN)", () => {
  it("full fill of the worked order: sell released = amount_sell, fee = 1%", () => {
    const { newSwapAmountSell, totalFee } = fillSellAndFee(25_000_000n, 125_124_999_999n, 125_124_999_999n, 100);
    expect(newSwapAmountSell).toBe(25_000_000n); // whole sell leg
    expect(totalFee).toBe(250_000n); // 0.25 ADA
  });

  it("getRatioAmount(x,x,y) == y (identity on full fill)", () => {
    expect(getRatioAmount(125_124_999_999n, 125_124_999_999n, 25_000_000n)).toBe(25_000_000n);
  });

  it("calculate_ratio / calculate_from_ratio round up", () => {
    // (1*1e12 + 3 - 1)/3 = (1e12+2)/3 -> ceil
    expect(calculateRatio(1n, 3n, 1_000_000_000_000n)).toBe(333333333334n);
    expect(calculateFromRatio(3n, 333333333334n, 1_000_000_000_000n)).toBe(2n); // rounds up past 1
  });

  it("calculate_fee rounds down (4% example)", () => {
    expect(calculateFee(4_235_165n, 400)).toBe(169_406n); // 4235165*400/10000 = 169406.6 -> 169406
    expect(calculateFee(25_000_000n, 100)).toBe(250_000n);
  });

  it("rejects a dust fill that floors the 1% fee to 0 (released sell < 100 base units)", () => {
    // released sell = ~25 base units -> 1% floors to 0 -> a 0-fee fill is refused
    expect(() => fillSellAndFee(50n, 100n, 50n, 100)).toThrow(/dust fill/);
  });

  it("a fill releasing exactly 100 base units keeps the minimum 1-unit fee (not dust)", () => {
    const { newSwapAmountSell, totalFee } = fillSellAndFee(100n, 100n, 100n, 100);
    expect(newSwapAmountSell).toBe(100n);
    expect(totalFee).toBe(1n);
  });
});

describe("canonical input sort (ledger: txid bytes then index)", () => {
  it("orders by txid bytes, then output index", () => {
    const a = { txHash: "00".repeat(32), outputIndex: 5 };
    const b = { txHash: "00".repeat(31) + "01", outputIndex: 0 };
    const c = { txHash: "00".repeat(32), outputIndex: 2 };
    const sorted = sortInputs([a, b, c]);
    expect(sorted.map((x) => x.outputIndex)).toEqual([2, 5, 0]); // c, a (same txid, idx 2<5), then b
    expect(compareTxIn(a, c)).toBeGreaterThan(0);
  });

  it("computes the order's input_index after sort", () => {
    const order = { txHash: "ff".repeat(32), outputIndex: 0 };
    const f1 = { txHash: "11".repeat(32), outputIndex: 0 };
    const f2 = { txHash: "aa".repeat(32), outputIndex: 3 };
    expect(inputIndexOf([order, f1, f2], order)).toBe(2); // ff sorts last
  });
});

describe("self-computed Conway script_data_hash primitives", () => {
  it("language_views encodes { 1 : <bare cost-model array> } (NOT tag-24)", () => {
    const lv = encodeLanguageViewsV2([100788n, 420n, 1n]);
    // a1 (map 1) 01 (key=1) 83 (array len 3) 1a000189b4 (100788) 1901a4 (420) 01 (1)
    expect(bytesToHex(lv)).toBe("a101" + "83" + "1a000189b4" + "1901a4" + "01");
    expect(bytesToHex(lv).startsWith("a101")).toBe(true); // map{1: ...}, no 0xd818 tag24
  });

  it("redeemer map is { [tag,index] => [data, [mem,steps]] }", () => {
    const data = swapActionRedeemer(125_124_999_999n, 2n as unknown as number, 0);
    const red = encodeRedeemerMap([{ tag: 0, index: 2, data, exUnits: { mem: 500000n, steps: 200000000n } }]);
    const hex = bytesToHex(red);
    // map(1) key=[00,02] -> a1 82 00 02 ; value [data, [mem,steps]]
    expect(hex.startsWith("a18200" + "02" + "82")).toBe(true);
    // contains the SwapAction data d8799f...ff
    expect(hex).toContain("d8799f1b0000001d2207fb3f0200ff");
  });

  it("hash from parts == constructive hash (datums omitted)", () => {
    const cm = [100788n, 420n, 1n, 1n, 1000n];
    const data = swapActionRedeemer(1n, 0, 0);
    const entry = { tag: 0, index: 0, data, exUnits: { mem: 1n, steps: 1n } };
    const h1 = computeScriptDataHash([entry], cm);
    const h2 = computeScriptDataHashFromParts(encodeRedeemerMap([entry]), null, cm);
    expect(bytesToHex(h1)).toBe(bytesToHex(h2));
    expect(h1.length).toBe(32);
  });

  it("blake2b256 matches the known empty-input digest", () => {
    expect(bytesToHex(blake2b256(new Uint8Array(0)))).toBe(
      "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
    );
  });
});
