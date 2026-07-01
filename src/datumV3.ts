// V3 SwapDatum / Coverage / PaymentDatum / FillReceipt codec.
//
// V3 differs from V2 in three load-bearing ways (the rest of the wire form is shared):
//   1. OutputReference is FLAT — Constr0[ bstr32(tx_id), uint(ix) ] — because the V3
//      contract's stdlib (aiken-lang/stdlib v2.2.0) defines `TransactionId` as a bytes
//      alias (Hash<Blake2b_256>), not a record. V2 (stdlib 1.8.0) wraps it:
//      Constr0[ Constr0[ bstr32 ], uint ]. This flat form is used EVERYWHERE an
//      OutputReference appears: SwapDatum.output_reference (idx 8), Coverage.policy_ref,
//      and the PaymentDatum double-satisfaction tag on owner/fee/premium/relist outputs.
//   2. SwapDatum has 11 positional fields: the 9 V2 fields plus min_partial_fill (idx 9)
//      and coverage: Option<Coverage> (idx 10).
//   3. The order rests at a PlutusV3 script — the script_data_hash uses language-views
//      key 2 (see scriptDataHash.ts).
//
// The Address encoding + SwapAction/CancelAction redeemers are IDENTICAL to V2, so they
// are reused from datum.ts.

import {
  decodePlutusData,
  PConstr,
  PHex,
  PInt,
  plutusToBytes,
  type PlutusData,
} from "./plutus.js";
import { bytesToHex, hexToBytes } from "./cbor.js";
import {
  addressToPlutusData,
  plutusDataToAddress,
  type OutputRef,
  type OwnerAddress,
  type SwapDatum,
} from "./datum.js";

// ---- Coverage (Aegis) ----

export interface Coverage {
  /** Aegis vault the per-fill premium is paid to (a normal output, NOT a treasury donation). */
  vault: OwnerAddress;
  /** premium charged per fill = filled_buy_amount * premium_bps / 10000, in the BUY asset */
  premiumBps: bigint;
  /** pin to the Aegis policy / coverage UTxO — the on-chain "Aegis-covered" truth */
  policyRef: OutputRef;
}

export interface SwapDatumV3 extends SwapDatum {
  /** minimum size (in buy-asset units) of any PARTIAL fill; 0 = no floor (V2 parity) */
  minPartialFill: bigint;
  /** Some(Coverage) marks the order Aegis-covered and forces a premium vault output; null = uncovered */
  coverage: Coverage | null;
}

// ---- FLAT OutputReference (V3) ----

/** V3 OutputReference = Constr0[ bstr32(tx_id), uint(output_index) ] (flat, no TransactionId wrapper). */
export function outputRefV3ToPlutusData(ref: OutputRef): PlutusData {
  return PConstr(0, [PHex(ref.txHash), PInt(ref.outputIndex)]);
}

export function plutusDataToOutputRefV3(d: PlutusData): OutputRef {
  if (d.kind !== "constr" || d.fields.length !== 2) throw new Error("malformed OutputReference (v3)");
  const idHex = d.fields[0]!;
  const idx = d.fields[1]!;
  if (idHex.kind !== "bytes") throw new Error("malformed OutputReference tx_id (v3)");
  if (idx.kind !== "int") throw new Error("malformed OutputReference output_index (v3)");
  return { txHash: bytesToHex(idHex.value), outputIndex: Number(idx.value) };
}

// ---- Coverage codec ----

export function coverageToPlutusData(cov: {
  vault: OwnerAddress;
  premiumBps: bigint;
  policyRef: OutputRef;
}): PlutusData {
  // Coverage = Constr0[ vault: Address, premium_bps: Int, policy_ref: OutputReference ]
  return PConstr(0, [
    addressToPlutusData(cov.vault),
    PInt(cov.premiumBps),
    outputRefV3ToPlutusData(cov.policyRef),
  ]);
}

function plutusDataToCoverage(d: PlutusData): Coverage {
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 3)
    throw new Error("malformed Coverage (expected Constr0 with 3 fields)");
  const [vault, bps, policyRef] = d.fields;
  if (bps!.kind !== "int") throw new Error("malformed Coverage premium_bps");
  return {
    vault: plutusDataToAddress(vault!),
    premiumBps: bps!.value,
    policyRef: plutusDataToOutputRefV3(policyRef!),
  };
}

// ---- SwapDatum (V3, 11 fields) ----

export function swapDatumV3ToPlutusData(datum: {
  owner: OwnerAddress;
  policyIdSell: string;
  assetNameSell: string;
  amountSell: bigint;
  policyIdBuy: string;
  assetNameBuy: string;
  amountBuy: bigint;
  validBeforeTime: bigint | null;
  outputReference: OutputRef;
  minPartialFill: bigint;
  coverage: { vault: OwnerAddress; premiumBps: bigint; policyRef: OutputRef } | null;
}): PlutusData {
  const vbt =
    datum.validBeforeTime === null ? PConstr(1, []) : PConstr(0, [PInt(datum.validBeforeTime)]);
  const cov = datum.coverage === null ? PConstr(1, []) : PConstr(0, [coverageToPlutusData(datum.coverage)]);
  return PConstr(0, [
    addressToPlutusData(datum.owner),
    PHex(datum.policyIdSell),
    PHex(datum.assetNameSell),
    PInt(datum.amountSell),
    PHex(datum.policyIdBuy),
    PHex(datum.assetNameBuy),
    PInt(datum.amountBuy),
    vbt,
    outputRefV3ToPlutusData(datum.outputReference),
    PInt(datum.minPartialFill),
    cov,
  ]);
}

