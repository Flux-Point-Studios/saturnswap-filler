import { describe, it, expect } from "vitest";
import {
  planCreateOneWaySwap,
  planRepriceOneWaySwap,
  planCancelOneWaySwap,
  makerOrderAddress,
  orderAddressFor,
  MAKER_STAKE_REDEEMER_HEX,
  type CardanoSwapsDeployment,
} from "../../src/cardanoSwapsLifecycle.js";
import {
  decodeOneWaySwapDatumHex,
  SPEND_WITH_STAKE_HEX,
  SPEND_WITH_MINT_HEX,
  CREATE_OR_CLOSE_SWAPS_HEX,
  UPDATE_SWAPS_HEX,
} from "../../src/cardanoSwapsDatum.js";
import { pairBeacon, offerBeacon, askBeacon } from "../../src/cardanoSwapsBeacons.js";
import { assetsToChainValue } from "../../src/cardanoSwapsFill.js";
import type { OutputRef, Credential } from "../../src/datum.js";

const AA = "aa".repeat(28);
const NM = "54455354";

const deployment: CardanoSwapsDeployment = {
  network: "Preprod",
  dappHash: "dd".repeat(28),
  beaconPolicy: "bb".repeat(28),
  makerStakeHash: "cc".repeat(28),
  adamBotPkh: "01".repeat(28),
  spendRefUtxo: { txHash: "ab".repeat(32), outputIndex: 0 },
  beaconRefUtxo: { txHash: "cd".repeat(32), outputIndex: 1 },
};
const makerStake: Credential = { type: "script", hash: deployment.makerStakeHash };
const orderRef: OutputRef = { txHash: "ee".repeat(32), outputIndex: 0 };

const PB = pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM });
const OB = offerBeacon("", "");
const ABN = askBeacon(AA, NM);

function created() {
  return planCreateOneWaySwap({
    deployment,
    offer: { policyId: "", assetName: "", amount: 100_000_000n },
    ask: { policyId: AA, assetName: NM },
    price: { num: 400n, den: 100_000_000n },
    stake: makerStake,
  });
}

function makerOrder() {
  const r = created();
  const out = r.outputs[0]!;
  return {
    datum: decodeOneWaySwapDatumHex(out.inlineDatumHex),
    utxo: orderRef,
    scriptValue: assetsToChainValue(out.assets),
    address: makerOrderAddress(deployment),
  };
}

describe("canonical create (CreateOrCloseSwaps beacon mint at the dApp+stake address)", () => {
  it("mints the 3 beacons (+1 each) with the CreateOrCloseSwaps redeemer; no spend/withdraw/signer", () => {
    const r = created();
    expect(r.action).toBe("create");
    expect(r.spends).toEqual([]);
    expect(r.withdrawals).toEqual([]);
    expect(r.requiredSigners).toEqual([]);
    expect(r.mints.length).toBe(1);
    expect(r.mints[0]!.redeemerHex).toBe(CREATE_OR_CLOSE_SWAPS_HEX);
    const units = new Set(r.mints[0]!.assets.map((a) => a.unit));
    expect(units).toEqual(
      new Set([deployment.beaconPolicy + PB, deployment.beaconPolicy + OB, deployment.beaconPolicy + ABN]),
    );
    for (const a of r.mints[0]!.assets) expect(a.quantity).toBe(1n);
    expect(r.refInputs).toEqual([deployment.beaconRefUtxo]);
  });

  it("emits one order UTxO at the dApp+maker_stake address with the canonical datum (prev_input=None)", () => {
    const r = created();
    expect(r.outputs.length).toBe(1);
    expect(r.outputs[0]!.addressBech32).toBe(makerOrderAddress(deployment));
    const d = decodeOneWaySwapDatumHex(r.outputs[0]!.inlineDatumHex);
    expect(d.beaconId).toBe(deployment.beaconPolicy);
    expect(d.prevInput).toBeNull();
    expect(d.price).toEqual({ num: 400n, den: 100_000_000n });
    expect(d.pairBeacon).toBe(PB);
    // value: offer ADA + deposit + 3 beacons
    expect(r.outputs[0]!.assets.lovelace).toBeGreaterThanOrEqual(100_000_000n);
    expect(r.outputs[0]!.assets[deployment.beaconPolicy + PB]).toBe(1n);
  });

  it("a user-staked order (pubkey stake) sits at a DIFFERENT address than the maker inventory", () => {
    const userStake: Credential = { type: "key", hash: "44".repeat(28) };
    expect(orderAddressFor(deployment, userStake)).not.toBe(makerOrderAddress(deployment));
  });

  it("rejects an expiration that is not on a 1-minute boundary (on-chain % 60000 rule)", () => {
    expect(() =>
      planCreateOneWaySwap({
        deployment,
        offer: { policyId: "", assetName: "", amount: 100_000_000n },
        ask: { policyId: AA, assetName: NM },
        price: { num: 400n, den: 100_000_000n },
        stake: makerStake,
        expiration: 1_800_000_000_001n,
      }),
    ).toThrow(/1-min/);
  });
});

