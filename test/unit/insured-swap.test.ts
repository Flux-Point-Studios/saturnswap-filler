import { describe, it, expect } from "vitest";
import {
  assembleInsuredSwap,
  assembleCoverageOnly,
  assertComposable,
  legsShareOnlyTx,
  VALIDITY_LOWER_MARGIN_MS,
  VALIDITY_UPPER_WINDOW_MS,
  type UnderwriteParts,
} from "../../src/insuredSwap.js";
import { cardanoSwapsComposable, addAsset, type OneWayOrder } from "../../src/cardanoSwapsFill.js";
import { encodeOneWaySwapDatumHex, SWAP_REDEEMER_HEX, type OneWaySwapDatum } from "../../src/cardanoSwapsDatum.js";
import { pairBeacon, offerBeacon, askBeacon } from "../../src/cardanoSwapsBeacons.js";
import { unit, type ChainValue } from "../../src/discovery.js";
import type { OutputRef } from "../../src/datum.js";
import type { UTxO } from "@lucid-evolution/lucid";

// ---- cardano-swaps V2 fill fixture (offer = ADA, ask = TOKEN) ----

const SWAP_TX = "aa".repeat(32);
const AA = "aa".repeat(28); // ask token policy
const NM = "54455354";
const BEACON = "22".repeat(28);
const DEPOSIT = 2_000_000n;
const swapOrderRef: OutputRef = { txHash: SWAP_TX, outputIndex: 1 };
const swapUtxo = { txHash: SWAP_TX, outputIndex: 1, address: "x", assets: {} } as unknown as UTxO;

function oneWayDatum(): OneWaySwapDatum {
  return {
    beaconId: BEACON,
    pairBeacon: pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM }),
    offerId: "",
    offerName: "",
    offerBeacon: offerBeacon("", ""),
    askId: AA,
    askName: NM,
    askBeacon: askBeacon(AA, NM),
    price: { num: 400n, den: 100_000_000n },
    prevInput: null,
    expiration: null,
  };
}

function oneWayOrder(): OneWayOrder {
  const datum = oneWayDatum();
  let v: ChainValue = { lovelace: DEPOSIT + 100_000_000n, assets: {} };
  v = addAsset(v, datum.beaconId, datum.pairBeacon, 1n);
  v = addAsset(v, datum.beaconId, datum.offerBeacon, 1n);
  v = addAsset(v, datum.beaconId, datum.askBeacon, 1n);
  return { kind: "one-way", utxo: swapOrderRef, address: "addr_test1_swap", datum, scriptValue: v };
}

function swapLeg() {
  return cardanoSwapsComposable({ order: oneWayOrder(), orderUtxo: swapUtxo, offerTaken: 25_000_000n });
}

// ---- Aegis V3 underwrite parts fixture (post-rotation: donation = 0) ----

const POOL_TX = "bb".repeat(32);
const MARKER_POLICY = "cc".repeat(28);
const MARKER_NAME = "41454749535f504f4c494359"; // "AEGIS_POLICY"
const POOL_NFT_POLICY = "dd".repeat(28);
const POOL_NFT_NAME = "706f6f6c"; // "pool"
const START = 1_750_000_000_000n;
const EXPIRY = START + 30n * 86_400_000n;

