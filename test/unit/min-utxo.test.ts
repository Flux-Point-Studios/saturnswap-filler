import { describe, it, expect } from "vitest";
import { bech32ToBytes, serializeConwayOutput, minUtxoLovelace } from "../../src/minUtxo.js";
import { paymentDatum } from "../../src/datum.js";
import { plutusToHex } from "../../src/plutus.js";
import { FEE_ADDRESS } from "../../src/contract.js";
import { bytesToHex, hexToBytes } from "../../src/cbor.js";

const pd = plutusToHex(
  paymentDatum({ txHash: "a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814", outputIndex: 0 }),
);

describe("min-utxo: bech32 decode", () => {
  it("decodes a base address to 57 bytes (1 header + 28 payment + 28 stake)", () => {
    const b = bech32ToBytes(FEE_ADDRESS);
    expect(b.length).toBe(57);
    expect(b[0]).toBe(0x01); // mainnet base addr, key payment + key stake
    // payment cred = cd51fc17…, stake = 63c28615…
    expect(bytesToHex(b.subarray(1, 29))).toBe("cd51fc17182a3b82f3b776e8a5a0d8808e6fc520fa8455015e2410df");
    expect(bytesToHex(b.subarray(29, 57))).toBe("63c28615bf264e2f5857c9e455dd8eb465cae43e91bef062dbd6b606");
  });
});

describe("min-utxo: Conway output serialization shape", () => {
  it("ADA-only output with inline datum is a 3-key map {0,1,2} with [1, tag24(...)] datum", () => {
    const out = serializeConwayOutput(bech32ToBytes(FEE_ADDRESS), { lovelace: 2_000_000n }, hexToBytes(pd));
    const hex = bytesToHex(out);
    expect(hex.startsWith("a3")).toBe(true); // map(3)
    expect(hex).toContain("d818"); // tag 24 around the inline datum bytes
  });
  it("token output is a [coin, multiasset] value", () => {
    const cmatra = "7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66" + "634d41545241";
    const out = serializeConwayOutput(bech32ToBytes(FEE_ADDRESS), { lovelace: 2_000_000n, [cmatra]: 5n }, hexToBytes(pd));
    // value is an array [coin, {policy:{name:amt}}] => contains the policy id bytes
    expect(bytesToHex(out)).toContain("7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66");
  });
});

describe("min-utxo: (size + 160) * coinsPerUtxoByte (the Conway/Babbage ledger rule)", () => {
  it("ADA-only fee output + PaymentDatum ~= 1.21 ADA on mainnet params (the ledger min-UTxO)", () => {
    const min = minUtxoLovelace({ addressBech32: FEE_ADDRESS, assets: { lovelace: 2_000_000n }, inlineDatumHex: pd }, 4310n);
    expect(min).toBe(1_211_110n);
    // explicit formula check
    const size = serializeConwayOutput(bech32ToBytes(FEE_ADDRESS), { lovelace: 2_000_000n }, hexToBytes(pd)).length;
    expect((BigInt(size) + 160n) * 4310n).toBe(min);
  });
  it("scales linearly with coinsPerUtxoByte", () => {
    const a = minUtxoLovelace({ addressBech32: FEE_ADDRESS, assets: { lovelace: 2_000_000n }, inlineDatumHex: pd }, 4310n);
    const b = minUtxoLovelace({ addressBech32: FEE_ADDRESS, assets: { lovelace: 2_000_000n }, inlineDatumHex: pd }, 8620n);
    expect(b).toBe(a * 2n);
  });
  it("token-bearing output costs more than ADA-only", () => {
    const cmatra = "7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66" + "634d41545241";
    const ada = minUtxoLovelace({ addressBech32: FEE_ADDRESS, assets: { lovelace: 2_000_000n }, inlineDatumHex: pd }, 4310n);
    const tok = minUtxoLovelace({ addressBech32: FEE_ADDRESS, assets: { lovelace: 2_000_000n, [cmatra]: 5n }, inlineDatumHex: pd }, 4310n);
    expect(tok).toBeGreaterThan(ada);
  });
});
