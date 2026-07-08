// Mainnet deployment constants — the 2026-07-08 ceremony (deployment.mainnet.json)
// plus the chain-verified Aegis V7 coverage manifest. Every hash and ref UTxO here
// was verified on-chain against Blockfrost before being pinned.
//
// Ceremony txs: spend ref 8ae2d109…#0, beacon ref b6125af1…#0, maker_stake ref
// aa19c205…#0, maker_stake stake reg c220af41…, oracle_observer stake reg 3d6d55f5….

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
    /** Registered on-chain (tx 3d6d55f5…) — the withdraw-0 attestation validates. */
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
  poolValidatorHash: "4aad412f98302e6aa5aa5c27bf003cbe20361ab276fba919bfacd502",
  poolAddress: "addr1w9926sf0nqczu6494fwz00cq8jlzqds6kfm0h2geh7kd2qs70dmj2",
  poolNftPolicyId: "a48f89cf5a52226a2f8226b1af033507594ded136031575a3b028154",
  poolNftAssetNameHex: "41454749535f504f4f4c5f5637",
  policyValidatorHash: "ccd5f3330fe223c12131543e93fa10b5e6e4acb334e454efd25331b3",
  markerPolicyId: "f3247570b5bb33abadfbba2fc6e9b9d4918194b9b4146debcf88ab3e",
  lpTokenPolicyId: "80c13796e6933eeb7322b095f6453be1dcd10caded381af949754b08",
  refs: {
    poolValidator: { txHash: "fff6be5a24fe27198ae3646335367d29a4d6e480b842939bbc3d66d66d56b34e", outputIndex: 0 },
    policyValidator: { txHash: "d27c1dcab43bbffd91941fb87280711f800362483bc0f3560a336cb9801d8d92", outputIndex: 0 },
    marker: { txHash: "539a186e872766ba7ead19f445b7a2e118b87ff2c3c977b8facdda46dde9092b", outputIndex: 0 },
    lpToken: { txHash: "3fb3d78475938273485999b8d4c58d630ef75f4599d47047887c7ca9216f78fd", outputIndex: 0 },
  },
  observer: {
    scriptHash: "669d5a25489c00aab367c3b9b71630efd523623ca13bbe0e1bd59752",
    refUtxo: { txHash: "69cb524f8311757b3989c056a7a92de394597e1f05c82d2bbbfa2dca02549fca", outputIndex: 0 },
    rewardAddress: "stake179nf6k39fzwqp24nvlpmndckxrha2gmz8jsnh0swr02ew5sx750sa",
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
