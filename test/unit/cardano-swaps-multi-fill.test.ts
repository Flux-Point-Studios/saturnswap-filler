// Multi-fill planner (cardanoSwapsMultiFill.ts) + ceremony-script fixture provenance.
// The emulator benchmark (scripts/bench-compose-ceiling.ts) exercises the assembler
// end-to-end against the real validator; these tests cover the pure planner math
// and pin the fixture bytes to the on-chain ceremony hashes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import { credentialToAddress, type UTxO } from "@lucid-evolution/lucid";
import { bytesToHex, hexToBytes } from "../../src/cbor.js";
import { unit } from "../../src/discovery.js";
import { planOneWayMultiFill, maxAdaOfferTake } from "../../src/cardanoSwapsMultiFill.js";
import { cardanoSwapsComposable, type OneWayOrder } from "../../src/cardanoSwapsFill.js";
import { minUtxoLovelace } from "../../src/minUtxo.js";
import { CARDANO_SWAPS_COINS_PER_UTXO_BYTE } from "../../src/cardanoSwapsLifecycle.js";
import { CARDANO_SWAPS_MAINNET } from "../../src/cardanoSwapsMainnet.js";

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "cardano-swaps-mainnet-scripts.json"), "utf8"),
);

const TOKEN = { policyId: "de".repeat(28), assetName: "42454e4348" };
// dApp payment cred (ceremony hash) + an arbitrary key stake cred
const ADDR = credentialToAddress(
  "Custom",
  { type: "Script", hash: CARDANO_SWAPS_MAINNET.dappHash },
  { type: "Key", hash: "ce".repeat(28) },
);

function mkOrder(i: number, sell: boolean, reserves: bigint, lovelace: bigint): OneWayOrder {
  return {
    kind: "one-way",
    utxo: { txHash: String(i).repeat(64).slice(0, 64), outputIndex: 0 },
    address: ADDR,
    datum: {
      beaconId: "c4".repeat(28),
      pairBeacon: "ab".repeat(32),
      offerId: sell ? TOKEN.policyId : "",
      offerName: sell ? TOKEN.assetName : "",
      offerBeacon: "cd".repeat(32),
      askId: sell ? "" : TOKEN.policyId,
      askName: sell ? "" : TOKEN.assetName,
      askBeacon: "ef".repeat(32),
      price: { num: 1n, den: 1n },
      prevInput: null,
      expiration: null,
    },
    scriptValue: sell
      ? { lovelace, assets: { [unit(TOKEN.policyId, TOKEN.assetName)]: reserves } }
      : { lovelace: lovelace + reserves, assets: {} },
  };
}

function mkUtxo(order: OneWayOrder): UTxO {
  return { txHash: order.utxo.txHash, outputIndex: order.utxo.outputIndex, address: order.address, assets: {} } as UTxO;
}

describe("ceremony-script fixture provenance", () => {
  it("script bytes hash to the deployed ceremony hashes (blake2b224(0x02 ++ bytes))", () => {
    for (const key of ["oneWaySpend", "oneWayBeacon"] as const) {
      const e = FIXTURE[key];
      const h = bytesToHex(blake2b(new Uint8Array([0x02, ...hexToBytes(e.cborHex)]), { dkLen: 28 }));
      expect(h).toBe(e.hash);
    }
    expect(FIXTURE.oneWaySpend.hash).toBe(CARDANO_SWAPS_MAINNET.dappHash);
    expect(FIXTURE.oneWayBeacon.hash).toBe(CARDANO_SWAPS_MAINNET.beaconPolicy);
  });

  it("fixture ref UTxOs are the ceremony reference-script UTxOs", () => {
    expect(FIXTURE.oneWaySpend.refUtxo).toEqual(CARDANO_SWAPS_MAINNET.spendRefUtxo);
    expect(FIXTURE.oneWayBeacon.refUtxo).toEqual(CARDANO_SWAPS_MAINNET.beaconRefUtxo);
  });
});

