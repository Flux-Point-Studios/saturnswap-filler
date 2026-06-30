// Self-computed Conway script_data_hash — the live recipe the ledger accepts, proven
// on-chain (SPEC §7.10):
//
//   script_data_hash = blake2b256( cbor(redeemers) || cbor(datums) || cbor(language_views) )
//     language_views = { 1 : <PlutusV2 cost-model integer array, BARE> }   # key 1 = PlutusV2
//                                                                          # NOT tag-24 wrapped
//     datums         = ZERO bytes for inline-datum spends (no witness datums)
//     redeemers      = the Conway redeemer map encoding from witness key 5
//
// This is DELIBERATELY NOT the legacy variant (tag-24-wrapped cost model + an empty 0x80
// datums array), which the ledger rejects (PPViewHashesDontMatch).

import { blake2b } from "@noble/hashes/blake2b";
import { CborWriter, bytesToHex } from "./cbor.js";
import { encodePlutusData, type PlutusData } from "./plutus.js";

export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

export interface RedeemerEntry {
  tag: number; // 0 = Spend, 1 = Mint, 2 = Cert, 3 = Reward, ...
  index: number; // pointer index (input position for Spend)
  data: PlutusData;
  exUnits: { mem: bigint; steps: bigint };
}

/** Conway redeemer witness map: { [tag, index] => [data, [mem, steps]] }, keys sorted by (tag, index). */
export function encodeRedeemerMap(entries: RedeemerEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag || a.index - b.index);
  const w = new CborWriter();
  w.writeMapDef(sorted.length);
  for (const e of sorted) {
    w.writeArrayDef(2).writeUint(BigInt(e.tag)).writeUint(BigInt(e.index)); // key [tag, index]
    w.writeArrayDef(2); // value [data, exunits]
    encodePlutusData(e.data, w);
    w.writeArrayDef(2).writeUint(e.exUnits.mem).writeUint(e.exUnits.steps);
  }
  return w.bytesOut();
}

/** language_views = { 1 : <bare PlutusV2 cost-model array> }. */
export function encodeLanguageViewsV2(costModelV2: bigint[]): Uint8Array {
  const w = new CborWriter();
  w.writeMapDef(1);
  w.writeUint(1n); // key = PlutusV2
  w.writeArrayDef(costModelV2.length);
  for (const n of costModelV2) w.writeInt(n);
  return w.bytesOut();
}

/** Low-level: hash from already-encoded parts (mirrors the live on-chain recipe exactly). */
export function computeScriptDataHashFromParts(
  redeemersCbor: Uint8Array,
  datumsCbor: Uint8Array | null,
  costModelV2: bigint[],
): Uint8Array {
  const langViews = encodeLanguageViewsV2(costModelV2);
  const datums = datumsCbor ?? new Uint8Array(0);
  const pre = new Uint8Array(redeemersCbor.length + datums.length + langViews.length);
  pre.set(redeemersCbor, 0);
  pre.set(datums, redeemersCbor.length);
  pre.set(langViews, redeemersCbor.length + datums.length);
  return blake2b256(pre);
}

/** Constructive: build the redeemer map from entries, omit datums (inline-datum spend). */
export function computeScriptDataHash(
  redeemers: RedeemerEntry[],
  costModelV2: bigint[],
  datumsCbor: Uint8Array | null = null,
): Uint8Array {
  return computeScriptDataHashFromParts(encodeRedeemerMap(redeemers), datumsCbor, costModelV2);
}

export { bytesToHex };
