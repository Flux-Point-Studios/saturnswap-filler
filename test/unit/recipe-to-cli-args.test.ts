// The seam between a planner's recipe and the cardano-cli invocation that submits it.
//
// Both sides have tests and both sides pass them; the PAIR is what breaks. The shell translator
// this replaces computed a withdrawal fragment into a variable and then never referenced it in the
// build command, so every withdrawal in a recipe was silently dropped. `SpendWithStake` requires
// the address's staking credential to approve via the withdrawals map, so the reprice and cancel
// paths could never have worked through it — only `create`, which has no withdrawal, was ever run.
//
// These tests exist because that failure is invisible from either side: the recipe is correct, the
// cli invocation is well-formed, and only the composition is wrong.
import { describe, expect, it } from "vitest";
import { recipeToCliArgs, type CliScriptSources } from "../../src/recipeToCliArgs.js";
import type { CardanoSwapsRecipe } from "../../src/cardanoSwapsLifecycle.js";
import { SPEND_WITH_STAKE_HEX, UPDATE_SWAPS_HEX } from "../../src/cardanoSwapsDatum.js";

const BEACON_POLICY = "8a199a17ef4517215945aaf3c8c5204c60fd94d34c46d341e99c8fcf";
const BOUND_HASH = "3227e1438302c680307273d6dc2e3261e4b60c364d5eb5b0cf7b0151";
const CLIENT_PKH = "559c89b84c94f8569039b74f54a3f7f6852a79aacf67e6cdf2b89823";
const DEST = "addr_test1xqge9z36cwm9akl3q04xhvek9cums7drdupgjl0nr3qfz7evdgpnguvc7cfg7sfv8s42x4kdvmwjhfhw535g79dpehhsdf8x8w";
const ORDER = { txHash: "9f".repeat(32), outputIndex: 0 };
const TOK = "0ff71ae2bdba25bb5e1805983c8e7924edfc77f808f4f8f6cc421ce44144414d4d4b54";

/** The two staking executions a re-band needs, and how each script is reached: the beacon policy
 *  from a deployed reference, the client's bound script from a local file. */
const sources: CliScriptSources = {
    [BEACON_POLICY]: {
        rewardAddress: "stake_test17z9pnxshaaz3wg2egk408jx9ypxxplv56dxyd56paxwglnce82j3g",
        refUtxo: { txHash: "70".repeat(32), outputIndex: 0 },
        plutusVersion: "v2",
    },
    [BOUND_HASH]: {
        rewardAddress: "stake_test17qez0c2rsvpvdqpswfeadhpwxfs7fdsvxex4addseaasz5g8z86ce",
        scriptFile: "/tmp/bound3227.plutus",
        plutusVersion: "v3",
    },
};

/** A re-band: one spend, one continuation, no mint, TWO withdrawals, the client as sole signer. */
const reband: CardanoSwapsRecipe = {
    action: "reprice",
    outputs: [
        {
            role: "continuation",
            addressBech32: DEST,
            assets: { lovelace: 5_000_000n, [TOK]: 4n, [BEACON_POLICY + "aa"]: 1n },
            inlineDatumHex: "d87980",
        },
    ],
    mints: [],
    withdrawals: [
        { stakeScriptHash: BEACON_POLICY, redeemerHex: UPDATE_SWAPS_HEX, amountLovelace: 0n },
        { stakeScriptHash: BOUND_HASH, redeemerHex: "d87980", amountLovelace: 0n },
    ],
    spends: [{ orderRef: ORDER, redeemerHex: SPEND_WITH_STAKE_HEX }],
    requiredSigners: [CLIENT_PKH],
    refInputs: [],
    validToUnixMs: null,
};

const build = (over: Partial<Parameters<typeof recipeToCliArgs>[0]> = {}) =>
    recipeToCliArgs({
        recipe: reband,
        sources,
        spendRefUtxo: { txHash: "04".repeat(32), outputIndex: 0 },
        changeAddress: "addr_test1vp2eezdcfj20s45s8xm5749r7lmg22ne4t8k0ekd72ufsgc7vj5pv",
        collateral: { txHash: "7e".repeat(32), outputIndex: 1 },
        fundingInputs: [{ txHash: "9f".repeat(32), outputIndex: 1 }],
        ...over,
    });

const argv = (o = {}) => build(o).args;
const joined = (o = {}) => argv(o).join(" ");

