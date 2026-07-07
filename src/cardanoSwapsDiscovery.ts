// Canonical cardano-swaps beacon discovery (CIP-0089 "distributed dApp"): query any
// indexer for the UTxOs holding a specific beacon asset, then decode the canonical
// SwapDatum. Provider-agnostic (Koios/Blockfrost/Kupo/Ogmios); a keyless
// KoiosBeaconProvider is the zero-config default.
//
//   whole one-way book for a pair   -> pairBeacon(offer, ask) under the one-way policy
//   all one-way orders offering X    -> offerBeacon(X)
//   all one-way orders asking X      -> askBeacon(X)
//   whole two-way book for a pair    -> pairBeacon(sortedPair) under the two-way policy

import { type RawUtxo } from "./discovery.js";
import { decodeOneWaySwapDatumHex, decodeTwoWaySwapDatumHex } from "./cardanoSwapsDatum.js";
import { pairBeacon, offerBeacon, askBeacon, sortPair, type AssetClass } from "./cardanoSwapsBeacons.js";
import type { OneWayOrder, TwoWayOrder } from "./cardanoSwapsFill.js";

/** Returns the UTxOs currently holding a given beacon asset (policyId + assetName hex). */
export interface BeaconProvider {
  utxosWithAsset(policyId: string, assetName: string): Promise<RawUtxo[]>;
}

export function decodeOneWayOrder(u: RawUtxo): OneWayOrder | undefined {
  if (!u.inlineDatumHex) return undefined;
  try {
    const datum = decodeOneWaySwapDatumHex(u.inlineDatumHex);
    return { kind: "one-way", utxo: { txHash: u.txHash, outputIndex: u.outputIndex }, address: u.address, datum, scriptValue: u.value, raw: u };
  } catch {
    return undefined;
  }
}

export function decodeTwoWayOrder(u: RawUtxo): TwoWayOrder | undefined {
  if (!u.inlineDatumHex) return undefined;
  try {
    const datum = decodeTwoWaySwapDatumHex(u.inlineDatumHex);
    return { kind: "two-way", utxo: { txHash: u.txHash, outputIndex: u.outputIndex }, address: u.address, datum, scriptValue: u.value, raw: u };
  } catch {
    return undefined;
  }
}

export interface CardanoSwapsDiscoverOptions {
  provider: BeaconProvider;
  /** the one-way beacon policy id */
  oneWayBeaconPolicy?: string;
  /** the two-way beacon policy id */
  twoWayBeaconPolicy?: string;
}

/** All open ONE-WAY orders for a directional pair (offer -> ask). */
export async function discoverOneWayOrders(offer: AssetClass, ask: AssetClass, opts: CardanoSwapsDiscoverOptions): Promise<OneWayOrder[]> {
  if (!opts.oneWayBeaconPolicy) throw new Error("oneWayBeaconPolicy required");
  const utxos = await opts.provider.utxosWithAsset(opts.oneWayBeaconPolicy, pairBeacon(offer, ask));
  return utxos.map(decodeOneWayOrder).filter((o): o is OneWayOrder => o !== undefined);
}

/** All open ONE-WAY orders OFFERING a given asset, any ask side. */
export async function discoverOrdersOfferingAsset(offer: AssetClass, opts: CardanoSwapsDiscoverOptions): Promise<OneWayOrder[]> {
  if (!opts.oneWayBeaconPolicy) throw new Error("oneWayBeaconPolicy required");
  const utxos = await opts.provider.utxosWithAsset(opts.oneWayBeaconPolicy, offerBeacon(offer.policyId, offer.assetName));
  return utxos.map(decodeOneWayOrder).filter((o): o is OneWayOrder => o !== undefined);
}

/** All open ONE-WAY orders ASKING FOR a given asset, any offer side. */
export async function discoverOrdersAskingAsset(ask: AssetClass, opts: CardanoSwapsDiscoverOptions): Promise<OneWayOrder[]> {
  if (!opts.oneWayBeaconPolicy) throw new Error("oneWayBeaconPolicy required");
  const utxos = await opts.provider.utxosWithAsset(opts.oneWayBeaconPolicy, askBeacon(ask.policyId, ask.assetName));
  return utxos.map(decodeOneWayOrder).filter((o): o is OneWayOrder => o !== undefined);
}

/** All open TWO-WAY orders for a pair (passed in any order; sorted internally). */
export async function discoverTwoWayOrders(assetA: AssetClass, assetB: AssetClass, opts: CardanoSwapsDiscoverOptions): Promise<TwoWayOrder[]> {
  if (!opts.twoWayBeaconPolicy) throw new Error("twoWayBeaconPolicy required");
  const [a1, a2] = sortPair(assetA, assetB);
  const utxos = await opts.provider.utxosWithAsset(opts.twoWayBeaconPolicy, pairBeacon(a1, a2));
  return utxos.map(decodeTwoWayOrder).filter((o): o is TwoWayOrder => o !== undefined);
}

// ---- Koios default provider (keyless mainnet) ----

interface KoiosAssetUtxoRow {
  tx_hash: string;
  tx_index: number;
  address: string;
  inline_datum?: { bytes?: string } | null;
  asset_list?: { policy_id: string; asset_name: string; quantity: string }[];
  value?: string;
}

export class KoiosBeaconProvider implements BeaconProvider {
  constructor(private baseUrl = "https://api.koios.rest/api/v1") {}

  async utxosWithAsset(policyId: string, assetName: string): Promise<RawUtxo[]> {
    const res = await fetch(`${this.baseUrl}/asset_utxos?_extended=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ _asset_list: [[policyId, assetName]], _extended: true }),
    });
    if (!res.ok) throw new Error(`Koios asset_utxos ${res.status}`);
    const rows = (await res.json()) as KoiosAssetUtxoRow[];
    return rows.map(toRawUtxo);
  }
}

function toRawUtxo(r: KoiosAssetUtxoRow): RawUtxo {
  const assets: Record<string, bigint> = {};
  let lovelace = 0n;
  for (const a of r.asset_list ?? []) {
    if (a.policy_id === "" || a.policy_id === "lovelace") lovelace += BigInt(a.quantity);
    else assets[a.policy_id + a.asset_name] = BigInt(a.quantity);
  }
  if (r.value) lovelace = BigInt(r.value);
  return {
    txHash: r.tx_hash,
    outputIndex: r.tx_index,
    address: r.address,
    value: { lovelace, assets },
    inlineDatumHex: r.inline_datum?.bytes ?? undefined,
  };
}
