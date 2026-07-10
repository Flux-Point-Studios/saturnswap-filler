import { describe, it, expect } from "vitest";
import { credentialToAddress, credentialToRewardAddress } from "@lucid-evolution/lucid";
import {
  CARDANO_SWAPS_MAINNET,
  MAKER_STAKE_REWARD_ADDRESS_MAINNET,
  AEGIS_V7_MAINNET,
} from "../../src/cardanoSwapsMainnet.js";
import {
  makerOrderAddress,
  planCreateOneWaySwap,
  planRepriceOneWaySwap,
  planCancelOneWaySwap,
  type CardanoSwapsDeployment,
  type MakerOrder,
} from "../../src/cardanoSwapsLifecycle.js";
import { pairBeacon, offerBeacon, askBeacon } from "../../src/cardanoSwapsBeacons.js";
import type { OneWaySwapDatum } from "../../src/cardanoSwapsDatum.js";
import { addAsset } from "../../src/cardanoSwapsFill.js";
import type { ChainValue } from "../../src/discovery.js";

// The 2026-07-08 mainnet ceremony (deployment.mainnet.json) — chain-verified.
const DAPP = "1d6cff26bcab91d2061aad0bd259cbb7d76d25ced2eeaed5926a42ad";
const BEACON = "c4d7d117d9ebcde6db28db40837ff2b1401e9eaaa6eecea9e070e209";
const MAKER_STAKE = "8d8f1d08bac89e552f5248af126bfbde09f91dfc78e218f26a565d68";
const BOT = "cea98dfce26e0ffbf5ab892edcb8f8ab8b794d5390f80ec0b9aafed3";
const SPEND_REF = { txHash: "8ae2d109559ce82e9fb067dc361693d28219a675a1b9d95b4ad5aa73bfbae7a5", outputIndex: 0 };
const BEACON_REF = { txHash: "b6125af19042ff26084f16586622a8ee0face80d1c67329f50fb2a50dd7ae0bd", outputIndex: 0 };
const MAKER_STAKE_REF = { txHash: "aa19c20586391c5e3102c5c20d6db5a339dfb7013ed77f32a5b08389d7f6c4ec", outputIndex: 0 };

describe("CARDANO_SWAPS_MAINNET — the ceremony manifest as a typed constant", () => {
  it("pins the canonical hashes and ref-script UTxOs", () => {
    expect(CARDANO_SWAPS_MAINNET.network).toBe("Mainnet");
    expect(CARDANO_SWAPS_MAINNET.dappHash).toBe(DAPP);
    expect(CARDANO_SWAPS_MAINNET.beaconPolicy).toBe(BEACON);
    expect(CARDANO_SWAPS_MAINNET.makerStakeHash).toBe(MAKER_STAKE);
    expect(CARDANO_SWAPS_MAINNET.adamBotPkh).toBe(BOT);
    expect(CARDANO_SWAPS_MAINNET.spendRefUtxo).toEqual(SPEND_REF);
    expect(CARDANO_SWAPS_MAINNET.beaconRefUtxo).toEqual(BEACON_REF);
    expect(CARDANO_SWAPS_MAINNET.makerStakeRefUtxo).toEqual(MAKER_STAKE_REF);
  });

  it("derives the REGISTERED maker_stake reward address (on-chain reg tx c220af41…)", () => {
    expect(
      credentialToRewardAddress("Mainnet", { type: "Script", hash: CARDANO_SWAPS_MAINNET.makerStakeHash }),
    ).toBe(MAKER_STAKE_REWARD_ADDRESS_MAINNET);
    expect(MAKER_STAKE_REWARD_ADDRESS_MAINNET).toBe("stake17xxc78gghtyfu4f02fy27yntl00qn7gal3uwyx8jdft966qdrjl4u");
  });

  it("derives the maker inventory address (dApp spend + maker_stake stake)", () => {
    expect(makerOrderAddress(CARDANO_SWAPS_MAINNET)).toBe(
      "addr1xywkelexhj4er5sxr2ksh5jeewmawmf9emfwatk4jf4y9tvd3uws3wkgne2j75jg4ufxh777p8u3mlrcugv0y6jkt45qhh0v53",
    );
  });
});

