import { describe, it, expect } from "vitest";
import { Constr, Data } from "@lucid-evolution/lucid";
import {
  decodeAegisFeedDatum,
  findLiveAegisFeed,
  encodeObserverAttestations,
  assertFeedUsable,
  MAX_FEED_AGE_MS,
  type FeedUtxoView,
} from "../../src/aegisFeed.js";
import { AEGIS_V7_MAINNET } from "../../src/cardanoSwapsMainnet.js";

// REAL mainnet datums captured 2026-07-08 at the AegisSelf publisher address.
// 5-key (a5) ADA/USD crash-shield datum — feed e108ff44…#0:
const ADA_DATUM_5KEY =
  "d8799fd87b9fa5001a00028c44011b0000019f422460d4021b0000019f42647714031a0002854e041b0000019f4107cdafffff";
// 3-key (a3) datum — SURF slot feed 1fa83d80…#0:
const SURF_DATUM_3KEY = "d8799fd87b9fa3001a000f4240011b0000019f42156a84021b0000019f425580c4ffff";

const ADA_FEED_POLICY = "f0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301";
const SURF1_POLICY = "c2f62874c860e1fc87bae0043066e551153f30fcc5d9944a370e8f8d";
// REAL full asset names (chain-verified — "AEGIS_P" was a display truncation):
const ADA_FEED_NAME = "41454749535f50524943455f464545445f5631"; // AEGIS_PRICE_FEED_V1
const SURF1_NAME = "41454749535f50524943455f464545445f53555246315f4556545f5631"; // AEGIS_PRICE_FEED_SURF1_EVT_V1
const PUBLISHER =
  "addr1qxasnapjg46en92yqwydh8hnlznpgfrw3ksamx7s2vnpx37mhqv8f4lgc96cj6q4upk62yfa0qm3l5fr6er5z5s7p80s8nnsfx";
// A real mainnet address with a DIFFERENT payment credential (the deploy wallet):
const NOT_PUBLISHER = "addr1vyvv7lezwz4h0q5qdume70t0wxv9l73qsq2ls9lmy2wh6qskxnh3p";

describe("decodeAegisFeedDatum — Charli3-GenericData shaped price map", () => {
  it("decodes the real 5-key ADA/USD datum (value/observed/valid_until/12h-low/low-observed)", () => {
    const d = decodeAegisFeedDatum(ADA_DATUM_5KEY);
    expect(d.priceScaled).toBe(0x00028c44n); // 166,980 = $0.16698 @1e6
    expect(d.observedAtMs).toBe(0x0000019f422460d4n);
    expect(d.validUntilMs).toBe(0x0000019f42647714n);
    expect(d.minPrice12hScaled).toBe(0x0002854en); // 165,198
    expect(d.lowObservedAtMs).toBe(0x0000019f4107cdafn);
  });

  it("defaults a missing key 3 to the SPOT price and key 4 to observed_at (the pool-drain guard — NEVER 0)", () => {
    // 3-key form: keys 0,1,2 only.
    const d = decodeAegisFeedDatum("d8799fd87b9fa3001a000f4240011b0000019f42156a84021b0000019f425580c4ffff");
    expect(d.priceScaled).toBe(1_000_000n);
    expect(d.minPrice12hScaled).toBe(1_000_000n); // = value, not 0
    expect(d.lowObservedAtMs).toBe(d.observedAtMs);
  });

  it("resolves a duplicate key to the FIRST occurrence (pairs.get_first)", () => {
    // key 0 appears twice (1_000_000 then 2_000_000) — first wins.
    const d = decodeAegisFeedDatum(
      "d8799fd87b9fa4001a000f4240001a001e8480011b0000019f42156a84021b0000019f425580c4ffff",
    );
    expect(d.priceScaled).toBe(1_000_000n);
  });

  it("rejects a non-Int price-map key (the on-chain expect would fail)", () => {
    // key = bytes 'aa' instead of an int
    expect(() =>
      decodeAegisFeedDatum("d8799fd87b9fa341aa1a000f4240011b0000019f42156a84021b0000019f425580c4ffff"),
    ).toThrow(/non-Int/i);
  });

  it("rejects a datum that is not the Constr0[Constr2[map]] feed shape", () => {
    expect(() => decodeAegisFeedDatum("d8799f00ff")).toThrow(/feed datum/i);
  });
});

// ---- live-feed discovery (the feed UTxO rotates every publish — never pin) ----

function feedUtxo(policy: string, name: string, datumHex: string, address = PUBLISHER, idx = 0): FeedUtxoView {
  return {
    txHash: "ab".repeat(32),
    outputIndex: idx,
    address,
    assets: { lovelace: 2_000_000n, [policy + name]: 1n },
    datumHex,
  };
}

