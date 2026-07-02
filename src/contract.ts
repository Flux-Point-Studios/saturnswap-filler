// SaturnSwap saturn_swap deployment registry. The mainnet production registry (DEPLOYMENTS)
// carries three in-scope deployments:
//   - current 1% V2 (hash 73990b71…, ref 0e16cd00…#0, fee_percent_x100 = 100)
//   - legacy 4% V2 run-off (hash 1af84a9e…, ref 86cdaeed…#0, fee_percent_x100 = 400)
//   - V3 (hash 6023f59d…, ref 68a5c0bb…#0, fee_percent_x100 = 100) — PlutusV3, adds the
//     min_partial_fill floor + optional Aegis coverage + a fill-receipt mint.
// The two V2 deployments share the SAME baked fee_address + authorize credential and differ
// ONLY in fee_percent; mainnet V3 bakes the SAME production fee_address.
// Orders may rest at ANY address. Resolution is PER ORDER, keyed by the order's own script
// address / payment credential: the resolved deployment supplies the fee_percent AND the
// reference-script UTxO to spend against. A 4% order MUST be filled with fee_percent = 400
// (the 1% recipe underpays 4x and the validator denies); a 1% order MUST be filled with
// fee_percent = 100. Mixing V2 deployments in one tx is fine as long as each order's fee
// output uses its OWN fee_percent + its OWN per-order PaymentDatum.
// A separate PREPROD_DEPLOYMENTS registry carries the hardened preprod V3 build (ec457591…)
// used by the differential tests; it is not scanned by production discovery.

export type Version = "1pct" | "4pct" | "v3";
export type PlutusVersion = "v2" | "v3";
export type Network = "mainnet" | "preprod";

export interface Deployment {
  version: Version;
  /** applied script hash = the order address payment credential */
  scriptHash: string;
  /** order script address (bech32) */
  orderAddress: string;
  /** reference-script UTxO carrying the validator (spend via this) */
  refScript: { txHash: string; outputIndex: number };
  /** fee_percent x 100 (matches the Aiken constant; calculate_fee divides by 10000) */
  feePercentX100: number;
  /** Plutus language of the validator — decides the SwapDatum wire form (V3 = 11 fields,
   *  flat OutputReference) and the script_data_hash language-views key (V2 = 1, V3 = 2). */
  plutusVersion: PlutusVersion;
  /** which network this deployment lives on */
  network: Network;
  /** the baked fee_address the sell-asset fee output is paid to for THIS deployment */
  feeAddress: string;
}

// fee_address baked into BOTH validators (the fee output goes here for either version).
//   payment VK cred cd51fc17..., stake key 63c28615...
export const FEE_ADDRESS =
  "addr1q8x4rlqhrq4rhqhnkamw3fdqmzqgum79yragg4gptcjpphmrc2rpt0exfch4s47fu32amr45vh9wg053hmcx9k7kkcrq6kxftd";
export const FEE_PAYMENT_CRED = "cd51fc17182a3b82f3b776e8a5a0d8808e6fc520fa8455015e2410df";
export const FEE_STAKE_CRED = "63c28615bf264e2f5857c9e455dd8eb465cae43e91bef062dbd6b606";

// authorize_address — a credential baked into the validator (readable on-chain), identical
// for both mainnet deployments. Aggregators NEVER hold this key, so the non-auth path (this
// lib) pays the fee in the sell asset to fee_address instead.
export const AUTHORIZE_PAYMENT_CRED = "7c2328db12987149ce8fdbbaa932c11542e24d6bd2d4876abffa58b8";

// ---- V3 (PlutusV3) ----
// The V3 saturn_swap validator adds the min_partial_fill floor + optional Aegis Coverage
// (a per-fill premium OUTPUT to the coverage vault; NOT a treasury_donation) + a CIP-69
// fill-receipt mint on the same script (receipt policy id == script hash). fee_percent is
// compiled in at 100 (1%), the same rate as the mainnet 1% deployment, and the fee is still
// paid in the sell asset to the baked fee_address.
//
// MAINNET V3 (6023f59d…) is LIVE and the default discovery target: it bakes the SAME
// production fee_address as the V2 deployments and rests at a BASE script address.
// PREPROD V3 (ec457591…) is the hardened build kept for the differential tests: its baked
// fee_address is the preprod deployment's and its order address is ENTERPRISE (type-7, no
// stake). In the hardened build the receipt mint binds to a real SwapAction fill (payout-index
// == receipt owner_output_index, PaymentDatum-tagged owner payout, on-chain-derived
// sold_amount), and a covered fill must pay the premium to a vault distinct from owner/fee with
// a ≥1-unit floor.
export const V3_SCRIPT_HASH_MAINNET = "6023f59dce0064f1d6d27594dbea25bc4305a9f6a10f3a064037553a";
export const V3_ORDER_ADDRESS_MAINNET =
  "addr1z9sz8avaecqxfuwk6f6efkl2yk7yxpdf76ss7wsxgqm42wh2l9cdyhc0eja9mxq0lgeer90edhlfymnxv2ym3szcetqsp0ume8";