describe("recipeToCliArgs — the withdrawals actually reach the command line", () => {
    // THE REGRESSION. The shell translator dropped these. Everything else about it was fine.
    it("emits one --withdrawal per withdrawal in the recipe", () => {
        expect(joined().match(/--withdrawal(?![-\w])/g) ?? []).toHaveLength(2);
    });

    it("names each reward address, not the script hash", () => {
        const s = joined();
        expect(s).toContain(`${sources[BEACON_POLICY]!.rewardAddress}+0`);
        expect(s).toContain(`${sources[BOUND_HASH]!.rewardAddress}+0`);
    });

    it("withdraws the amount the RECIPE states, not a hardcoded zero", () => {
        // This test used to assert the opposite — "withdraws exactly zero" — which was true of the
        // code and false of the ledger. Conway drains the reward balance EXACTLY, so a hardcoded
        // zero is correct only while the credential has never delegated. cardano-cli is the
        // MANDATED rail for every transaction in this stack; if the amount does not reach argv, the
        // fix reaches the browser and misses the path that actually carries mainnet funds.
        for (const m of joined().matchAll(/--withdrawal (\S+)/g)) expect(m[1]).toMatch(/\+0$/);
    });

    it("REFUSES a reward address that names a different credential than the leg withdraws from", () => {
        // --withdrawal is what SELECTS which credential the ledger drains. This function took the
        // bech32 verbatim from caller-supplied sources and never checked it against
        // w.stakeScriptHash — while re-hashing a carried SCRIPT against that same hash two lines
        // later. One copy-paste in a per-client params file, or one stale entry after a re-band
        // moves a client to a new ceremony, and the command withdraws from one credential while
        // witnessing another: the order's real staking credential never appears in the withdrawals
        // map, staking_credential_approves fails, and the keeper's collateral is consumed by a
        // phase-2 failure whose error names neither credential.
        const wrongReward = "stake_test17qez0c2rsvpvdqpswfeadhpwxfs7fdsvxex4addseaasz5g8z86ce"; // decodes to BOUND_HASH
        expect(() =>
            build({
                recipe: { ...reband, withdrawals: [{ stakeScriptHash: BEACON_POLICY, redeemerHex: UPDATE_SWAPS_HEX, amountLovelace: 0n }] },
                sources: { [BEACON_POLICY]: { ...sources[BEACON_POLICY]!, rewardAddress: wrongReward } },
            }),
        ).toThrow(/reward address|does not name|different credential/i);
    });

    it("carries a NON-ZERO amount into argv", () => {
        const args = joined({
            recipe: { ...reband, withdrawals: [{ stakeScriptHash: BOUND_HASH, redeemerHex: "d87980", amountLovelace: 4_000_000n }] },
        });
        expect(args).toMatch(/--withdrawal \S+\+4000000\b/);
        expect(args).not.toMatch(/--withdrawal \S+\+0\b/);
    });

    // A script reached by reference and a script attached from a file take DIFFERENT flags. Getting
    // this wrong fails at build time with a redeemer-pointer error that names neither.
    it("reaches a deployed script by reference", () => {
        const s = joined();
        expect(s).toContain(`--withdrawal-tx-in-reference ${"70".repeat(32)}#0`);
        expect(s).toContain("--withdrawal-plutus-script-v2");
        expect(s).toMatch(/--withdrawal-reference-tx-in-redeemer-cbor-file \S+/);
    });

    it("attaches a local script from its file", () => {
        const s = joined();
        expect(s).toContain("--withdrawal-script-file /tmp/bound3227.plutus");
        expect(s).toMatch(/--withdrawal-redeemer-cbor-file \S+/);
        expect(s, "a file-attached script must not also be referenced").not.toContain(
            "--withdrawal-tx-in-reference /tmp/bound3227.plutus",
        );
    });

    it("refuses a withdrawal whose script it cannot reach", () => {
        expect(() => build({ sources: { [BEACON_POLICY]: sources[BEACON_POLICY]! } })).toThrow(/3227e143|cannot reach|no script source/i);
    });
});

