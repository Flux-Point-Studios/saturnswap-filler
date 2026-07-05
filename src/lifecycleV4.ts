// V4 order-lifecycle recipe planners (PURE) — create, cancel, reprice for
// one-way orders, plus the per-user address derivation every step needs.
// Same recipe shape as fillV4's planTakerFillV4Tx: a serializable description
// (outputs, mints, spend redeemer, required signers, ref inputs) that a thin
// Lucid assembler turns into a signable tx. Fully offline-testable.
//
// CIP-0089: an order lives at a PER-USER address = (the shared saturn_swap_v4
// script hash) + (the maker's OWN staking credential). Owner actions
// (cancel/reprice) are authorized by that staking credential — a key signature
// in extra_signatories, or a script via the withdraw-zero trick.

import { credentialToAddress } from "@lucid-evolution/lucid";
import type { Network } from "@lucid-evolution/lucid";
import type { OrderDatumV4 } from "./datumV4.js";
import {
  orderDatumToPlutusData,
  cancelRedeemer,
  repriceRedeemer,
  beaconCreateOrClose,
  beaconBurnOnly,
  paymentDatumV4,
} from "./datumV4.js";
import { pairBeaconName, offerBeaconName, askBeaconName } from "./beaconsV4.js";
import { plutusToHex } from "./plutus.js";
import type { ChainValue } from "./discovery.js";
import { inputIndexOf, type TxIn } from "./sort.js";
import { minUtxoLovelace } from "./minUtxo.js";
import { V4_MAINNET_COINS_PER_UTXO_BYTE, type V4Deployment, type RecipeOutput, type RecipeMintGroup } from "./fillV4.js";
import type { OutputRef, Credential } from "./datum.js";

// Credential (`{ type: "key" | "script"; hash }`) is re-used from datum.js.

/** Derive a maker's per-user order address = script(orderScriptHash) + stake. */
export function orderAddressFor(
  deployment: Pick<V4Deployment, "orderScriptHash" | "network">,
  stake: Credential,
): string {
  return credentialToAddress(
    deployment.network,
    { type: "Script", hash: deployment.orderScriptHash },
    { type: stake.type === "key" ? "Key" : "Script", hash: stake.hash },
  );
}

function credToBech32(
  addr: { payment: { type: "key" | "script"; hash: string }; stake?: { type: "key" | "script"; hash: string } },
  network: Network,
): string {
  const payment = { type: addr.payment.type === "key" ? ("Key" as const) : ("Script" as const), hash: addr.payment.hash };
  if (!addr.stake) return credentialToAddress(network, payment);
  const stake = { type: addr.stake.type === "key" ? ("Key" as const) : ("Script" as const), hash: addr.stake.hash };
  return credentialToAddress(network, payment, stake);
}

function chainValueToAssets(v: ChainValue): Record<string, bigint> {
  const out: Record<string, bigint> = { lovelace: v.lovelace };
  for (const [u, amt] of Object.entries(v.assets)) if (amt !== 0n) out[u] = amt;
  return out;
}

function floorMinUtxo(
  assets: Record<string, bigint>,
  addressBech32: string,
  coinsPerUtxoByte: bigint,
  inlineDatumHex?: string,
): Record<string, bigint> {
  const sizing: Record<string, bigint> = { ...assets };
  if (!sizing["lovelace"] || sizing["lovelace"] < 1_000_000n) sizing["lovelace"] = 2_000_000n;
  const floor = minUtxoLovelace({ addressBech32, assets: sizing, inlineDatumHex }, coinsPerUtxoByte);
  const current = assets["lovelace"] ?? 0n;
  return { ...assets, lovelace: current > floor ? current : floor };
}

function datumForBuilder(d: OrderDatumV4) {
  return {
    beaconPolicy: d.beaconPolicy,
    owner: d.owner,
    policyIdSell: d.policyIdSell,
    assetNameSell: d.assetNameSell,
    amountSell: d.amountSell,
    policyIdBuy: d.policyIdBuy,
    assetNameBuy: d.assetNameBuy,
    amountBuy: d.amountBuy,
    validBeforeTime: d.validBeforeTime,
    minPartialFill: d.minPartialFill,
    coverage: d.coverage,
    outputReference: d.outputReference,
  };
}

/** sentinel output_reference for a freshly-created order (never spent). */
export const SENTINEL_OUTREF: OutputRef = { txHash: "00".repeat(32), outputIndex: 0 };

// ---- shared recipe types ----

export interface LifecycleRecipe {
  action: "create" | "cancel" | "reprice";
  outputs: RecipeOutput[];
  mints: RecipeMintGroup[];
  refInputs: OutputRef[];
  /** present for cancel/reprice (an order is spent) */
  spend?: { orderRef: OutputRef; redeemerHex: string; inputIndex: number; spendInputs: TxIn[] };
  /** stake key hash to add to required_signers (key-cred owner auth); script
   *  creds authorize via a withdraw-zero entry the caller must add instead */
  requiredStakeKeyHash?: string;
  validToUnixMs: number | null;
}

// ---- create one-way order ----

