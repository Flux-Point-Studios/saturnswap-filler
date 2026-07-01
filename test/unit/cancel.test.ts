import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Lucid, type UTxO } from "@lucid-evolution/lucid";
import { buildCancel } from "../../src/cancel.js";
import { cancelActionRedeemer } from "../../src/datum.js";
import { plutusToHex } from "../../src/plutus.js";
import type { Order } from "../../src/discovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const PP = JSON.parse(readFileSync(join(here, "../../fixtures/lucid_pparams.json"), "utf8"), (_k, v) =>
  typeof v === "string" && v.startsWith("BIGINT:") ? BigInt(v.slice(7)) : v,
) as unknown;
const TAKER =
  "addr1qyqpzg3ng32kvaugnx4thnxaamlsqyfzxdz92enh3zv64wllamwuewa2nxy8wej4gsejyygqllhdmn9m42vcsamx24zqla6jt9";

const scriptOwnerOrder: Order = {
  utxo: { txHash: "ab".repeat(32), outputIndex: 0 },
  orderAddress: "addr1z9eejzm3qsww4hn0semp0akwnuv84dcsag4lrludklgzjt675jq4yvpskgayj55xegdp30g5rfynax66r8vgn9fldndsrfnae7",
  version: "1pct",
  plutusVersion: "v2",
  scriptHash: "73990b71041ceade6f867617f6ce9f187ab710ea2bf1ff8db7d0292f",
  refScript: { txHash: "0e16cd00b2cde4d9aad3ee30ce05a09d39009bd40e83aa477eee71870a97e8d9", outputIndex: 0 },
  feePercentX100: 100,
  feeAddress: "addr1q8x4rlqhrq4rhqhnkamw3fdqmzqgum79yragg4gptcjpphmrc2rpt0exfch4s47fu32amr45vh9wg053hmcx9k7kkcrq6kxftd",
  datum: {
    owner: { payment: { type: "script", hash: "bec4575e6b77dfd0f60ccf510b0aa3dfc8ef69faa9774928130a849c" } },
    ownerRaw: { kind: "constr", alt: 0, fields: [] },
    policyIdSell: "",
    assetNameSell: "",
    amountSell: 1_000_000n,
    policyIdBuy: "7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66",
    assetNameBuy: "634d41545241",
    amountBuy: 1_000n,
    validBeforeTime: null,
    outputReference: { txHash: "00", outputIndex: 0 },
  },
  scriptValue: { lovelace: 2_000_000n, assets: {} },
  sell: { policyId: "", assetName: "", amount: 1_000_000n },
  buy: { policyId: "7ff33a5565393dc47b48ac47becc12d92c9952e724e8446dfb6adc66", assetName: "634d41545241", amount: 1_000n },
  priceBaseUnits: 1000,
  validBeforeTime: null,
  minPartialFill: 0n,
  coverage: null,
};

describe("CancelAction", () => {
  it("redeemer is Constr1[input_index] (matches the real on-chain CancelAction(1))", () => {
    expect(plutusToHex(cancelActionRedeemer(1))).toBe("d87a9f01ff");
    expect(plutusToHex(cancelActionRedeemer(0))).toBe("d87a9f00ff");
  });

  it("buildCancel refuses a SCRIPT-owner order (needs an owner-script input the filler can't supply)", async () => {
    await expect(
      // lucid is never reached: the script-owner guard throws first
      buildCancel({ lucid: {} as never, order: scriptOwnerOrder, fundingUtxos: [], collateralUtxo: {} as never }),
    ).rejects.toThrow(/SCRIPT_OWNER_CANCEL_UNSUPPORTED/);
  });
});

// Key-hash owner order (the path buildCancel actually builds).
const keyOwnerOrder: Order = {
  ...scriptOwnerOrder,
  datum: {
    ...scriptOwnerOrder.datum,
    owner: { payment: { type: "key", hash: "bec4575e6b77dfd0f60ccf510b0aa3dfc8ef69faa9774928130a849c" } },
  },
};

const orderUtxo: UTxO = {
  txHash: keyOwnerOrder.utxo.txHash,
  outputIndex: keyOwnerOrder.utxo.outputIndex,
  address: keyOwnerOrder.orderAddress,
  assets: { lovelace: keyOwnerOrder.scriptValue.lovelace },
  datum: "d8799f00ff",
};
const refUtxo: UTxO = {
  txHash: keyOwnerOrder.refScript.txHash,
  outputIndex: keyOwnerOrder.refScript.outputIndex,
  address: keyOwnerOrder.orderAddress,
  assets: { lovelace: 30_000_000n },
  scriptRef: { type: "PlutusV2", script: "49480100002221200101" },
};

async function stubLucid() {
  const provider = {
    getProtocolParameters: async () => PP,
    getUtxosByOutRef: async (refs: { txHash: string; outputIndex: number }[]) => {
      const r = refs[0]!;
      if (r.txHash === orderUtxo.txHash && r.outputIndex === orderUtxo.outputIndex) return [orderUtxo];
      if (r.txHash === refUtxo.txHash && r.outputIndex === refUtxo.outputIndex) return [refUtxo];
      return [];
    },
  } as unknown as Parameters<typeof Lucid>[0];
  return Lucid(provider, "Mainnet");
}

describe("buildCancel — collateral pool excludes funding (bug 2 sibling)", () => {
  it("passes ONLY the dedicated collateral to selectWallet, even when a funding UTxO holds more ADA", async () => {
    const lucid = await stubLucid();
    const collateralUtxo: UTxO = { txHash: "bb".repeat(32), outputIndex: 0, address: TAKER, assets: { lovelace: 5_000_000n } };
    const fundingUtxos: UTxO[] = [
      { txHash: "cc".repeat(32), outputIndex: 0, address: TAKER, assets: { lovelace: 100_000_000n } },
    ];
    // bug-2 precondition: funding ADA > collateral ADA, so Lucid's largest-first picker would
    // otherwise pledge a funding UTxO as collateral AND spend it (overlap -> DENY).
    expect(fundingUtxos[0]!.assets.lovelace!).toBeGreaterThan(collateralUtxo.assets.lovelace!);

    let captured: UTxO[] | undefined;
    (lucid.selectWallet as { fromAddress: (a: string, u: UTxO[]) => void }).fromAddress = (_a, u) => {
      captured = u;
      throw new Error("SENTINEL-STOP"); // halt before .complete() — we only assert the pool
    };

    await expect(
      buildCancel({ lucid, order: keyOwnerOrder, fundingUtxos, collateralUtxo, changeAddress: TAKER }),
    ).rejects.toThrow("SENTINEL-STOP");

    expect(captured).toBeDefined();
    expect(captured!).toHaveLength(1);
    expect(captured![0]).toBe(collateralUtxo);
    for (const f of fundingUtxos) expect(captured!).not.toContain(f);
  });

  it("throws when collateral is also a funding input (defense-in-depth)", async () => {
    const lucid = await stubLucid();
    const overlap = { txHash: "cc".repeat(32), outputIndex: 2 };
    const collateralUtxo: UTxO = { ...overlap, address: TAKER, assets: { lovelace: 5_000_000n } };
    const fundingUtxos: UTxO[] = [{ ...overlap, address: TAKER, assets: { lovelace: 5_000_000n } }];
    await expect(
      buildCancel({ lucid, order: keyOwnerOrder, fundingUtxos, collateralUtxo, changeAddress: TAKER }),
    ).rejects.toThrow(/must be disjoint from the spend inputs/);
  });
});
