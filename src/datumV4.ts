// V4 datum/redeemer codecs. Field order and constructor indices match the
// on-chain Aiken types exactly:
//   SaturnSwapContract/v4/lib/saturn_swap_v4/types.ak (OrderDatum, OrderRedeemer,
//     Coverage, BeaconRedeemer, PaymentDatum)
//   .../two_way_types.ak (TwoWayOrderDatum, TwoWayRedeemer)
//   .../receipt_validation.ak (FillReceiptDatum, ReceiptRedeemer, ReceiptClaim)
//
// Reuses the Address/OutputReference codecs and PlutusData model from datum.ts.

import {
  PConstr,
  PInt,
  PHex,
  type PlutusData,
  plutusToBytes,
  decodePlutusData,
} from "./plutus.js";
import { bytesToHex, hexToBytes } from "./cbor.js";
import {
  type OwnerAddress,
  type OutputRef,
  addressToPlutusData,
  plutusDataToAddress,
} from "./datum.js";
import { sha256 } from "@noble/hashes/sha256";

// ---- OutputReference (Plutus V3 / stdlib v3 shape) ----
// IMPORTANT: Plutus V3 removed the TxId newtype wrapper. stdlib v3's
// OutputReference encodes as Constr0[ ByteArray(tx_id), Int(index) ] — NOT
// the V2 Constr0[ Constr0[ByteArray], Int ] that datum.ts's
// outputRefToPlutusData produces for the V3 contracts. V4 datums and the
// receipt token name MUST use this shape. (Verified against the on-chain
// Aiken receipt-name vector in receipt_test.ak.)

function outputRefToPlutusData(ref: OutputRef): PlutusData {
  return PConstr(0, [PHex(ref.txHash), PInt(ref.outputIndex)]);
}

// ---- helpers ----

function asBytes(x: PlutusData): string {
  if (x.kind !== "bytes") throw new Error("expected bytes");
  return bytesToHex(x.value);
}
function asInt(x: PlutusData): bigint {
  if (x.kind !== "int") throw new Error("expected int");
  return x.value;
}
function optInt(x: PlutusData): bigint | null {
  if (x.kind === "constr" && x.alt === 0) return asInt(x.fields[0]!);
  return null;
}
function outputRefFromData(d: PlutusData): OutputRef {
  // Plutus V3 shape: Constr0[ ByteArray(tx_id), Int(index) ] — tx_id is a
  // bare bytestring, no TxId wrapper.
  if (d.kind !== "constr" || d.fields.length !== 2) throw new Error("malformed OutputReference");
  const txId = d.fields[0]!;
  if (txId.kind !== "bytes") throw new Error("malformed transaction_id (expected bare bytes in Plutus V3)");
  return { txHash: bytesToHex(txId.value), outputIndex: Number(asInt(d.fields[1]!)) };
}
function pOptInt(v: bigint | null): PlutusData {
  return v === null ? PConstr(1, []) : PConstr(0, [PInt(v)]);
}

// ---- Coverage (Aegis) : Constr0[ vault: Address, premium_bps: Int, policy_ref: OutputReference ]

export interface CoverageV4 {
  vault: OwnerAddress;
  premiumBps: bigint;
  policyRef: OutputRef;
}

export function coverageToPlutusData(c: CoverageV4): PlutusData {
  return PConstr(0, [addressToPlutusData(c.vault), PInt(c.premiumBps), outputRefToPlutusData(c.policyRef)]);
}

function coverageFromData(d: PlutusData): CoverageV4 {
  if (d.kind !== "constr" || d.fields.length !== 3) throw new Error("malformed Coverage");
  return {
    vault: plutusDataToAddress(d.fields[0]!),
    premiumBps: asInt(d.fields[1]!),
    policyRef: outputRefFromData(d.fields[2]!),
  };
}

// ---- OrderDatum (one-way limit order) : Constr0, 13 fields ----

export interface OrderDatumV4 {
  version: bigint; // 4
  beaconPolicy: string;
  owner: OwnerAddress;
  ownerRaw: PlutusData;
  policyIdSell: string;
  assetNameSell: string;
  amountSell: bigint;
  policyIdBuy: string;
  assetNameBuy: string;
  amountBuy: bigint;
  validBeforeTime: bigint | null;
  minPartialFill: bigint;
  coverage: CoverageV4 | null;
  outputReference: OutputRef;
}

