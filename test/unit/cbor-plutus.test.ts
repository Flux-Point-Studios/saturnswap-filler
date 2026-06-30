import { describe, it, expect } from "vitest";
import { decodePlutusHex, plutusToHex, PConstr, PInt, PHex } from "../../src/plutus.js";
import { CborWriter, bytesToHex } from "../../src/cbor.js";

// Real live on-chain order a28c54cc#0 (1% address) inline datum.
// The oracle for byte-exact reproduction.
const REAL_DATUM =
  "d8799fd8799fd8799f581c5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4ffd8799fd8799fd8799f581c96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305ffffffff40401a017d7840581c7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc6646634d415452411b0000001d2207fb3fd87a9fffd8799fd8799f4100ff00ffff";

describe("Plutus CBOR codec", () => {
  it("round-trips the real on-chain SwapDatum byte-identically", () => {
    const decoded = decodePlutusHex(REAL_DATUM);
    expect(plutusToHex(decoded)).toBe(REAL_DATUM);
  });

  it("encodes constructors as indefinite arrays (tag + 0x9f .. 0xff)", () => {
    // None = Constr1[] must be d87a9fff (verified on chain, field 7 of REAL_DATUM)
    expect(plutusToHex(PConstr(1, []))).toBe("d87a9fff");
    // Constr0[] = d8799fff
    expect(plutusToHex(PConstr(0, []))).toBe("d8799fff");
  });

  it("encodes uints with minimal CBOR length classes", () => {
    expect(plutusToHex(PInt(25000000n))).toBe("1a017d7840"); // 4-byte class
    expect(plutusToHex(PInt(125124999999n))).toBe("1b0000001d2207fb3f"); // 8-byte class
    expect(plutusToHex(PInt(0n))).toBe("00");
    expect(plutusToHex(PInt(23n))).toBe("17");
    expect(plutusToHex(PInt(24n))).toBe("1818");
  });

  it("encodes ADA legs (empty policy/name) as 0x40", () => {
    expect(plutusToHex(PHex(""))).toBe("40");
  });

  it("supports bignums beyond uint64", () => {
    const big = (1n << 64n) + 5n;
    const w = new CborWriter();
    w.writeUint(big);
    // tag 2 (0xc2) + 9-byte bytestring 0x01 00..00 05
    expect(bytesToHex(w.bytesOut())).toBe("c2490100000000000000" + "05");
  });
});