export const V3_REF_SCRIPT_MAINNET = {
  txHash: "68a5c0bbf721a68b8049ba8807e348120a6bad599a81d163fa63cc961b2f35c4",
  outputIndex: 0,
};

export const V3_SCRIPT_HASH_PREPROD = "ec457591a4f5ab0d070146558e5f1729fcc5c0b230472437be337625";
export const V3_ORDER_ADDRESS_PREPROD =
  "addr_test1wrky2av35n66krg8q9r9trjlzu5le3wqkgcywfphhcehvfg03jugc";
export const V3_REF_SCRIPT_PREPROD = {
  txHash: "efb2c0dc789d9bdf0f3988c01c2ca24fe43f16706086252d7576a6a0ad25fa7e",
  outputIndex: 0,
};
export const V3_FEE_ADDRESS_PREPROD =
  "addr_test1vrjau4npl8vg8fvp38ahj3lxu3wtlp3qyh2agu4u6vqxlds065ldr";
export const V3_FEE_PAYMENT_CRED_PREPROD =
  "e5de5661f9d883a58189fb7947e6e45cbf862025d5d472bcd3006fb6";

// Ratio scale (the validator's ratio helpers) — all roundings are UP.
export const RATIO_SCALE = 1_000_000_000_000n;

// fee_percent is compiled into each validator as a constant (calculate_fee divides by 10000),
// so total_fee = new_swap_amount_sell * fee_percent_x100 / 10000 with the PER-DEPLOYMENT rate.
export const FEE_PERCENT_X100 = 100; // current 1%
export const LEGACY_FEE_PERCENT_X100 = 400; // legacy 4% run-off
export const V3_FEE_PERCENT_X100 = 100; // V3 (1%)

// Mainnet production registry — what discovery scans by default.
export const MAINNET_DEPLOYMENTS: Deployment[] = [
  {
    version: "1pct",
    scriptHash: "73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f",
    orderAddress:
      "addr1z9eejzm3qsww4hn0semp0akwnuv84dcsag4lrludklgzjt675jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsrfnae7",
    refScript: { txHash: "0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9", outputIndex: 0 },
    feePercentX100: FEE_PERCENT_X100,
    plutusVersion: "v2",
    network: "mainnet",
    feeAddress: FEE_ADDRESS,
  },
  {
    version: "4pct",
    scriptHash: "1af84a9e697e1e7b042a0a06f061e88182feb9e9ada950b36a916bd5",
    orderAddress:
      "addr1zyd0sj57d9lpu7cy9g9qdurpazqc9l4eaxk6j59nd2gkh4275jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsqzf5tn",
    refScript: { txHash: "86cdaeed2afa48821a229f09582ddc8a350fcea2f770875cd5ea92b230b7a0a8", outputIndex: 0 },
    feePercentX100: LEGACY_FEE_PERCENT_X100,
    plutusVersion: "v2",
    network: "mainnet",
    feeAddress: FEE_ADDRESS,
  },
  {
    version: "v3",
    scriptHash: V3_SCRIPT_HASH_MAINNET,
    orderAddress: V3_ORDER_ADDRESS_MAINNET,
    refScript: V3_REF_SCRIPT_MAINNET,
    feePercentX100: V3_FEE_PERCENT_X100,
    plutusVersion: "v3",
    network: "mainnet",
    feeAddress: FEE_ADDRESS,
  },
];

// Preprod registry — the hardened preprod V3 build, kept for the differential tests. NOT
// scanned by production discovery (DEPLOYMENTS), but resolvable by hash/address.
export const PREPROD_DEPLOYMENTS: Deployment[] = [
  {
    version: "v3",
    scriptHash: V3_SCRIPT_HASH_PREPROD,
    orderAddress: V3_ORDER_ADDRESS_PREPROD,
    refScript: V3_REF_SCRIPT_PREPROD,
    feePercentX100: V3_FEE_PERCENT_X100,
    plutusVersion: "v3",
    network: "preprod",
    feeAddress: V3_FEE_ADDRESS_PREPROD,
  },
];

/** Production (mainnet) registry — the default discovery target. */
export const DEPLOYMENTS: Deployment[] = MAINNET_DEPLOYMENTS;

const ALL_DEPLOYMENTS: Deployment[] = [...MAINNET_DEPLOYMENTS, ...PREPROD_DEPLOYMENTS];

export function deploymentByScriptHash(scriptHash: string): Deployment | undefined {
  const h = scriptHash.toLowerCase();
  return ALL_DEPLOYMENTS.find((d) => d.scriptHash === h);
}

export function deploymentByOrderAddress(orderAddress: string): Deployment | undefined {
  return ALL_DEPLOYMENTS.find((d) => d.orderAddress === orderAddress);
}
