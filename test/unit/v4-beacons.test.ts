import { describe, it, expect } from "vitest";
import {
  pairBeaconName,
  offerBeaconName,
  askBeaconName,
  sortedPairBeaconName,
  compareAsset,
  sortPair,
} from "../../src/beaconsV4.js";

// TOKEN = policy aa*28, name "TEST" (54455354). These vectors are the SAME
// ones pinned in the on-chain Aiken suite (v4/lib/tests/beacons_test.ak),
// computed independently via python hashlib — so a match proves the TS and
// Aiken derivations agree byte-for-byte.
const TOKEN_POLICY = "aa".repeat(28);
const TOKEN_NAME = "54455354";

describe("V4 beacon derivation (cross-checked vs on-chain Aiken vectors)", () => {
  it("ADA sell -> TOKEN buy: pair beacon", () => {
    expect(pairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME)).toBe(
      "6a0e5c7a3d93bf8a089e2280ee60f45da11bd21ad71ff9d854674ba2d6dc8dd3",
    );
  });

  it("offer beacon of ADA = sha256(0x01)", () => {
    expect(offerBeaconName("", "")).toBe(
      "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
    );
  });

  it("ask beacon of TOKEN", () => {
    expect(askBeaconName(TOKEN_POLICY, TOKEN_NAME)).toBe(
      "b8da51c5f64327eb5ba34741c94ce95e2a246e76c3dc9fdf5f93085979769de8",
    );
  });

  it("TOKEN sell -> ADA buy: pair beacon (directional, differs from reverse)", () => {
    expect(pairBeaconName(TOKEN_POLICY, TOKEN_NAME, "", "")).toBe(
      "ee1f6c4c121da1bda2223b10f516bd736d0891929cdb7fcee1407b9fcbafa37e",
    );
  });

  it("offer beacon of TOKEN", () => {
    expect(offerBeaconName(TOKEN_POLICY, TOKEN_NAME)).toBe(
      "c31e159104d82d34b4c1fdee59dab7faecb9616d9929e1d5137deccf7d06dc73",
    );
  });

  it("ask beacon of ADA = sha256(0x02)", () => {
    expect(askBeaconName("", "")).toBe(
      "dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986",
    );
  });

  it("pair beacon is directional", () => {
    expect(pairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME)).not.toBe(
      pairBeaconName(TOKEN_POLICY, TOKEN_NAME, "", ""),
    );
  });

  it("two-way sorted-pair beacon is symmetric under sortPair", () => {
    const ada = { policyId: "", assetName: "" };
    const tok = { policyId: TOKEN_POLICY, assetName: TOKEN_NAME };
    const [a1, a2] = sortPair(tok, ada); // ADA must sort first
    expect(a1).toEqual(ada);
    expect(a2).toEqual(tok);
    const name = sortedPairBeaconName(a1.policyId, a1.assetName, a2.policyId, a2.assetName);
    // matches the one-way pair beacon of ADA->TOKEN because the byte preimage
    // is identical (0x00 ++ policy++name); the DISTINCTION is the policy id.
    expect(name).toBe("6a0e5c7a3d93bf8a089e2280ee60f45da11bd21ad71ff9d854674ba2d6dc8dd3");
  });

  it("compareAsset: ADA (empty policy) sorts first", () => {
    expect(compareAsset("", "", TOKEN_POLICY, TOKEN_NAME)).toBeLessThan(0);
    expect(compareAsset(TOKEN_POLICY, TOKEN_NAME, "", "")).toBeGreaterThan(0);
    expect(compareAsset(TOKEN_POLICY, TOKEN_NAME, TOKEN_POLICY, TOKEN_NAME)).toBe(0);
  });
});
