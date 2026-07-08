// Insured swap (tx-cart) — compose a canonical cardano-swaps fill (PlutusV2)
// and an Aegis Underwrite (PlutusV3) into ONE tx, ONE signature, with NO Conway
// `treasury_donation` (CDDL key 22).  Option C §5.4.
//
// WHY key 22 must be absent: the Conway ledger builds a separate script context
// per Plutus version. PlutusV2's TxInfo has no field for treasury_donation, so
// the mere presence of key 22 in the body fails the V2 context build and every
// V2 script fails phase-2 (TreasuryDonationFieldNotSupported). Aegis V7 keeps
// treasury_share_bps = 2500 but its donation_ok accepts an ABSENT key-22 (the
// CONDITIONAL donation), so the composable path owes no tx-level donation and
// this assembler emits none — the V2 swap fill and the V3 underwrite then each
// validate against their own context. The treasury cut settles later via the
// SDK's key-witnessed sweep path, never inside a composed tx.
//
// COMPOSE, DON'T COUPLE: nothing on chain links the two legs. The Aegis policy
// is bound to the POOL UTxO (derivePolicyId keys off the pool OutputReference),
// never to the swap order, its datum, or its output. The two validators never
// read each other's UTxOs; they share only (a) the same tx and (b) the same
// signer. `legsShareOnlyTx` proves the absence of any cross-referencing datum /
// redeemer, so there is no double-satisfaction vector between the legs.
//
// The coverage params (coverageLovelace = f(swap output), strike/premium from
// the quote) are set at BUILD time when `buildUnderwriteParts` is called; this
// assembler only splices the already-built legs. If the pool rotation is not
// yet live, use `assembleCoverageOnly` for the 2-tx fallback (fill in tx A,
// standalone coverage in tx B).

import type { OutputRef } from "./datum.js";
import { unit } from "./discovery.js";
import type { PlutusVersion } from "./contract.js";
import type { CardanoSwapsComposableResult, ComposableFill } from "./cardanoSwapsFill.js";
import { MAX_FEED_AGE_MS } from "./aegisFeed.js";

// ---------------------------------------------------------------------------
// Structural mirror of aegis-sdk `buildUnderwriteParts` output — the exact
// fields this assembler splices. Kept as a local interface so saturnswap-filler
// stays dependency-free (its package.json ethos); the shape is byte-for-byte the
// aegis-sdk `UnderwriteParts`.
// ---------------------------------------------------------------------------

export interface AegisRefUtxo {
  txHash: string;
  index: number;
}
export interface AegisAsset {
  policyId: string;
  assetNameHex: string;
  quantity: bigint;
}
export interface AegisScriptOutput {
  address: string;
  lovelace: bigint;
  inlineDatumCbor: string;
}
export interface AegisPolicyOutput extends AegisScriptOutput {
  marker: AegisAsset;
}
export interface AegisPoolOutput extends AegisScriptOutput {
  poolNft: AegisAsset;
}
export interface AegisFeeOutput {
  address: string;
  lovelace: bigint;
}
export interface AegisMintPart {
  policyId: string;
  assetNameHex: string;
  quantity: bigint;
  redeemerCbor: string;
}

/** The subset of aegis-sdk `UnderwriteParts` the tx-cart needs. */
export interface UnderwriteParts {
  policyOutput: AegisPolicyOutput;
  poolOutput: AegisPoolOutput;
  teamOutput: AegisFeeOutput;
  partnerOutput: AegisFeeOutput | null;
  mint: AegisMintPart;
  poolRedeemerCbor: string;
  /** MUST be 0n post-rotation. The assembler refuses to place a Conway key-22
   *  field; a non-zero value here means the SDK was not rotated and the tx would
   *  fail phase-2 for the V2 leg. */
  treasuryDonationLovelace: bigint;
  poolInput: AegisRefUtxo;
  references: { poolValidator: AegisRefUtxo | null; marker: AegisRefUtxo | null; oracleRequired: boolean };
  validity: { startTimeMs: bigint; expiryTimeMs: bigint };
}