function underwriteParts(donation: bigint = 0n, withPartner = false): UnderwriteParts {
  return {
    // policy datum keys off the POOL outputref, not the swap order — the CBOR
    // embeds POOL_TX, never SWAP_TX (compose, don't couple).
    policyOutput: {
      address: "addr_test1_policy",
      lovelace: 100_000_000n,
      marker: { policyId: MARKER_POLICY, assetNameHex: MARKER_NAME, quantity: 1n },
      inlineDatumCbor: "d8799f" + POOL_TX + "ff",
    },
    poolOutput: {
      address: "addr_test1_pool",
      lovelace: 500_000_000n,
      poolNft: { policyId: POOL_NFT_POLICY, assetNameHex: POOL_NFT_NAME, quantity: 1n },
      inlineDatumCbor: "d8799f0102ff",
    },
    teamOutput: { address: "addr_test1_team", lovelace: 2_000_000n },
    partnerOutput: withPartner ? { address: "addr_test1_partner", lovelace: 3_000_000n } : null,
    mint: { policyId: MARKER_POLICY, assetNameHex: MARKER_NAME, quantity: 1n, redeemerCbor: "d87b9f01ff" },
    poolRedeemerCbor: "d8799f1a05f5e1001a02faf080ff",
    treasuryDonationLovelace: donation,
    poolInput: { txHash: POOL_TX, index: 0 },
    references: {
      poolValidator: { txHash: "ee".repeat(32), index: 0 },
      marker: { txHash: "ef".repeat(32), index: 0 },
      // Depeg/Shielded-class fixture — Barrier (oracleRequired) has its own block below.
      oracleRequired: false,
    },
    validity: { startTimeMs: START, expiryTimeMs: EXPIRY },
  };
}

const TAKER = "12".repeat(28); // 56 hex
const SWAP_REFS: OutputRef[] = [{ txHash: "f0".repeat(32), outputIndex: 0 }];

describe("assembleInsuredSwap — 1-tx V2 swap ⊗ V3 underwrite, NO key 22", () => {
  const plan = assembleInsuredSwap({
    swap: swapLeg(),
    underwrite: underwriteParts(),
    takerPkh: TAKER,
    swapReferenceInputs: SWAP_REFS,
  });

  it("contains BOTH a V2 cardano-swaps fill spend and a V3 aegis underwrite spend", () => {
    expect(plan.spends).toHaveLength(2);
    const swap = plan.spends.find((s) => s.role === "cardano-swaps-fill")!;
    const uw = plan.spends.find((s) => s.role === "aegis-underwrite")!;
    expect(swap.plutusVersion).toBe("v2");
    expect(swap.redeemerCbor).toBe(SWAP_REDEEMER_HEX);
    expect(swap.input).toEqual(swapOrderRef);
    expect(uw.plutusVersion).toBe("v3");
    expect(uw.redeemerCbor).toBe("d8799f1a05f5e1001a02faf080ff");
    expect(uw.input).toEqual({ txHash: POOL_TX, outputIndex: 0 });
    expect(plan.plutusVersions).toEqual(["v2", "v3"]);
  });

  it("carries NO Conway treasury_donation (key 22)", () => {
    expect(plan.treasuryDonation).toBeNull();
  });

  it("has exactly ONE required signer — the taker", () => {
    expect(plan.requiredSigners).toEqual([TAKER]);
  });

  it("mints the single Aegis marker and emits swap-continuation + policy/pool/team outputs", () => {
    expect(plan.mints).toEqual([
      { policyId: MARKER_POLICY, assetNameHex: MARKER_NAME, quantity: 1n, redeemerCbor: "d87b9f01ff" },
    ]);
    const roles = plan.outputs.map((o) => o.role);
    expect(roles).toEqual(["swap-continuation", "aegis-policy", "aegis-pool", "aegis-team"]);
    // swap continuation carries the traded value + preserved beacons
    const cont = plan.outputs[0]!;
    expect(cont.value.lovelace).toBe(DEPOSIT + 75_000_000n);
    expect(cont.value[unit(AA, NM)]).toBe(100n);
    expect(cont.datumCbor).toBe(encodeOneWaySwapDatumHex({ ...oneWayDatum(), prevInput: swapOrderRef }));
    // policy output carries the coverage + 1 marker
    const policy = plan.outputs[1]!;
    expect(policy.value.lovelace).toBe(100_000_000n);
    expect(policy.value[unit(MARKER_POLICY, MARKER_NAME)]).toBe(1n);
  });

  it("attaches both the cardano-swaps V2 ref scripts and the Aegis pool/marker refs", () => {
    expect(plan.referenceInputs).toEqual([
      ...SWAP_REFS,
      { txHash: "ee".repeat(32), outputIndex: 0 },
      { txHash: "ef".repeat(32), outputIndex: 0 },
    ]);
    expect(plan.oracleRequired).toBe(false);
    expect(plan.withdrawals).toEqual([]);
  });

  it("passes the V2⊗V3 composability gate", () => {
    expect(() => assertComposable(plan)).not.toThrow();
  });

  it("the two legs share ONLY the tx — no cross-referencing datum/redeemer", () => {
    expect(legsShareOnlyTx(plan)).toBe(true);
    // the underwrite input is the pool, NOT the swap order (distinct UTxOs)
    const swap = plan.spends.find((s) => s.role === "cardano-swaps-fill")!;
    const uw = plan.spends.find((s) => s.role === "aegis-underwrite")!;
    expect(swap.input.txHash).not.toBe(uw.input.txHash);
  });

  it("includes the partner output when the underwrite has a partner cut", () => {
    const p = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: underwriteParts(0n, true),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
    });
    expect(p.outputs.map((o) => o.role)).toEqual([
      "swap-continuation",
      "aegis-policy",
      "aegis-pool",
      "aegis-team",
      "aegis-partner",
    ]);
  });

  it("upper bound is nowMs + VALIDITY_UPPER_WINDOW_MS (short window), capped by a nearer order expiration", () => {
    const NOW = START + 1_000_000n; // after policy start, far below the 30-day expiry
    const p = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: underwriteParts(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
    });
    // lower bound sits a slot-safe margin below the policy start (pool invariant)
    expect(p.validity.invalidBefore).toBe(START - VALIDITY_LOWER_MARGIN_MS);
    // upper bound is the SHORT within-horizon window, NOT the 30-day policy expiry
    expect(p.validity.invalidHereafter).toBe(NOW + VALIDITY_UPPER_WINDOW_MS);
    expect(p.validity.invalidHereafter).not.toBe(EXPIRY);
    // a nearer order expiration caps it below the window
    const earlyExp = NOW + 1_000_000n;
    const p2 = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: underwriteParts(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      swapExpirationMs: earlyExp,
      nowMs: NOW,
    });
    expect(p2.validity.invalidHereafter).toBe(earlyExp);
  });
});

