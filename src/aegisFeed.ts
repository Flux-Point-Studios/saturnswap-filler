// AegisSelf price-feed discovery + observer attestation encoding.
//
// A feed is a rotating UTxO at the canonical publisher address carrying one
// "AEGIS_P" token under a per-pair feed-NFT policy and an inline
// Charli3-GenericData-shaped datum: Constr0[Constr2[{0: price(1e6), 1:
// observed_at ms, 2: valid_until ms, 3?: trailing-12h low, 4?: low observed
// ms}]]. The UTxO ref changes on EVERY publish (~hourly) — always discover at
// build time by (feed policy, publisher address), never pin a ref.
//
// A Barrier underwrite must attach (a) the live feed UTxO as a read-only
// reference input and (b) the oracle_observer's withdraw-0 whose redeemer is a
// List<Attestation> echoing the feed's Price byte-for-byte (the observer
// re-resolves each feed from the tx's own reference inputs and compares with
// strict ==). Freshness stays consumer-side: pool.ak's Barrier arm requires
//   tx_lower <= price.observed_at + 300_000 && tx_upper <= price.valid_until.

import type { OutputRef } from "./datum.js";
import { PConstr, PHex, PInt, plutusToHex, decodePlutusHex, type PlutusData } from "./plutus.js";
import { AEGIS_V7_MAINNET } from "./cardanoSwapsMainnet.js";

/** pool.ak Barrier freshness: tx_lower <= observed_at + 300_000. */
export const MAX_FEED_AGE_MS = 300_000n;

/** The feed marker asset name — "AEGIS_P". */
export const AEGIS_FEED_ASSET_NAME_HEX = "41454749535f50";

export interface AegisFeedPrice {
  priceScaled: bigint;
  observedAtMs: bigint;
  validUntilMs: bigint;
  minPrice12hScaled: bigint;
  lowObservedAtMs: bigint;
}

export interface AegisFeedReading extends AegisFeedPrice {
  feedPolicyId: string;
  utxo: OutputRef;
}

/** A provider-neutral view of a UTxO at the publisher address (adapt from
 *  Blockfrost/Kupo/lucid before calling the finder). */
export interface FeedUtxoView {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
  datumHex: string | null;
}

function expectInt(d: PlutusData | undefined, what: string): bigint {
  if (!d || d.kind !== "int") throw new Error(`feed datum: expected int for ${what}`);
  return d.value;
}

/** Decode the inline feed datum. Missing key 3 defaults to the SPOT price and
 *  key 4 to observed_at — mirroring the on-chain parser's pool-drain guard
 *  (a 0 default would make `min_price_12h <= strike` true for every policy). */
export function decodeAegisFeedDatum(datumHex: string): AegisFeedPrice {
  const top = decodePlutusHex(datumHex);
  if (top.kind !== "constr" || top.alt !== 0 || top.fields.length !== 1) {
    throw new Error("not an AegisSelf feed datum: expected Constr0[Constr2[price map]]");
  }
  const inner = top.fields[0]!;
  if (inner.kind !== "constr" || inner.alt !== 2 || inner.fields.length !== 1 || inner.fields[0]!.kind !== "map") {
    throw new Error("not an AegisSelf feed datum: expected Constr2[price map] inside Constr0");
  }
  const entries = new Map<bigint, PlutusData>();
  for (const [k, v] of inner.fields[0]!.entries) {
    if (k.kind === "int") entries.set(k.value, v);
  }
  const priceScaled = expectInt(entries.get(0n), "price (key 0)");
  const observedAtMs = expectInt(entries.get(1n), "observed_at (key 1)");
  const validUntilMs = expectInt(entries.get(2n), "valid_until (key 2)");
  const minPrice12hScaled = entries.has(3n) ? expectInt(entries.get(3n), "min_price_12h (key 3)") : priceScaled;
  const lowObservedAtMs = entries.has(4n) ? expectInt(entries.get(4n), "low_observed_at (key 4)") : observedAtMs;
  return { priceScaled, observedAtMs, validUntilMs, minPrice12hScaled, lowObservedAtMs };
}

/** Find the live feed UTxO for a feed-NFT policy among the publisher's UTxOs.
 *  Rejects a marker sitting away from the canonical publisher address — the
 *  same two-layer pin (policy + publisher) the on-chain parser enforces. */
export function findLiveAegisFeed(
  utxos: FeedUtxoView[],
  feedPolicyId: string,
  publisherAddress: string = AEGIS_V7_MAINNET.publisher.address,
): AegisFeedReading {
  const markerUnit = feedPolicyId + AEGIS_FEED_ASSET_NAME_HEX;
  const carriers = utxos.filter((u) => (u.assets[markerUnit] ?? 0n) > 0n);
  if (carriers.length === 0) throw new Error(`AegisSelf feed not found for policy ${feedPolicyId}`);
  const atPublisher = carriers.find((u) => u.address === publisherAddress);
  if (!atPublisher) {
    throw new Error(`AegisSelf feed marker for ${feedPolicyId} is not at the canonical publisher address`);
  }
  if (!atPublisher.datumHex) throw new Error("AegisSelf feed UTxO has no inline datum");
  return {
    feedPolicyId,
    utxo: { txHash: atPublisher.txHash, outputIndex: atPublisher.outputIndex },
    ...decodeAegisFeedDatum(atPublisher.datumHex),
  };
}

/** Throw once the reading expired — tx_upper <= valid_until is unsatisfiable. */
export function assertFeedUsable(feed: AegisFeedPrice, nowMs: bigint): void {
  if (nowMs > feed.validUntilMs) {
    throw new Error(
      `AegisSelf feed expired at ${feed.validUntilMs} (now ${nowMs}) — wait for the next publish before underwriting`,
    );
  }
}

/** Encode the oracle_observer withdraw-0 redeemer: List<Attestation> with
 *  Attestation = Constr0[OracleProvider, oracle_nft bytes, Price(5 ints)] and
 *  OracleProvider::AegisSelf = Constr 2. The Price must echo the referenced
 *  feed exactly — the observer re-resolves and compares with strict ==. */
export function encodeObserverAttestations(feeds: AegisFeedReading[]): string {
  if (feeds.length === 0) throw new Error("observer attestation needs at least one feed");
  const items = feeds.map((f) =>
    PConstr(0, [
      PConstr(2, []), // AegisSelf
      PHex(f.feedPolicyId),
      PConstr(0, [
        PInt(f.priceScaled),
        PInt(f.observedAtMs),
        PInt(f.validUntilMs),
        PInt(f.minPrice12hScaled),
        PInt(f.lowObservedAtMs),
      ]),
    ]),
  );
  return plutusToHex({ kind: "list", items });
}

/** Adapt Blockfrost /addresses/{addr}/utxos rows into FeedUtxoView. */
export function feedViewFromBlockfrost(rows: Array<{
  tx_hash: string;
  output_index: number;
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  inline_datum: string | null;
}>): FeedUtxoView[] {
  return rows.map((r) => {
    const assets: Record<string, bigint> = {};
    for (const a of r.amount) assets[a.unit] = BigInt(a.quantity);
    return { txHash: r.tx_hash, outputIndex: r.output_index, address: r.address, assets, datumHex: r.inline_datum };
  });
}