// ---------------------------------------------------------------------------
// The assembled plan (a venue-agnostic tx descriptor; a Lucid/cardano-cli
// builder turns it into a signed tx).
// ---------------------------------------------------------------------------

export interface PlanSpend {
  role: "cardano-swaps-fill" | "aegis-underwrite";
  input: OutputRef;
  redeemerCbor: string;
  plutusVersion: PlutusVersion;
}

export interface PlanOutput {
  role: "swap-continuation" | "aegis-policy" | "aegis-pool" | "aegis-team" | "aegis-partner";
  address: string;
  value: Record<string, bigint>;
  datumCbor?: string;
}

export interface PlanMint {
  policyId: string;
  assetNameHex: string;
  quantity: bigint;
  redeemerCbor: string;
}

/** A 0-lovelace staking-script withdrawal (the withdraw-0 trick). */
export interface PlanWithdrawal {
  scriptHash: string;
  redeemerCbor: string;
}

/** The oracle leg a Barrier-class underwrite must carry: the live AegisSelf
 *  feed as a read-only reference input plus the oracle_observer's withdraw-0
 *  attestation. Build the redeemer with `encodeObserverAttestations` from the
 *  reading returned by `findLiveAegisFeed`. */
export interface OracleAttestationLeg {
  /** The LIVE feed UTxO — rotates every publish; discover at build time. */
  feedRefUtxo: OutputRef;
  observerScriptHash: string;
  /** The observer's CIP-33 ref-script UTxO. */
  observerRefUtxo: OutputRef;
  /** List<Attestation> echoing the feed's Price byte-for-byte. */
  attestationRedeemerCbor: string;
  /** From the feed datum — drive the freshness clamps below. */
  feedObservedAtMs: bigint;
  feedValidUntilMs: bigint;
}

export interface InsuredSwapPlan {
  spends: PlanSpend[];
  mints: PlanMint[];
  outputs: PlanOutput[];
  referenceInputs: OutputRef[];
  /** Observer withdraw-0 for Barrier plans; empty otherwise. */
  withdrawals: PlanWithdrawal[];
  /** Exactly ONE — the taker's CIP-30 key. Canonical fills are taker-signed and
   *  the Aegis pool spend needs no maker signature. */
  requiredSigners: string[];
  /** The TX validity window (NOT the coverage term — that lives in the
   *  PolicyDatum). invalidBefore sits a slot-safe margin below policy.start_time
   *  so the pool spend's start_time >= tx.validity_lower_bound holds after the
   *  builder floors it to a slot. invalidHereafter is a SHORT within-horizon
   *  window (nowMs + VALIDITY_UPPER_WINDOW_MS), capped by the order's own
   *  expiration if set — never the long-dated coverage expiry, which would be
   *  past the node's slot->time forecast horizon (TimeTranslationPastHorizon). */
  validity: { invalidBefore: bigint; invalidHereafter: bigint };
  /** ALWAYS null: NO Conway `treasury_donation` (CDDL key 22) so the V2 and V3
   *  script contexts both build. */
  treasuryDonation: null;
  /** Distinct Plutus versions present, sorted. A 1-tx insured swap is {v2,v3}. */
  plutusVersions: PlutusVersion[];
  /** True iff a Barrier-class policy needs the oracle feed as a ref input. */
  oracleRequired: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slot-safe margin (ms) the tx validity_lower_bound sits BELOW policy.start_time.
 *  The pool validator's start_time_in_tx_range enforces
 *  policy.start_time >= tx.validity_lower_bound. A builder floors the requested
 *  POSIX-ms lower bound to a whole slot, so setting it EQUAL to start_time can
 *  round the slot's POSIX start above start_time and crash the pool spend (the
 *  Phase-5b failure). Sitting a slot-safe margin below start_time keeps the
 *  relation true after flooring and absorbs build-machine clock skew. */
export const VALIDITY_LOWER_MARGIN_MS = 90_000n;

