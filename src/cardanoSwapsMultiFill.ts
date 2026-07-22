// Standalone one-way multi-fill: compose K canonical cardano-swaps taker fills
// into ONE transaction without the ADAM-OC guard router (BEACON_VOLUME_EXPERIMENT.md
// §6.2 — the experiment must be runnable by any operator).
//
// On eUTxO a flat batch, a multi-hop route, and a closed cycle are the same tx
// shape: each spent order validates only its own continuation (datum-scan on
// prev_input) and price, and the ledger checks the global balance — so the offer
// taken from one fill funds the ask of another inside the same tx. The planner
// therefore reports the MERGED signed delta across legs (netTokenDelta /
// netAdaOutflow): funding must cover the net, never the gross legs.

import type { UTxO, LucidEvolution, Assets } from "@lucid-evolution/lucid";
import { unit } from "./discovery.js";
import { minUtxoLovelace } from "./minUtxo.js";
import {
  cardanoSwapsComposable,
  computeOneWayFill,
  quantityOf,
  type ComposableFill,
  type OneWayOrder,
} from "./cardanoSwapsFill.js";
import type { CardanoSwapsDeployment } from "./cardanoSwapsLifecycle.js";
import { CARDANO_SWAPS_COINS_PER_UTXO_BYTE } from "./cardanoSwapsLifecycle.js";

export interface OneWayFillLeg {
  order: OneWayOrder;
  orderUtxo: UTxO;
  offerTaken: bigint;
}

export interface MultiFillPlan {
  fills: ComposableFill[];
  /** merged signed per-unit deltas from the taker's perspective (+ = gained) */
  netTokenDelta: Record<string, bigint>;
  /** net ADA the taker must fund (negative = the taker nets ADA out of the tx) */
  netAdaOutflow: bigint;
  /** sum of every fill's ADA leg (offer or ask side), both directions — the
   *  gross settled notional this tx represents for volume accounting.
   *  Token↔token fills contribute 0; price those off-chain if needed. */
  grossNotionalLovelace: bigint;
}

/** Largest offerTaken an ADA-offering order supports without dropping its
 *  continuation below the min-UTxO floor (the ledger enforces the floor at
 *  phase-1; computeOneWayFill does not — BEACON_VOLUME_EXPERIMENT.md §4). */
export function maxAdaOfferTake(order: OneWayOrder, coinsPerUtxoByte: bigint = CARDANO_SWAPS_COINS_PER_UTXO_BYTE): bigint {
  if (order.datum.offerId !== "") return quantityOf(order.scriptValue, order.datum.offerId, order.datum.offerName);
  // Size the floor against a representative continuation (same assets plus the
  // ask tokens, prev_input populated) so the datum/value bytes are realistic.
  const probe = cardanoSwapsComposable({ order, orderUtxo: probeUtxo(order), offerTaken: 1n });
  const cont = probe.fill.outputs[0]!;
  const floor = minUtxoLovelace(
    { addressBech32: cont.address, assets: cont.value, inlineDatumHex: cont.datum },
    coinsPerUtxoByte,
  );
  const available = order.scriptValue.lovelace - floor;
  return available > 0n ? available : 0n;
}

function probeUtxo(order: OneWayOrder): UTxO {
  return {
    txHash: order.utxo.txHash,
    outputIndex: order.utxo.outputIndex,
    address: order.address,
    assets: {},
  } as UTxO;
}

export function planOneWayMultiFill(legs: OneWayFillLeg[]): MultiFillPlan {
  if (legs.length === 0) throw new Error("at least one fill leg required");
  const seen = new Set<string>();
  for (const leg of legs) {
    const ref = `${leg.order.utxo.txHash}#${leg.order.utxo.outputIndex}`;
    if (seen.has(ref)) throw new Error(`duplicate order in batch: ${ref} (a UTxO can be spent once per tx)`);
    seen.add(ref);
  }

  const fills: ComposableFill[] = [];
  const netTokenDelta: Record<string, bigint> = {};
  let netAdaOutflow = 0n;
  let grossNotionalLovelace = 0n;

  const addDelta = (policyId: string, assetName: string, qty: bigint) => {
    if (qty === 0n) return;
    const u = unit(policyId, assetName);
    const next = (netTokenDelta[u] ?? 0n) + qty;
    if (next === 0n) delete netTokenDelta[u];
    else netTokenDelta[u] = next;
  };

  for (const leg of legs) {
    const d = leg.order.datum;
    if (d.offerId === "") {
      const cap = maxAdaOfferTake(leg.order);
      if (leg.offerTaken > cap)
        throw new Error(
          `offerTaken ${leg.offerTaken} would drop the continuation of ${leg.order.utxo.txHash}#${leg.order.utxo.outputIndex} below its min-UTxO floor (max safe take ${cap})`,
        );
    }
    const f = computeOneWayFill(leg.order, leg.offerTaken);
    const { fill } = cardanoSwapsComposable({ order: leg.order, orderUtxo: leg.orderUtxo, offerTaken: leg.offerTaken });
    fills.push(fill);

    // Taker gains the offer, spends the ask; ADA legs fold into netAdaOutflow.
    if (d.offerId === "") netAdaOutflow -= f.offerTaken;
    else addDelta(d.offerId, d.offerName, f.offerTaken);
    if (d.askId === "") netAdaOutflow += f.askGiven;
    else addDelta(d.askId, d.askName, -f.askGiven);

    grossNotionalLovelace += (d.offerId === "" ? f.offerTaken : 0n) + (d.askId === "" ? f.askGiven : 0n);
  }
  return { fills, netTokenDelta, netAdaOutflow, grossNotionalLovelace };
}

export interface AssembleOneWayMultiFillArgs {
  /** wallet must already be selected (its UTxOs fund the net delta + fee) */
  lucid: LucidEvolution;
  deployment: CardanoSwapsDeployment;
  plan: MultiFillPlan;
  changeAddress: string;
}

/**
 * One tx: K order inputs (nullary Swap via the CIP-33 spend reference script),
 * K continuation outputs, wallet funding + change. No mint, no withdrawals, no
 * required signers — fills are permissionless.
 */
export async function assembleOneWayMultiFillTx(
  args: AssembleOneWayMultiFillArgs,
): Promise<{ unsignedCbor: string; txHash: string; txSizeBytes: number }> {
  const { lucid, deployment, plan } = args;
  const [spendRef] = await lucid.utxosByOutRef([
    { txHash: deployment.spendRefUtxo.txHash, outputIndex: deployment.spendRefUtxo.outputIndex },
  ]);
  if (!spendRef) throw new Error("spend reference-script UTxO not found");

  let tx = lucid.newTx().readFrom([spendRef]);
  for (const fill of plan.fills) {
    if (typeof fill.redeemer !== "string") throw new Error("canonical fills use a fixed nullary redeemer");
    tx = tx.collectFrom([fill.input], fill.redeemer);
    for (const out of fill.outputs) {
      tx = tx.pay.ToAddressWithData(out.address, { kind: "inline", value: out.datum }, out.value as Assets);
    }
  }
  const signBuilder = await tx.complete({ changeAddress: args.changeAddress });
  const unsignedCbor = signBuilder.toCBOR();
  return { unsignedCbor, txHash: signBuilder.toHash(), txSizeBytes: unsignedCbor.length / 2 };
}
