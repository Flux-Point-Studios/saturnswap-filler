import { describe, expect, it } from "vitest";
import {
  planCreateTwoWaySwap,
  orderAddressFor,
  type CardanoSwapsDeployment,
} from "../../src/cardanoSwapsLifecycle.js";
import { decodeTwoWaySwapDatumHex, CREATE_OR_CLOSE_SWAPS_HEX } from "../../src/cardanoSwapsDatum.js";
import { pairBeacon, assetBeacon, sortPair } from "../../src/cardanoSwapsBeacons.js";

const TOK = { policyId: "aa".repeat(28), assetName: "54455354" };
const ADA = { policyId: "", assetName: "" };

const deployment: CardanoSwapsDeployment = {
  network: "Mainnet",
  dappHash: "11928a3ac3b65edbf103ea6bb3362e39b879a36f02897df31c40917b",
  beaconPolicy: "8a199a17ef4517215945aaf3c8c5204c60fd94d34c46d341e99c8fcf",
  makerStakeHash: "cc".repeat(28),
  adamBotPkh: "01".repeat(28),
  spendRefUtxo: { txHash: "ab".repeat(32), outputIndex: 0 },
  beaconRefUtxo: { txHash: "cd".repeat(32), outputIndex: 1 },
};

/** A client's bound maker_stake_bound instance — a SCRIPT stake credential. */
const bound = { type: "script", hash: "d8295a05a5320e13a686a9d4fe2744559d1371e97d27e7e62e7468c8" } as const;

// The ceremony floors: asset1_price is token-per-lovelace (the BID ceiling),
// asset2_price is lovelace-per-token (the ASK floor). 2.6 / 2.7 ADA at 6 decimals.
const A1 = { num: 5n, den: 13n };
const A2 = { num: 27n, den: 10n };

function created(over: Partial<Parameters<typeof planCreateTwoWaySwap>[0]> = {}) {
  return planCreateTwoWaySwap({
    deployment,
    asset1: ADA,
    asset2: TOK,
    asset1Price: A1,
    asset2Price: A2,
    inventory: [{ ...TOK, amount: 4_000_000n }],
    stake: bound,
    ...over,
  });
}

describe("planCreateTwoWaySwap", () => {
  it("pays the bound order address, not the maker's", () => {
    expect(created().outputs[0]!.addressBech32).toBe(orderAddressFor(deployment, bound));
  });

  it("mints exactly the three two-way beacons, each once", () => {
    const [mint] = created().mints;
    expect(mint!.redeemerHex).toBe(CREATE_OR_CLOSE_SWAPS_HEX);
    const [a1, a2] = sortPair(ADA, TOK);
    const names = [
      pairBeacon(a1!, a2!),
      assetBeacon(a1!.policyId, a1!.assetName),
      assetBeacon(a2!.policyId, a2!.assetName),
    ].map((n) => deployment.beaconPolicy + n);
    expect(mint!.assets.map((a) => a.unit).sort()).toEqual(names.sort());
    expect(mint!.assets.every((a) => a.quantity === 1n)).toBe(true);
  });

  /* The one-way beacons are PREFIXED (0x01/0x02); the two-way asset beacons are
   * not. Using the one-way derivation here mints names the two-way policy refuses. */
  it("uses UNPREFIXED asset beacons, which is what makes them two-way", () => {
    const d = decodeTwoWaySwapDatumHex(created().outputs[0]!.inlineDatumHex!)!;
    expect(d.asset1Beacon).toBe(assetBeacon(ADA.policyId, ADA.assetName));
    expect(d.asset2Beacon).toBe(assetBeacon(TOK.policyId, TOK.assetName));
  });

  it("carries an inline 12-field datum naming the ceremony's beacon policy", () => {
    const d = decodeTwoWaySwapDatumHex(created().outputs[0]!.inlineDatumHex!)!;
    expect(d.beaconId).toBe(deployment.beaconPolicy);
    expect(d.asset1Price).toEqual(A1);
    expect(d.asset2Price).toEqual(A2);
    expect(d.prevInput).toBeNull();
  });

  /* maker_stake_bound's is_spendable_continuation_datum requires the pair SORTED,
   * and ADA (empty policy) sorts first — so asset1 is ADA and asset2 the token
   * however the caller passes them. */
  it("sorts the pair, so the caller cannot transpose the legs", () => {
    const swapped = created({ asset1: TOK, asset2: ADA, asset1Price: A2, asset2Price: A1 });
    const d = decodeTwoWaySwapDatumHex(swapped.outputs[0]!.inlineDatumHex!)!;
    expect(d.asset1Id).toBe("");
    expect(d.asset2Id).toBe(TOK.policyId);
    expect(d.asset1Price).toEqual(A1);
    expect(d.asset2Price).toEqual(A2);
  });

  it("puts the inventory and the beacons in the order output", () => {
    const out = created().outputs[0]!;
    expect(out.assets[TOK.policyId + TOK.assetName]).toBe(4_000_000n);
    expect(out.assets["lovelace"]).toBeGreaterThan(0n);
  });

  it("reads the beacon reference script and spends nothing", () => {
    const r = created();
    expect(r.refInputs).toEqual([deployment.beaconRefUtxo]);
    expect(r.spends).toEqual([]);
    /* verify_create_body.py hard-refuses a body carrying certificates or
     * withdrawals, so a combined register+create breaks the client's own gate. */
    expect(r.withdrawals).toEqual([]);
  });

  it("refuses a non-positive price rather than resting a free round-trip", () => {
    expect(() => created({ asset1Price: { num: 0n, den: 1n } })).toThrow(/price/i);
    expect(() => created({ asset2Price: { num: 1n, den: 0n } })).toThrow(/price/i);
  });

  it("refuses a pair whose legs are the same asset", () => {
    expect(() => created({ asset1: TOK, asset2: TOK })).toThrow(/differ/i);
  });
});