describe("planOneWayMultiFill — intra-tx netting", () => {
  it("a paired round-trip (TOKEN→ADA + ADA→TOKEN at 1:1) nets both deltas to zero", () => {
    const sellOrder = mkOrder(1, true, 20_000_000n, 2_000_000n);
    const buyOrder = mkOrder(2, false, 20_000_000n, 2_000_000n);
    const plan = planOneWayMultiFill([
      { order: sellOrder, orderUtxo: mkUtxo(sellOrder), offerTaken: 1_000_000n },
      { order: buyOrder, orderUtxo: mkUtxo(buyOrder), offerTaken: 1_000_000n },
    ]);
    expect(plan.fills).toHaveLength(2);
    expect(plan.netTokenDelta).toEqual({}); // taker needs zero TOKEN
    expect(plan.netAdaOutflow).toBe(0n); // and zero net ADA (fee/min-UTxO aside)
    expect(plan.grossNotionalLovelace).toBe(2_000_000n); // both ADA legs count
  });

  it("an unpaired leg surfaces as a signed net delta", () => {
    const sellOrder = mkOrder(3, true, 20_000_000n, 2_000_000n);
    const plan = planOneWayMultiFill([{ order: sellOrder, orderUtxo: mkUtxo(sellOrder), offerTaken: 500_000n }]);
    expect(plan.netTokenDelta).toEqual({ [unit(TOKEN.policyId, TOKEN.assetName)]: 500_000n });
    expect(plan.netAdaOutflow).toBe(500_000n); // ask is ADA at 1:1
  });

  it("rejects spending the same order twice in one tx", () => {
    const order = mkOrder(4, true, 20_000_000n, 2_000_000n);
    expect(() =>
      planOneWayMultiFill([
        { order, orderUtxo: mkUtxo(order), offerTaken: 1n },
        { order, orderUtxo: mkUtxo(order), offerTaken: 1n },
      ]),
    ).toThrow(/duplicate order/);
  });
});

describe("min-UTxO floor guard on ADA-offering orders", () => {
  it("caps the take so the continuation keeps its floor, and rejects an over-take", () => {
    const buyOrder = mkOrder(5, false, 20_000_000n, 2_000_000n); // 22 ADA total
    const cap = maxAdaOfferTake(buyOrder);
    expect(cap).toBeGreaterThan(15_000_000n);
    expect(cap).toBeLessThan(21_000_000n); // floor reserved
    expect(() =>
      planOneWayMultiFill([{ order: buyOrder, orderUtxo: mkUtxo(buyOrder), offerTaken: cap + 1n }]),
    ).toThrow(/min-UTxO floor/);
    const ok = planOneWayMultiFill([{ order: buyOrder, orderUtxo: mkUtxo(buyOrder), offerTaken: cap }]);
    expect(ok.fills).toHaveLength(1);
    // The cap must be safe ON-CHAIN, not just off-chain: build the REAL continuation at
    // `cap` and assert its lovelace clears its true min-UTxO floor (the MEDIUM the red-team
    // caught — the old cap was undersized by the ask-quantity CBOR-byte delta).
    const cont = cardanoSwapsComposable({ order: buyOrder, orderUtxo: mkUtxo(buyOrder), offerTaken: cap }).fill.outputs[0]!;
    const floor = minUtxoLovelace(
      { addressBech32: cont.address, assets: cont.value, inlineDatumHex: cont.datum },
      CARDANO_SWAPS_COINS_PER_UTXO_BYTE,
    );
    expect(cont.value["lovelace"]!).toBeGreaterThanOrEqual(floor);
    // And one lovelace more of take must breach it (cap is the true boundary, not conservative slack).
    const contOver = cardanoSwapsComposable({ order: buyOrder, orderUtxo: mkUtxo(buyOrder), offerTaken: cap + 1n }).fill.outputs[0]!;
    const floorOver = minUtxoLovelace(
      { addressBech32: contOver.address, assets: contOver.value, inlineDatumHex: contOver.datum },
      CARDANO_SWAPS_COINS_PER_UTXO_BYTE,
    );
    expect(contOver.value["lovelace"]!).toBeLessThan(floorOver);
  });

  it("token-offering orders cap at their full reserve", () => {
    const sellOrder = mkOrder(6, true, 20_000_000n, 2_000_000n);
    expect(maxAdaOfferTake(sellOrder)).toBe(20_000_000n);
  });
});