// The Phase-5b crash: the pool validator's start_time_in_tx_range enforces
// policy.start_time >= tx.validity_lower_bound. A single nowMs must drive BOTH
// the SDK's start_time (= nowMs − startMargin) and the assembled tx's
// validity_lower_bound, and the lower bound must sit at/below start_time with a
// slot-safe margin so the relation survives ms→slot flooring in the builder.
describe("start_time pinning — validity_lower_bound <= policy.start_time (the pool invariant)", () => {
  const NOW = 1_770_000_000_000n;
  const START_MARGIN = 120_000n;
  const start = NOW - START_MARGIN;

  // Mirror the SDK: one nowMs derives policy.start_time = nowMs − startMargin.
  function underwritePartsAt(nowMs: bigint, startMarginMs = START_MARGIN): UnderwriteParts {
    const s = nowMs - startMarginMs;
    const p = underwriteParts();
    p.validity = { startTimeMs: s, expiryTimeMs: s + 30n * 86_400_000n };
    return p;
  }

  it("insured swap: validity_lower_bound <= policy.start_time when one nowMs is threaded", () => {
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: underwritePartsAt(NOW),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
    });
    expect(plan.validity.invalidBefore <= start).toBe(true);
    expect(plan.validity.invalidBefore).toBe(start - VALIDITY_LOWER_MARGIN_MS);
  });

  it("coverage-only: validity_lower_bound <= policy.start_time when one nowMs is threaded", () => {
    const plan = assembleCoverageOnly({
      underwrite: underwritePartsAt(NOW),
      takerPkh: TAKER,
      nowMs: NOW,
    });
    expect(plan.validity.invalidBefore <= start).toBe(true);
    expect(plan.validity.invalidBefore).toBe(start - VALIDITY_LOWER_MARGIN_MS);
  });

  it("holds even when the assembler clock runs LATER than the SDK clock (the 5b divergence)", () => {
    // SDK pinned start from an earlier read; assembler sees a later nowMs. The
    // lower bound must still stay at/below the (earlier) policy start_time.
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: underwritePartsAt(NOW),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW + 300_000n,
    });
    expect(plan.validity.invalidBefore <= start).toBe(true);
  });

  it("defaults nowMs to a single captured clock read (no arg needed)", () => {
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: underwritePartsAt(NOW),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
    });
    // start is in the past relative to the real Date.now(), so min() picks start.
    expect(plan.validity.invalidBefore).toBe(start - VALIDITY_LOWER_MARGIN_MS);
  });
});