export interface PlanCreateOrderV4Args {
  deployment: V4Deployment;
  /** the full order datum to post (beaconPolicy must equal deployment.beaconPolicy;
   *  outputReference should be SENTINEL_OUTREF for a fresh order) */
  datum: OrderDatumV4;
  /** the maker's staking credential — determines the per-user order address */
  makerStake: Credential;
  /** deposit/min-ADA to lock alongside the sell asset + beacons */
  depositLovelace?: bigint;
  coinsPerUtxoByte?: bigint;
}

/**
 * PURE: recipe to create (post) a one-way limit order. Mints the three beacons
 * (CreateOrClose) into a UTxO at the maker's per-user address, funded to
 * amount_sell + deposit.
 */
export function planCreateOrderV4Tx(args: PlanCreateOrderV4Args): LifecycleRecipe {
  const { deployment, datum } = args;
  const coinsPerUtxoByte = args.coinsPerUtxoByte ?? V4_MAINNET_COINS_PER_UTXO_BYTE;
  if (datum.beaconPolicy !== deployment.beaconPolicy)
    throw new Error("datum.beaconPolicy must equal deployment.beaconPolicy");
  if (datum.policyIdSell === datum.policyIdBuy && datum.assetNameSell === datum.assetNameBuy)
    throw new Error("sell and buy asset must differ");
  if (datum.amountSell <= 0n || datum.amountBuy <= 0n) throw new Error("amounts must be > 0");

  const orderAddress = orderAddressFor(deployment, args.makerStake);
  const pairName = pairBeaconName(datum.policyIdSell, datum.assetNameSell, datum.policyIdBuy, datum.assetNameBuy);
  const offerName = offerBeaconName(datum.policyIdSell, datum.assetNameSell);
  const askName = askBeaconName(datum.policyIdBuy, datum.assetNameBuy);

  // order value: deposit + amount_sell + 3 beacons
  const deposit = args.depositLovelace ?? 2_000_000n;
  const sellIsAda = datum.policyIdSell === "";
  const value: Record<string, bigint> = { lovelace: sellIsAda ? deposit + datum.amountSell : deposit };
  if (!sellIsAda) value[datum.policyIdSell + datum.assetNameSell] = datum.amountSell;
  value[deployment.beaconPolicy + pairName] = 1n;
  value[deployment.beaconPolicy + offerName] = 1n;
  value[deployment.beaconPolicy + askName] = 1n;

  const datumHex = plutusToHex(orderDatumToPlutusData(datumForBuilder(datum)));

  return {
    action: "create",
    outputs: [
      {
        role: "continuation", // the new order UTxO
        addressBech32: orderAddress,
        assets: floorMinUtxo(value, orderAddress, coinsPerUtxoByte, datumHex),
        inlineDatumHex: datumHex,
      },
    ],
    mints: [
      {
        redeemerHex: plutusToHex(beaconCreateOrClose),
        assets: [
          { unit: deployment.beaconPolicy + pairName, quantity: 1n },
          { unit: deployment.beaconPolicy + offerName, quantity: 1n },
          { unit: deployment.beaconPolicy + askName, quantity: 1n },
        ],
      },
    ],
    refInputs: [deployment.beaconRefUtxo],
    validToUnixMs: null,
  };
}

// ---- cancel one-way order ----

export interface PlanCancelOrderV4Args {
  deployment: V4Deployment;
  order: { datum: OrderDatumV4; utxo: OutputRef; scriptValue: ChainValue; address: string };
  /** the maker's OWN staking credential (the order address's stake cred — this
   *  is what authorizes the cancel). Key creds add a required signer; script
   *  creds authorize via a withdraw-zero entry the caller adds. */
  makerStake: Credential;
  /** funding inputs (for the canonical input sort / index) */
  fundingInputs: TxIn[];
  coinsPerUtxoByte?: bigint;
}

/**
 * PURE: recipe to cancel an order. Spends it (Cancel), burns the three beacons,
 * and pays the reclaimed value (everything except the beacons) to the datum
 * owner, tagged with the spent order's own_ref — the security-review
 * owner-binding requirement.
 */
