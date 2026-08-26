// Moving a resting two-way order to a different stake credential, at new prices, in one spend.
//
// A bound order's prices are floored by its stake script, and that script's hash IS the address —
// so changing the floors means a different address. The naive route is close-then-recreate: burn
// three beacons, mint three more, and hand the inventory back through a wallet on the way.
//
// The dApp validator does not require that. `beacon_destination_check` asks only that a beacon
// output go to `ScriptCredential(dapp_hash)` with SOME staking credential — not the same one — and
// the owner path does not compare the continuation's datum to the input's. So this is a REPRICE
// WHOSE CONTINUATION MOVES HOUSE: one spend, no mint, value carried across untouched.
//
// The taker path is the one that pins both (`swap_output_value` requires an identical datum bar
// `prev_input`, at the same address). That asymmetry is deliberate and is what these tests protect:
// a change that made the owner path behave like the taker path would silently disable re-banding.
import { describe, expect, it } from "vitest";
import {
  planRebandTwoWaySwap,
  orderAddressFor,
  type CardanoSwapsDeployment,
} from "../../src/cardanoSwapsLifecycle.js";
import {
  decodeTwoWaySwapDatumHex,
  encodeTwoWaySwapDatumHex,
  SPEND_WITH_STAKE_HEX,
  UPDATE_SWAPS_HEX,
  type TwoWaySwapDatum,
} from "../../src/cardanoSwapsDatum.js";
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

/** The instance the market left, and the one built at today's prices. Different applied hashes
 *  because the floors differ — that is the whole reason a move is needed. */
const OLD_STAKE = { type: "script", hash: "d8".repeat(28) } as const;
const NEW_STAKE = { type: "script", hash: "3c".repeat(28) } as const;

/** The escape-hatch key. `maker_stake_bound.withdraw` short-circuits on this signer before it
 *  reaches the operator branch, so the whole move is the client's to make. */
const CLIENT_VKH = "ab".repeat(28);

const [A1_ASSET, A2_ASSET] = sortPair(ADA, TOK);
const BEACONS = {
  pair: pairBeacon(A1_ASSET!, A2_ASSET!),
  a1: assetBeacon(A1_ASSET!.policyId, A1_ASSET!.assetName),
  a2: assetBeacon(A2_ASSET!.policyId, A2_ASSET!.assetName),
};

const OLD_DATUM: TwoWaySwapDatum = {
  beaconId: deployment.beaconPolicy,
  pairBeacon: BEACONS.pair,
  asset1Id: A1_ASSET!.policyId,
  asset1Name: A1_ASSET!.assetName,
  asset1Beacon: BEACONS.a1,
  asset2Id: A2_ASSET!.policyId,
  asset2Name: A2_ASSET!.assetName,
  asset2Beacon: BEACONS.a2,
  asset1Price: { num: 5n, den: 13n },
  asset2Price: { num: 27n, den: 10n },
  prevInput: null,
  expiration: null,
};

const TOK_UNIT = TOK.policyId + TOK.assetName;

/** What the order is actually resting with: min-ADA, the client's tokens, and the three beacons. */
const SCRIPT_VALUE = {
  lovelace: 27_000_000n,
  assets: {
    [TOK_UNIT]: 120_000_000n,
    [deployment.beaconPolicy + BEACONS.pair]: 1n,
    [deployment.beaconPolicy + BEACONS.a1]: 1n,
    [deployment.beaconPolicy + BEACONS.a2]: 1n,
  },
};

const NEW_A1 = { num: 1n, den: 4n };
const NEW_A2 = { num: 41n, den: 10n };

function reband(over: Partial<Parameters<typeof planRebandTwoWaySwap>[0]> = {}) {
  return planRebandTwoWaySwap({
    deployment,
    order: {
      datum: OLD_DATUM,
      utxo: { txHash: "9f".repeat(32), outputIndex: 0 },
      scriptValue: SCRIPT_VALUE,
      address: orderAddressFor(deployment, OLD_STAKE),
    },
    fromStakeScriptHash: OLD_STAKE.hash,
    toStake: NEW_STAKE,
    newAsset1Price: NEW_A1,
    newAsset2Price: NEW_A2,
    clientOwnerVkh: CLIENT_VKH,
    // The common case, and the ONLY case the old hardcoded `0n` could express.
    fromRewardBalanceLovelace: 0n,
    ...over,
  });
}

