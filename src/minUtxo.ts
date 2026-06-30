// Exact Conway/Babbage min-UTxO, the ledger rule the fee/owner outputs are floored to:
//
//   minUtxo(output) = ( ||cbor(output)|| + 160 ) * coinsPerUtxoByte
//
// where the output is the post-Alonzo map form { 0: address, 1: value, 2: datum_option }
// and coinsPerUtxoByte is the live `utxoCostPerByte` protocol param (4310 on mainnet).

import { CborWriter, hexToBytes } from "./cbor.js";

const MIN_UTXO_BYTE_OVERHEAD = 160n;

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Decode a bech32 (no length cap, no bech32m) address to its raw bytes (header + creds). */
export function bech32ToBytes(addr: string): Uint8Array {
  const sep = addr.lastIndexOf("1");
  if (sep < 1) throw new Error(`not a bech32 string: ${addr}`);
  const data = addr.slice(sep + 1).toLowerCase();
  const values: number[] = [];
  for (const ch of data) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) throw new Error(`bad bech32 char: ${ch}`);
    values.push(v);
  }
  const payload = values.slice(0, values.length - 6); // drop 6-symbol checksum
  return convertBits(payload, 5, 8, false);
}

function convertBits(data: number[], from: number, to: number, pad: boolean): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return new Uint8Array(out);
}

export type SizingAssets = Record<string, bigint>; // "lovelace" + unit(policyHex+nameHex)

function writeValue(w: CborWriter, assets: SizingAssets): void {
  const lovelace = assets["lovelace"] ?? 0n;
  const tokens = Object.entries(assets).filter(([k]) => k !== "lovelace");
  if (tokens.length === 0) {
    w.writeUint(lovelace);
    return;
  }
  // [ coin, { policy(28B) : { assetName : amount } } ]
  const byPolicy = new Map<string, [string, bigint][]>();
  for (const [unit, amt] of tokens) {
    const policy = unit.slice(0, 56);
    const name = unit.slice(56);
    if (!byPolicy.has(policy)) byPolicy.set(policy, []);
    byPolicy.get(policy)!.push([name, amt]);
  }
  w.writeArrayDef(2);
  w.writeUint(lovelace);
  w.writeMapDef(byPolicy.size);
  for (const [policy, names] of byPolicy) {
    w.writeByteString(hexToBytes(policy));
    w.writeMapDef(names.length);
    for (const [name, amt] of names) {
      w.writeByteString(hexToBytes(name));
      w.writeUint(amt);
    }
  }
}

/** Serialized post-Alonzo output bytes (for sizing). */
export function serializeConwayOutput(
  addressBytes: Uint8Array,
  assets: SizingAssets,
  inlineDatumBytes?: Uint8Array,
): Uint8Array {
  const w = new CborWriter();
  w.writeMapDef(inlineDatumBytes ? 3 : 2);
  w.writeUint(0n).writeByteString(addressBytes);
  w.writeUint(1n);
  writeValue(w, assets);
  if (inlineDatumBytes) {
    w.writeUint(2n);
    w.writeArrayDef(2).writeUint(1n).writeTag(24n).writeByteString(inlineDatumBytes);
  }
  return w.bytesOut();
}

export interface MinUtxoOutput {
  addressBech32: string;
  /** assets used for sizing (include a representative lovelace; token min-utxos are ~1-2 ADA = 4-byte uint) */
  assets: SizingAssets;
  inlineDatumHex?: string;
}

/** (serializedSize + 160) * coinsPerUtxoByte */
export function minUtxoLovelace(out: MinUtxoOutput, coinsPerUtxoByte: bigint): bigint {
  const addrBytes = bech32ToBytes(out.addressBech32);
  const datum = out.inlineDatumHex ? hexToBytes(out.inlineDatumHex) : undefined;
  const size = BigInt(serializeConwayOutput(addrBytes, out.assets, datum).length);
  return (size + MIN_UTXO_BYTE_OVERHEAD) * coinsPerUtxoByte;
}
