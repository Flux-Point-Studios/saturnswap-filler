// Canonical cardano-swaps SwapDatum / redeemer codecs (protocol v2, PlutusV2).
// Field order + constructor indices match the on-chain Aiken types exactly:
//   one_way_swap/types.ak  SwapDatum (11 fields), SwapRedeemer, BeaconRedeemer
//   two_way_swap/types.ak  SwapDatum (12 fields), SwapRedeemer
//
// NOTE: canonical is compiled with aiken-lang/stdlib 1.7.0 (PlutusV2), whose
// OutputReference keeps the TransactionId newtype wrapper:
//   OutputReference = Constr0[ Constr0[bstr(tx_id)] , Int ]
// This is the WRAPPED shape (datum.ts outputRefToPlutusData), NOT the bare-bytes
// stdlib-v3 shape the retired V4 fork used. prev_input MUST use the wrapped shape.

import { PConstr, PInt, PHex, plutusToHex, decodePlutusData, decodePlutusHex, type PlutusData } from "./plutus.js";
import { bytesToHex, hexToBytes } from "./cbor.js";
import { outputRefToPlutusData, plutusDataToOutputRef, type OutputRef } from "./datum.js";
import type { Rational } from "./cardanoSwapsRatio.js";

// ---- one-way SwapDatum ----

export interface OneWaySwapDatum {
  beaconId: string;
  pairBeacon: string;
  offerId: string;
  offerName: string;
  offerBeacon: string;
  askId: string;
  askName: string;
  askBeacon: string;
  price: Rational; // Ask/Offer
  prevInput: OutputRef | null; // Some(input_ref) on a taker continuation; None otherwise
  expiration: bigint | null; // POSIX ms; None = never expires
}

// ---- two-way SwapDatum ----

export interface TwoWaySwapDatum {
  beaconId: string;
  pairBeacon: string;
  asset1Id: string;
  asset1Name: string;
  asset1Beacon: string;
  asset2Id: string;
  asset2Name: string;
  asset2Beacon: string;
  asset1Price: Rational; // Asset2/Asset1
  asset2Price: Rational; // Asset1/Asset2
  prevInput: OutputRef | null;
  expiration: bigint | null;
}

// ---- shared field encoders ----

function rationalToPD(r: Rational): PlutusData {
  return PConstr(0, [PInt(r.num), PInt(r.den)]);
}
function rationalFromPD(d: PlutusData): Rational {
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 2) throw new Error("malformed Rational");
  return { num: asInt(d.fields[0]!), den: asInt(d.fields[1]!) };
}
function optOutRefToPD(ref: OutputRef | null): PlutusData {
  return ref === null ? PConstr(1, []) : PConstr(0, [outputRefToPlutusData(ref)]);
}
function optOutRefFromPD(d: PlutusData): OutputRef | null {
  if (d.kind !== "constr") throw new Error("malformed Option<OutputReference>");
  if (d.alt === 1) return null;
  return plutusDataToOutputRef(d.fields[0]!);
}
function optIntToPD(v: bigint | null): PlutusData {
  return v === null ? PConstr(1, []) : PConstr(0, [PInt(v)]);
}
function optIntFromPD(d: PlutusData): bigint | null {
  if (d.kind !== "constr") throw new Error("malformed Option<Int>");
  return d.alt === 0 ? asInt(d.fields[0]!) : null;
}
function asBytes(x: PlutusData): string {
  if (x.kind !== "bytes") throw new Error("expected bytes");
  return bytesToHex(x.value);
}
function asInt(x: PlutusData): bigint {
  if (x.kind !== "int") throw new Error("expected int");
  return x.value;
}

// ---- one-way codec ----

export function encodeOneWaySwapDatum(d: OneWaySwapDatum): Uint8Array {
  return hexToBytes(encodeOneWaySwapDatumHex(d));
}

export function encodeOneWaySwapDatumHex(d: OneWaySwapDatum): string {
  return plutusToHex(
    PConstr(0, [
      PHex(d.beaconId),
      PHex(d.pairBeacon),
      PHex(d.offerId),
      PHex(d.offerName),
      PHex(d.offerBeacon),
      PHex(d.askId),
      PHex(d.askName),
      PHex(d.askBeacon),
      rationalToPD(d.price),
      optOutRefToPD(d.prevInput),
      optIntToPD(d.expiration),
    ]),
  );
}

