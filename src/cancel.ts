// CancelAction tx builder (OWNER-ONLY). Produces an UNSIGNED cancel that the ORDER OWNER
// signs — not an aggregator action, but built here for completeness (SPEC §9 +
// the saturn_swap validator's `cancel` path).
//
//   cancel(tx, datum, own_input):
//     tx_signed_by_owner  — key-hash owner: owner pkh ∈ tx.extra_signatories
//                           script owner:   tx has an input from the owner's script credential
//     is_cancel_valid     — script owner ONLY: spent value returns to owner with PaymentDatum{spent ref}
//
// This builder handles the KEY-HASH owner path (the common case). A SCRIPT-owner cancel
// additionally requires an input from the owner's own script, which only the owner's
// infrastructure can supply — so this builder refuses it (clear error).

import type { LucidEvolution, UTxO, Assets } from "@lucid-evolution/lucid";
import { credentialToAddress } from "@lucid-evolution/lucid";
import type { Order } from "./discovery.js";
import { cancelActionRedeemer } from "./datum.js";
import { plutusToHex } from "./plutus.js";
import { assertCollateralDisjoint, inputIndexOf, sortInputs } from "./sort.js";
import { CborReader, hexToBytes, bytesToHex } from "./cbor.js";

export interface BuildCancelOptions {
  lucid: LucidEvolution;
  order: Order;
  /** funding inputs for the tx fee (the owner's own UTxOs in a real cancel) */
  fundingUtxos: UTxO[];
  /** pure-ADA collateral UTxO (script spend needs collateral) */
  collateralUtxo: UTxO;
  /** where the change goes; defaults to the collateral's address */
  changeAddress?: string;
}

export interface CancelResult {
  unsignedCbor: string;
  txHash: string;
  inputIndex: number;
  /** owner key hash that MUST sign (added to required_signers) */
  ownerKeyHash: string;
  ownerAddressBech32: string;
}

function ownerBech32(order: Order): string {
  const o = order.datum.owner;
  const payment = { type: o.payment.type === "key" ? ("Key" as const) : ("Script" as const), hash: o.payment.hash };
  if (!o.stake) return credentialToAddress("Mainnet", payment);
  const stake = { type: o.stake.type === "key" ? ("Key" as const) : ("Script" as const), hash: o.stake.hash };
  return credentialToAddress("Mainnet", payment, stake);
}

function chainValueToAssets(v: Order["scriptValue"]): Assets {
  const out: Assets = { lovelace: v.lovelace };
  for (const [u, amt] of Object.entries(v.assets)) out[u] = amt;
  return out;
}

export async function buildCancel(opts: BuildCancelOptions): Promise<CancelResult> {
  const { lucid, order } = opts;
  if (order.datum.owner.payment.type !== "key")
    throw new Error(
      "SCRIPT_OWNER_CANCEL_UNSUPPORTED: a script-owner cancel needs an input from the owner's own script " +
        "(only the owner's infrastructure can supply it); this builder handles key-hash owners only.",
    );
  const ownerKeyHash = order.datum.owner.payment.hash;

  const [orderUtxo] = await lucid.utxosByOutRef([
    { txHash: order.utxo.txHash, outputIndex: order.utxo.outputIndex },
  ]);
  if (!orderUtxo) throw new Error(`order UTxO ${order.utxo.txHash}#${order.utxo.outputIndex} not found on-chain`);
  const [refUtxo] = await lucid.utxosByOutRef([
    { txHash: order.refScript.txHash, outputIndex: order.refScript.outputIndex },
  ]);
  if (!refUtxo?.scriptRef) throw new Error("reference-script UTxO missing scriptRef");

  const spendInputs = [order.utxo, ...opts.fundingUtxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex }))];
  const inputIndex = inputIndexOf(spendInputs, order.utxo);
  if (inputIndex < 0) throw new Error("order input not found in spend-input set");

  const redeemerHex = plutusToHex(cancelActionRedeemer(inputIndex));
  const ownerAddressBech32 = ownerBech32(order);
  const changeAddress = opts.changeAddress ?? opts.collateralUtxo.address;

  assertCollateralDisjoint(opts.collateralUtxo, opts.fundingUtxos);
  // Only the dedicated collateral goes in the wallet pool; funding is supplied explicitly via
  // collectFrom below. Lucid's collateral picker is largest-first and does NOT exclude
  // already-collected inputs, so leaving funding in the pool lets a funding UTxO with more ADA
  // than the collateral get pledged as collateral AND spent as an input (overlap -> DENY).
  lucid.selectWallet.fromAddress(changeAddress, [opts.collateralUtxo]);

  const tx = lucid
    .newTx()
    .collectFrom([orderUtxo], redeemerHex)
    .collectFrom(opts.fundingUtxos)
    .readFrom([refUtxo])
    // the owner reclaims the order's value (key-hash owner: no datum/routing constraint)
    .pay.ToAddress(ownerAddressBech32, chainValueToAssets(order.scriptValue))
    .addSignerKey(ownerKeyHash); // owner pkh -> required_signers -> tx.extra_signatories

  const signBuilder = await tx.complete({ changeAddress, setCollateral: 5_000_000n });
  const unsignedCbor = signBuilder.toCBOR();

  // safety net: redeemer input_index must match the final sorted spend inputs
  const finalIndex = sortInputs(spendInputs).findIndex(
    (i) => i.txHash === order.utxo.txHash && i.outputIndex === order.utxo.outputIndex,
  );
  if (finalIndex !== inputIndex) throw new Error(`cancel input_index drift: ${inputIndex} vs ${finalIndex}`);

  // sanity: the owner pkh is present in required_signers (body key 14)
  if (!requiredSignersInclude(unsignedCbor, ownerKeyHash))
    throw new Error("owner key hash not present in required_signers");

  return { unsignedCbor, txHash: signBuilder.toHash(), inputIndex, ownerKeyHash, ownerAddressBech32 };
}

/** check that body key 14 (required_signers) contains `keyHashHex`. */
function requiredSignersInclude(unsignedCbor: string, keyHashHex: string): boolean {
  const top = new CborReader(hexToBytes(unsignedCbor)).decode();
  if (top.t !== "array") return false;
  let body = top.v[0]!;
  if (body.t === "tag") body = body.v;
  if (body.t !== "map") return false;
  const e = body.v.find(([k]) => k.t === "uint" && k.v === 14n);
  if (!e) return false;
  let arr = e[1];
  if (arr.t === "tag") arr = arr.v; // set(258) wrapper
  if (arr.t !== "array") return false;
  return arr.v.some((x) => x.t === "bytes" && bytesToHex(x.v) === keyHashHex);
}