// The TimeTranslationPastHorizon fix: the coverage TERM lives in the PolicyDatum
// (start/expiry), NOT in the tx validity range. The pool validator only needs
// start_time <= tx.validity_upper_bound (pool.ak:436). A long-dated coverage
// expiry as the tx UPPER bound is past the node's ~36-54h slot->time forecast
// horizon and fails submit. So the tx upper bound is a SHORT within-horizon
// window (nowMs + VALIDITY_UPPER_WINDOW_MS), independent of the coverage term.
describe("tx validity UPPER bound is a short within-horizon window, not the coverage expiry", () => {
  const NOW = 1_770_000_000_000n;
  const START_MARGIN = 120_000n;
  const start = NOW - START_MARGIN;
  const thirtyDayExpiry = start + 30n * 86_400_000n;

  function uw30d(): UnderwriteParts {
    const p = underwriteParts();
    p.validity = { startTimeMs: start, expiryTimeMs: thirtyDayExpiry };
    return p;
  }

  it("insured swap: invalidHereafter == nowMs + VALIDITY_UPPER_WINDOW_MS for a 30-day policy (NOT the policy expiry)", () => {
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: uw30d(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
    });
    expect(plan.validity.invalidHereafter).toBe(NOW + VALIDITY_UPPER_WINDOW_MS);
    expect(plan.validity.invalidHereafter).not.toBe(thirtyDayExpiry);
    // both bounds hold: window > lower bound and window >= policy.start_time
    expect(plan.validity.invalidHereafter > plan.validity.invalidBefore).toBe(true);
    expect(plan.validity.invalidHereafter >= start).toBe(true);
    // and the window sits FAR below the 30-day coverage expiry — that is what
    // keeps it inside the node's slot->time forecast horizon.
    expect(plan.validity.invalidHereafter < thirtyDayExpiry).toBe(true);
  });

  it("coverage-only: same short window for a 30-day policy (shares the validity path)", () => {
    const plan = assembleCoverageOnly({ underwrite: uw30d(), takerPkh: TAKER, nowMs: NOW });
    expect(plan.validity.invalidHereafter).toBe(NOW + VALIDITY_UPPER_WINDOW_MS);
    expect(plan.validity.invalidHereafter < thirtyDayExpiry).toBe(true);
    expect(plan.validity.invalidHereafter >= start).toBe(true);
  });

  it("a nearer order expiration caps the upper bound below the window", () => {
    const near = NOW + 1_000_000n; // < the 3h window
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: uw30d(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      swapExpirationMs: near,
      nowMs: NOW,
    });
    expect(plan.validity.invalidHereafter).toBe(near);
  });

  it("an order expiration beyond the window does NOT extend the tx past nowMs + window", () => {
    const far = NOW + 10n * 86_400_000n;
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: uw30d(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      swapExpirationMs: far,
      nowMs: NOW,
    });
    expect(plan.validity.invalidHereafter).toBe(NOW + VALIDITY_UPPER_WINDOW_MS);
  });

  it("VALIDITY_UPPER_WINDOW_MS is a short span comfortably inside the ~36h horizon", () => {
    expect(VALIDITY_UPPER_WINDOW_MS).toBe(10_800_000n); // 3h
    expect(VALIDITY_UPPER_WINDOW_MS < 36n * 3_600_000n).toBe(true);
  });

  it("REFUSES an order expiration that caps the upper bound below policy.start_time", () => {
    const beforeStart = start - 1n;
    expect(() =>
      assembleInsuredSwap({
        swap: swapLeg(),
        underwrite: uw30d(),
        takerPkh: TAKER,
        swapReferenceInputs: SWAP_REFS,
        swapExpirationMs: beforeStart,
        nowMs: NOW,
      }),
    ).toThrow(/start_time|validity/i);
  });
});

