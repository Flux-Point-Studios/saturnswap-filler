// Self-computed Conway script_data_hash — the live recipe the ledger accepts, proven
// on-chain (SPEC §7.10):
//
//   script_data_hash = blake2b256( cbor(redeemers) || cbor(datums) || cbor(language_views) )
//     language_views = { <lang> : <cost-model integer array, BARE> }   # key 1 = PlutusV2,
//                                                                      # key 2 = PlutusV3
//                                                                      # NOT tag-24 wrapped
//     datums         = ZERO bytes for inline-datum spends (no witness datums)
//     redeemers      = the Conway redeemer map encoding from witness key 5
//
// This is DELIBERATELY NOT the legacy variant (tag-24-wrapped cost model + an empty 0x80
// datums array), which the ledger rejects (PPViewHashesDontMatch). A V2 order (mainnet)
// uses the key-1 recipe; a V3 order uses the key-2 recipe with the bare PlutusV3 cost model.

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

/** language_views = { <langKey> : <bare cost-model integer array> } (NOT tag-24 wrapped). */
export function encodeLanguageViews(langKey: bigint, costModel: bigint[]): Uint8Array {
  const w = new CborWriter();
  w.writeMapDef(1);
  w.writeUint(langKey); // 1 = PlutusV2, 2 = PlutusV3
  w.writeArrayDef(costModel.length);
  for (const n of costModel) w.writeInt(n);
  return w.bytesOut();
}

/** language_views = { 1 : <bare PlutusV2 cost-model array> }. */
export function encodeLanguageViewsV2(costModelV2: bigint[]): Uint8Array {
  return encodeLanguageViews(1n, costModelV2);
}

/** language_views = { 2 : <bare PlutusV3 cost-model array> }. */
export function encodeLanguageViewsV3(costModelV3: bigint[]): Uint8Array {
  return encodeLanguageViews(2n, costModelV3);
}

function hashScriptDataParts(
  redeemersCbor: Uint8Array,
  datumsCbor: Uint8Array | null,
  langViews: Uint8Array,
): Uint8Array {
  const datums = datumsCbor ?? new Uint8Array(0);
  const pre = new Uint8Array(redeemersCbor.length + datums.length + langViews.length);
  pre.set(redeemersCbor, 0);
  pre.set(datums, redeemersCbor.length);
  pre.set(langViews, redeemersCbor.length + datums.length);
  return blake2b256(pre);
}

/** Low-level (PlutusV2): hash from already-encoded parts (mirrors the live on-chain recipe). */
export function computeScriptDataHashFromParts(
  redeemersCbor: Uint8Array,
  datumsCbor: Uint8Array | null,
  costModelV2: bigint[],
): Uint8Array {
  return hashScriptDataParts(redeemersCbor, datumsCbor, encodeLanguageViewsV2(costModelV2));
}

/** Low-level (PlutusV3): language-views key 2 + the bare PlutusV3 cost model. */
export function computeScriptDataHashV3FromParts(
  redeemersCbor: Uint8Array,
  datumsCbor: Uint8Array | null,
  costModelV3: bigint[],
): Uint8Array {
  return hashScriptDataParts(redeemersCbor, datumsCbor, encodeLanguageViewsV3(costModelV3));
}

/** Constructive (PlutusV2): build the redeemer map from entries, omit datums (inline-datum spend). */
export function computeScriptDataHash(
  redeemers: RedeemerEntry[],
  costModelV2: bigint[],
  datumsCbor: Uint8Array | null = null,
): Uint8Array {
  return computeScriptDataHashFromParts(encodeRedeemerMap(redeemers), datumsCbor, costModelV2);
}

/** Constructive (PlutusV3): build the redeemer map from entries, omit datums (inline-datum spend). */
export function computeScriptDataHashV3(
  redeemers: RedeemerEntry[],
  costModelV3: bigint[],
  datumsCbor: Uint8Array | null = null,
): Uint8Array {
  return computeScriptDataHashV3FromParts(encodeRedeemerMap(redeemers), datumsCbor, costModelV3);
}

export { bytesToHex };
