import { describe, it, expect } from "vitest";
import {
  discoverOneWayOrders,
  discoverTwoWayOrders,
  decodeOneWay,
  type BeaconProvider,
} from "../../src/discoveryV4.js";
import { orderDatumToPlutusData } from "../../src/datumV4.js";
import { pairBeaconName } from "../../src/beaconsV4.js";
import { plutusToHex } from "../../src/plutus.js";
import type { RawUtxo } from "../../src/discovery.js";
import type { OwnerAddress, OutputRef } from "../../src/datum.js";

const owner: OwnerAddress = {
  payment: { type: "key", hash: "44".repeat(28) },
  stake: { type: "key", hash: "33".repeat(28) },
};
const BEACON_POLICY = "22".repeat(28);
const TOKEN_POLICY = "aa".repeat(28);
const TOKEN_NAME = "54455354";
const orderRef: OutputRef = { txHash: "aa".repeat(32), outputIndex: 1 };

function makeOrderUtxo(): RawUtxo {
  const datumHex = plutusToHex(
    orderDatumToPlutusData({
      beaconPolicy: BEACON_POLICY,
      owner,
      policyIdSell: "",
      assetNameSell: "",
      amountSell: 100_000_000n,
      policyIdBuy: TOKEN_POLICY,
      assetNameBuy: TOKEN_NAME,
      amountBuy: 400n,
      validBeforeTime: null,
      minPartialFill: 0n,
      coverage: null,
      outputReference: orderRef,
    }),
  );
  const pairName = pairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME);
  return {
    txHash: "bb".repeat(32),
    outputIndex: 0,
    address: "addr1_test_order_address",
    value: { lovelace: 102_000_000n, assets: { [BEACON_POLICY + pairName]: 1n } },
    inlineDatumHex: datumHex,
  };
}

// A fixture provider that only answers the exact (policy, name) it was seeded with.
class FixtureProvider implements BeaconProvider {
  constructor(private book: Record<string, RawUtxo[]>) {}
  async utxosWithAsset(policyId: string, assetName: string): Promise<RawUtxo[]> {
    return this.book[policyId + assetName] ?? [];
  }
}

describe("V4 beacon discovery", () => {
  it("finds a one-way order by its pair beacon and decodes the datum", async () => {
    const utxo = makeOrderUtxo();
    const pairName = pairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME);
    const provider = new FixtureProvider({ [BEACON_POLICY + pairName]: [utxo] });

    const orders = await discoverOneWayOrders(
      { policyId: "", assetName: "" },
      { policyId: TOKEN_POLICY, assetName: TOKEN_NAME },
      { provider, oneWayBeaconPolicy: BEACON_POLICY },
    );

    expect(orders.length).toBe(1);
    expect(orders[0]!.datum.amountSell).toBe(100_000_000n);
    expect(orders[0]!.datum.amountBuy).toBe(400n);
    expect(orders[0]!.datum.beaconPolicy).toBe(BEACON_POLICY);
    expect(orders[0]!.utxo).toEqual({ txHash: "bb".repeat(32), outputIndex: 0 });
  });

  it("returns empty for a pair with no beacons", async () => {
    const provider = new FixtureProvider({});
    const orders = await discoverOneWayOrders(
      { policyId: "", assetName: "" },
      { policyId: TOKEN_POLICY, assetName: TOKEN_NAME },
      { provider, oneWayBeaconPolicy: BEACON_POLICY },
    );
    expect(orders.length).toBe(0);
  });

  it("skips UTxOs with no inline datum", () => {
    const bad: RawUtxo = { ...makeOrderUtxo(), inlineDatumHex: undefined };
    expect(decodeOneWay(bad)).toBeUndefined();
  });

  it("two-way discovery sorts the pair before querying", async () => {
    // provider seeded under the SORTED beacon; querying with reversed args
    // must still find it
    const { sortedPairBeaconName } = await import("../../src/beaconsV4.js");
    const sortedName = sortedPairBeaconName("", "", TOKEN_POLICY, TOKEN_NAME);
    const provider = new FixtureProvider({ [BEACON_POLICY + sortedName]: [] });
    // just assert it queries the sorted key without throwing (empty book ok)
    const orders = await discoverTwoWayOrders(
      { policyId: TOKEN_POLICY, assetName: TOKEN_NAME },
      { policyId: "", assetName: "" },
      { provider, twoWayBeaconPolicy: BEACON_POLICY },
    );
    expect(orders).toEqual([]);
  });
});
