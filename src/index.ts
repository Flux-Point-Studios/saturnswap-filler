// saturnswap-filler — standalone, optional reference filler for aggregators.
// Discover SaturnSwap CLOB orders on-chain (1% + optional 4% run-off) and build a non-auth
// taker fill, paying the fee at the order's own deployment rate (1% or 4%) in the sell asset.
// No SaturnSwap API. No SaturnSwapBackend / SaturnSwapWeb dependency, either direction.

export * from "./contract.js";
export * from "./plutus.js";
export * from "./datum.js";
export * from "./datumV3.js";
export * from "./ratio.js";
export * from "./sort.js";
export * from "./scriptDataHash.js";
export * from "./minUtxo.js";
export * from "./outputs.js";
export * from "./discovery.js";
export * from "./fill.js";
export * from "./fillV3.js";
export * from "./cancel.js";
export { CborReader, CborWriter } from "./cbor.js";

// Canonical cardano-swaps (fallen-icarus protocol v2, PlutusV2): beacon discovery,
// SwapDatum/redeemer codecs, taker-fill composable, and the maker lifecycle
// (create / reprice / cancel via the maker_stake withdraw-0 + ADAM bot signer).
export * from "./cardanoSwapsBeacons.js";
export * from "./cardanoSwapsRatio.js";
export * from "./cardanoSwapsDatum.js";
export * from "./cardanoSwapsFill.js";
export * from "./cardanoSwapsLifecycle.js";
export * from "./cardanoSwapsDiscovery.js";
export * from "./cardanoSwapsMultiFill.js";

// Insured swap (tx-cart): compose a V2 cardano-swaps fill + a V3 Aegis
// underwrite into ONE tx, ONE signature, NO Conway treasury_donation (key 22).
// Plus the standalone coverage-only 2-tx fallback.
export * from "./insuredSwap.js";

// Mainnet wiring: the 2026-07-08 ceremony manifest + Aegis V7 coverage
// constants, and AegisSelf rotating-feed discovery / observer attestation.
export * from "./cardanoSwapsMainnet.js";
export * from "./aegisFeed.js";