export function orderDatumToPlutusData(d: {
  version?: bigint;
  beaconPolicy: string;
  owner: OwnerAddress;
  policyIdSell: string;
  assetNameSell: string;
  amountSell: bigint;
  policyIdBuy: string;
  assetNameBuy: string;
  amountBuy: bigint;
  validBeforeTime: bigint | null;
  minPartialFill: bigint;
  coverage: CoverageV4 | null;
  outputReference: OutputRef;
}): PlutusData {
  return PConstr(0, [
    PInt(d.version ?? 4n),
    PHex(d.beaconPolicy),
    addressToPlutusData(d.owner),
    PHex(d.policyIdSell),
    PHex(d.assetNameSell),
    PInt(d.amountSell),
    PHex(d.policyIdBuy),
    PHex(d.assetNameBuy),
    PInt(d.amountBuy),
    pOptInt(d.validBeforeTime),
    PInt(d.minPartialFill),
    d.coverage === null ? PConstr(1, []) : PConstr(0, [coverageToPlutusData(d.coverage)]),
    outputRefToPlutusData(d.outputReference),
  ]);
}

export function decodeOrderDatumV4(bytes: Uint8Array): OrderDatumV4 {
  const d = decodePlutusData(bytes);
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 13)
    throw new Error("not an OrderDatumV4 (expected Constr0 with 13 fields)");
  const [ver, beacon, owner, polS, nameS, amtS, polB, nameB, amtB, vbt, minPf, cov, outRef] = d.fields;
  let coverage: CoverageV4 | null = null;
  if (cov!.kind === "constr" && cov!.alt === 0) coverage = coverageFromData(cov!.fields[0]!);
  return {
    version: asInt(ver!),
    beaconPolicy: asBytes(beacon!),
    owner: plutusDataToAddress(owner!),
    ownerRaw: owner!,
    policyIdSell: asBytes(polS!),
    assetNameSell: asBytes(nameS!),
    amountSell: asInt(amtS!),
    policyIdBuy: asBytes(polB!),
    assetNameBuy: asBytes(nameB!),
    amountBuy: asInt(amtB!),
    validBeforeTime: optInt(vbt!),
    minPartialFill: asInt(minPf!),
    coverage,
    outputReference: outputRefFromData(outRef!),
  };
}

export function decodeOrderDatumV4Hex(hex: string): OrderDatumV4 {
  return decodeOrderDatumV4(hexToBytes(hex));
}

// ---- OrderRedeemer ----
// Fill  { buy_amount, input_index, output_index } = Constr0[int,int,int]
// Cancel{ input_index }                           = Constr1[int]
// Reprice{ input_index, output_index }            = Constr2[int,int]

export function fillRedeemer(buyAmount: bigint, inputIndex: number, outputIndex: number): PlutusData {
  return PConstr(0, [PInt(buyAmount), PInt(inputIndex), PInt(outputIndex)]);
}
export function cancelRedeemer(inputIndex: number): PlutusData {
  return PConstr(1, [PInt(inputIndex)]);
}
export function repriceRedeemer(inputIndex: number, outputIndex: number): PlutusData {
  return PConstr(2, [PInt(inputIndex), PInt(outputIndex)]);
}

// ---- BeaconRedeemer : CreateOrClose = Constr0[], BurnOnly = Constr1[] ----

export const beaconCreateOrClose: PlutusData = PConstr(0, []);
export const beaconBurnOnly: PlutusData = PConstr(1, []);

// ---- PaymentDatum : Constr0[ OutputReference ] (owner / fee / coverage-vault tag) ----

export function paymentDatumV4(spentOrder: OutputRef): PlutusData {
  return PConstr(0, [outputRefToPlutusData(spentOrder)]);
}

// ---- TwoWayOrderDatum : Constr0, 15 fields ----

export interface TwoWayOrderDatumV4 {
  version: bigint;
  beaconPolicy: string;
  owner: OwnerAddress;
  ownerRaw: PlutusData;
  policyId1: string;
  assetName1: string;
  policyId2: string;
  assetName2: string;
  price1Num: bigint;
  price1Den: bigint;
  price2Num: bigint;
  price2Den: bigint;
  validBeforeTime: bigint | null;
  minTake1: bigint;
  minTake2: bigint;
  outputReference: OutputRef;
}

export function twoWayDatumToPlutusData(d: {
  version?: bigint;
  beaconPolicy: string;
  owner: OwnerAddress;
  policyId1: string;
  assetName1: string;
  policyId2: string;
  assetName2: string;
  price1Num: bigint;
  price1Den: bigint;
  price2Num: bigint;
  price2Den: bigint;
  validBeforeTime: bigint | null;
  minTake1: bigint;
  minTake2: bigint;
  outputReference: OutputRef;
}): PlutusData {
  return PConstr(0, [
    PInt(d.version ?? 4n),
    PHex(d.beaconPolicy),
    addressToPlutusData(d.owner),
    PHex(d.policyId1),
    PHex(d.assetName1),
    PHex(d.policyId2),
    PHex(d.assetName2),
    PInt(d.price1Num),
    PInt(d.price1Den),
    PInt(d.price2Num),
    PInt(d.price2Den),
    pOptInt(d.validBeforeTime),
    PInt(d.minTake1),
    PInt(d.minTake2),
    outputRefToPlutusData(d.outputReference),
  ]);
}

