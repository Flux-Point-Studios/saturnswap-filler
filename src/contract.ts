// SaturnSwap saturn_swap deployment registry (mainnet). 1%-ONLY by design.
// The legacy 4% run-off deployment (hash 1af84a9e…, ref 86cdaeed…#0) is OUT OF SCOPE:
// those orders are NOT discovered and MUST NOT be filled by this lib. Resolution is
// PER ORDER, keyed by the order's own script address / payment credential — but only
// the single 1% deployment is registered, so any non-1% order fails to resolve.

export type Version = "1pct";

export interface Deployment {
  version: Version;
  /** applied script hash = the order address payment credential */
  scriptHash: string;
  /** order script address (bech32, base addr type-1 = script payment + key stake) */
  orderAddress: string;
  /** reference-script UTxO carrying the validator (spend via this) */
  refScript: { txHash: string; outputIndex: number };
  /** fee_percent x 100 (matches the Aiken constant; calculate_fee divides by 10000) */
  feePercentX100: number;
}

// fee_address baked into the validator (the 1% fee output goes here).
//   payment VK cred cd51fc17..., stake key 63c28615...
export const FEE_ADDRESS =
  "addr1q8x4rlqhrq4rhqhnkamw3fdqmzqgum79yragg4gptcjpphmrc2rpt0exfch4s47fu32amr45vh9wg053hmcx9k7kkcrq6kxftd";
export const FEE_PAYMENT_CRED = "cd51fc17182a3b82f3b776e8a5a0d8808e6fc520fa8455015e2410df";
export const FEE_STAKE_CRED = "63c28615bf264e2f5857c9e455dd8eb465cae43e91bef062dbd6b606";

// authorize_address — a credential baked into the validator (readable on-chain).
// Aggregators NEVER hold this key, so the non-auth path (this lib) pays the 1% fee in
// the sell asset to fee_address instead.
export const AUTHORIZE_PAYMENT_CRED = "7c2328db12987149ce8fdbbaa932c11542e24d6bd2d4876abffa58b8";

// Ratio scale (the validator's ratio helpers) — all roundings are UP.
export const RATIO_SCALE = 1_000_000_000_000n;

// Single supported deployment: the current 1% saturn_swap. fee_percent is compiled in
// as a constant (100 => 1%; calculate_fee divides by 10000), so total_fee is always
// new_swap_amount_sell * 100 / 10000.
export const FEE_PERCENT_X100 = 100;

export const DEPLOYMENTS: Deployment[] = [
  {
    version: "1pct",
    scriptHash: "73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f",
    orderAddress:
      "addr1z9eejzm3qsww4hn0semp0akwnuv84dcsag4lrludklgzjt675jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsrfnae7",
    refScript: { txHash: "0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9", outputIndex: 0 },
    feePercentX100: FEE_PERCENT_X100,
  },
];

export function deploymentByScriptHash(scriptHash: string): Deployment | undefined {
  const h = scriptHash.toLowerCase();
  return DEPLOYMENTS.find((d) => d.scriptHash === h);
}

export function deploymentByOrderAddress(orderAddress: string): Deployment | undefined {
  return DEPLOYMENTS.find((d) => d.orderAddress === orderAddress);
}