export function decodeSwapDatumV3(bytes: Uint8Array): SwapDatumV3 {
  const d = decodePlutusData(bytes);
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 11)
    throw new Error("not a V3 SwapDatum (expected Constr0 with 11 fields)");
  const [owner, polS, nameS, amtS, polB, nameB, amtB, vbt, outRef, minPartial, covOpt] = d.fields;
  const asBytes = (x: PlutusData): string => {
    if (x.kind !== "bytes") throw new Error("expected bytes");
    return bytesToHex(x.value);
  };
  const asInt = (x: PlutusData): bigint => {
    if (x.kind !== "int") throw new Error("expected int");
    return x.value;
  };
  let validBeforeTime: bigint | null = null;
  if (vbt!.kind === "constr" && vbt!.alt === 0) validBeforeTime = asInt(vbt!.fields[0]!);

  let coverage: Coverage | null = null;
  if (covOpt!.kind === "constr" && covOpt!.alt === 0) coverage = plutusDataToCoverage(covOpt!.fields[0]!);
  else if (!(covOpt!.kind === "constr" && covOpt!.alt === 1))
    throw new Error("malformed coverage option");

  return {
    owner: plutusDataToAddress(owner!),
    ownerRaw: owner!,
    policyIdSell: asBytes(polS!),
    assetNameSell: asBytes(nameS!),
    amountSell: asInt(amtS!),
    policyIdBuy: asBytes(polB!),
    assetNameBuy: asBytes(nameB!),
    amountBuy: asInt(amtB!),
    validBeforeTime,
    outputReference: plutusDataToOutputRefV3(outRef!),
    minPartialFill: asInt(minPartial!),
    coverage,
  };
}

export function decodeSwapDatumV3Hex(hex: string): SwapDatumV3 {
  return decodeSwapDatumV3(hexToBytes(hex));
}

// ---- PaymentDatum (V3, flat OutputReference) ----
// PaymentDatum = Constr0[ OutputReference ]. For a taker fill the OutputReference is the
// SPENT ORDER's OWN input ref (NOT SwapDatum.output_reference), same rule as V2 — only the
// inner OutputReference encoding is flat.

export function paymentDatumV3(spentOrder: OutputRef): PlutusData {
  return PConstr(0, [outputRefV3ToPlutusData(spentOrder)]);
}

export function paymentDatumV3Bytes(spentOrder: OutputRef): Uint8Array {
  return plutusToBytes(paymentDatumV3(spentOrder));
}

// ---- Fill receipt (CIP-69 mint on the swap script; policy id == script hash) ----
// A filler MAY mint a self-validating fill-receipt alongside a fill. The swap `spend` handler
// does NOT require it, so minting is optional; the codec is provided so aggregators can emit
// and indexers can read the oracle-free executed-price receipt.
//
// The receipt token name is FILLER-CHOSEN: the mint handler requires exactly ONE token of
// quantity 1 under the policy but does NOT constrain the name (it binds the DATUM, not the
// name). We use the UTF-8 bytes of "SaturnFillReceipt".
export const FILL_RECEIPT_ASSET_NAME = bytesToHex(new TextEncoder().encode("SaturnFillReceipt"));

export interface FillReceiptDatum {
  maker: OwnerAddress;
  orderReference: OutputRef;
  soldAmount: bigint;
  boughtAmount: bigint;
  policyIdSell: string;
  assetNameSell: string;
  policyIdBuy: string;
  assetNameBuy: string;
  /** the tx's finite lower validity bound — POSIXTime in MILLISECONDS (not a slot) */
  executedAt: bigint;
}

export function fillReceiptDatumToPlutusData(r: FillReceiptDatum): PlutusData {
  return PConstr(0, [
    addressToPlutusData(r.maker),
    outputRefV3ToPlutusData(r.orderReference),
    PInt(r.soldAmount),
    PInt(r.boughtAmount),
    PHex(r.policyIdSell),
    PHex(r.assetNameSell),
    PHex(r.policyIdBuy),
    PHex(r.assetNameBuy),
    PInt(r.executedAt),
  ]);
}

export function decodeFillReceiptDatum(bytes: Uint8Array): FillReceiptDatum {
  const d = decodePlutusData(bytes);
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 9)
    throw new Error("not a FillReceiptDatum (expected Constr0 with 9 fields)");
  const [maker, ref, sold, bought, polS, nameS, polB, nameB, at] = d.fields;
  const asBytes = (x: PlutusData): string => {
    if (x.kind !== "bytes") throw new Error("expected bytes");
    return bytesToHex(x.value);
  };
  const asInt = (x: PlutusData): bigint => {
    if (x.kind !== "int") throw new Error("expected int");
    return x.value;
  };
  return {
    maker: plutusDataToAddress(maker!),
    orderReference: plutusDataToOutputRefV3(ref!),
    soldAmount: asInt(sold!),
    boughtAmount: asInt(bought!),
    policyIdSell: asBytes(polS!),
    assetNameSell: asBytes(nameS!),
    policyIdBuy: asBytes(polB!),
    assetNameBuy: asBytes(nameB!),
    executedAt: asInt(at!),
  };
}

// MintFillReceipt(order_input_index, owner_output_index, receipt_output_index) = Constr0[int,int,int]
// BurnFillReceipt = Constr1[]
export function mintFillReceiptRedeemer(
  orderInputIndex: number,
  ownerOutputIndex: number,
  receiptOutputIndex: number,
): PlutusData {
  return PConstr(0, [PInt(orderInputIndex), PInt(ownerOutputIndex), PInt(receiptOutputIndex)]);
}

export function burnFillReceiptRedeemer(): PlutusData {
  return PConstr(1, []);
}