describe("assembleInsuredSwap — guards", () => {
  it("REFUSES to compose when the underwrite still carries a treasury donation (key 22 would poison V2)", () => {
    expect(() =>
      assembleInsuredSwap({
        swap: swapLeg(),
        underwrite: underwriteParts(500_000n),
        takerPkh: TAKER,
        swapReferenceInputs: SWAP_REFS,
      }),
    ).toThrow(/treasury donation|key-22|phase-2/i);
  });

  it("rejects a malformed taker key hash", () => {
    expect(() =>
      assembleInsuredSwap({ swap: swapLeg(), underwrite: underwriteParts(), takerPkh: "12", swapReferenceInputs: SWAP_REFS }),
    ).toThrow(/56 hex/);
  });
});

describe("assembleCoverageOnly — the 2-tx fallback still works", () => {
  const plan = assembleCoverageOnly({ underwrite: underwriteParts(), takerPkh: TAKER });

  it("is a standalone V3-only underwrite (no swap leg), still no key 22", () => {
    expect(plan.spends).toHaveLength(1);
    expect(plan.spends[0]!.role).toBe("aegis-underwrite");
    expect(plan.plutusVersions).toEqual(["v3"]);
    expect(plan.treasuryDonation).toBeNull();
    expect(plan.requiredSigners).toEqual([TAKER]);
    expect(plan.outputs.map((o) => o.role)).toEqual(["aegis-policy", "aegis-pool", "aegis-team"]);
  });

  it("is NOT a 1-tx insured swap (assertComposable rejects it — no V2 leg)", () => {
    expect(() => assertComposable(plan)).toThrow(/BOTH a V2 swap spend and a V3 underwrite/);
  });
});

// ---------------------------------------------------------------------------
// Barrier (oracleRequired) — the underwrite must carry the AegisSelf feed as a
// read-only reference input AND the oracle_observer's withdraw-0 attestation.
// pool.ak's Barrier arm then enforces freshness:
//   tx_lower <= price.observed_at + 300_000 && tx_upper <= price.valid_until
// ---------------------------------------------------------------------------

const OBSERVER_HASH = "669d5a25489c00aab367c3b9b71630efd523623ca13bbe0e1bd59752";
const FEED_REF: OutputRef = { txHash: "0e".repeat(32), outputIndex: 0 };
const OBSERVER_REF: OutputRef = { txHash: "0b".repeat(32), outputIndex: 0 };
const ATTESTATION_CBOR = "9fd8799fd87b9f".padEnd(40, "0") + "ff"; // opaque to the assembler

function barrierParts(): UnderwriteParts {
  const p = underwriteParts();
  p.references = { ...p.references, oracleRequired: true };
  return p;
}

function oracleLeg(nowMs: bigint, observedAgoMs = 60_000n, validForMs = 4_200_000n) {
  const observed = nowMs - observedAgoMs;
  return {
    feedRefUtxo: FEED_REF,
    observerScriptHash: OBSERVER_HASH,
    observerRefUtxo: OBSERVER_REF,
    attestationRedeemerCbor: ATTESTATION_CBOR,
    feedObservedAtMs: observed,
    feedValidUntilMs: observed + validForMs,
  };
}

