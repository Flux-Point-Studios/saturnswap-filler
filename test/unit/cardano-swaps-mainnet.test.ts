import { describe, it, expect } from "vitest";
import { credentialToRewardAddress } from "@lucid-evolution/lucid";
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

describe("AEGIS_V7_MAINNET — chain-verified V7 coverage constants", () => {
  it("pins the pool family hashes + ref UTxOs", () => {
    expect(AEGIS_V7_MAINNET.poolValidatorHash).toBe("4aad412f98302e6aa5aa5c27bf003cbe20361ab276fba919bfacd502");
    expect(AEGIS_V7_MAINNET.poolAddress).toBe("addr1w9926sf0nqczu6494fwz00cq8jlzqds6kfm0h2geh7kd2qs70dmj2");
    expect(AEGIS_V7_MAINNET.poolNftPolicyId).toBe("a48f89cf5a52226a2f8226b1af033507594ded136031575a3b028154");
    expect(AEGIS_V7_MAINNET.markerPolicyId).toBe("f3247570b5bb33abadfbba2fc6e9b9d4918194b9b4146debcf88ab3e");
    expect(AEGIS_V7_MAINNET.refs.poolValidator).toEqual({
      txHash: "fff6be5a24fe27198ae3646335367d29a4d6e480b842939bbc3d66d66d56b34e",
      outputIndex: 0,
    });
    expect(AEGIS_V7_MAINNET.refs.marker).toEqual({
      txHash: "539a186e872766ba7ead19f445b7a2e118b87ff2c3c977b8facdda46dde9092b",
      outputIndex: 0,
    });
  });

  it("pins the oracle observer (hash, ref, REGISTERED reward account — reg tx 3d6d55f5…)", () => {
    expect(AEGIS_V7_MAINNET.observer.scriptHash).toBe("669d5a25489c00aab367c3b9b71630efd523623ca13bbe0e1bd59752");
    expect(AEGIS_V7_MAINNET.observer.refUtxo).toEqual({
      txHash: "69cb524f8311757b3989c056a7a92de394597e1f05c82d2bbbfa2dca02549fca",
      outputIndex: 0,
    });
    expect(
      credentialToRewardAddress("Mainnet", { type: "Script", hash: AEGIS_V7_MAINNET.observer.scriptHash }),
    ).toBe(AEGIS_V7_MAINNET.observer.rewardAddress);
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
