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

// V4 (CIP-0089 distributed order book): beacon discovery + datum/redeemer
// codecs + fill/swap planners.
export * from "./beaconsV4.js";
export * from "./datumV4.js";
export * from "./discoveryV4.js";
export * from "./ratioV4.js";
export * from "./fillPlanV4.js";
export * from "./fillV4.js";