// ROTATED pool family (redeployed 2026-07-10; the prior observer embedded the
// preprod publisher VKH). Every value verified on Blockfrost mainnet against the
// Barrier underwrite proof tx 17b64a52fd5531ee9f73c104f7f5b34c1e4de7cc25d0ae017acb8b4e66ff13ef.
describe("AEGIS_V7_MAINNET — chain-verified rotated V7 coverage constants", () => {
  it("pins the pool family hashes + ref UTxOs", () => {
    expect(AEGIS_V7_MAINNET.poolValidatorHash).toBe("cca5c1f2c6195cffe1b82b531417be423b0a3f91b7e741e03cbc6cff");
    expect(AEGIS_V7_MAINNET.poolAddress).toBe("addr1w8x2ts0jccv4ellphq44x9qhheprkz3ljxm7ws0q8j7xelcj85sg4");
    expect(AEGIS_V7_MAINNET.poolNftPolicyId).toBe("9cf48b68374e539babe1bd583151868d031c37a83443ee58b8b2571a");
    // AEGIS_POOL_V7 — asset name unchanged across the rotation.
    expect(AEGIS_V7_MAINNET.poolNftAssetNameHex).toBe("41454749535f504f4f4c5f5637");
    expect(AEGIS_V7_MAINNET.policyValidatorHash).toBe("f2557118860f37dfd6b3fa4a7c5f1a593761d3e1391418efaeb8cf2c");
    expect(AEGIS_V7_MAINNET.markerPolicyId).toBe("7778a648610ee4e87004c867fd40c277d159139d635453fce270f0ab");
    expect(AEGIS_V7_MAINNET.lpTokenPolicyId).toBe("ad155127c7022f435ec0b1be0992de0f72200c9a120f91a70fba2656");
    expect(AEGIS_V7_MAINNET.refs.poolValidator).toEqual({
      txHash: "971bd46c6c97372dde752eb4222afbc237278de8d39a6efd4af85ac1933d487f",
      outputIndex: 0,
    });
    expect(AEGIS_V7_MAINNET.refs.policyValidator).toEqual({
      txHash: "97e95a829240c7ea5612f6aa353fc0efe3e93776c02c07b8bbfebd4d6475e09c",
      outputIndex: 0,
    });
    expect(AEGIS_V7_MAINNET.refs.marker).toEqual({
      txHash: "239c25639661589b8943bba62558d1e293ef944e789e7ea03634987ad68b943f",
      outputIndex: 0,
    });
    expect(AEGIS_V7_MAINNET.refs.lpToken).toEqual({
      txHash: "bf5cd5c2c33f33f546f39826ea36aa9d40bc3158aee293546d1e4163d85f6bc3",
      outputIndex: 0,
    });
  });

  it("derives the pool address from the pool_validator hash", () => {
    expect(credentialToAddress("Mainnet", { type: "Script", hash: AEGIS_V7_MAINNET.poolValidatorHash })).toBe(
      AEGIS_V7_MAINNET.poolAddress,
    );
  });

  it("pins the rotated oracle observer (hash, ref, REGISTERED reward account — reg tx 387de8bd…)", () => {
    expect(AEGIS_V7_MAINNET.observer.scriptHash).toBe("f6b8c654c582f7b8b57ae5f7c6066317e90846263391589878f88cac");
    expect(AEGIS_V7_MAINNET.observer.refUtxo).toEqual({
      txHash: "f01c779b5a13c41aa271e61642f3c7bf3c8c1ff047598679317b824dad80eb80",
      outputIndex: 0,
    });
    expect(
      credentialToRewardAddress("Mainnet", { type: "Script", hash: AEGIS_V7_MAINNET.observer.scriptHash }),
    ).toBe(AEGIS_V7_MAINNET.observer.rewardAddress);
    expect(AEGIS_V7_MAINNET.observer.rewardAddress).toBe(
      "stake178mt33j5ckp00w940tjl03sxvvt7jzzxyceezkyc0rugetqpcypmh",
    );
  });

  it("pins the AegisSelf publisher + the ADA/USD barrier feed policy", () => {
    expect(AEGIS_V7_MAINNET.publisher.vkh).toBe("bb09f43245759995440388db9ef3f8a614246e8da1dd9bd053261347");
    expect(AEGIS_V7_MAINNET.feeds.ADA_USD).toBe("f0f14cd0dd1cae52398360e3e4001375000032cb392cb3efeb342301");
  });
});

