// A withdrawal the transaction cannot actually execute.
//
// `assembleCardanoSwapsTx` calls `tx.withdraw(rewardAddr, 0n, redeemer)` for every withdrawal in a
// recipe, but a staking SCRIPT only runs if its code is in the transaction — as a reference input,
// or attached to the witness set. Nothing checked that. A recipe naming a credential the assembler
// could not reach produced a build that fails with MISSING_SCRIPT, or, worse, a plausible-looking
// transaction the client is asked to sign.
//
// This is the browser twin of the defect `recipeToCliArgs` closed on the CLI side, where a computed
// withdrawal fragment was never referenced in the command. Two executors, one recipe, and the
// composition is the only place either could be wrong.
//
// It matters right now because the re-band is the FIRST recipe whose withdrawal is a CLIENT'S OWN
// applied validator: there is no published reference script for it and there never will be — a
// ceremony's script is unique to that client's band.
import { describe, expect, it } from "vitest";
import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import {
  assembleCardanoSwapsTx,
  planRebandTwoWaySwap,
  orderAddressFor,
  BOUND_STAKE_REDEEMER_HEX,
  type CardanoSwapsDeployment,
} from "../../src/cardanoSwapsLifecycle.js";
import { UPDATE_SWAPS_HEX, type TwoWaySwapDatum } from "../../src/cardanoSwapsDatum.js";
import { pairBeacon, assetBeacon, sortPair } from "../../src/cardanoSwapsBeacons.js";

/**
 * An always-true PlutusV3 script and its hash, derived by the LEDGER's rule — blake2b-224 over
 * (0x03 ‖ script bytes) — not by the function under test. The two agree for this script because it
 * is already double-CBOR-encoded; `SINGLE_ENCODED` below is the case where they do not.
 */
const V3_SCRIPT = "5253010100322253330034a229309b2b2b9a01";
const V3_HASH = "bf6ac8c003b32b7e570d3d863f9b1813b98264ef1cb0f91d58f4bac7";

/** The same program, one CBOR layer shallower. Lucid normalises before hashing, so this is the
 *  same credential to the ledger — and a hand-rolled blake2b over the raw bytes would refuse it. */
const SINGLE_ENCODED = "53010100322253330034a229309b2b2b9a01";

const TOK = { policyId: "aa".repeat(28), assetName: "54455354" };
const ADA = { policyId: "", assetName: "" };
const CLIENT_VKH = "ab".repeat(28);

const deployment: CardanoSwapsDeployment = {
  network: "Mainnet",
  dappHash: "11928a3ac3b65edbf103ea6bb3362e39b879a36f02897df31c40917b",
  beaconPolicy: "8a199a17ef4517215945aaf3c8c5204c60fd94d34c46d341e99c8fcf",
  makerStakeHash: "cc".repeat(28),
  adamBotPkh: "01".repeat(28),
  spendRefUtxo: { txHash: "ab".repeat(32), outputIndex: 0 },
  beaconRefUtxo: { txHash: "cd".repeat(32), outputIndex: 1 },
};

const [A1, A2] = sortPair(ADA, TOK);
const B = {
  pair: pairBeacon(A1!, A2!),
  a1: assetBeacon(A1!.policyId, A1!.assetName),
  a2: assetBeacon(A2!.policyId, A2!.assetName),
};
const DATUM: TwoWaySwapDatum = {
  beaconId: deployment.beaconPolicy,
  pairBeacon: B.pair,
  asset1Id: A1!.policyId,
  asset1Name: A1!.assetName,
  asset1Beacon: B.a1,
  asset2Id: A2!.policyId,
  asset2Name: A2!.assetName,
  asset2Beacon: B.a2,
  asset1Price: { num: 5n, den: 13n },
  asset2Price: { num: 27n, den: 10n },
  prevInput: null,
  expiration: null,
};
const ORDER_REF = { txHash: "9f".repeat(32), outputIndex: 0 };
const SCRIPT_VALUE = {
  lovelace: 27_000_000n,
  assets: {
    [TOK.policyId + TOK.assetName]: 120_000_000n,
    [deployment.beaconPolicy + B.pair]: 1n,
    [deployment.beaconPolicy + B.a1]: 1n,
    [deployment.beaconPolicy + B.a2]: 1n,
  },
};

/** The credential the order rests at today — the client's applied bound validator. */
const FROM_HASH = V3_HASH;
const TO_STAKE = { type: "script", hash: "3c".repeat(28) } as const;

