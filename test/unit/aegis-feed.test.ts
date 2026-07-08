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
const AEGIS_P = "41454749535f50"; // "AEGIS_P"
const PUBLISHER =
  "addr1qxasnapjg46en92yqwydh8hnlznpgfrw3ksamx7s2vnpx37mhqv8f4lgc96cj6q4upk62yfa0qm3l5fr6er5z5s7p80s8nnsfx";

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
    const d = decodeAegisFeedDatum(SURF_DATUM_3KEY);
    expect(d.priceScaled).toBe(1_000_000n);
    expect(d.minPrice12hScaled).toBe(1_000_000n); // = value, not 0
    expect(d.lowObservedAtMs).toBe(d.observedAtMs);
  });

  it("rejects a datum that is not the Constr0[Constr2[map]] feed shape", () => {
    expect(() => decodeAegisFeedDatum("d8799f00ff")).toThrow(/feed datum/i);
  });
});

// ---- live-feed discovery (the feed UTxO rotates every publish — never pin) ----

function feedUtxo(policy: string, datumHex: string, address = PUBLISHER, idx = 0): FeedUtxoView {
  return {
    txHash: "ab".repeat(32),
    outputIndex: idx,
    address,
    assets: { lovelace: 2_000_000n, [policy + AEGIS_P]: 1n },
    datumHex,
  };
}

describe("findLiveAegisFeed — discovery by feed-NFT policy at the canonical publisher", () => {
  it("finds the ADA feed among mixed publisher UTxOs and decodes its reading", () => {
    const utxos: FeedUtxoView[] = [
      { txHash: "01".repeat(32), outputIndex: 1, address: PUBLISHER, assets: { lovelace: 500_000_000n }, datumHex: null },
      feedUtxo(SURF1_POLICY, SURF_DATUM_3KEY, PUBLISHER, 0),
      feedUtxo(ADA_FEED_POLICY, ADA_DATUM_5KEY, PUBLISHER, 2),
    ];
    const feed = findLiveAegisFeed(utxos, ADA_FEED_POLICY);
    expect(feed.utxo).toEqual({ txHash: "ab".repeat(32), outputIndex: 2 });
    expect(feed.feedPolicyId).toBe(ADA_FEED_POLICY);
    expect(feed.priceScaled).toBe(166_980n);
    expect(feed.validUntilMs).toBe(0x0000019f42647714n);
  });

  it("REJECTS a feed-marker token that sits away from the canonical publisher address (forged host)", () => {
    const forged = feedUtxo(ADA_FEED_POLICY, ADA_DATUM_5KEY, "addr1q9attacker000000000000000000000000000000000000000000");
    expect(() => findLiveAegisFeed([forged], ADA_FEED_POLICY)).toThrow(/publisher/i);
  });

  it("throws when no UTxO carries the feed policy", () => {
    expect(() => findLiveAegisFeed([], ADA_FEED_POLICY)).toThrow(/not found/i);
  });
});

describe("assertFeedUsable — expiry gate", () => {
  const feed = findLiveAegisFeed([feedUtxo(ADA_FEED_POLICY, ADA_DATUM_5KEY)], ADA_FEED_POLICY);

  it("passes while now < valid_until", () => {
    expect(() => assertFeedUsable(feed, feed.validUntilMs - 60_000n)).not.toThrow();
  });

  it("throws once the reading expired (tx_upper <= valid_until is unsatisfiable)", () => {
    expect(() => assertFeedUsable(feed, feed.validUntilMs + 1n)).toThrow(/expired/i);
  });
});

// ---- observer attestation redeemer: List<Attestation>, AegisSelf = Constr 2 ----

describe("encodeObserverAttestations — byte-compatible with the Aiken List<Attestation> redeemer", () => {
  it("encodes Constr0[AegisSelf, feed policy bytes, Price(5 ints)] — cross-checked against lucid Data", () => {
    const feed = findLiveAegisFeed([feedUtxo(ADA_FEED_POLICY, ADA_DATUM_5KEY)], ADA_FEED_POLICY);
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