describe("recipeToCliArgs — the rest of the shape", () => {
    it("spends the order by reference, with an inline datum and the recipe's redeemer", () => {
        const s = joined();
        expect(s).toContain(`--tx-in ${ORDER.txHash}#0`);
        expect(s).toContain(`--spending-tx-in-reference ${"04".repeat(32)}#0`);
        expect(s).toContain("--spending-reference-tx-in-inline-datum-present");
    });

    it("carries every asset of the continuation into the tx-out", () => {
        const s = joined();
        expect(s).toContain(`${DEST}+5000000`);
        expect(s).toContain(`4 ${TOK.slice(0, 56)}.${TOK.slice(56)}`);
        expect(s).toContain(`1 ${BEACON_POLICY}.aa`);
    });

    it("passes the required signers through", () => {
        expect(joined()).toContain(`--required-signer-hash ${CLIENT_PKH}`);
    });

    // A re-band mints nothing. An accidental --mint would make it a close-and-recreate.
    it("emits no mint when the recipe has none", () => {
        expect(joined()).not.toContain("--mint");
    });

    it("stages every redeemer and datum blob it references", () => {
        const { args, blobs } = build();
        for (const b of blobs) expect(args.join(" "), `${b.path} is written but never used`).toContain(b.path);
        for (const m of args.join(" ").matchAll(/--\S*cbor-file (\S+)/g))
            expect(blobs.map((b) => b.path), `${m[1]} is used but never written`).toContain(m[1]);
    });
});

/**
 * PARITY WITH A TRANSACTION THAT ACTUALLY LANDED.
 *
 * Preprod 289e0e8a0edda9906a01b2dbe0d7632abe4a4909098902e586ed678b5f1733b4 moved a bound two-way
 * order from ceremony 3227e143… to ceremony 2c6a0334… at new prices, in one spend, with no mint,
 * signed by the client alone. It was built by hand from the planner's SHAPE, which is precisely the
 * arrangement that lets a planner and its executor drift apart.
 *
 * So: run the real order through the planner, translate, and require every flag the landed
 * transaction used. Hand-written fixtures agree with whatever the code does; this one does not.
 */
describe("parity with the landed preprod re-band", () => {
    const LANDED = {
        order: { txHash: "9fe05064f2e4d78890b137337a230f71491dfade00058b2a1adeede6495c75c9", outputIndex: 0 },
        spendRef: { txHash: "048f6ce44e5ed450c11bad44c2e10d8fcd586697c6ddb5d0c59198fd04fb40f0", outputIndex: 0 },
        beaconRef: { txHash: "706be9f8bf1735a8f52aec9c745656a15398f8a33d6f2608197ea2a4de24aca9", outputIndex: 0 },
        beaconReward: "stake_test17z9pnxshaaz3wg2egk408jx9ypxxplv56dxyd56paxwglnce82j3g",
        boundReward: "stake_test17qez0c2rsvpvdqpswfeadhpwxfs7fdsvxex4addseaasz5g8z86ce",
        boundScript: "/tmp/bound3227.plutus",
        clientPkh: "559c89b84c94f8569039b74f54a3f7f6852a79aacf67e6cdf2b89823",
        dest: "addr_test1xqge9z36cwm9akl3q04xhvek9cums7drdupgjl0nr3qfz7evdgpnguvc7cfg7sfv8s42x4kdvmwjhfhw535g79dpehhsdf8x8w",
        client: "addr_test1vp2eezdcfj20s45s8xm5749r7lmg22ne4t8k0ekd72ufsgc7vj5pv",
    };

    const built = () =>
        recipeToCliArgs({
            recipe: {
                ...reband,
                spends: [{ orderRef: LANDED.order, redeemerHex: SPEND_WITH_STAKE_HEX }],
                outputs: [{ ...reband.outputs[0]!, addressBech32: LANDED.dest }],
                requiredSigners: [LANDED.clientPkh],
            },
            sources: {
                [BEACON_POLICY]: { rewardAddress: LANDED.beaconReward, refUtxo: LANDED.beaconRef, plutusVersion: "v2" },
                [BOUND_HASH]: { rewardAddress: LANDED.boundReward, scriptFile: LANDED.boundScript, plutusVersion: "v3" },
            },
            spendRefUtxo: LANDED.spendRef,
            changeAddress: LANDED.client,
            collateral: { txHash: "7e719ac995b983e1c43a2adfbf7ccb21d42c04e684ebe7ff66c335f93ba6a08e", outputIndex: 1 },
            fundingInputs: [{ txHash: LANDED.order.txHash, outputIndex: 1 }],
        }).args.join(" ");

    // Each of these appeared in the command that the node accepted.
    for (const [what, flag] of [
        ["spends the order", `--tx-in ${LANDED.order.txHash}#0`],
        ["through the deployed spend script", `--spending-tx-in-reference ${LANDED.spendRef.txHash}#0`],
        ["with the inline datum already present", "--spending-reference-tx-in-inline-datum-present"],
        ["runs the beacon policy as a staking script", `--withdrawal ${LANDED.beaconReward}+0`],
        ["by reference", `--withdrawal-tx-in-reference ${LANDED.beaconRef.txHash}#0`],
        ["runs the client's bound script", `--withdrawal ${LANDED.boundReward}+0`],
        ["attached from its file", `--withdrawal-script-file ${LANDED.boundScript}`],
        ["signed by the client", `--required-signer-hash ${LANDED.clientPkh}`],
        ["continuing at the new ceremony", `--tx-out ${LANDED.dest}+`],
        ["change to the client", `--change-address ${LANDED.client}`],
    ] as const)
        it(`${what}: ${flag.split(" ")[0]}`, () => expect(built()).toContain(flag));

    it("mints nothing, exactly as the landed transaction did", () => {
        expect(built()).not.toContain("--mint");
    });

    // The defect this whole file exists for: the shell translator emitted ZERO of these.
    it("emits BOTH withdrawals — the landed transaction needed both", () => {
        expect(built().match(/--withdrawal(?![-\w])/g) ?? []).toHaveLength(2);
    });
});