function rebandRecipe() {
  return planRebandTwoWaySwap({
    deployment,
    order: {
      datum: DATUM,
      utxo: ORDER_REF,
      scriptValue: SCRIPT_VALUE,
      address: orderAddressFor(deployment, { type: "script", hash: FROM_HASH }),
    },
    fromStakeScriptHash: FROM_HASH,
    toStake: TO_STAKE,
    newAsset1Price: { num: 1n, den: 4n },
    newAsset2Price: { num: 41n, den: 10n },
    clientOwnerVkh: CLIENT_VKH,
    fromRewardBalanceLovelace: 0n,
  });
}

/** Every builder call, in order, so a test can assert an attach happened BEFORE the withdraw. */
interface Recorder {
  calls: Array<{ method: string; args: unknown[] }>;
}

function mockLucid(rec: Recorder): LucidEvolution {
  const b: Record<string, unknown> = {};
  const note =
    (method: string) =>
    (...args: unknown[]) => {
      rec.calls.push({ method, args });
      return b;
    };
  Object.assign(b, {
    collectFrom: note("collectFrom"),
    readFrom: note("readFrom"),
    mintAssets: note("mintAssets"),
    withdraw: note("withdraw"),
    addSignerKey: note("addSignerKey"),
    validTo: note("validTo"),
  });
  b.pay = { ToAddress: note("pay.ToAddress"), ToAddressWithData: note("pay.ToAddressWithData") };
  b.attach = {
    WithdrawalValidator: note("attach.WithdrawalValidator"),
    SpendingValidator: note("attach.SpendingValidator"),
    MintingPolicy: note("attach.MintingPolicy"),
  };
  b.complete = async () => {
    rec.calls.push({ method: "complete", args: [] });
    return { toCBOR: () => "00", toHash: () => "ff".repeat(32) };
  };
  const utxo = (ref: { txHash: string; outputIndex: number }): UTxO =>
    ({
      txHash: ref.txHash,
      outputIndex: ref.outputIndex,
      address: "addr1_stub",
      assets: { lovelace: 5_000_000n },
      datum: null,
    }) as unknown as UTxO;
  return {
    utxosByOutRef: async (refs: Array<{ txHash: string; outputIndex: number }>) => refs.map(utxo),
    selectWallet: { fromAddress: () => {} },
    newTx: () => b,
  } as unknown as LucidEvolution;
}

const CHANGE = "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv";
const collateral = { txHash: "ee".repeat(32), outputIndex: 0, address: CHANGE, assets: { lovelace: 10_000_000n } } as UTxO;

function assemble(over: Record<string, unknown> = {}, rec: Recorder = { calls: [] }) {
  return assembleCardanoSwapsTx({
    lucid: mockLucid(rec),
    deployment,
    recipe: rebandRecipe(),
    changeAddress: CHANGE,
    collateralUtxo: collateral,
    fundingUtxos: [],
    ...over,
  } as Parameters<typeof assembleCardanoSwapsTx>[0]);
}

