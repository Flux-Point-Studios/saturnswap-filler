// V4 beacon-based order discovery — the CIP-0089 replacement for the V3
// per-address scan (discovery.ts). Instead of scanning a script address,
// query any indexer for UTxOs holding a specific beacon asset:
//
//   whole book for a pair   -> pairBeaconName(sell,buy) under the beacon policy
//   all orders offering X    -> offerBeaconName(X)
//   all orders asking X      -> askBeaconName(X)
//
// This module is provider-agnostic: implement BeaconProvider over Koios
// (asset_utxos), Blockfrost (assets/{asset}/addresses + utxos), Kupo
// (matches?policy_id / asset_name), or Ogmios. A KoiosBeaconProvider is
// included as a zero-config default, mirroring discovery.ts's KoiosProvider.

import { type RawUtxo } from "./discovery.js";
import {
  decodeOrderDatumV4Hex,
  decodeTwoWayDatumV4,
  type OrderDatumV4,
  type TwoWayOrderDatumV4,
} from "./datumV4.js";
import {
  pairBeaconName,
  offerBeaconName,
  askBeaconName,
  sortedPairBeaconName,
} from "./beaconsV4.js";
import { hexToBytes } from "./cbor.js";

/** A provider that returns UTxOs currently holding a given beacon asset
 *  (policyId + assetName hex, concatenated — the Cardano "unit"). */
export interface BeaconProvider {
  utxosWithAsset(policyId: string, assetName: string): Promise<RawUtxo[]>;
}

export interface OneWayBeaconOrder {
  kind: "one-way";
  utxo: { txHash: string; outputIndex: number };
  address: string;
  beaconPolicy: string;
  datum: OrderDatumV4;
  raw: RawUtxo;
}

export interface TwoWayBeaconOrder {
  kind: "two-way";
  utxo: { txHash: string; outputIndex: number };
  address: string;
  beaconPolicy: string;
  datum: TwoWayOrderDatumV4;
  raw: RawUtxo;
}

export type BeaconOrder = OneWayBeaconOrder | TwoWayBeaconOrder;

function inlineDatumHex(u: RawUtxo): string | undefined {
  return u.inlineDatumHex;
}

/** Decode a UTxO known to hold a one-way beacon into an order (undefined if
 *  it has no inline datum or the datum doesn't decode). */
export function decodeOneWay(u: RawUtxo): OneWayBeaconOrder | undefined {
  const hex = inlineDatumHex(u);
  if (!hex) return undefined;
  try {
    const datum = decodeOrderDatumV4Hex(hex);
    return {
      kind: "one-way",
      utxo: { txHash: u.txHash, outputIndex: u.outputIndex },
      address: u.address,
      beaconPolicy: datum.beaconPolicy,
      datum,
      raw: u,
    };
  } catch {
    return undefined;
  }
}

export function decodeTwoWay(u: RawUtxo): TwoWayBeaconOrder | undefined {
  const hex = inlineDatumHex(u);
  if (!hex) return undefined;
  try {
    const datum = decodeTwoWayDatumV4(hexToBytes(hex));
    return {
      kind: "two-way",
      utxo: { txHash: u.txHash, outputIndex: u.outputIndex },
      address: u.address,
      beaconPolicy: datum.beaconPolicy,
      datum,
      raw: u,
    };
  } catch {
    return undefined;
  }
}

export interface DiscoverV4Options {
  provider: BeaconProvider;
  /** the beacon_limit policy id for one-way orders */
  oneWayBeaconPolicy?: string;
  /** the beacon_amm policy id for two-way orders */
  twoWayBeaconPolicy?: string;
}

/** All open ONE-WAY orders for a directional pair (sell -> buy). */
export async function discoverOneWayOrders(
  sell: { policyId: string; assetName: string },
  buy: { policyId: string; assetName: string },
  opts: DiscoverV4Options,
): Promise<OneWayBeaconOrder[]> {
  if (!opts.oneWayBeaconPolicy) throw new Error("oneWayBeaconPolicy required");
  const name = pairBeaconName(sell.policyId, sell.assetName, buy.policyId, buy.assetName);
  const utxos = await opts.provider.utxosWithAsset(opts.oneWayBeaconPolicy, name);
  return utxos.map(decodeOneWay).filter((o): o is OneWayBeaconOrder => o !== undefined);
}

/** All open ONE-WAY orders OFFERING (selling) a given asset, any ask side. */
export async function discoverOrdersOfferingAsset(
  offer: { policyId: string; assetName: string },
  opts: DiscoverV4Options,
): Promise<OneWayBeaconOrder[]> {
  if (!opts.oneWayBeaconPolicy) throw new Error("oneWayBeaconPolicy required");
  const name = offerBeaconName(offer.policyId, offer.assetName);
  const utxos = await opts.provider.utxosWithAsset(opts.oneWayBeaconPolicy, name);
  return utxos.map(decodeOneWay).filter((o): o is OneWayBeaconOrder => o !== undefined);
}

/** All open ONE-WAY orders ASKING FOR (buying) a given asset, any offer side. */
export async function discoverOrdersAskingAsset(
  ask: { policyId: string; assetName: string },
  opts: DiscoverV4Options,
): Promise<OneWayBeaconOrder[]> {
  if (!opts.oneWayBeaconPolicy) throw new Error("oneWayBeaconPolicy required");
  const name = askBeaconName(ask.policyId, ask.assetName);
  const utxos = await opts.provider.utxosWithAsset(opts.oneWayBeaconPolicy, name);
  return utxos.map(decodeOneWay).filter((o): o is OneWayBeaconOrder => o !== undefined);
}

/** All open TWO-WAY (market-maker) orders for a pair. Pass the pair in any
 *  order — it is sorted internally to match the non-directional beacon. */
export async function discoverTwoWayOrders(
  assetA: { policyId: string; assetName: string },
  assetB: { policyId: string; assetName: string },
  opts: DiscoverV4Options,
): Promise<TwoWayBeaconOrder[]> {
  if (!opts.twoWayBeaconPolicy) throw new Error("twoWayBeaconPolicy required");
  // sortedPairBeaconName is symmetric only if we sort first
  const { sortPair } = await import("./beaconsV4.js");
  const [a1, a2] = sortPair(assetA, assetB);
  const name = sortedPairBeaconName(a1.policyId, a1.assetName, a2.policyId, a2.assetName);
  const utxos = await opts.provider.utxosWithAsset(opts.twoWayBeaconPolicy, name);
  return utxos.map(decodeTwoWay).filter((o): o is TwoWayBeaconOrder => o !== undefined);
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
    // Koios asset_utxos: POST _asset_list = [[policy_id, asset_name]], _extended=true
    const res = await fetch(`${this.baseUrl}/asset_utxos?_extended=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ _asset_list: [[policyId, assetName]], _extended: true }),
    });
    if (!res.ok) throw new Error(`Koios asset_utxos ${res.status}`);
    const rows = (await res.json()) as KoiosAssetUtxoRow[];
    return rows.map((r) => toRawUtxo(r));
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