export function decodeOneWaySwapDatum(bytes: Uint8Array): OneWaySwapDatum {
  return fromOneWayPD(decodePlutusData(bytes));
}

export function decodeOneWaySwapDatumHex(hex: string): OneWaySwapDatum {
  return fromOneWayPD(decodePlutusHex(hex));
}

function fromOneWayPD(d: PlutusData): OneWaySwapDatum {
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 11)
    throw new Error("not a one-way SwapDatum (expected Constr0 with 11 fields)");
  const f = d.fields;
  return {
    beaconId: asBytes(f[0]!),
    pairBeacon: asBytes(f[1]!),
    offerId: asBytes(f[2]!),
    offerName: asBytes(f[3]!),
    offerBeacon: asBytes(f[4]!),
    askId: asBytes(f[5]!),
    askName: asBytes(f[6]!),
    askBeacon: asBytes(f[7]!),
    price: rationalFromPD(f[8]!),
    prevInput: optOutRefFromPD(f[9]!),
    expiration: optIntFromPD(f[10]!),
  };
}

// ---- two-way codec ----

export function encodeTwoWaySwapDatum(d: TwoWaySwapDatum): Uint8Array {
  return hexToBytes(encodeTwoWaySwapDatumHex(d));
}

export function encodeTwoWaySwapDatumHex(d: TwoWaySwapDatum): string {
  return plutusToHex(
    PConstr(0, [
      PHex(d.beaconId),
      PHex(d.pairBeacon),
      PHex(d.asset1Id),
      PHex(d.asset1Name),
      PHex(d.asset1Beacon),
      PHex(d.asset2Id),
      PHex(d.asset2Name),
      PHex(d.asset2Beacon),
      rationalToPD(d.asset1Price),
      rationalToPD(d.asset2Price),
      optOutRefToPD(d.prevInput),
      optIntToPD(d.expiration),
    ]),
  );
}

export function decodeTwoWaySwapDatum(bytes: Uint8Array): TwoWaySwapDatum {
  return fromTwoWayPD(decodePlutusData(bytes));
}

export function decodeTwoWaySwapDatumHex(hex: string): TwoWaySwapDatum {
  return fromTwoWayPD(decodePlutusHex(hex));
}

function fromTwoWayPD(d: PlutusData): TwoWaySwapDatum {
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 12)
    throw new Error("not a two-way SwapDatum (expected Constr0 with 12 fields)");
  const f = d.fields;
  return {
    beaconId: asBytes(f[0]!),
    pairBeacon: asBytes(f[1]!),
    asset1Id: asBytes(f[2]!),
    asset1Name: asBytes(f[3]!),
    asset1Beacon: asBytes(f[4]!),
    asset2Id: asBytes(f[5]!),
    asset2Name: asBytes(f[6]!),
    asset2Beacon: asBytes(f[7]!),
    asset1Price: rationalFromPD(f[8]!),
    asset2Price: rationalFromPD(f[9]!),
    prevInput: optOutRefFromPD(f[10]!),
    expiration: optIntFromPD(f[11]!),
  };
}

// ---- redeemers (all nullary constructors) ----
// one-way SwapRedeemer = SpendWithMint | SpendWithStake | Swap
// two-way SwapRedeemer = SpendWithMint | SpendWithStake | TakeAsset1 | TakeAsset2
// BeaconRedeemer       = RegisterBeaconScript | CreateOrCloseSwaps | UpdateSwaps

export const SPEND_WITH_MINT_HEX = plutusToHex(PConstr(0, []));
export const SPEND_WITH_STAKE_HEX = plutusToHex(PConstr(1, []));
export const SWAP_REDEEMER_HEX = plutusToHex(PConstr(2, []));
export const TAKE_ASSET1_REDEEMER_HEX = plutusToHex(PConstr(2, []));
export const TAKE_ASSET2_REDEEMER_HEX = plutusToHex(PConstr(3, []));

export const REGISTER_BEACON_SCRIPT_HEX = plutusToHex(PConstr(0, []));
export const CREATE_OR_CLOSE_SWAPS_HEX = plutusToHex(PConstr(1, []));
export const UPDATE_SWAPS_HEX = plutusToHex(PConstr(2, []));
