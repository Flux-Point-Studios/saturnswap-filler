import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Lucid, type UTxO } from "@lucid-evolution/lucid";
import { buildTakerFill, buildMultiTakerFill } from "../../src/fill.js";
import { koiosRowToRawUtxo, decodeOrderUtxo, unit } from "../../src/discovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../fixtures/live_1pct_book.json"), "utf8"));
const row = fixture.find((u: any) => u.tx_hash.startsWith("a28c54cc"));
const order = decodeOrderUtxo(koiosRowToRawUtxo(row))!;
// synthetic mainnet base address (the test halts on a SENTINEL before .complete(), so any valid
// base address works) — no real ops wallet in the public test.
const TAKER =
  "addr1qyqpzg3ng32kvaugnx4thnxaamlsqyfzxdz92enh3zv64wllamwuewa2nxy8wej4gsejyygqllhdmn9m42vcsamx24zqla6jt9";

// The resting order UTxO (inline datum) + a dummy reference-script UTxO, resolved by the stub
// provider's getUtxosByOutRef. We intercept selectWallet before .complete(), so the validator
// is never evaluated — this test isolates the wallet-pool composition (bug 2), nothing else.
const raw = koiosRowToRawUtxo(row);
const orderUtxo: UTxO = {
  txHash: order.utxo.txHash,
  outputIndex: order.utxo.outputIndex,
  address: order.orderAddress,
  assets: { lovelace: raw.value.lovelace, ...raw.value.assets },
  datum: raw.inlineDatumHex,
};
const refUtxo: UTxO = {
  txHash: order.refScript.txHash,
  outputIndex: order.refScript.outputIndex,
  address: order.orderAddress,
  assets: { lovelace: 30_000_000n },
  scriptRef: { type: "PlutusV2", script: "49480100002221200101" },
};
// Real preprod protocol params (Lucid shape) — Lucid() eagerly builds cost models at
// construction, so a hand-stubbed subset is not enough. Bigints are serialized as "BIGINT:n".
const PP = JSON.parse(readFileSync(join(here, "../../fixtures/lucid_pparams.json"), "utf8"), (_k, v) =>
  typeof v === "string" && v.startsWith("BIGINT:") ? BigInt(v.slice(7)) : v,
) as unknown;

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

describe("buildTakerFill — collateral pool excludes funding (bug 2)", () => {
  it("passes ONLY the dedicated collateral to selectWallet, even when a funding UTxO holds more ADA", async () => {
    const lucid = await stubLucid();
    const collateralUtxo: UTxO = { txHash: "bb".repeat(32), outputIndex: 0, address: TAKER, assets: { lovelace: 5_000_000n } };
    const fundingUtxos: UTxO[] = [
      {
        txHash: "cc".repeat(32),
        outputIndex: 0,
        address: TAKER,
        assets: { lovelace: 100_000_000n, [unit(order.buy.policyId, order.buy.assetName)]: 1_000_000n },
      },
    ];
    // bug-2 precondition: a funding UTxO holds MORE ADA than the collateral (so Lucid's
    // largest-first findCollateral would otherwise pledge it as collateral AND spend it).
    expect(fundingUtxos[0]!.assets.lovelace!).toBeGreaterThan(collateralUtxo.assets.lovelace!);

    let captured: UTxO[] | undefined;
    (lucid.selectWallet as { fromAddress: (a: string, u: UTxO[]) => void }).fromAddress = (_a, u) => {
      captured = u;
      throw new Error("SENTINEL-STOP"); // halt before .complete() — we only assert the pool
    };

    await expect(
      buildTakerFill({ lucid, order, userSellAmount: 500_000n, fundingUtxos, collateralUtxo, changeAddress: TAKER }),
    ).rejects.toThrow("SENTINEL-STOP");

    expect(captured).toBeDefined();
    expect(captured!).toHaveLength(1);
    expect(captured![0]).toBe(collateralUtxo);
    for (const f of fundingUtxos) expect(captured!).not.toContain(f);
  });

  it("buildMultiTakerFill has the same collateral-pool guarantee", async () => {
    const lucid = await stubLucid();
    const collateralUtxo: UTxO = { txHash: "dd".repeat(32), outputIndex: 0, address: TAKER, assets: { lovelace: 5_000_000n } };
    const fundingUtxos: UTxO[] = [
      {
        txHash: "ee".repeat(32),
        outputIndex: 0,
        address: TAKER,
        assets: { lovelace: 100_000_000n, [unit(order.buy.policyId, order.buy.assetName)]: 1_000_000n },
      },
    ];
    expect(fundingUtxos[0]!.assets.lovelace!).toBeGreaterThan(collateralUtxo.assets.lovelace!);

    let captured: UTxO[] | undefined;
    (lucid.selectWallet as { fromAddress: (a: string, u: UTxO[]) => void }).fromAddress = (_a, u) => {
      captured = u;
      throw new Error("SENTINEL-STOP");
    };

    await expect(
      buildMultiTakerFill({ lucid, fills: [{ order, userSellAmount: 500_000n }], fundingUtxos, collateralUtxo, changeAddress: TAKER }),
    ).rejects.toThrow("SENTINEL-STOP");

    expect(captured).toHaveLength(1);
    expect(captured![0]).toBe(collateralUtxo);
  });
});

describe("collateral/funding disjoint assert (defense-in-depth)", () => {
  // collateral txHash#index identical to a funding input -> Lucid could pledge it as collateral
  // AND spend it. Both fill builders must refuse this before assembling the tx.
  const overlap = { txHash: "ab".repeat(32), outputIndex: 1 };
  const collateralUtxo: UTxO = { ...overlap, address: TAKER, assets: { lovelace: 5_000_000n } };
  const fundingUtxos: UTxO[] = [
    { ...overlap, address: TAKER, assets: { lovelace: 5_000_000n, [unit(order.buy.policyId, order.buy.assetName)]: 1_000_000n } },
  ];

  it("buildTakerFill throws when collateral is also a funding input", async () => {
    const lucid = await stubLucid();
    await expect(
      buildTakerFill({ lucid, order, userSellAmount: 500_000n, fundingUtxos, collateralUtxo, changeAddress: TAKER }),
    ).rejects.toThrow(/must be disjoint from the spend inputs/);
  });

  it("buildMultiTakerFill throws when collateral is also a funding input", async () => {
    const lucid = await stubLucid();
    await expect(
      buildMultiTakerFill({ lucid, fills: [{ order, userSellAmount: 500_000n }], fundingUtxos, collateralUtxo, changeAddress: TAKER }),
    ).rejects.toThrow(/must be disjoint from the spend inputs/);
  });
});
