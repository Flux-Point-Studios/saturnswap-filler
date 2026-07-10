// Mainnet deployment constants — the 2026-07-08 cardano-swaps ceremony
// (deployment.mainnet.json) plus the ROTATED Aegis V7 coverage manifest
// (redeployed 2026-07-10; the prior pool family shipped a defective observer
// that embedded the preprod publisher VKH, so no mainnet feed could attest).
// Every hash and ref UTxO here was verified on-chain against Blockfrost mainnet.
//
// cardano-swaps ceremony txs (UNCHANGED): spend ref 8ae2d109…#0, beacon ref
// b6125af1…#0, maker_stake ref aa19c205…#0, maker_stake stake reg c220af41….
// Aegis V7 rotation proof: Barrier underwrite tx 17b64a52… minted the first
// coverage marker and passed the observer withdraw-0; observer reward reg tx
// 387de8bd…. The pool UTxO is identified by the AEGIS_POOL_V7 NFT (pool_nft
// policy) at the pool_validator; a coverage policy is identified by the
// AEGIS_POLICY marker (marker policy) at the policy_validator.

import type { CardanoSwapsDeployment } from "./cardanoSwapsLifecycle.js";
import type { OutputRef } from "./datum.js";

export const CARDANO_SWAPS_MAINNET: CardanoSwapsDeployment = {
  network: "Mainnet",
  dappHash: "1d6cff26bcab91d2061aad0bd259cbb7d76d25ced2eeaed5926a42ad",
  beaconPolicy: "c4d7d117d9ebcde6db28db40837ff2b1401e9eaaa6eecea9e070e209",
  makerStakeHash: "8d8f1d08bac89e552f5248af126bfbde09f91dfc78e218f26a565d68",
  adamBotPkh: "cea98dfce26e0ffbf5ab892edcb8f8ab8b794d5390f80ec0b9aafed3",
  spendRefUtxo: { txHash: "8ae2d109559ce82e9fb067dc361693d28219a675a1b9d95b4ad5aa73bfbae7a5", outputIndex: 0 },
  beaconRefUtxo: { txHash: "b6125af19042ff26084f16586622a8ee0face80d1c67329f50fb2a50dd7ae0bd", outputIndex: 0 },
  makerStakeRefUtxo: { txHash: "aa19c20586391c5e3102c5c20d6db5a339dfb7013ed77f32a5b08389d7f6c4ec", outputIndex: 0 },
};

/** Registered on-chain (tx c220af41…, epoch 641) — withdraw-0 owner-auth is live. */
export const MAKER_STAKE_REWARD_ADDRESS_MAINNET =
  "stake17xxc78gghtyfu4f02fy27yntl00qn7gal3uwyx8jdft966qdrjl4u";

export interface AegisV7Mainnet {
  poolValidatorHash: string;
  poolAddress: string;
  poolNftPolicyId: string;
  /** "AEGIS_POOL_V7" */
  poolNftAssetNameHex: string;
  policyValidatorHash: string;
  markerPolicyId: string;
  lpTokenPolicyId: string;
  refs: {
    poolValidator: OutputRef;
    policyValidator: OutputRef;
    marker: OutputRef;
    lpToken: OutputRef;
  };
  observer: {
    scriptHash: string;
    refUtxo: OutputRef;
    /** Registered on-chain (tx 387de8bd…) — the withdraw-0 attestation validates. */
    rewardAddress: string;
  };
  publisher: {
    /** The canonical AegisSelf publisher — feeds live at this exact address. */
    address: string;
    /** Its payment credential; the on-chain parser pins feeds to this VKH. */
    vkh: string;
  };
  /** Feed-NFT policy ids (asset name "AEGIS_P" on the live UTxO). The feed UTxO
   *  itself rotates every publish — discover it at build time, never pin it. */
  feeds: Record<"ADA_USD" | "BTC_USD" | "ETH_USD" | "USDC_USD" | "USDT_USD" | "USDM_USD" | "IUSD_USD", string>;
}

export const AEGIS_V7_MAINNET: AegisV7Mainnet = {
  poolValidatorHash: "cca5c1f2c6195cffe1b82b531417be423b0a3f91b7e741e03cbc6cff",
  poolAddress: "addr1w8x2ts0jccv4ellphq44x9qhheprkz3ljxm7ws0q8j7xelcj85sg4",
  poolNftPolicyId: "9cf48b68374e539babe1bd583151868d031c37a83443ee58b8b2571a",
  poolNftAssetNameHex: "41454749535f504f4f4c5f5637",
  policyValidatorHash: "f2557118860f37dfd6b3fa4a7c5f1a593761d3e1391418efaeb8cf2c",
  markerPolicyId: "7778a648610ee4e87004c867fd40c277d159139d635453fce270f0ab",
  lpTokenPolicyId: "ad155127c7022f435ec0b1be0992de0f72200c9a120f91a70fba2656",
  refs: {
    poolValidator: { txHash: "971bd46c6c97372dde752eb4222afbc237278de8d39a6efd4af85ac1933d487f", outputIndex: 0 },
    policyValidator: { txHash: "97e95a829240c7ea5612f6aa353fc0efe3e93776c02c07b8bbfebd4d6475e09c", outputIndex: 0 },
    marker: { txHash: "239c25639661589b8943bba62558d1e293ef944e789e7ea03634987ad68b943f", outputIndex: 0 },
    lpToken: { txHash: "bf5cd5c2c33f33f546f39826ea36aa9d40bc3158aee293546d1e4163d85f6bc3", outputIndex: 0 },
  },
  observer: {
    scriptHash: "f6b8c654c582f7b8b57ae5f7c6066317e90846263391589878f88cac",
    refUtxo: { txHash: "f01c779b5a13c41aa271e61642f3c7bf3c8c1ff047598679317b824dad80eb80", outputIndex: 0 },
    rewardAddress: "stake178mt33j5ckp00w940tjl03sxvvt7jzzxyceezkyc0rugetqpcypmh",
  },
  publisher: {
    address:
      "addr1qxasnapjg46en92yqwydh8hnlznpgfrw3ksamx7s2vnpx37mhqv8f4lgc96cj6q4upk62yfa0qm3l5fr6er5z5s7p80s8nnsfx",
    vkh: "bb09f43245759995440388db9ef3f8a614246e8da1dd9bd053261347",
  },
  feeds: {
    ADA_USD: "f0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301",
    BTC_USD: "99e8fe4f9d2a4a85f5e3f20d37b10048ce54e4a03e56d9fd492163b3",
    ETH_USD: "a8c5354a4813f2b3f60836839b8842a9422186f4f15511790ec95f9c",
    USDC_USD: "a8231f0c10b514659fd590f6ee7420acf4e145cce36909a7f5fe1c5e",
    USDT_USD: "82a324a3de0be7bc9c4b8450db5350cf0479fa1393eb8eee2481c652",
    USDM_USD: "b99998ba0353f47137fb9499da624b63a855d60719d4902777312439",
    IUSD_USD: "f6458f3b7a6b2027fe89c39a622956336ec3253b7d65971f0cb64b02",
  },
};
