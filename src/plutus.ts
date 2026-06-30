// Plutus Data <-> CBOR. Encoding matches SaturnSwap's on-chain form exactly:
// constructors are tag + INDEFINITE array (0x9f .. 0xff), even when empty
// (verified against real on-chain order datums).

import { CborReader, CborWriter, type CborValue, bytesToHex, hexToBytes } from "./cbor.js";

export type PlutusData =
  | { kind: "constr"; alt: number; fields: PlutusData[] }
  | { kind: "int"; value: bigint }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "list"; items: PlutusData[] }
  | { kind: "map"; entries: [PlutusData, PlutusData][] };

export const PConstr = (alt: number, fields: PlutusData[]): PlutusData => ({ kind: "constr", alt, fields });
export const PInt = (value: bigint | number): PlutusData => ({ kind: "int", value: BigInt(value) });
export const PBytes = (value: Uint8Array): PlutusData => ({ kind: "bytes", value });
export const PHex = (hex: string): PlutusData => ({ kind: "bytes", value: hexToBytes(hex) });

function tagForAlt(alt: number): { tag: bigint; compact: boolean } {
  if (alt >= 0 && alt <= 6) return { tag: 121n + BigInt(alt), compact: true };
  if (alt >= 7 && alt <= 127) return { tag: 1280n + BigInt(alt - 7), compact: true };
  return { tag: 102n, compact: false };
}

export function encodePlutusData(d: PlutusData, w: CborWriter = new CborWriter()): CborWriter {
  switch (d.kind) {
    case "int":
      w.writeInt(d.value);
      return w;
    case "bytes":
      w.writeByteString(d.value);
      return w;
    case "list":
      w.beginArrayIndef();
      for (const it of d.items) encodePlutusData(it, w);
      w.endIndef();
      return w;
    case "map":
      w.writeMapDef(d.entries.length);
      for (const [k, v] of d.entries) {
        encodePlutusData(k, w);
        encodePlutusData(v, w);
      }
      return w;
    case "constr": {
      const { tag, compact } = tagForAlt(d.alt);
      w.writeTag(tag);
      if (compact) {
        w.beginArrayIndef();
        for (const f of d.fields) encodePlutusData(f, w);
        w.endIndef();
      } else {
        // general constructor: tag 102 + [ uint(alt), indefinite-list(fields) ]
        w.writeArrayDef(2);
        w.writeUint(BigInt(d.alt));
        w.beginArrayIndef();
        for (const f of d.fields) encodePlutusData(f, w);
        w.endIndef();
      }
      return w;
    }
  }
}

export function plutusToBytes(d: PlutusData): Uint8Array {
  return encodePlutusData(d).bytesOut();
}

export function plutusToHex(d: PlutusData): string {
  return bytesToHex(plutusToBytes(d));
}

function fromCbor(v: CborValue): PlutusData {
  switch (v.t) {
    case "uint":
      return { kind: "int", value: v.v };
    case "nint":
      return { kind: "int", value: v.v };
    case "bytes":
      return { kind: "bytes", value: v.v };
    case "array":
      return { kind: "list", items: v.v.map(fromCbor) };
    case "map":
      return { kind: "map", entries: v.v.map(([k, val]) => [fromCbor(k), fromCbor(val)] as [PlutusData, PlutusData]) };
    case "tag": {
      const tag = v.tag;
      let alt: number | null = null;
      if (tag >= 121n && tag <= 127n) alt = Number(tag - 121n);
      else if (tag >= 1280n && tag <= 1400n) alt = Number(tag - 1280n) + 7;
      if (alt !== null) {
        if (v.v.t !== "array") throw new Error("constructor tag without array body");
        return { kind: "constr", alt, fields: v.v.v.map(fromCbor) };
      }
      if (tag === 102n) {
        if (v.v.t !== "array" || v.v.v.length !== 2) throw new Error("tag-102 constructor malformed");
        const altNode = v.v.v[0]!;
        const body = v.v.v[1]!;
        if (altNode.t !== "uint" || body.t !== "array") throw new Error("tag-102 constructor malformed");
        return { kind: "constr", alt: Number(altNode.v), fields: body.v.map(fromCbor) };
      }
      throw new Error(`unsupported CBOR tag ${tag}`);
    }
    case "text":
      return { kind: "bytes", value: new TextEncoder().encode(v.v) };
    case "simple":
    case "float":
      throw new Error("CBOR simple/float value is not valid Plutus data");
  }
}

export function decodePlutusData(bytes: Uint8Array): PlutusData {
  return fromCbor(new CborReader(bytes).decode());
}

export function decodePlutusHex(hex: string): PlutusData {
  return decodePlutusData(hexToBytes(hex));
}

export { bytesToHex, hexToBytes };
