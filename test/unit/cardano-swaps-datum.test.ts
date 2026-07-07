import { describe, it, expect } from "vitest";
import {
  encodeOneWaySwapDatum,
  encodeOneWaySwapDatumHex,
  decodeOneWaySwapDatum,
  decodeOneWaySwapDatumHex,
  encodeTwoWaySwapDatumHex,
  decodeTwoWaySwapDatumHex,
  SPEND_WITH_MINT_HEX,
  SPEND_WITH_STAKE_HEX,
  SWAP_REDEEMER_HEX,
  TAKE_ASSET1_REDEEMER_HEX,
  TAKE_ASSET2_REDEEMER_HEX,
  REGISTER_BEACON_SCRIPT_HEX,
  CREATE_OR_CLOSE_SWAPS_HEX,
  UPDATE_SWAPS_HEX,
  type OneWaySwapDatum,
  type TwoWaySwapDatum,
} from "../../src/cardanoSwapsDatum.js";
import { decodePlutusHex } from "../../src/plutus.js";
import type { OutputRef } from "../../src/datum.js";

const BEACON = "22".repeat(28);
const AA = "aa".repeat(28);
const NM = "54455354";
const B32 = (h: string) => h.repeat(32); // a 32-byte beacon-name placeholder
const orderRef: OutputRef = { txHash: "11".repeat(32), outputIndex: 2 };

function oneWay(prevInput: OutputRef | null): OneWaySwapDatum {
  return {
    beaconId: BEACON,
    pairBeacon: B32("ab"),
    offerId: "",
    offerName: "",
    offerBeacon: B32("cd"),
    askId: AA,
    askName: NM,
    askBeacon: B32("ef"),
    price: { num: 400n, den: 100_000_000n },
    prevInput,
    expiration: null,
  };
}

function twoWay(prevInput: OutputRef | null): TwoWaySwapDatum {
  return {
    beaconId: BEACON,
    pairBeacon: B32("ab"),
    asset1Id: "",
    asset1Name: "",
    asset1Beacon: B32("cd"),
    asset2Id: AA,
    asset2Name: NM,
    asset2Beacon: B32("ef"),
    asset1Price: { num: 400n, den: 100_000_000n },
    asset2Price: { num: 100_000_000n, den: 400n },
    prevInput,
    expiration: 1_800_000_000_000n,
  };
}

describe("canonical SwapDatum codec (one-way)", () => {
  it("round-trips exactly (prev_input None)", () => {
    const d = oneWay(null);
    expect(decodeOneWaySwapDatum(encodeOneWaySwapDatum(d))).toEqual(d);
  });

  it("round-trips exactly (prev_input Some) via hex", () => {
    const d = oneWay(orderRef);
    expect(decodeOneWaySwapDatumHex(encodeOneWaySwapDatumHex(d))).toEqual(d);
  });

  it("encodes as Constr0 with exactly 11 fields; swap_price is a Rational Constr0[num,den]", () => {
    const pd = decodePlutusHex(encodeOneWaySwapDatumHex(oneWay(null)));
    expect(pd.kind).toBe("constr");
    if (pd.kind !== "constr") throw new Error("unreachable");
    expect(pd.alt).toBe(0);
    expect(pd.fields.length).toBe(11);
    const price = pd.fields[8]!;
    expect(price.kind).toBe("constr");
    if (price.kind !== "constr") throw new Error("unreachable");
    expect(price.alt).toBe(0);
    expect(price.fields.length).toBe(2);
  });

  it("prev_input Some encodes the WRAPPED PlutusV2 OutputReference (TxId newtype), NOT bare bytes", () => {
    const pd = decodePlutusHex(encodeOneWaySwapDatumHex(oneWay(orderRef)));
    if (pd.kind !== "constr") throw new Error("unreachable");
    const prev = pd.fields[9]!; // Option<OutputReference>
    if (prev.kind !== "constr") throw new Error("prev_input not a constr");
    expect(prev.alt).toBe(0); // Some
    const outRef = prev.fields[0]!; // OutputReference = Constr0[ TransactionId, Int ]
    if (outRef.kind !== "constr") throw new Error("outref not a constr");
    expect(outRef.alt).toBe(0);
    expect(outRef.fields.length).toBe(2);
    const txId = outRef.fields[0]!; // TransactionId = Constr0[ bstr ]  (the V2 wrapper)
    expect(txId.kind).toBe("constr");
    if (txId.kind !== "constr") throw new Error("unreachable");
    expect(txId.alt).toBe(0);
    expect(txId.fields[0]!.kind).toBe("bytes");
  });

  it("prev_input None encodes as Constr1 (Option None)", () => {
    const pd = decodePlutusHex(encodeOneWaySwapDatumHex(oneWay(null)));
    if (pd.kind !== "constr") throw new Error("unreachable");
    const prev = pd.fields[9]!;
    if (prev.kind !== "constr") throw new Error("unreachable");
    expect(prev.alt).toBe(1);
    expect(prev.fields.length).toBe(0);
  });
});

describe("canonical SwapDatum codec (two-way)", () => {
  it("round-trips exactly (with expiration + prev_input Some)", () => {
    const d = twoWay(orderRef);
    expect(decodeTwoWaySwapDatumHex(encodeTwoWaySwapDatumHex(d))).toEqual(d);
  });

  it("encodes as Constr0 with 12 fields; two Rational prices", () => {
    const pd = decodePlutusHex(encodeTwoWaySwapDatumHex(twoWay(null)));
    if (pd.kind !== "constr") throw new Error("unreachable");
    expect(pd.alt).toBe(0);
    expect(pd.fields.length).toBe(12);
    expect(pd.fields[8]!.kind).toBe("constr"); // asset1_price
    expect(pd.fields[9]!.kind).toBe("constr"); // asset2_price
  });
});

describe("canonical redeemers (nullary constructors)", () => {
  it("one-way spend redeemers: SpendWithMint=0, SpendWithStake=1, Swap=2", () => {
    expect(SPEND_WITH_MINT_HEX).toBe("d8799fff");
    expect(SPEND_WITH_STAKE_HEX).toBe("d87a9fff");
    expect(SWAP_REDEEMER_HEX).toBe("d87b9fff");
  });

  it("two-way taker redeemers: TakeAsset1=2, TakeAsset2=3", () => {
    expect(TAKE_ASSET1_REDEEMER_HEX).toBe("d87b9fff");
    expect(TAKE_ASSET2_REDEEMER_HEX).toBe("d87c9fff");
  });

  it("beacon redeemers: RegisterBeaconScript=0, CreateOrCloseSwaps=1, UpdateSwaps=2", () => {
    expect(REGISTER_BEACON_SCRIPT_HEX).toBe("d8799fff");
    expect(CREATE_OR_CLOSE_SWAPS_HEX).toBe("d87a9fff");
    expect(UPDATE_SWAPS_HEX).toBe("d87b9fff");
  });
});
