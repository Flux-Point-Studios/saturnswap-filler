// V4 beacon token-name derivation. Byte-for-byte identical to the on-chain
// Aiken derivation in SaturnSwapContract/v4/lib/saturn_swap_v4/beacons.ak
// (and to adam-oc's @adam/cardano-swaps scheme):
//
//   pair  = sha2_256( pairAssetBytes(sell) ++ pairAssetBytes(buy) )   (one-way, directional)
//   offer = sha2_256( 0x01 ++ sell_policy ++ sell_name )
//   ask   = sha2_256( 0x02 ++ buy_policy  ++ buy_name  )
//   sortedPair = sha2_256( pairAssetBytes(a1) ++ pairAssetBytes(a2) ) (two-way, non-directional)
//
// where pairAssetBytes(policy,name) = 0x00 if policy is empty (ADA), else policy++name.
//
// Names are 32-byte hex. Query an indexer for policyId+name to enumerate the book.

import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes, bytesToHex } from "./cbor.js";

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

function sha2_256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** ADA (empty policy) contributes the single byte 0x00; otherwise policy++name. */
function pairAssetBytes(policyId: string, assetName: string): Uint8Array {
  if (policyId === "") return new Uint8Array([0x00]);
  return concatBytes(hexToBytes(policyId), hexToBytes(assetName));
}

/** Directional trading-pair beacon (one-way orders): sell → buy. */
export function pairBeaconName(
  policyIdSell: string,
  assetNameSell: string,
  policyIdBuy: string,
  assetNameBuy: string,
): string {
  return sha2_256Hex(
    concatBytes(pairAssetBytes(policyIdSell, assetNameSell), pairAssetBytes(policyIdBuy, assetNameBuy)),
  );
}

/** Offer-asset beacon: all orders offering (selling) this asset. */
export function offerBeaconName(policyIdSell: string, assetNameSell: string): string {
  return sha2_256Hex(concatBytes(new Uint8Array([0x01]), hexToBytes(policyIdSell), hexToBytes(assetNameSell)));
}

/** Ask-asset beacon: all orders asking for (buying) this asset. */
export function askBeaconName(policyIdBuy: string, assetNameBuy: string): string {
  return sha2_256Hex(concatBytes(new Uint8Array([0x02]), hexToBytes(policyIdBuy), hexToBytes(assetNameBuy)));
}

/** Non-directional sorted-pair beacon (two-way MM orders). Pass the pair
 *  lexicographically sorted (asset1 < asset2), same as the datum stores it. */
export function sortedPairBeaconName(
  policyId1: string,
  assetName1: string,
  policyId2: string,
  assetName2: string,
): string {
  return sha2_256Hex(
    concatBytes(pairAssetBytes(policyId1, assetName1), pairAssetBytes(policyId2, assetName2)),
  );
}

/** Lexicographic (policy, then name) comparison; matches Aiken bytearray.compare.
 *  Returns <0, 0, >0. Empty (ADA) policy sorts first. */
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

/** Sort a pair into (asset1, asset2) with asset1 < asset2, as beacon_amm requires. */
export function sortPair(
  a: { policyId: string; assetName: string },
  b: { policyId: string; assetName: string },
): [{ policyId: string; assetName: string }, { policyId: string; assetName: string }] {
  return compareAsset(a.policyId, a.assetName, b.policyId, b.assetName) <= 0 ? [a, b] : [b, a];
}
