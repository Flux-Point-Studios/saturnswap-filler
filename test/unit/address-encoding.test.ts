import { describe, it, expect } from "vitest";
import { addressToPlutusData, plutusDataToAddress, swapDatumToPlutusData, decodeSwapDatumHex, type OwnerAddress } from "../../src/datum.js";
import { plutusToHex, decodePlutusHex, type PlutusData } from "../../src/plutus.js";
import { koiosRowToRawUtxo, decodeOrderUtxo } from "../../src/discovery.js";
import { computeFillPlan } from "../../src/fill.js";
import { DEPLOYMENTS } from "../../src/contract.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../fixtures/live_1pct_book.json"), "utf8"));
const baseOwnerOrder = decodeOrderUtxo(koiosRowToRawUtxo(fixture.find((u: any) => u.tx_hash.startsWith("a28c54cc"))))!;

const ENTERPRISE: OwnerAddress = {
  payment: { type: "key", hash: "e5de5661f9d883a58189fb7947e6e45cbf862025d5d472bcd3006fb6" },
};
// The owner field exactly as it appears in the live preprod resting order (verified on-chain):
// Constr0[ Constr0[bstr], None ].
const LIVE_PREPROD_OWNER_HEX =
  "d8799fd8799f581ce5de5661f9d883a58189fb7947e6e45cbf862025d5d472bcd3006fb6ffd87a9fffff";

const constr = (d: PlutusData) => {
  if (d.kind !== "constr") throw new Error("not a constr");
  return d;
};

describe("addressToPlutusData — canonical Aiken Address (always 2-field)", () => {
  it("enterprise (stakeless) owner encodes as Constr0[payment, None] and matches the live preprod datum", () => {
    const pd = constr(addressToPlutusData(ENTERPRISE));
    expect(pd.alt).toBe(0);
    expect(pd.fields).toHaveLength(2); // NOT 1 — the bug emitted a single-field constructor
    expect(constr(pd.fields[0]!).alt).toBe(0); // payment = VerificationKey
    const stakeOpt = constr(pd.fields[1]!);
    expect(stakeOpt.alt).toBe(1); // None
    expect(stakeOpt.fields).toHaveLength(0);
    expect(plutusToHex(addressToPlutusData(ENTERPRISE))).toBe(LIVE_PREPROD_OWNER_HEX);
  });

  it("base owner encodes as Constr0[payment, Some(Inline(stake))]", () => {
    const owner = baseOwnerOrder.datum.owner;
    expect(owner.stake).toBeDefined();
    const pd = constr(addressToPlutusData(owner));
    expect(pd.fields).toHaveLength(2);
    const stakeOpt = constr(pd.fields[1]!);
    expect(stakeOpt.alt).toBe(0); // Some
    const inline = constr(stakeOpt.fields[0]!); // Inline
    expect(inline.alt).toBe(0);
    const cred = constr(inline.fields[0]!); // stake credential
    expect(cred.fields).toHaveLength(1);
  });

  it("round-trips through plutusDataToAddress (enterprise and base)", () => {
    const ent = plutusDataToAddress(addressToPlutusData(ENTERPRISE));
    expect(ent.payment).toEqual(ENTERPRISE.payment);
    expect(ent.stake).toBeUndefined();

    const base = plutusDataToAddress(addressToPlutusData(baseOwnerOrder.datum.owner));
    expect(base.payment).toEqual(baseOwnerOrder.datum.owner.payment);
    expect(base.stake).toEqual(baseOwnerOrder.datum.owner.stake);
  });
});

describe("relist datum of a PARTIAL fill of an ENTERPRISE-owner order (bug-1 failure mode)", () => {
  // A synthetic 1% order owned by an enterprise (stakeless) address: sell 1000 TEST for 10 tADA.
  const dep = DEPLOYMENTS[0]!;
  const TEST = "0ff71ae2bdba25bb5e1805983c8e7924edfc77f808f4f8f6cc421ce4";
  const NAME = "54455354";
  const orderDatumHex = plutusToHex(
    swapDatumToPlutusData({
      owner: ENTERPRISE,
      policyIdSell: TEST,
      assetNameSell: NAME,
      amountSell: 1000n,
      policyIdBuy: "",
      assetNameBuy: "",
      amountBuy: 10_000_000n,
      validBeforeTime: null,
      outputReference: { txHash: "00", outputIndex: 0 },
    }),
  );

  const order = decodeOrderUtxo({
    txHash: "aa".repeat(32),
    outputIndex: 0,
    address: dep.orderAddress,
    value: { lovelace: 2_000_000n, assets: { [TEST + NAME]: 1000n } },
    inlineDatumHex: orderDatumHex,
  })!;

  it("the order decodes with an enterprise (stakeless) owner", () => {
    expect(order.datum.owner.payment.hash).toBe(ENTERPRISE.payment.hash);
    expect(order.datum.owner.stake).toBeUndefined();
  });

  it("the relist continuation datum is a VALID, decodable Address (no 1-field corruption)", () => {
    const plan = computeFillPlan(order, 4_000_000n); // partial fill -> relist
    expect(plan.relist).toBeDefined();
    const d = decodeSwapDatumHex(plan.relist!.datumHex); // throws if the owner Address is malformed
    expect(d.owner.payment.hash).toBe(ENTERPRISE.payment.hash);
    expect(d.owner.stake).toBeUndefined();
    // owner sub-structure is the canonical 2-field form
    const ownerPd = constr((decodePlutusHex(plan.relist!.datumHex) as any).fields[0]);
    expect(ownerPd.fields).toHaveLength(2);
    expect(constr(ownerPd.fields[1]!).alt).toBe(1); // None
  });
});