describe("planRebandTwoWaySwap — where the inventory lands", () => {
  it("continues at the NEW instance's address", () => {
    expect(reband().outputs[0]!.addressBech32).toBe(orderAddressFor(deployment, NEW_STAKE));
  });

  it("does not leave it at the old one", () => {
    expect(reband().outputs[0]!.addressBech32).not.toBe(orderAddressFor(deployment, OLD_STAKE));
  });

  it("produces exactly one continuation and nothing else", () => {
    const r = reband();
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0]!.role).toBe("continuation");
  });
});

describe("planRebandTwoWaySwap — the value crosses untouched", () => {
  // The funds-safety property. Anything dropped here is a client's inventory left behind or burned.
  it("carries every asset across, beacons included", () => {
    const assets = reband().outputs[0]!.assets;
    expect(assets[TOK_UNIT]).toBe(120_000_000n);
    for (const n of [BEACONS.pair, BEACONS.a1, BEACONS.a2])
      expect(assets[deployment.beaconPolicy + n], `beacon ${n} must cross`).toBe(1n);
  });

  it("keeps at least the lovelace it was resting with", () => {
    expect(reband().outputs[0]!.assets.lovelace).toBeGreaterThanOrEqual(27_000_000n);
  });

  it("introduces no asset the order was not already holding", () => {
    const before = new Set(["lovelace", ...Object.keys(SCRIPT_VALUE.assets)]);
    for (const unit of Object.keys(reband().outputs[0]!.assets))
      expect(before.has(unit), `${unit} is not part of the order`).toBe(true);
  });

  // A close-and-recreate would burn three beacons and mint three more. That costs an extra
  // execution, and it routes the inventory through a wallet on the way — the thing this avoids.
  it("mints and burns nothing", () => {
    expect(reband().mints).toEqual([]);
  });
});

describe("planRebandTwoWaySwap — the datum changes only what it must", () => {
  it("moves both prices to the new floors", () => {
    const d = decodeTwoWaySwapDatumHex(reband().outputs[0]!.inlineDatumHex);
    expect(d.asset1Price).toEqual(NEW_A1);
    expect(d.asset2Price).toEqual(NEW_A2);
  });

  // Every one of these is checked by the beacon policy against the beacons in the value. A single
  // transposed field makes the output un-spendable by anyone, at phase 2, after the client signed.
  it("preserves every beacon and pair field verbatim", () => {
    const d = decodeTwoWaySwapDatumHex(reband().outputs[0]!.inlineDatumHex);
    const untouched = { ...OLD_DATUM, asset1Price: d.asset1Price, asset2Price: d.asset2Price, prevInput: d.prevInput };
    expect(d).toEqual(untouched);
  });

  it("keeps the expiration the order already carried", () => {
    const r = reband({
      order: {
        datum: { ...OLD_DATUM, expiration: 1_800_000_000_000n },
        utxo: { txHash: "ab".repeat(32), outputIndex: 3 },
        scriptValue: SCRIPT_VALUE,
        address: orderAddressFor(deployment, OLD_STAKE),
      },
    });
    expect(decodeTwoWaySwapDatumHex(r.outputs[0]!.inlineDatumHex).expiration).toBe(1_800_000_000_000n);
  });

  it("round-trips through the codec, so what is planned is what lands", () => {
    const hex = reband().outputs[0]!.inlineDatumHex;
    expect(encodeTwoWaySwapDatumHex(decodeTwoWaySwapDatumHex(hex))).toBe(hex);
  });
});