describe("Barrier — oracle attestation leg", () => {
  const NOW = START + 1_000_000n;

  it("FAIL-CLOSED: refuses a Barrier underwrite without the oracle leg (both assemblers)", () => {
    expect(() =>
      assembleInsuredSwap({ swap: swapLeg(), underwrite: barrierParts(), takerPkh: TAKER, swapReferenceInputs: SWAP_REFS, nowMs: NOW }),
    ).toThrow(/oracle/i);
    expect(() => assembleCoverageOnly({ underwrite: barrierParts(), takerPkh: TAKER, nowMs: NOW })).toThrow(/oracle/i);
  });

  it("attaches the feed + observer refs and the observer withdraw-0 attestation", () => {
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: barrierParts(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
      oracle: oracleLeg(NOW),
    });
    expect(plan.oracleRequired).toBe(true);
    expect(plan.withdrawals).toEqual([{ scriptHash: OBSERVER_HASH, redeemerCbor: ATTESTATION_CBOR }]);
    expect(plan.referenceInputs).toEqual([
      ...SWAP_REFS,
      { txHash: "ee".repeat(32), outputIndex: 0 },
      { txHash: "ef".repeat(32), outputIndex: 0 },
      FEED_REF,
      OBSERVER_REF,
    ]);
    expect(() => assertComposable(plan)).not.toThrow();
  });

  it("clamps validity_lower_bound to observed_at + 300s for an older feed (tx_lower gate)", () => {
    // feed observed ~33 min ago: observed_at + 300s sits BELOW the default lower
    // bound (start − margin), so tx_lower must clamp down to stay inside the gate.
    const leg = oracleLeg(NOW, 2_000_000n);
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: barrierParts(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
      oracle: leg,
    });
    expect(plan.validity.invalidBefore).toBe(leg.feedObservedAtMs + 300_000n);
    expect(plan.validity.invalidBefore <= leg.feedObservedAtMs + 300_000n).toBe(true);
  });

  it("keeps the normal lower bound when the feed is fresh (no unnecessary clamp)", () => {
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: barrierParts(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
      oracle: oracleLeg(NOW, 60_000n),
    });
    expect(plan.validity.invalidBefore).toBe(START - VALIDITY_LOWER_MARGIN_MS);
  });

  it("caps validity_upper_bound at the feed's valid_until (tx_upper gate)", () => {
    // feed expires 10 min from now — well inside the 3h window.
    const leg = oracleLeg(NOW, 3_600_000n, 4_200_000n); // observed 1h ago, expires in 10min
    const plan = assembleCoverageOnly({
      underwrite: barrierParts(),
      takerPkh: TAKER,
      nowMs: NOW,
      oracle: leg,
    });
    expect(plan.validity.invalidHereafter).toBe(leg.feedValidUntilMs);
    expect(plan.withdrawals).toEqual([{ scriptHash: OBSERVER_HASH, redeemerCbor: ATTESTATION_CBOR }]);
  });

  it("REFUSES an expired feed (upper clamp collapses the validity window)", () => {
    const leg = oracleLeg(NOW, 4_300_000n, 4_200_000n); // valid_until already passed
    expect(() =>
      assembleCoverageOnly({ underwrite: barrierParts(), takerPkh: TAKER, nowMs: NOW, oracle: leg }),
    ).toThrow(/exceed|expired/i);
  });

  it("assertComposable rejects a Barrier plan whose observer withdrawal was stripped", () => {
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: barrierParts(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
      oracle: oracleLeg(NOW),
    });
    const stripped = { ...plan, withdrawals: [] };
    expect(() => assertComposable(stripped)).toThrow(/observer|oracle/i);
  });

  it("a non-Barrier plan carries no withdrawals and needs no oracle leg", () => {
    const plan = assembleInsuredSwap({
      swap: swapLeg(),
      underwrite: underwriteParts(),
      takerPkh: TAKER,
      swapReferenceInputs: SWAP_REFS,
      nowMs: NOW,
    });
    expect(plan.oracleRequired).toBe(false);
    expect(plan.withdrawals).toEqual([]);
  });
});