/** Span (ms) the tx validity_upper_bound sits ABOVE nowMs. The coverage TERM
 *  lives in the PolicyDatum (start/expiry); the pool validator only requires
 *  policy.start_time <= tx.validity_upper_bound (pool.ak:436) — it does NOT read
 *  the coverage term from the tx validity range. Using a long-dated coverage
 *  expiry as the tx upper bound puts it past the node's slot->time forecast
 *  horizon (~36-54h) and submit fails with TimeTranslationPastHorizon. So the tx
 *  upper bound is a SHORT fixed window, comfortably inside the horizon and far
 *  above start_time, independent of the coverage term (which stays in the datum). */
export const VALIDITY_UPPER_WINDOW_MS = 10_800_000n; // 3h

function refOf(u: AegisRefUtxo): OutputRef {
  return { txHash: u.txHash, outputIndex: u.index };
}

function assetValue(lovelace: bigint, asset: AegisAsset): Record<string, bigint> {
  return { lovelace, [unit(asset.policyId, asset.assetNameHex)]: asset.quantity };
}

/** The fixed nullary redeemer of a canonical cardano-swaps fill (index-free).
 *  A function redeemer would be a V3/SaturnSwap indexed fill — not composable
 *  here — so we require the string form. */
function fillRedeemerHex(fill: ComposableFill): string {
  if (typeof fill.redeemer !== "string") {
    throw new Error("insured swap expects a canonical cardano-swaps fill with a fixed nullary redeemer");
  }
  return fill.redeemer;
}

function aegisOutputs(uw: UnderwriteParts): PlanOutput[] {
  const outs: PlanOutput[] = [
    {
      role: "aegis-policy",
      address: uw.policyOutput.address,
      value: assetValue(uw.policyOutput.lovelace, uw.policyOutput.marker),
      datumCbor: uw.policyOutput.inlineDatumCbor,
    },
    {
      role: "aegis-pool",
      address: uw.poolOutput.address,
      value: assetValue(uw.poolOutput.lovelace, uw.poolOutput.poolNft),
      datumCbor: uw.poolOutput.inlineDatumCbor,
    },
    { role: "aegis-team", address: uw.teamOutput.address, value: { lovelace: uw.teamOutput.lovelace } },
  ];
  if (uw.partnerOutput) {
    outs.push({ role: "aegis-partner", address: uw.partnerOutput.address, value: { lovelace: uw.partnerOutput.lovelace } });
  }
  return outs;
}

function aegisReferenceInputs(uw: UnderwriteParts): OutputRef[] {
  const refs: OutputRef[] = [];
  if (uw.references.poolValidator) refs.push(refOf(uw.references.poolValidator));
  if (uw.references.marker) refs.push(refOf(uw.references.marker));
  return refs;
}

function assertNoDonation(uw: UnderwriteParts): void {
  if (uw.treasuryDonationLovelace !== 0n) {
    throw new Error(
      `underwrite parts carry a non-zero treasury donation (${uw.treasuryDonationLovelace}); ` +
        "rotate the pool (treasury_share_bps=0) and the SDK so no Conway key-22 is emitted, " +
        "or the V2 cardano-swaps leg will fail phase-2 (TreasuryDonationFieldNotSupported)",
    );
  }
}

function assertTakerPkh(takerPkh: string): void {
  if (!takerPkh || takerPkh.length !== 56) {
    throw new Error(`takerPkh must be 56 hex chars (28-byte payment key hash), got ${takerPkh?.length ?? 0}`);
  }
}

/** Fail-closed oracle gate: a Barrier underwrite without its attestation leg
 *  would fail phase-2 anyway (pool.ak reads attested_price) — refuse off-chain. */
function oracleLegs(
  uw: UnderwriteParts,
  oracle: OracleAttestationLeg | undefined,
): { refs: OutputRef[]; withdrawals: PlanWithdrawal[] } {
  if (uw.references.oracleRequired && !oracle) {
    throw new Error(
      "Barrier underwrite requires the oracle attestation leg (live AegisSelf feed reference + " +
        "oracle_observer withdraw-0) — build it with findLiveAegisFeed + encodeObserverAttestations",
    );
  }
  if (!oracle) return { refs: [], withdrawals: [] };
  return {
    refs: [oracle.feedRefUtxo, oracle.observerRefUtxo],
    withdrawals: [{ scriptHash: oracle.observerScriptHash, redeemerCbor: oracle.attestationRedeemerCbor }],
  };
}

