import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { koiosRowToRawUtxo, decodeOrderUtxo, unit, type Order } from "../../src/discovery.js";
import { computeFillPlan } from "../../src/fill.js";
import { FEE_PAYMENT_CRED } from "../../src/contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../fixtures/live_1pct_book.json"), "utf8"));

const worked = decodeOrderUtxo(koiosRowToRawUtxo(fixture.find((u: any) => u.tx_hash.startsWith("a28c54cc"))))!;
const CMATRA = unit("7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66", "634d41545241");

// Synthetic 1% token-sell order (SELL a token, BUY ADA) to exercise the token-fee /
// ADA-owner branch under the 1%-only model.
const TOKEN = "50cd0a2d8f2cc2092bbc5fb87c2c9488afee3d6fc4458fc8a0e89f8e";
const NAME = "4652454e43484945205749464620";
const tokenSell1pct: Order = {
  utxo: { txHash: "11".repeat(32), outputIndex: 0 },
  orderAddress: "addr1z9eejzm3qsww4hn0semp0akwnuv84dcsag4lrludklgzjt675jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsrfnae7",
  version: "1pct",
  scriptHash: "73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f",
  refScript: { txHash: "0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9", outputIndex: 0 },
  feePercentX100: 100,
  datum: {
    owner: { payment: { type: "key", hash: "5fce592147c520b69d3a485b15447cb24fd59cba6d78f143616effc4" }, stake: { type: "key", hash: "96a62ca41357a962e53c93308fe761a4b244f4cf065ada8f912cc305" } },
    ownerRaw: { kind: "constr", alt: 0, fields: [] },
    policyIdSell: TOKEN,
    assetNameSell: NAME,
    amountSell: 4_235_165n,
    policyIdBuy: "",
    assetNameBuy: "",
    amountBuy: 12_705_491n,
    validBeforeTime: null,
    outputReference: { txHash: "00", outputIndex: 0 },
  },
  scriptValue: { lovelace: 2_047_250n, assets: { [unit(TOKEN, NAME)]: 4_235_165n } },
  sell: { policyId: TOKEN, assetName: NAME, amount: 4_235_165n },
  buy: { policyId: "", assetName: "", amount: 12_705_491n },
  priceBaseUnits: 4_235_165 / 12_705_491,
  validBeforeTime: null,
};

describe("computeFillPlan — 1% ADA-sell worked order (buy cMATRA), full fill", () => {
  const plan = computeFillPlan(worked, worked.buy.amount); // default coinsPerUtxoByte = 4310
  it("releases the whole sell leg and takes 1% in the sell asset (ADA)", () => {
    expect(plan.isFullFill).toBe(true);
    expect(plan.newSwapAmountSell).toBe(25_000_000n);
    expect(plan.totalFee).toBe(250_000n); // 0.25 ADA
  });
  it("owner output = amount_buy of cMATRA + EXACT computed min-utxo (not the old 2-ADA floor)", () => {
    expect(plan.ownerOutputAssets[CMATRA]).toBe(125_124_999_999n);
    expect(plan.ownerOutputAssets["lovelace"]).toBe(1_422_300n); // (size+160)*4310
  });
  it("fee output = SELL asset (ADA), floored to the EXACT min-utxo (fee < min-utxo)", () => {
    expect(plan.feeOutputAssets["lovelace"]).toBe(1_211_110n); // ~1.21 ADA, the ledger min-UTxO
  });
  it("PaymentDatum tag uses the SPENT ORDER's OWN ref (SPEC §7/§10 golden hex)", () => {
    expect(plan.paymentDatumHex).toBe(
      "d8799fd8799fd8799f5820a28c54cc8a18823df9254f75038a8b72b82fec655a73288c7868714b4d27c814ff00ffff",
    );
  });
  it("a partial fill produces a relist continuation (not a throw)", () => {
    const partial = computeFillPlan(worked, 500_000n);
    expect(partial.isFullFill).toBe(false);
    expect(partial.relist).toBeDefined();
  });
});

describe("computeFillPlan — 1% token-sell order (buy ADA), full fill", () => {
  const plan = computeFillPlan(tokenSell1pct, tokenSell1pct.buy.amount);
  it("takes 1% in the SELL token, rounded down", () => {
    expect(plan.newSwapAmountSell).toBe(4_235_165n);
    expect(plan.totalFee).toBe(42_351n); // 4235165 * 100 / 10000 = 42351.65 -> 42351
  });
  it("owner (ADA-buy) output lovelace = amount_buy + script lovelace (owner_paid_enough)", () => {
    expect(plan.ownerOutputAssets["lovelace"]).toBe(12_705_491n + 2_047_250n);
    expect(Object.keys(plan.ownerOutputAssets)).toEqual(["lovelace"]); // ADA-only owner output
  });
  it("fee output = SELL token (1%) + exact min-utxo ADA, to fee_address", () => {
    expect(plan.feeOutputAssets[unit(TOKEN, NAME)]).toBe(42_351n);
    expect(plan.feeOutputAssets["lovelace"]).toBeGreaterThan(1_200_000n);
    expect(plan.feeOutputAssets["lovelace"]).toBeLessThan(1_500_000n);
    expect(FEE_PAYMENT_CRED).toBe("cd51fc17182a3b82f3b776e8a5a0d8808e6fc520fa8455015e2410df");
  });
});

// token→token order (SELL token A, BUY token B). A FULL fill would need amount_buy-as-lovelace
// on the owner output (validator case (c)) — infeasible — so computeFillPlan must refuse it and
// steer to a partial fill (which satisfies case (a)).
const TOKEN_B = "9a9693a9a37912a5097918f97918d15240c92ab729a0b7c4aa144d77";
const NAME_B = "53554e444145";
const tokenToToken1pct: Order = {
  ...tokenSell1pct,
  utxo: { txHash: "22".repeat(32), outputIndex: 0 },
  buy: { policyId: TOKEN_B, assetName: NAME_B, amount: 12_705_491n },
  datum: { ...tokenSell1pct.datum, policyIdBuy: TOKEN_B, assetNameBuy: NAME_B },
};

describe("computeFillPlan — token→token order", () => {
  it("THROWS on a full fill (validator case (c) demands amount_buy-as-lovelace — infeasible)", () => {
    expect(() => computeFillPlan(tokenToToken1pct, tokenToToken1pct.buy.amount)).toThrow(
      /token→token orders must be filled as a PARTIAL fill/,
    );
  });

  it("a PARTIAL fill still produces a valid plan (owner gets the buy TOKEN, not raw lovelace)", () => {
    const partial = computeFillPlan(tokenToToken1pct, 500_000n);
    expect(partial.isFullFill).toBe(false);
    expect(partial.relist).toBeDefined();
    // owner output carries the delivered buy token + only its own min-utxo ADA (never amount_buy lovelace)
    expect(partial.ownerOutputAssets[unit(TOKEN_B, NAME_B)]).toBe(500_000n);
    expect(partial.ownerOutputAssets["lovelace"]).toBeLessThan(2_000_000n);
    // relist continuation carries the remaining SELL token back to the script
    expect(partial.relist!.assets[unit(TOKEN, NAME)]).toBeGreaterThan(0n);
  });
});
