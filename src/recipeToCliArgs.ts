/**
 * A CardanoSwapsRecipe, translated into the cardano-cli arguments that submit it.
 *
 * This is a SEAM: the planner and the CLI invocation each look correct on their own, and only the
 * composition can be wrong. The shell translator this replaces computed a withdrawal fragment into
 * a variable and then never referenced it in the build command, so every withdrawal in a recipe was
 * dropped. `SpendWithStake` requires the address's staking credential to approve via the
 * withdrawals map, so the reprice and cancel paths could not have worked through it — only
 * `create`, which has no withdrawal, was ever exercised.
 *
 * Being a pure function of the recipe is the point: what the tests assert is exactly what runs.
 */

import { validatorToScriptHash } from "@lucid-evolution/lucid";
import type { OutputRef } from "./datum.js";
import type { CardanoSwapsRecipe } from "./cardanoSwapsLifecycle.js";

/** How a staking script is reached: a deployed reference, a local file, or the bytes themselves. */
export interface CliScriptSource {
  /** the reward address the withdrawal names — a script hash is not an address */
  rewardAddress: string;
  refUtxo?: OutputRef;
  /** a path this function does not open and therefore cannot check. Prefer `script`. */
  scriptFile?: string;
  /**
   * The script itself, which is the only form that can be VERIFIED. A carried witness is safe to
   * use only once it has been re-hashed against the credential the leg withdraws from — otherwise
   * the mismatch surfaces as a redeemer-pointer error from the node, after the build.
   */
  script?: { plutusVersion: "v2" | "v3"; cborHex: string };
  plutusVersion: "v2" | "v3";
}

/** Keyed by stake script hash, as the recipe's withdrawals name them. */
export type CliScriptSources = Record<string, CliScriptSource>;

export interface RecipeToCliArgsInput {
  recipe: CardanoSwapsRecipe;
  sources: CliScriptSources;
  /** the dApp spend validator's deployed reference — every order input is spent through it */
  spendRefUtxo: OutputRef;
  changeAddress: string;
  collateral: OutputRef;
  fundingInputs?: OutputRef[];
  /** where staged redeemer/datum blobs land; the container path, not the host's */
  blobDir?: string;
}

/**
 * A file the command references and the caller must write before invoking. Exactly one of `hex`
 * (raw bytes — redeemers and datums) or `envelope` (a cardano-cli text envelope — an attached
 * script) is set: cardano-cli reads the two differently, and writing an envelope as bytes produces
 * a file it refuses with a message about the wrong thing.
 */
export interface CliBlob {
  path: string;
  hex?: string;
  envelope?: { type: string; description: string; cborHex: string };
}

export interface RecipeCliArgs {
  args: string[];
  blobs: CliBlob[];
}

const ref = (r: OutputRef) => `${r.txHash}#${r.outputIndex}`;

/** `lovelace + n policy.name` in the shape --tx-out expects. */
function valueOf(assets: Record<string, bigint | string>): string {
  const parts: string[] = [String(assets.lovelace ?? 0n)];
  for (const [unit, qty] of Object.entries(assets)) {
    if (unit === "lovelace") continue;
    parts.push(`${qty} ${unit.slice(0, 56)}.${unit.slice(56)}`);
  }
  return parts.join(" + ");
}

export function recipeToCliArgs(input: RecipeToCliArgsInput): RecipeCliArgs {
  const { recipe, sources } = input;
  const dir = input.blobDir ?? "/tmp";
  const blobs: CliBlob[] = [];
  const args: string[] = [];
  const stage = (name: string, hex: string) => {
    const path = `${dir}/${name}.cbor`;
    blobs.push({ path, hex });
    return path;
  };
  const stageScript = (name: string, script: { plutusVersion: "v2" | "v3"; cborHex: string }) => {
    const path = `${dir}/${name}.plutus`;
    blobs.push({
      path,
      envelope: { type: script.plutusVersion === "v3" ? "PlutusScriptV3" : "PlutusScriptV2", description: "", cborHex: script.cborHex },
    });
    return path;
  };

  recipe.spends.forEach((s, i) => {
    args.push(
      "--tx-in", ref(s.orderRef),
      "--spending-tx-in-reference", ref(input.spendRefUtxo),
      "--spending-plutus-script-v2",
      "--spending-reference-tx-in-inline-datum-present",
      "--spending-reference-tx-in-redeemer-cbor-file", stage(`r_spend_${i}`, s.redeemerHex),
    );
  });

  for (const f of input.fundingInputs ?? []) args.push("--tx-in", ref(f));
  args.push("--tx-in-collateral", ref(input.collateral));

  recipe.mints.forEach((g, i) => {
    const policy = g.assets[0]?.unit.slice(0, 56);
    if (!policy) return;
    const value = g.assets.map((a) => `${a.quantity} ${a.unit.slice(0, 56)}.${a.unit.slice(56)}`).join(" + ");
    args.push(
      "--mint", value,
      "--mint-plutus-script-v2",
      "--mint-reference-tx-in-redeemer-cbor-file", stage(`r_mint_${i}`, g.redeemerHex),
      "--policy-id", policy,
    );
  });

  // Every withdrawal, not the first. A re-band runs TWO staking scripts — the beacon policy and the
  // client's own bound credential — and dropping either fails validation with an error that names
  // neither.
  recipe.withdrawals.forEach((w, i) => {
    const src = sources[w.stakeScriptHash];
    if (!src)
      throw new Error(
        `no script source for withdrawal ${w.stakeScriptHash} — cannot reach it by reference or by file, ` +
          `so the transaction would be built without a staking execution the validator requires`,
      );
    const redeemer = stage(`r_wdl_${i}`, w.redeemerHex);
    args.push("--withdrawal", `${src.rewardAddress}+0`);
    if (src.refUtxo) {
      args.push(
        "--withdrawal-tx-in-reference", ref(src.refUtxo),
        `--withdrawal-plutus-script-${src.plutusVersion}`,
        "--withdrawal-reference-tx-in-redeemer-cbor-file", redeemer,
      );
    } else if (src.script) {
      // Recomputing the credential is what makes a carried witness safe to use at all. lucid's hash
      // agrees with the ledger's rule on a real ceremony envelope — the preimage is the STRIPPED
      // inner script, not the CBOR envelope, and the two differ.
      const derived = validatorToScriptHash({
        type: src.script.plutusVersion === "v3" ? "PlutusV3" : "PlutusV2",
        script: src.script.cborHex,
      });
      if (derived !== w.stakeScriptHash)
        throw new Error(
          `the script carried for withdrawal ${w.stakeScriptHash} hashes to ${derived}, so it would witness a ` +
            `different credential. Nothing was built.`,
        );
      args.push("--withdrawal-script-file", stageScript(`r_wdlscript_${i}`, src.script), "--withdrawal-redeemer-cbor-file", redeemer);
    } else if (src.scriptFile) {
      args.push("--withdrawal-script-file", src.scriptFile, "--withdrawal-redeemer-cbor-file", redeemer);
    } else {
      throw new Error(`script source for ${w.stakeScriptHash} names neither a refUtxo, a script, nor a scriptFile`);
    }
  });

  recipe.outputs.forEach((o, i) => {
    args.push("--tx-out", `${o.addressBech32}+${valueOf(o.assets as Record<string, bigint>)}`);
    if (o.inlineDatumHex) args.push("--tx-out-inline-datum-cbor-file", stage(`r_dat_${i}`, o.inlineDatumHex));
  });

  for (const s of recipe.requiredSigners) args.push("--required-signer-hash", s);
  args.push("--change-address", input.changeAddress);

  return { args, blobs };
}