/** The tx validity range. NOTE: this is the TX validity window, NOT the coverage
 *  term — the coverage start/expiry lives in the PolicyDatum and is enforced
 *  there, never via the tx validity range.
 *
 *  Lower bound: VALIDITY_LOWER_MARGIN_MS below the policy start_time so
 *  policy.start_time >= tx.validity_lower_bound survives the builder's ms→slot
 *  flooring (the pool spend's start_time_in_tx_range check). It also never sits
 *  ahead of `nowMs`, so a start_time pinned into the future can't make the tx
 *  not-yet-valid.
 *
 *  Upper bound: a SHORT within-horizon window (nowMs + VALIDITY_UPPER_WINDOW_MS),
 *  NOT the policy/coverage expiry — a long-dated expiry as the tx upper bound is
 *  past the node's slot->time forecast horizon (TimeTranslationPastHorizon). If
 *  the order carries its own on-chain expiration, the upper bound is capped to
 *  it. The pool validator only needs start_time <= tx.validity_upper_bound
 *  (pool.ak:436), which the window satisfies. */
function intersectValidity(
  uw: UnderwriteParts,
  swapExpirationMs: bigint | null | undefined,
  nowMs: bigint,
  oracle?: OracleAttestationLeg,
): { invalidBefore: bigint; invalidHereafter: bigint } {
  if (oracle && nowMs > oracle.feedValidUntilMs) {
    throw new Error(
      `AegisSelf feed expired at ${oracle.feedValidUntilMs} (now ${nowMs}) — ` +
        "tx_upper <= valid_until is unsatisfiable; wait for the next publish",
    );
  }

  const base = uw.validity.startTimeMs < nowMs ? uw.validity.startTimeMs : nowMs;
  let invalidBefore = base - VALIDITY_LOWER_MARGIN_MS;
  // pool.ak's Barrier freshness gate: tx_lower <= price.observed_at + 300_000.
  // An older feed forces the lower bound DOWN to stay inside the gate (a past
  // lower bound is always node-legal).
  if (oracle) {
    const feedLowerCap = oracle.feedObservedAtMs + MAX_FEED_AGE_MS;
    if (feedLowerCap < invalidBefore) invalidBefore = feedLowerCap;
  }

  // ... and its upper leg: tx_upper <= price.valid_until.
  let windowUpper = nowMs + VALIDITY_UPPER_WINDOW_MS;
  if (oracle && oracle.feedValidUntilMs < windowUpper) windowUpper = oracle.feedValidUntilMs;
  const invalidHereafter =
    swapExpirationMs != null && swapExpirationMs < windowUpper ? swapExpirationMs : windowUpper;

  if (invalidHereafter <= invalidBefore) {
    throw new Error(
      `tx validity_upper_bound (${invalidHereafter}) must exceed validity_lower_bound (${invalidBefore}); ` +
        `the order expiration (${swapExpirationMs}) caps it at/below the lower bound`,
    );
  }
  if (invalidHereafter < uw.validity.startTimeMs) {
    throw new Error(
      `tx validity_upper_bound (${invalidHereafter}) must be >= policy.start_time (${uw.validity.startTimeMs}); ` +
        `the pool spend's start_time_in_tx_range requires start_time <= tx.validity_upper_bound, ` +
        `but the order expiration (${swapExpirationMs}) caps it too early`,
    );
  }
  return { invalidBefore, invalidHereafter };
}

// ---------------------------------------------------------------------------
// Assemblers
// ---------------------------------------------------------------------------