describe("assembleCardanoSwapsTx — a withdrawal must be reachable", () => {
  it("REFUSES a withdrawal whose script is neither attached nor referenced", async () => {
    // The original defect, in its browser form. Without this the build either dies inside lucid
    // with MISSING_SCRIPT, or produces a transaction the ledger refuses after the client has signed.
    await expect(assemble()).rejects.toThrow(new RegExp(FROM_HASH));
  });

  it("names what to do about it, not just that it failed", async () => {
    await expect(assemble()).rejects.toThrow(/attach|reference/i);
  });

  it("builds once the client's own validator is supplied", async () => {
    const rec: Recorder = { calls: [] };
    await expect(
      assemble({ withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV3", script: V3_SCRIPT } } } }, rec),
    ).resolves.toMatchObject({ txHash: "ff".repeat(32) });
    expect(rec.calls.some((c) => c.method === "complete")).toBe(true);
  });

  it("accepts the same program single-CBOR-encoded — lucid normalises, and so must the check", async () => {
    // A hand-rolled blake2b over the raw bytes would refuse this, and the refusal would be about a
    // credential the ledger considers identical.
    await expect(
      assemble({ withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV3", script: SINGLE_ENCODED } } } }),
    ).resolves.toBeDefined();
  });
});

describe("assembleCardanoSwapsTx — the attached script must BE the credential", () => {
  it("refuses a script that hashes to something else", async () => {
    await expect(
      assemble({
        withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV2", script: V3_SCRIPT } } },
      }),
    ).rejects.toThrow(/hashes to/i);
  });

  it("says both hashes, so the mismatch is diagnosable", async () => {
    const err = await assemble({
      withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV2", script: V3_SCRIPT } } },
    }).catch((e: Error) => e.message);
    expect(err).toContain(FROM_HASH);
    expect(err).toMatch(/a2c53654a7a19064d192d1cb7b2db83995f05b9e56219e7b0a36c73b/);
  });
});

describe("assembleCardanoSwapsTx — attach precedes withdraw", () => {
  it("attaches the validator BEFORE the withdrawal that needs it", async () => {
    // Lucid resolves a script witness out of a map keyed by hash at the moment the withdrawal is
    // processed. The registration certificate hit exactly this and failed with MISSING_SCRIPT.
    const rec: Recorder = { calls: [] };
    await assemble({ withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV3", script: V3_SCRIPT } } } }, rec);
    const attachAt = rec.calls.findIndex((c) => c.method === "attach.WithdrawalValidator");
    const withdrawAt = rec.calls.findIndex(
      (c) => c.method === "withdraw" && c.args[2] === BOUND_STAKE_REDEEMER_HEX,
    );
    expect(attachAt).toBeGreaterThanOrEqual(0);
    expect(withdrawAt).toBeGreaterThanOrEqual(0);
    expect(attachAt).toBeLessThan(withdrawAt);
  });

  it("still executes BOTH withdrawals — the beacon policy and the client's credential", async () => {
    // Losing either one is a phase-2 failure. `recipeToCliArgs` had the same pair of defects: drop
    // them all, or take only the first.
    const rec: Recorder = { calls: [] };
    await assemble({ withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV3", script: V3_SCRIPT } } } }, rec);
    const redeemers = rec.calls.filter((c) => c.method === "withdraw").map((c) => c.args[2]);
    expect(redeemers).toHaveLength(2);
    expect(redeemers).toContain(UPDATE_SWAPS_HEX);
    expect(redeemers).toContain(BOUND_STAKE_REDEEMER_HEX);
  });

  it("attaches only the client's validator — the beacon policy comes from its reference input", async () => {
    const rec: Recorder = { calls: [] };
    await assemble({ withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV3", script: V3_SCRIPT } } } }, rec);
    expect(rec.calls.filter((c) => c.method === "attach.WithdrawalValidator")).toHaveLength(1);
  });
});

describe("assembleCardanoSwapsTx — a reference source must actually be read", () => {
  it("refuses a refUtxo the recipe never lists as a reference input", async () => {
    // `readFrom` is the only thing that puts a reference input in the transaction. A source naming
    // a UTxO outside `recipe.refInputs` is a script the built transaction does not carry.
    await expect(
      assemble({
        withdrawalScripts: { [FROM_HASH]: { refUtxo: { txHash: "12".repeat(32), outputIndex: 7 } } },
      }),
    ).rejects.toThrow(/reference input/i);
  });

  it("accepts a refUtxo the recipe does list", async () => {
    await expect(assemble({ withdrawalScripts: { [FROM_HASH]: { refUtxo: deployment.beaconRefUtxo } } })).resolves.toBeDefined();
  });
});

describe("assembleCardanoSwapsTx — the deployment's own scripts still resolve", () => {
  it("needs no caller-supplied source for the beacon policy", async () => {
    // The beacon policy is reached through `deployment.beaconRefUtxo`, which every recipe already
    // lists. Requiring callers to restate it would be a gate that refuses the working path.
    const rec: Recorder = { calls: [] };
    await assemble({ withdrawalScripts: { [FROM_HASH]: { script: { type: "PlutusV3", script: V3_SCRIPT } } } }, rec);
    expect(rec.calls.some((c) => c.method === "withdraw" && c.args[2] === UPDATE_SWAPS_HEX)).toBe(true);
  });

  it("refuses maker_stake when the deployment publishes no reference for it", async () => {
    // A latent one: `makerStakeRefUtxo` is optional, the comment says an unset one falls back to
    // "an inline attach", and no code has ever attached anything. Cancel and reprice through this
    // assembler would have built a withdrawal lucid cannot witness.
    const recipe = rebandRecipe();
    recipe.withdrawals = [{ stakeScriptHash: deployment.makerStakeHash, redeemerHex: "d87980", amountLovelace: 0n }];
    await expect(assemble({ recipe })).rejects.toThrow(new RegExp(deployment.makerStakeHash));
  });

  it("accepts maker_stake when the deployment DOES publish one", async () => {
    const recipe = rebandRecipe();
    recipe.withdrawals = [{ stakeScriptHash: deployment.makerStakeHash, redeemerHex: "d87980", amountLovelace: 0n }];
    const withRef = { ...deployment, makerStakeRefUtxo: deployment.beaconRefUtxo };
    recipe.refInputs = [deployment.spendRefUtxo, deployment.beaconRefUtxo];
    await expect(assemble({ recipe, deployment: withRef })).resolves.toBeDefined();
  });
});