export function planCancelOrderV4Tx(args: PlanCancelOrderV4Args): LifecycleRecipe {
  const { deployment, order } = args;
  const coinsPerUtxoByte = args.coinsPerUtxoByte ?? V4_MAINNET_COINS_PER_UTXO_BYTE;
  const orderRef = order.utxo;

  // sanity: the order must actually sit at the maker's per-user address
  const expectedAddress = orderAddressFor(deployment, args.makerStake);
  if (order.address !== expectedAddress)
    throw new Error("order.address does not match orderAddressFor(deployment, makerStake)");

  const spendInputs: TxIn[] = [orderRef, ...args.fundingInputs];
  const inputIndex = inputIndexOf(spendInputs, orderRef);
  if (inputIndex < 0) throw new Error("order input not in spend-input set");

  const d = order.datum;
  const pairName = pairBeaconName(d.policyIdSell, d.assetNameSell, d.policyIdBuy, d.assetNameBuy);
  const offerName = offerBeaconName(d.policyIdSell, d.assetNameSell);
  const askName = askBeaconName(d.policyIdBuy, d.assetNameBuy);

  // reclaimed value = order value minus the 3 beacons
  const reclaim = chainValueToAssets(order.scriptValue);
  for (const name of [pairName, offerName, askName]) {
    const u = deployment.beaconPolicy + name;
    if (reclaim[u]) {
      reclaim[u] -= 1n;
      if (reclaim[u] === 0n) delete reclaim[u];
    }
  }
  const paymentDatumHex = plutusToHex(paymentDatumV4(orderRef));
  const ownerBech32 = credToBech32(d.owner, deployment.network);

  return {
    action: "cancel",
    outputs: [
      {
        role: "owner",
        addressBech32: ownerBech32,
        assets: floorMinUtxo(reclaim, ownerBech32, coinsPerUtxoByte, paymentDatumHex),
        inlineDatumHex: paymentDatumHex,
      },
    ],
    mints: [
      {
        redeemerHex: plutusToHex(beaconBurnOnly),
        assets: [
          { unit: deployment.beaconPolicy + pairName, quantity: -1n },
          { unit: deployment.beaconPolicy + offerName, quantity: -1n },
          { unit: deployment.beaconPolicy + askName, quantity: -1n },
        ],
      },
    ],
    refInputs: [deployment.spendRefUtxo, deployment.beaconRefUtxo],
    spend: { orderRef, redeemerHex: plutusToHex(cancelRedeemer(inputIndex)), inputIndex, spendInputs },
    requiredStakeKeyHash: args.makerStake.type === "key" ? args.makerStake.hash : undefined,
    validToUnixMs: null,
  };
}

// ---- reprice one-way order ----

export interface PlanRepriceOrderV4Args {
  deployment: V4Deployment;
  order: { datum: OrderDatumV4; utxo: OutputRef; scriptValue: ChainValue; address: string };
  /** the maker's OWN staking credential (authorizes the reprice) */
  makerStake: Credential;
  /** the new datum — same owner & pair (enforced on-chain); new price/amounts/
   *  expiry/min-partial/coverage allowed. output_reference is set to own_ref. */
  newDatum: OrderDatumV4;
  /** the reserves to fund the continuation to newDatum.amountSell (defaults to
   *  the current order value — a pure price change keeps the same value) */
  newValue?: ChainValue;
  fundingInputs: TxIn[];
  coinsPerUtxoByte?: bigint;
}

/** PURE: recipe to reprice an order in place (net-zero beacons). */
export function planRepriceOrderV4Tx(args: PlanRepriceOrderV4Args): LifecycleRecipe {
  const { deployment, order } = args;
  const coinsPerUtxoByte = args.coinsPerUtxoByte ?? V4_MAINNET_COINS_PER_UTXO_BYTE;
  const orderRef = order.utxo;
  const d = order.datum;

  if (order.address !== orderAddressFor(deployment, args.makerStake))
    throw new Error("order.address does not match orderAddressFor(deployment, makerStake)");

  // enforce the invariants the validator checks (fail early off-chain)
  if (args.newDatum.owner.payment.hash !== d.owner.payment.hash || args.newDatum.owner.stake?.hash !== d.owner.stake?.hash)
    throw new Error("reprice cannot change owner");
  if (
    args.newDatum.policyIdSell !== d.policyIdSell ||
    args.newDatum.assetNameSell !== d.assetNameSell ||
    args.newDatum.policyIdBuy !== d.policyIdBuy ||
    args.newDatum.assetNameBuy !== d.assetNameBuy
  )
    throw new Error("reprice cannot change the trading pair");
  if (args.newDatum.amountSell <= 0n || args.newDatum.amountBuy <= 0n) throw new Error("amounts must be > 0");

  const spendInputs: TxIn[] = [orderRef, ...args.fundingInputs];
  const inputIndex = inputIndexOf(spendInputs, orderRef);
  if (inputIndex < 0) throw new Error("order input not in spend-input set");

  const contDatum: OrderDatumV4 = { ...args.newDatum, beaconPolicy: d.beaconPolicy, outputReference: orderRef };
  const value = args.newValue ?? order.scriptValue;
  const contAssets = chainValueToAssets(value);
  // sanity: continuation must hold >= newDatum.amountSell of the sell asset
  const sellUnit = d.policyIdSell === "" ? "lovelace" : d.policyIdSell + d.assetNameSell;
  if ((contAssets[sellUnit] ?? 0n) < args.newDatum.amountSell)
    throw new Error("continuation underfunded for new amount_sell");
  const datumHex = plutusToHex(orderDatumToPlutusData(datumForBuilder(contDatum)));

  return {
    action: "reprice",
    outputs: [
      { role: "continuation", addressBech32: order.address, assets: contAssets, inlineDatumHex: datumHex },
    ],
    mints: [], // net-zero beacons — the policy does not run
    refInputs: [deployment.spendRefUtxo],
    spend: { orderRef, redeemerHex: plutusToHex(repriceRedeemer(inputIndex, 0)), inputIndex, spendInputs },
    requiredStakeKeyHash: args.makerStake.type === "key" ? args.makerStake.hash : undefined,
    validToUnixMs: null,
  };
}
