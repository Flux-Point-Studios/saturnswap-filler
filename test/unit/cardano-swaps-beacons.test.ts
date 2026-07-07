import { describe, it, expect } from "vitest";
import {
  pairBeacon,
  offerBeacon,
  askBeacon,
  assetBeacon,
  compareAsset,
  sortPair,
} from "../../src/cardanoSwapsBeacons.js";

const AA = "aa".repeat(28);
const NM = "54455354"; // "TEST"

// Golden vectors computed directly from the canonical cardano-swaps Aiken
// derivations (one_way_swap/utils.ak generate_pair_beacon / generate_offer_beacon /
// generate_ask_beacon, two_way_swap/utils.ak generate_asset_beacon).
describe("canonical cardano-swaps beacon derivation", () => {
  it("one-way pair beacon = sha256(offer_id_or00 ++ offer_name ++ ask_id_or00 ++ ask_name)", () => {
    expect(pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM })).toBe(
      "6a0e5c7a3d93bf8a089e2280ee60f45da11bd21ad71ff9d854674ba2d6dc8dd3",
    );
  });

  it("one-way offer beacon is 0x01-prefixed sha256", () => {
    expect(offerBeacon("", "")).toBe(
      "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
    );
  });

  it("one-way ask beacon is 0x02-prefixed sha256", () => {
    expect(askBeacon(AA, NM)).toBe(
      "b8da51c5f64327eb5ba34741c94ce95e2a246e76c3dc9fdf5f93085979769de8",
    );
  });

  it("two-way asset beacon is UNPREFIXED sha256(policy ++ name) — distinct from one-way beacons", () => {
    expect(assetBeacon(AA, NM)).toBe(
      "b00d9d765d37e32dc8b389824c0b5dd4703e7f93cb53f4e1488dbc844a11e7f2",
    );
    expect(assetBeacon("", "")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(assetBeacon(AA, NM)).not.toBe(offerBeacon(AA, NM));
    expect(assetBeacon(AA, NM)).not.toBe(askBeacon(AA, NM));
  });

  it("one-way pair beacon is directional (offer->ask differs from ask->offer)", () => {
    expect(pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM })).not.toBe(
      pairBeacon({ policyId: AA, assetName: NM }, { policyId: "", assetName: "" }),
    );
  });

  it("sortPair sorts ADA (empty policy) before a token; compareAsset agrees", () => {
    const [a1, a2] = sortPair({ policyId: AA, assetName: NM }, { policyId: "", assetName: "" });
    expect(a1.policyId).toBe("");
    expect(a2.policyId).toBe(AA);
    expect(compareAsset("", "", AA, NM)).toBeLessThan(0);
    expect(compareAsset(AA, NM, "", "")).toBeGreaterThan(0);
  });

  it("two-way pair beacon (sorted ADA<TOKEN) equals the sorted-order pair hash", () => {
    const [a1, a2] = sortPair({ policyId: AA, assetName: NM }, { policyId: "", assetName: "" });
    expect(pairBeacon(a1, a2)).toBe(
      "6a0e5c7a3d93bf8a089e2280ee60f45da11bd21ad71ff9d854674ba2d6dc8dd3",
    );
  });
});
