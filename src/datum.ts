// SwapDatum / PaymentDatum / SwapRedeemer encoders + decoders.
// Verified against real on-chain order datums + redeemers and the SPEC golden hex.

import {
  decodePlutusData,
  PBytes,
  PConstr,
  PHex,
  PInt,
  plutusToBytes,
  type PlutusData,
} from "./plutus.js";
import { bytesToHex, hexToBytes } from "./cbor.js";

export type CredType = "key" | "script";

export interface Credential {
  type: CredType;
  hash: string; // 28-byte hex
}

export interface OwnerAddress {
  payment: Credential;
  stake?: Credential; // Inline(cred); pointer/none -> undefined
}

export interface OutputRef {
  txHash: string;
  outputIndex: number;
}

export interface SwapDatum {
  owner: OwnerAddress;
  /** raw owner Address PlutusData — copy verbatim into outputs / relist */
  ownerRaw: PlutusData;
  policyIdSell: string; // "" = ADA
  assetNameSell: string; // "" = ADA
  amountSell: bigint;
  policyIdBuy: string;
  assetNameBuy: string;
  amountBuy: bigint;
  validBeforeTime: bigint | null; // POSIX ms or null
  outputReference: OutputRef; // relist-chain link (sentinel for fresh orders)
}

// ---- Address (Aiken credential.Address) ----

export function addressToPlutusData(addr: OwnerAddress): PlutusData {
  // Aiken `Address` is ALWAYS Constr0[ payment_credential, stake_credential: Option ].
  // Enterprise (stakeless) owners encode the second field as None (Constr1[]) — NOT a
  // 1-field constructor, which fails to decode as `Address` and corrupts the relist datum.
  const paymentCred = PConstr(addr.payment.type === "key" ? 0 : 1, [PHex(addr.payment.hash)]);
  const optStake = addr.stake
    ? // Some(Inline(cred)) = Constr0[ Constr0[ Constr0/1[bstr] ] ]
      PConstr(0, [PConstr(0, [PConstr(addr.stake.type === "key" ? 0 : 1, [PHex(addr.stake.hash)])])])
    : PConstr(1, []); // None
  return PConstr(0, [paymentCred, optStake]);
}

function credFromConstr(d: PlutusData): Credential {
  if (d.kind !== "constr" || d.fields.length !== 1 || d.fields[0]!.kind !== "bytes")
    throw new Error("malformed credential");
  return { type: d.alt === 0 ? "key" : "script", hash: bytesToHex(d.fields[0]!.value) };
}

export function plutusDataToAddress(d: PlutusData): OwnerAddress {
  if (d.kind !== "constr" || d.fields.length < 1) throw new Error("malformed Address");
  const payment = credFromConstr(d.fields[0]!);
  if (d.fields.length === 1) return { payment };
  const opt = d.fields[1]!;
  if (opt.kind !== "constr") throw new Error("malformed stake option");
  if (opt.alt === 1) return { payment }; // None
  // Some( referenced ): Constr0[ Constr0[ cred ] ] (Inline) — pointer is not produced by SaturnSwap
  const referenced = opt.fields[0]!;
  if (referenced.kind !== "constr") throw new Error("malformed referenced stake");
  const inlineCred = referenced.fields[0]!;
  return { payment, stake: credFromConstr(inlineCred) };
}

// ---- OutputReference ----

export function outputRefToPlutusData(ref: OutputRef): PlutusData {
  // OutputReference = Constr0[ TransactionId, output_index ]; TransactionId = Constr0[bstr]
  return PConstr(0, [PConstr(0, [PHex(ref.txHash)]), PInt(ref.outputIndex)]);
}

export function plutusDataToOutputRef(d: PlutusData): OutputRef {
  if (d.kind !== "constr" || d.fields.length !== 2) throw new Error("malformed OutputReference");
  const txId = d.fields[0]!;
  if (txId.kind !== "constr" || txId.fields[0]!.kind !== "bytes") throw new Error("malformed TransactionId");
  const idx = d.fields[1]!;
  if (idx.kind !== "int") throw new Error("malformed output index");
  return { txHash: bytesToHex(txId.fields[0]!.value), outputIndex: Number(idx.value) };
}

// ---- SwapDatum ----

export function swapDatumToPlutusData(datum: {
  owner: OwnerAddress;
  policyIdSell: string;
  assetNameSell: string;
  amountSell: bigint;
  policyIdBuy: string;
  assetNameBuy: string;
  amountBuy: bigint;
  validBeforeTime: bigint | null;
  outputReference: OutputRef;
}): PlutusData {
  const vbt =
    datum.validBeforeTime === null ? PConstr(1, []) : PConstr(0, [PInt(datum.validBeforeTime)]);
  return PConstr(0, [
    addressToPlutusData(datum.owner),
    PHex(datum.policyIdSell),
    PHex(datum.assetNameSell),
    PInt(datum.amountSell),
    PHex(datum.policyIdBuy),
    PHex(datum.assetNameBuy),
    PInt(datum.amountBuy),
    vbt,
    outputRefToPlutusData(datum.outputReference),
  ]);
}

export function decodeSwapDatum(bytes: Uint8Array): SwapDatum {
  const d = decodePlutusData(bytes);
  if (d.kind !== "constr" || d.alt !== 0 || d.fields.length !== 9)
    throw new Error("not a SwapDatum (expected Constr0 with 9 fields)");
  const [owner, polS, nameS, amtS, polB, nameB, amtB, vbt, outRef] = d.fields;
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
    outputReference: plutusDataToOutputRef(outRef!),
  };
}

export function decodeSwapDatumHex(hex: string): SwapDatum {
  return decodeSwapDatum(hexToBytes(hex));
}

// ---- PaymentDatum (double-satisfaction tag on owner + fee outputs) ----
// PaymentDatum = Constr0[ OutputReference ]. For a taker fill, the OutputReference
// is the SPENT ORDER's OWN input ref (NOT SwapDatum.output_reference). (SPEC §7.)

export function paymentDatum(spentOrder: OutputRef): PlutusData {
  return PConstr(0, [outputRefToPlutusData(spentOrder)]);
}

export function paymentDatumBytes(spentOrder: OutputRef): Uint8Array {
  return plutusToBytes(paymentDatum(spentOrder));
}

// ---- SwapRedeemer ----
// SwapAction(user_sell_amount, input_index, output_index) = Constr0[int,int,int]
// CancelAction(input_index) = Constr1[int]

export function swapActionRedeemer(
  userSellAmount: bigint,
  inputIndex: number,
  outputIndex: number,
): PlutusData {
  return PConstr(0, [PInt(userSellAmount), PInt(inputIndex), PInt(outputIndex)]);
}

export function cancelActionRedeemer(inputIndex: number): PlutusData {
  return PConstr(1, [PInt(inputIndex)]);
}

export { PBytes };