describe("planRebandTwoWaySwap — who authorises it", () => {
  it("spends the old order with SpendWithStake", () => {
    const r = reband();
    expect(r.spends).toHaveLength(1);
    expect(r.spends[0]!.redeemerHex).toBe(SPEND_WITH_STAKE_HEX);
  });

  // Two staking executions: the beacon policy (which the dApp validator demands for this redeemer)
  // and the OLD instance's own script, which is what actually gates the move.
  it("runs the beacon policy as a staking script", () => {
    expect(reband().withdrawals).toContainEqual({
      stakeScriptHash: deployment.beaconPolicy,
      redeemerHex: UPDATE_SWAPS_HEX,
      // The beacon policy is not a delegating credential and never accrues, so ITS withdrawal is
      // genuinely zero — but it has to SAY so. A recipe that omits the amount is not the same
      // recipe, and toContainEqual would have accepted one that did.
      amountLovelace: 0n,
    });
  });

  // THE CASE THIS TYPE CHANGE EXISTS FOR.
  //
  // Conway requires a withdrawal to drain the reward balance EXACTLY. Every builder here emitted
  // a hardcoded `0n`, which is right only while the credential has never delegated. The moment a
  // client delegates their own vault the balance goes non-zero ~4 epochs later, and from then on
  // their re-band builds cleanly, gets signed, and is refused by the node — because nothing in
  // the build path ever queries a reward account.
  //
  // So the planner must carry the REAL balance through to the withdrawal that spends the OLD
  // instance. Asserting 0n everywhere would re-enshrine the bug in a test.
  it("carries a NON-ZERO reward balance into the old instance's withdrawal", () => {
    const balance = 1_234_567n;
    const w = reband({ fromRewardBalanceLovelace: balance }).withdrawals;
    const old = w.find((x) => x.stakeScriptHash === OLD_STAKE.hash);
    expect(old, "the old instance's withdrawal must exist").toBeDefined();
    expect(old!.amountLovelace).toBe(balance);
    // ...and only that one. The beacon policy cannot accrue, so draining it would be a lie.
    const beacon = w.find((x) => x.stakeScriptHash === deployment.beaconPolicy);
    expect(beacon!.amountLovelace).toBe(0n);
  });

  it("runs the OLD instance's stake script, which is what approves the spend", () => {
    expect(reband().withdrawals.map((w) => w.stakeScriptHash)).toContain(OLD_STAKE.hash);
  });

  // THE TRUST PROPERTY. maker_stake_bound.withdraw is `or { client_sig, and { bot_sig, ... } }`, so
  // the client's key alone carries this. An operator key here would mean the client cannot leave
  // without us — the opposite of what the escape hatch is for.
  it("requires the client's key and no operator key", () => {
    const signers = reband().requiredSigners;
    expect(signers).toEqual([CLIENT_VKH]);
    expect(signers).not.toContain(deployment.adamBotPkh);
  });

  it("does not run the shared maker stake script", () => {
    expect(reband().withdrawals.map((w) => w.stakeScriptHash)).not.toContain(deployment.makerStakeHash);
  });

  it("references both deployed scripts rather than inlining them", () => {
    expect(reband().refInputs).toEqual(expect.arrayContaining([deployment.spendRefUtxo, deployment.beaconRefUtxo]));
  });
});

describe("planRebandTwoWaySwap — refusals, before anything is signed", () => {
  it("refuses a move that does not move", () => {
    expect(() => reband({ toStake: OLD_STAKE })).toThrow(/same|not a move|already/i);
  });

  for (const [name, price] of [
    ["newAsset1Price", { num: 0n, den: 1n }],
    ["newAsset2Price", { num: 1n, den: 0n }],
  ] as const)
    it(`refuses a non-positive ${name}`, () => {
      expect(() => reband({ [name]: price } as never)).toThrow(/> 0/);
    });

  it("refuses an order whose value carries no beacons", () => {
    expect(() =>
      reband({
        order: {
          datum: OLD_DATUM,
          utxo: { txHash: "ab".repeat(32), outputIndex: 0 },
          scriptValue: { lovelace: 27_000_000n, assets: { [TOK_UNIT]: 1n } },
          address: orderAddressFor(deployment, OLD_STAKE),
        },
      }),
    ).toThrow(/beacon/i);
  });

  it("refuses a client key that is not 28 bytes", () => {
    expect(() => reband({ clientOwnerVkh: "abcd" })).toThrow(/28|key hash/i);
  });
});