export interface AssembleInsuredSwapArgs {
  /** The canonical cardano-swaps fill (V2) from `cardanoSwapsComposable`. */
  swap: CardanoSwapsComposableResult;
  /** The Aegis Underwrite parts (V3) from `buildUnderwriteParts` — donation must be 0. */
  underwrite: UnderwriteParts;
  /** The single required signer — the taker's 28-byte (56-hex) payment key hash. */
  takerPkh: string;
  /** cardano-swaps beacon/spend V2 reference scripts (CIP-33). */
  swapReferenceInputs: OutputRef[];
  /** The order's own expiration bound (ms), if the SwapDatum sets one. */
  swapExpirationMs?: bigint | null;
  /** The SINGLE wall-clock now (ms). Thread the SAME value passed to the SDK's
   *  `buildUnderwriteParts` so policy.start_time and the tx validity_lower_bound
   *  derive from one clock read — never two divergent `Date.now()`s (the 5b
   *  crash). Defaults to a single Date.now() captured at the top of the build. */
  nowMs?: bigint;
  /** REQUIRED for Barrier-class parts (references.oracleRequired). */
  oracle?: OracleAttestationLeg;
}

/**
 * Compose a V2 cardano-swaps `Swap` fill + a V3 Aegis Underwrite into ONE tx.
 * Premium flows to the vault via the pool spend; NO treasury donation is placed,
 * so the tx body carries no Conway key-22 and both script contexts build.
 */
export function assembleInsuredSwap(args: AssembleInsuredSwapArgs): InsuredSwapPlan {
  const { swap, underwrite: uw, takerPkh, swapReferenceInputs, swapExpirationMs } = args;
  const nowMs = args.nowMs ?? BigInt(Date.now());
  assertNoDonation(uw);
  assertTakerPkh(takerPkh);
  const oracle = oracleLegs(uw, args.oracle);

  const swapFill = swap.fill;
  const swapOutput = swapFill.outputs[0];
  if (!swapOutput || swapFill.outputs.length !== 1) {
    throw new Error("a canonical cardano-swaps fill has exactly one continuation output");
  }

  const spends: PlanSpend[] = [
    {
      role: "cardano-swaps-fill",
      input: { txHash: swapFill.input.txHash, outputIndex: swapFill.input.outputIndex },
      redeemerCbor: fillRedeemerHex(swapFill),
      plutusVersion: "v2",
    },
    {
      role: "aegis-underwrite",
      input: refOf(uw.poolInput),
      redeemerCbor: uw.poolRedeemerCbor,
      plutusVersion: "v3",
    },
  ];

  const outputs: PlanOutput[] = [
    { role: "swap-continuation", address: swapOutput.address, value: swapOutput.value, datumCbor: swapOutput.datum },
    ...aegisOutputs(uw),
  ];

  return {
    spends,
    mints: [{ ...uw.mint }],
    outputs,
    referenceInputs: [...swapReferenceInputs, ...aegisReferenceInputs(uw), ...oracle.refs],
    withdrawals: oracle.withdrawals,
    requiredSigners: [takerPkh],
    validity: intersectValidity(uw, swapExpirationMs, nowMs, args.oracle),
    treasuryDonation: null,
    plutusVersions: ["v2", "v3"],
    oracleRequired: uw.references.oracleRequired,
  };
}

export interface AssembleCoverageOnlyArgs {
  underwrite: UnderwriteParts;
  takerPkh: string;
  swapExpirationMs?: bigint | null;
  /** The SINGLE wall-clock now (ms) — thread the same value passed to the SDK's
   *  `buildUnderwriteParts`. See AssembleInsuredSwapArgs.nowMs. */
  nowMs?: bigint;
  /** REQUIRED for Barrier-class parts (references.oracleRequired). */
  oracle?: OracleAttestationLeg;
}

/**
 * The 2-tx fallback coverage leg: a STANDALONE Aegis Underwrite (V3 only), no
 * swap fill. Use when the pool rotation is not yet live (fill in tx A, coverage
 * here in tx B). Still carries no Conway key-22.
 */