/**
 * A withdrawal leg that carries its own script.
 *
 * The keeper's own rail executor already carries the script and hashes what it carries, so
 * repointing that rail at this function would have been a REGRESSION. `scriptFile` names a path
 * nobody checks; `script` carries the bytes, and bytes can be checked against the credential they
 * claim to be.
 *
 * The preimage rule was settled by derivation against a real applied validator rather than reasoned
 * about, and the vector below reproduces it: blake2b-224 runs over `0x03 ‖ inner`, where `inner` is
 * the script with its CBOR bytestring header STRIPPED. Hashing the un-stripped envelope produces
 * something else entirely, which is the mistake this exists to prevent.
 */
describe("recipeToCliArgs — a carried withdrawal script is verified, not trusted", () => {
    /** An always-true PlutusV3 script and the credential it produces. */
    const CARRIED_SCRIPT = "5253010100322253330034a229309b2b2b9a01";
    const CARRIED_HASH = "bf6ac8c003b32b7e570d3d863f9b1813b98264ef1cb0f91d58f4bac7";
    // Derived FROM CARRIED_HASH, not pasted. This literal used to be BOUND_HASH's reward address
        // on a source keyed to CARRIED_HASH — a fixture that withdrew from one credential while
        // witnessing another, and 331 tests passed over it because nothing checked the selector.
        const CARRIED_REWARD = "stake_test17zlk4jxqqwejkljhp57cv0umrqfmnqnyauwtp7gatr6t43c4rc2cq";

    const carried = (cborHex = CARRIED_SCRIPT, plutusVersion: "v2" | "v3" = "v3") => ({
        recipe: {
            ...reband,
            withdrawals: [
                { stakeScriptHash: BEACON_POLICY, redeemerHex: UPDATE_SWAPS_HEX, amountLovelace: 0n },
                { stakeScriptHash: CARRIED_HASH, redeemerHex: "d87980", amountLovelace: 0n },
            ],
        },
        sources: {
            [BEACON_POLICY]: sources[BEACON_POLICY]!,
            [CARRIED_HASH]: { rewardAddress: CARRIED_REWARD, plutusVersion: "v3" as const, script: { plutusVersion, cborHex } },
        },
    });

    it("stages a cardano-cli text envelope and points the flag at it", () => {
        const { args, blobs } = build(carried());
        const at = args.indexOf("--withdrawal-script-file");
        expect(at).toBeGreaterThan(-1);
        const env = blobs.find((b) => b.path === args[at + 1]);
        expect(env?.envelope).toEqual({ type: "PlutusScriptV3", description: "", cborHex: CARRIED_SCRIPT });
        expect(env?.hex).toBeUndefined();
    });

    it("REFUSES a script that hashes to something other than the credential it withdraws from", () => {
        expect(() => build(carried("5253010100322253330034a229309b2b2b9a02"))).toThrow(/hashes to/i);
    });

    it("names both hashes, so the mismatch is diagnosable", () => {
        let message = "";
        try {
            build(carried(CARRIED_SCRIPT, "v2"));
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain(CARRIED_HASH);
        expect(message).toMatch(/a2c53654a7a19064d192d1cb7b2db83995f05b9e56219e7b0a36c73b/);
    });

    it("still reaches the beacon policy by REFERENCE in the same transaction", () => {
        const { args } = build(carried());
        expect(args.filter((a) => a === "--withdrawal")).toHaveLength(2);
        expect(args).toContain("--withdrawal-tx-in-reference");
        expect(args).toContain("--withdrawal-script-file");
    });

    it("emits the envelope as JSON text, never as raw bytes — cardano-cli reads a text envelope", () => {
        const { blobs } = build(carried());
        for (const b of blobs) expect(b.hex === undefined || b.envelope === undefined).toBe(true);
    });
});