describe("canonical reprice (SpendWithStake + UpdateSwaps withdraw-0 + maker_stake withdraw-0 + bot sig)", () => {
  it("spends the order with SpendWithStake and carries no beacon mint", () => {
    const r = planRepriceOneWaySwap({ deployment, order: makerOrder(), newPrice: { num: 450n, den: 100_000_000n } });
    expect(r.action).toBe("reprice");
    expect(r.spends.length).toBe(1);
    expect(r.spends[0]!.orderRef).toEqual(orderRef);
    expect(r.spends[0]!.redeemerHex).toBe(SPEND_WITH_STAKE_HEX);
    expect(r.mints).toEqual([]);
  });

  it("carries BOTH withdraw-0s: the beacon policy (UpdateSwaps) and maker_stake, plus the ADAM bot signer", () => {
    const r = planRepriceOneWaySwap({ deployment, order: makerOrder(), newPrice: { num: 450n, den: 100_000_000n } });
    const wd = new Map(r.withdrawals.map((w) => [w.stakeScriptHash, w.redeemerHex]));
    expect(wd.get(deployment.beaconPolicy)).toBe(UPDATE_SWAPS_HEX);
    expect(wd.get(deployment.makerStakeHash)).toBe(MAKER_STAKE_REDEEMER_HEX);
    expect(r.requiredSigners).toEqual([deployment.adamBotPkh]);
    expect(r.refInputs).toEqual([deployment.spendRefUtxo, deployment.beaconRefUtxo]);
  });

  it("continuation carries the new price, prev_input=None, at the SAME order address", () => {
    const order = makerOrder();
    const r = planRepriceOneWaySwap({ deployment, order, newPrice: { num: 450n, den: 100_000_000n } });
    expect(r.outputs.length).toBe(1);
    expect(r.outputs[0]!.addressBech32).toBe(order.address);
    const cont = decodeOneWaySwapDatumHex(r.outputs[0]!.inlineDatumHex);
    expect(cont.price).toEqual({ num: 450n, den: 100_000_000n });
    expect(cont.prevInput).toBeNull();
    expect(cont.pairBeacon).toBe(PB);
    // beacons preserved in the continuation value
    expect(r.outputs[0]!.assets[deployment.beaconPolicy + PB]).toBe(1n);
  });
});

describe("canonical cancel (SpendWithMint + beacon burn + maker_stake withdraw-0 + bot sig)", () => {
  it("spends with SpendWithMint and burns the 3 beacons (-1 each) via CreateOrCloseSwaps", () => {
    const r = planCancelOneWaySwap({ deployment, order: makerOrder(), payoutAddressBech32: makerOrderAddress(deployment) });
    expect(r.action).toBe("cancel");
    expect(r.spends[0]!.redeemerHex).toBe(SPEND_WITH_MINT_HEX);
    expect(r.mints.length).toBe(1);
    expect(r.mints[0]!.redeemerHex).toBe(CREATE_OR_CLOSE_SWAPS_HEX);
    for (const a of r.mints[0]!.assets) expect(a.quantity).toBe(-1n);
  });

  it("carries only the maker_stake withdraw-0 (beacon runs as mint) + the bot signer; payout is beacon-free", () => {
    const r = planCancelOneWaySwap({ deployment, order: makerOrder(), payoutAddressBech32: makerOrderAddress(deployment) });
    expect(r.withdrawals.length).toBe(1);
    expect(r.withdrawals[0]!.stakeScriptHash).toBe(deployment.makerStakeHash);
    expect(r.withdrawals[0]!.redeemerHex).toBe(MAKER_STAKE_REDEEMER_HEX);
    expect(r.requiredSigners).toEqual([deployment.adamBotPkh]);
    expect(r.outputs[0]!.assets[deployment.beaconPolicy + PB]).toBeUndefined();
    expect(r.refInputs).toEqual([deployment.spendRefUtxo, deployment.beaconRefUtxo]);
  });
});
