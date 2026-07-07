import { describe, it, expect } from "vitest";
import {
  discoverOneWayOrders,
  discoverOrdersOfferingAsset,
  discoverTwoWayOrders,
  type BeaconProvider,
} from "../../src/cardanoSwapsDiscovery.js";
import {
  encodeOneWaySwapDatumHex,
  encodeTwoWaySwapDatumHex,
  type OneWaySwapDatum,
  type TwoWaySwapDatum,
} from "../../src/cardanoSwapsDatum.js";
import { pairBeacon, offerBeacon, askBeacon, assetBeacon, sortPair } from "../../src/cardanoSwapsBeacons.js";
import type { RawUtxo } from "../../src/discovery.js";

const BEACON = "22".repeat(28);
const TWO_BEACON = "23".repeat(28);
const AA = "aa".repeat(28);
const NM = "54455354";

function oneWayDatum(): OneWaySwapDatum {
  return {
    beaconId: BEACON,
    pairBeacon: pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM }),
    offerId: "",
    offerName: "",
    offerBeacon: offerBeacon("", ""),
    askId: AA,
    askName: NM,
    askBeacon: askBeacon(AA, NM),
    price: { num: 400n, den: 100_000_000n },
    prevInput: null,
    expiration: null,
  };
}

function rawUtxo(datumHex: string | undefined, idx: number): RawUtxo {
  return {
    txHash: "ff".repeat(32),
    outputIndex: idx,
    address: "addr_test1_swap",
    value: { lovelace: 102_000_000n, assets: {} },
    inlineDatumHex: datumHex,
  };
}

class FixtureProvider implements BeaconProvider {
  calls: Array<[string, string]> = [];
  constructor(private byUnit: Record<string, RawUtxo[]>) {}
  async utxosWithAsset(policyId: string, assetName: string): Promise<RawUtxo[]> {
    this.calls.push([policyId, assetName]);
    return this.byUnit[policyId + assetName] ?? [];
  }
}

describe("canonical beacon discovery (decodes SwapDatum, filters garbage)", () => {
  it("queries the directional pair beacon under the one-way policy and decodes valid orders only", async () => {
    const pb = pairBeacon({ policyId: "", assetName: "" }, { policyId: AA, assetName: NM });
    const good = rawUtxo(encodeOneWaySwapDatumHex(oneWayDatum()), 0);
    const garbage = rawUtxo("d8799f00ff", 1); // not a SwapDatum
    const noDatum = rawUtxo(undefined, 2);
    const provider = new FixtureProvider({ [BEACON + pb]: [good, garbage, noDatum] });

    const orders = await discoverOneWayOrders(
      { policyId: "", assetName: "" },
      { policyId: AA, assetName: NM },
      { provider, oneWayBeaconPolicy: BEACON },
    );

    expect(provider.calls).toEqual([[BEACON, pb]]);
    expect(orders.length).toBe(1);
    expect(orders[0]!.kind).toBe("one-way");
    expect(orders[0]!.datum.askId).toBe(AA);
    expect(orders[0]!.scriptValue.lovelace).toBe(102_000_000n);
    expect(orders[0]!.utxo).toEqual({ txHash: "ff".repeat(32), outputIndex: 0 });
  });

  it("discoverOrdersOfferingAsset queries the 0x01 offer beacon", async () => {
    const ob = offerBeacon("", "");
    const provider = new FixtureProvider({ [BEACON + ob]: [rawUtxo(encodeOneWaySwapDatumHex(oneWayDatum()), 0)] });
    const orders = await discoverOrdersOfferingAsset({ policyId: "", assetName: "" }, { provider, oneWayBeaconPolicy: BEACON });
    expect(provider.calls).toEqual([[BEACON, ob]]);
    expect(orders.length).toBe(1);
  });

  it("discoverTwoWayOrders queries the UNPREFIXED sorted-pair beacon and decodes two-way datums", async () => {
    const [a1, a2] = sortPair({ policyId: AA, assetName: NM }, { policyId: "", assetName: "" });
    const pb = pairBeacon(a1, a2);
    const twoWay: TwoWaySwapDatum = {
      beaconId: TWO_BEACON,
      pairBeacon: pb,
      asset1Id: a1.policyId,
      asset1Name: a1.assetName,
      asset1Beacon: assetBeacon(a1.policyId, a1.assetName),
      asset2Id: a2.policyId,
      asset2Name: a2.assetName,
      asset2Beacon: assetBeacon(a2.policyId, a2.assetName),
      asset1Price: { num: 400n, den: 100_000_000n },
      asset2Price: { num: 100_000_000n, den: 400n },
      prevInput: null,
      expiration: null,
    };
    const provider = new FixtureProvider({ [TWO_BEACON + pb]: [rawUtxo(encodeTwoWaySwapDatumHex(twoWay), 0)] });
    const orders = await discoverTwoWayOrders(
      { policyId: AA, assetName: NM },
      { policyId: "", assetName: "" },
      { provider, twoWayBeaconPolicy: TWO_BEACON },
    );
    expect(provider.calls).toEqual([[TWO_BEACON, pb]]);
    expect(orders.length).toBe(1);
    expect(orders[0]!.kind).toBe("two-way");
    expect(orders[0]!.datum.asset2Id).toBe(AA);
  });
});