export function decodeTwoWayDatumV4(bytes: Uint8Array): TwoWayOrderDatumV4 {
  const d = decodePlutusData(bytes);
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 15)
    throw new Error("not a TwoWayOrderDatumV4 (expected Constr0 with 15 fields)");
  const [ver, beacon, owner, p1, n1, p2, n2, pr1n, pr1d, pr2n, pr2d, vbt, mt1, mt2, outRef] = d.fields;
  return {
    version: asInt(ver!),
    beaconPolicy: asBytes(beacon!),
    owner: plutusDataToAddress(owner!),
    ownerRaw: owner!,
    policyId1: asBytes(p1!),
    assetName1: asBytes(n1!),
    policyId2: asBytes(p2!),
    assetName2: asBytes(n2!),
    price1Num: asInt(pr1n!),
    price1Den: asInt(pr1d!),
    price2Num: asInt(pr2n!),
    price2Den: asInt(pr2d!),
    validBeforeTime: optInt(vbt!),
    minTake1: asInt(mt1!),
    minTake2: asInt(mt2!),
    outputReference: outputRefFromData(outRef!),
  };
}

// ---- TwoWayRedeemer ----
// Swap { take_asset1: Bool, take_amount, input_index, output_index } = Constr0[Bool,int,int,int]
//   Bool: False = Constr0[], True = Constr1[]
// Close { input_index }               = Constr1[int]
// Update { input_index, output_index }= Constr2[int,int]

function pBool(b: boolean): PlutusData {
  return PConstr(b ? 1 : 0, []);
}
export function twoWaySwapRedeemer(
  takeAsset1: boolean,
  takeAmount: bigint,
  inputIndex: number,
  outputIndex: number,
): PlutusData {
  return PConstr(0, [pBool(takeAsset1), PInt(takeAmount), PInt(inputIndex), PInt(outputIndex)]);
}
export function twoWayCloseRedeemer(inputIndex: number): PlutusData {
  return PConstr(1, [PInt(inputIndex)]);
}
export function twoWayUpdateRedeemer(inputIndex: number, outputIndex: number): PlutusData {
  return PConstr(2, [PInt(inputIndex), PInt(outputIndex)]);
}

// ---- Fill receipts ----
// FillReceiptDatum = Constr0[ order_reference, maker: Address, sell_policy, sell_name,
//                             sold, buy_policy, buy_name, bought ]  (8 fields)
// receipt token name = sha2_256( cbor(order OutputReference) )
// ReceiptClaim = Constr0[ order_input_index, receipt_output_index ]
// ReceiptRedeemer: MintFillReceipts(claims) = Constr0[[claims]], BurnReceipts = Constr1[]

export interface FillReceiptDatumV4 {
  orderReference: OutputRef;
  maker: OwnerAddress;
  policyIdSell: string;
  assetNameSell: string;
  sold: bigint;
  policyIdBuy: string;
  assetNameBuy: string;
  bought: bigint;
}

export function fillReceiptDatumToPlutusData(r: FillReceiptDatumV4): PlutusData {
  return PConstr(0, [
    outputRefToPlutusData(r.orderReference),
    addressToPlutusData(r.maker),
    PHex(r.policyIdSell),
    PHex(r.assetNameSell),
    PInt(r.sold),
    PHex(r.policyIdBuy),
    PHex(r.assetNameBuy),
    PInt(r.bought),
  ]);
}

/** receipt token name = sha2_256( cbor(order OutputReference) ). */
export function receiptTokenName(orderRef: OutputRef): string {
  return bytesToHex(sha256(plutusToBytes(outputRefToPlutusData(orderRef))));
}

export function receiptClaim(orderInputIndex: number, receiptOutputIndex: number): PlutusData {
  return PConstr(0, [PInt(orderInputIndex), PInt(receiptOutputIndex)]);
}
export function mintFillReceiptsRedeemer(claims: { orderInputIndex: number; receiptOutputIndex: number }[]): PlutusData {
  return PConstr(0, [{ kind: "list", items: claims.map((c) => receiptClaim(c.orderInputIndex, c.receiptOutputIndex)) }]);
}
export const burnReceiptsRedeemer: PlutusData = PConstr(1, []);
