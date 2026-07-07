// Canonical cardano-swaps beacon token-name derivation (fallen-icarus protocol v2).
// Byte-for-byte the on-chain Aiken hashes in cardano-swaps/aiken/lib/cardano_swaps:
//
//   one-way pair  = sha2_256( offer_id_or00 ++ offer_name ++ ask_id_or00 ++ ask_name )
//   one-way offer = sha2_256( 0x01 ++ offer_id ++ offer_name )
//   one-way ask   = sha2_256( 0x02 ++ ask_id  ++ ask_name  )
//   two-way pair  = sha2_256( a1_id_or00 ++ a1_name ++ a2_id_or00 ++ a2_name )  (pair sorted)
//   two-way asset = sha2_256( asset_id ++ asset_name )                          (UNPREFIXED)
//
// where an empty (ADA) policy id is replaced by the single byte 0x00 for the pair
// pre-hash so ADA pairs get a distinct beacon per direction. Names are 32-byte hex.

import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes, bytesToHex } from "./cbor.js";

export interface AssetClass {
  policyId: string; // "" = ADA
  assetName: string; // "" = ADA
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function sha2(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Pair pre-hash id: ADA (empty policy) becomes the single byte 0x00. */
function pairIdBytes(policyId: string): Uint8Array {
  return policyId === "" ? new Uint8Array([0x00]) : hexToBytes(policyId);
}

/** Pair beacon: sha256(id1_or00 ++ name1 ++ id2_or00 ++ name2). Directional for
 *  one-way (pass offer, ask); pass a sorted pair for two-way. */
export function pairBeacon(a1: AssetClass, a2: AssetClass): string {
  return sha2(
    concatBytes(
      pairIdBytes(a1.policyId),
      hexToBytes(a1.assetName),
      pairIdBytes(a2.policyId),
      hexToBytes(a2.assetName),
    ),
  );
}

/** One-way offer beacon: sha256(0x01 ++ offer_id ++ offer_name). */
export function offerBeacon(policyId: string, assetName: string): string {
  return sha2(concatBytes(new Uint8Array([0x01]), hexToBytes(policyId), hexToBytes(assetName)));
}

/** One-way ask beacon: sha256(0x02 ++ ask_id ++ ask_name). */
export function askBeacon(policyId: string, assetName: string): string {
  return sha2(concatBytes(new Uint8Array([0x02]), hexToBytes(policyId), hexToBytes(assetName)));
}

/** Two-way asset beacon: sha256(asset_id ++ asset_name) — UNPREFIXED. */
export function assetBeacon(policyId: string, assetName: string): string {
  return sha2(concatBytes(hexToBytes(policyId), hexToBytes(assetName)));
}

/** Lexicographic (policy, then name) comparison; matches Aiken bytearray.compare.
 *  Empty (ADA) policy sorts first. */
export function compareAsset(policyId1: string, assetName1: string, policyId2: string, assetName2: string): number {
  const c = compareHex(policyId1, policyId2);
  return c !== 0 ? c : compareHex(assetName1, assetName2);
}

function compareHex(a: string, b: string): number {
  const ba = hexToBytes(a);
  const bb = hexToBytes(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i]! !== bb[i]!) return ba[i]! - bb[i]!;
  }
  return ba.length - bb.length;
}

/** Sort a pair so asset1 < asset2, as the two-way beacon derivation requires. */
export function sortPair(a: AssetClass, b: AssetClass): [AssetClass, AssetClass] {
  return compareAsset(a.policyId, a.assetName, b.policyId, b.assetName) <= 0 ? [a, b] : [b, a];
}