describe("findLiveAegisFeed — discovery by feed-NFT policy at the canonical publisher", () => {
  it("finds the ADA feed (real asset name) among mixed publisher UTxOs and decodes its reading", () => {
    const utxos: FeedUtxoView[] = [
      { txHash: "01".repeat(32), outputIndex: 1, address: PUBLISHER, assets: { lovelace: 500_000_000n }, datumHex: null },
      feedUtxo(SURF1_POLICY, SURF1_NAME, SURF_DATUM_3KEY, PUBLISHER, 0),
      feedUtxo(ADA_FEED_POLICY, ADA_FEED_NAME, ADA_DATUM_5KEY, PUBLISHER, 2),
    ];
    const feed = findLiveAegisFeed(utxos, ADA_FEED_POLICY);
    expect(feed.utxo).toEqual({ txHash: "ab".repeat(32), outputIndex: 2 });
    expect(feed.feedPolicyId).toBe(ADA_FEED_POLICY);
    expect(feed.priceScaled).toBe(166_980n);
    expect(feed.validUntilMs).toBe(0x0000019f42647714n);
  });

  it("matches ANY asset name under the feed policy (the validator gates on policy membership only)", () => {
    const oddName = feedUtxo(ADA_FEED_POLICY, "00", ADA_DATUM_5KEY);
    const feed = findLiveAegisFeed([oddName], ADA_FEED_POLICY);
    expect(feed.priceScaled).toBe(166_980n);
  });

  it("REJECTS a feed-marker token whose host address has a different payment credential (forged host)", () => {
    const forged = feedUtxo(ADA_FEED_POLICY, ADA_FEED_NAME, ADA_DATUM_5KEY, NOT_PUBLISHER);
    expect(() => findLiveAegisFeed([forged], ADA_FEED_POLICY)).toThrow(/publisher/i);
  });

  it("accepts the publisher's payment credential regardless of the stake part (mirrors the on-chain VKH pin)", () => {
    // The canonical base address itself must resolve to the pinned VKH.
    const feed = findLiveAegisFeed([feedUtxo(ADA_FEED_POLICY, ADA_FEED_NAME, ADA_DATUM_5KEY)], ADA_FEED_POLICY);
    expect(feed.feedPolicyId).toBe(ADA_FEED_POLICY);
  });

  it("throws when no UTxO carries the feed policy", () => {
    expect(() => findLiveAegisFeed([], ADA_FEED_POLICY)).toThrow(/not found/i);
  });
});

describe("assertFeedUsable — expiry + staleness gates", () => {
  const feed = findLiveAegisFeed([feedUtxo(ADA_FEED_POLICY, ADA_FEED_NAME, ADA_DATUM_5KEY)], ADA_FEED_POLICY);

  it("passes while fresh (within 5 min of observed_at and before valid_until)", () => {
    expect(() => assertFeedUsable(feed, feed.observedAtMs + 60_000n)).not.toThrow();
  });

  it("throws once the reading expired (tx_upper <= valid_until is unsatisfiable)", () => {
    expect(() => assertFeedUsable(feed, feed.validUntilMs + 1n)).toThrow(/expired/i);
  });

  it("throws once the reading is older than the 5-min pool.ak tx_lower gate (LP staleness protection)", () => {
    expect(() => assertFeedUsable(feed, feed.observedAtMs + MAX_FEED_AGE_MS + 1n)).toThrow(/stale/i);
  });
});

// ---- observer attestation redeemer: List<Attestation>, AegisSelf = Constr 2 ----

describe("encodeObserverAttestations — byte-compatible with the Aiken List<Attestation> redeemer", () => {
  it("encodes Constr0[AegisSelf, feed policy bytes, Price(5 ints)] — cross-checked against lucid Data", () => {
    const feed = findLiveAegisFeed([feedUtxo(ADA_FEED_POLICY, ADA_FEED_NAME, ADA_DATUM_5KEY)], ADA_FEED_POLICY);
    const hex = encodeObserverAttestations([feed]);

    // Independent decoder: lucid must read back the exact structure the observer expects.
    const decoded = Data.from(hex) as Array<Constr<unknown>>;
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toHaveLength(1);
    const att = decoded[0]!;
    expect(att.index).toBe(0);
    const [provider, nft, price] = att.fields as [Constr<never>, string, Constr<bigint>];
    expect(provider.index).toBe(2); // OracleProvider::AegisSelf
    expect(provider.fields).toEqual([]);
    expect(nft).toBe(ADA_FEED_POLICY);
    expect(price.index).toBe(0);
    // Price record field order: value, observed_at, valid_until, min_price_12h, low_observed_at
    expect(price.fields).toEqual([
      166_980n,
      0x0000019f422460d4n,
      0x0000019f42647714n,
      165_198n,
      0x0000019f4107cdafn,
    ]);
  });

  it("refuses an empty attestation list (the observer requires nonempty)", () => {
    expect(() => encodeObserverAttestations([])).toThrow(/at least one/i);
  });
});

describe("constants", () => {
  it("MAX_FEED_AGE_MS mirrors pool.ak's Barrier freshness gate (300s)", () => {
    expect(MAX_FEED_AGE_MS).toBe(300_000n);
  });

  it("publisher address constant matches the canonical AegisSelf publisher", () => {
    expect(AEGIS_V7_MAINNET.publisher.address).toBe(PUBLISHER);
  });
});