// ---- makerStakeRefUtxo lands in refInputs for recipes that execute maker_stake ----

function makerOrderFixture(deployment: CardanoSwapsDeployment): MakerOrder {
  const offer = { policyId: "", assetName: "" };
  const ask = { policyId: "aa".repeat(28), assetName: "54455354" };
  const datum: OneWaySwapDatum = {
    beaconId: deployment.beaconPolicy,
    pairBeacon: pairBeacon(offer, ask),
    offerId: offer.policyId,
    offerName: offer.assetName,
    offerBeacon: offerBeacon(offer.policyId, offer.assetName),
    askId: ask.policyId,
    askName: ask.assetName,
    askBeacon: askBeacon(ask.policyId, ask.assetName),
    price: { num: 400n, den: 100_000_000n },
    prevInput: null,
    expiration: null,
  };
  let v: ChainValue = { lovelace: 102_000_000n, assets: {} };
  v = addAsset(v, datum.beaconId, datum.pairBeacon, 1n);
  v = addAsset(v, datum.beaconId, datum.offerBeacon, 1n);
  v = addAsset(v, datum.beaconId, datum.askBeacon, 1n);
  return {
    datum,
    utxo: { txHash: "11".repeat(32), outputIndex: 0 },
    scriptValue: v,
    address: makerOrderAddress(deployment),
  };
}

describe("maker_stake reference script wiring (CIP-33 instead of inline attach)", () => {
  const withoutRef: CardanoSwapsDeployment = { ...CARDANO_SWAPS_MAINNET, makerStakeRefUtxo: undefined };

  it("reprice: refInputs carry spend + beacon + maker_stake refs on mainnet", () => {
    const r = planRepriceOneWaySwap({
      deployment: CARDANO_SWAPS_MAINNET,
      order: makerOrderFixture(CARDANO_SWAPS_MAINNET),
      newPrice: { num: 500n, den: 100_000_000n },
    });
    expect(r.refInputs).toEqual([SPEND_REF, BEACON_REF, MAKER_STAKE_REF]);
  });

  it("cancel: refInputs carry spend + beacon + maker_stake refs on mainnet", () => {
    const r = planCancelOneWaySwap({
      deployment: CARDANO_SWAPS_MAINNET,
      order: makerOrderFixture(CARDANO_SWAPS_MAINNET),
      payoutAddressBech32: makerOrderAddress(CARDANO_SWAPS_MAINNET),
    });
    expect(r.refInputs).toEqual([SPEND_REF, BEACON_REF, MAKER_STAKE_REF]);
  });

  it("create executes no maker_stake — refInputs stay beacon-only", () => {
    const r = planCreateOneWaySwap({
      deployment: CARDANO_SWAPS_MAINNET,
      offer: { policyId: "", assetName: "", amount: 100_000_000n },
      ask: { policyId: "aa".repeat(28), assetName: "54455354" },
      price: { num: 400n, den: 100_000_000n },
      stake: { type: "script", hash: CARDANO_SWAPS_MAINNET.makerStakeHash },
    });
    expect(r.refInputs).toEqual([BEACON_REF]);
  });

  it("back-compat: a deployment without makerStakeRefUtxo (preprod inline-attach harness) keeps the old refInputs", () => {
    const r = planRepriceOneWaySwap({
      deployment: withoutRef,
      order: makerOrderFixture(withoutRef),
      newPrice: { num: 500n, den: 100_000_000n },
    });
    expect(r.refInputs).toEqual([SPEND_REF, BEACON_REF]);
  });
});