export function assembleCoverageOnly(args: AssembleCoverageOnlyArgs): InsuredSwapPlan {
  const { underwrite: uw, takerPkh, swapExpirationMs } = args;
  const nowMs = args.nowMs ?? BigInt(Date.now());
  assertNoDonation(uw);
  assertTakerPkh(takerPkh);
  const oracle = oracleLegs(uw, args.oracle);

  return {
    spends: [
      {
        role: "aegis-underwrite",
        input: refOf(uw.poolInput),
        redeemerCbor: uw.poolRedeemerCbor,
        plutusVersion: "v3",
      },
    ],
    mints: [{ ...uw.mint }],
    outputs: aegisOutputs(uw),
    referenceInputs: [...aegisReferenceInputs(uw), ...oracle.refs],
    withdrawals: oracle.withdrawals,
    requiredSigners: [takerPkh],
    validity: intersectValidity(uw, swapExpirationMs, nowMs, args.oracle),
    treasuryDonation: null,
    plutusVersions: ["v3"],
    oracleRequired: uw.references.oracleRequired,
  };
}

// ---------------------------------------------------------------------------
// Invariant checks (the harness decides "composable", not the builder)
// ---------------------------------------------------------------------------

/**
 * Assert the plan is a legal V2⊗V3 composition: no Conway key-22, exactly one
 * signer, both Plutus versions present, and the two script inputs are distinct
 * UTxOs. Throws with a precise reason on any violation.
 */
export function assertComposable(plan: InsuredSwapPlan): void {
  if (plan.treasuryDonation !== null) {
    throw new Error("insured swap must carry NO Conway treasury_donation (key 22) — it poisons the V2 context");
  }
  if (plan.requiredSigners.length !== 1) {
    throw new Error(`insured swap must have exactly one required signer, got ${plan.requiredSigners.length}`);
  }
  if (!plan.plutusVersions.includes("v2") || !plan.plutusVersions.includes("v3")) {
    throw new Error("a 1-tx insured swap must contain BOTH a V2 swap spend and a V3 underwrite");
  }
  if (plan.oracleRequired && plan.withdrawals.length === 0) {
    throw new Error("a Barrier (oracleRequired) plan must carry the oracle_observer withdraw-0 attestation");
  }
  const swap = plan.spends.find((s) => s.role === "cardano-swaps-fill");
  const uw = plan.spends.find((s) => s.role === "aegis-underwrite");
  if (!swap || !uw) throw new Error("insured swap must contain a cardano-swaps fill spend and an aegis-underwrite spend");
  if (swap.input.txHash === uw.input.txHash && swap.input.outputIndex === uw.input.outputIndex) {
    throw new Error("the swap and underwrite legs must spend DISTINCT UTxOs (compose, don't couple)");
  }
}

/**
 * Prove the two legs share ONLY the tx: neither leg's redeemer or output datum
 * references the other leg's spent UTxO. The Aegis policy is bound to the pool
 * OutputReference, never to the swap order — so no cross-referencing datum /
 * redeemer exists and there is no double-satisfaction vector.
 */
export function legsShareOnlyTx(plan: InsuredSwapPlan): boolean {
  const swap = plan.spends.find((s) => s.role === "cardano-swaps-fill");
  const uw = plan.spends.find((s) => s.role === "aegis-underwrite");
  if (!swap || !uw) return false;
  const swapTx = swap.input.txHash;
  const poolTx = uw.input.txHash;

  const aegisArtifacts = [
    uw.redeemerCbor,
    ...plan.mints.map((m) => m.redeemerCbor),
    ...plan.outputs.filter((o) => o.role.startsWith("aegis-")).map((o) => o.datumCbor ?? ""),
  ];
  const swapArtifacts = [
    swap.redeemerCbor,
    ...plan.outputs.filter((o) => o.role === "swap-continuation").map((o) => o.datumCbor ?? ""),
  ];

  // The aegis leg must not embed the swap order's tx hash, and the swap leg must
  // not embed the pool's tx hash. (Distinct hashes → the includes() checks are
  // meaningful; assertComposable guarantees the inputs differ.)
  const aegisReferencesSwap = aegisArtifacts.some((a) => a.length > 0 && a.includes(swapTx));
  const swapReferencesPool = swapArtifacts.some((a) => a.length > 0 && a.includes(poolTx));
  return !aegisReferencesSwap && !swapReferencesPool;
}
