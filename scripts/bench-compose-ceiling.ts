// Compose-ceiling benchmark (BEACON_VOLUME_EXPERIMENT.md §6.1 — the gating number).
//
// Measures, against the EXACT script bytes deployed by the 2026-07-08 mainnet
// ceremony (fixtures/cardano-swaps-mainnet-scripts.json, hash-verified), how many
// canonical one-way fills fit in one transaction, and what each K costs:
//   - runs a Lucid Evolution Emulator whose default protocol parameters equal
//     mainnet's (16,384 B tx / 14M mem / 10B steps / real fee prices);
//   - deploys the spend validator + beacon policy as CIP-33 reference scripts;
//   - creates a book of paired opposite one-way orders (TOKEN→ADA and ADA→TOKEN
//     at 1:1) with the REAL beacon policy executing on every create;
//   - for K = 1..N builds a K-fill round-trip tx with planOneWayMultiFill /
//     assembleOneWayMultiFillTx and records size, evaluated ex-units, fee(K),
//     and the block-level throughput each K implies.
//
// The taker wallet holds ONLY ADA: every even K settles TOKEN legs purely by
// intra-tx netting, which is the multi-hop/cycle capability proof in executable
// form. This is an emulator measurement — one step above folklore, one step
// below an on-chain preprod submit (tracked as follow-up).
//
// Run: npx tsx scripts/bench-compose-ceiling.ts

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Emulator,
  Lucid,
  generateEmulatorAccount,
  applyDoubleCborEncoding,
  getAddressDetails,
  CML,
  type LucidEvolution,
  type Script,
  type UTxO,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "../src/cbor.js";
import {
  planCreateOneWaySwap,
  orderAddressFor,
  type CardanoSwapsDeployment,
} from "../src/cardanoSwapsLifecycle.js";
import { decodeOneWayOrder } from "../src/cardanoSwapsDiscovery.js";
import { planOneWayMultiFill, assembleOneWayMultiFillTx, type OneWayFillLeg } from "../src/cardanoSwapsMultiFill.js";
import type { OneWayOrder } from "../src/cardanoSwapsFill.js";

// ---- mainnet constants for fee/throughput analytics ----
const MAINNET = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  priceMem: 577n, // per 10_000
  priceStep: 721n, // per 10_000_000
  refScriptFeePerByte: 15n,
  maxTxSize: 16_384,
  maxTxMem: 14_000_000n,
  maxTxSteps: 10_000_000_000n,
  maxBlockSize: 90_112,
  maxBlockMem: 62_000_000n,
  maxBlockSteps: 20_000_000_000n,
};

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cardano-swaps-mainnet-scripts.json"), "utf8"),
);

function verifiedScript(entry: { hash: string; cborHex: string }): Script {
  const h = bytesToHex(blake2b(new Uint8Array([0x02, ...hexToBytes(entry.cborHex)]), { dkLen: 28 }));
  if (h !== entry.hash) throw new Error(`fixture script hash mismatch: ${h} != ${entry.hash}`);
  return { type: "PlutusV2", script: applyDoubleCborEncoding(entry.cborHex) };
}

const TOKEN_POLICY = "deadbeef".repeat(7); // 28-byte dummy policy, genesis-assigned
const TOKEN_NAME = "42454e4348"; // "BENCH"
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_NAME;
const TAKE = 1_000_000n; // per-fill take (1:1 price → exact intra-tx netting)

interface KRow {
  k: number;
  ok: boolean;
  error?: string;
  sizeBytes?: number;
  mem?: bigint;
  steps?: bigint;
  mainnetFeeLovelace?: bigint;
  txPerBlock?: number;
  fillsPerBlock?: number;
  grossNotionalLovelace?: bigint;
}

async function main() {
  const spendScript = verifiedScript(FIXTURE.oneWaySpend);
  const beaconScript = verifiedScript(FIXTURE.oneWayBeacon);
  console.log("fixture scripts hash-verified against the ceremony constants");

  const maker = generateEmulatorAccount({ lovelace: 2_000_000_000n, [TOKEN_UNIT]: 2_000_000_000n });
  const taker = generateEmulatorAccount({ lovelace: 2_000_000_000n }); // ADA ONLY — netting proof
  const emulator = new Emulator([maker, taker]);
  const lucid: LucidEvolution = await Lucid(emulator, "Custom");

  // ---- deploy CIP-33 reference scripts ----
  lucid.selectWallet.fromSeed(taker.seedPhrase);
  const deployTx = await lucid
    .newTx()
    .pay.ToAddressWithData(taker.address, undefined, { lovelace: 30_000_000n }, spendScript)
    .pay.ToAddressWithData(taker.address, undefined, { lovelace: 30_000_000n }, beaconScript)
    .complete();
  const deployHash = await (await deployTx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);

  const deployment: CardanoSwapsDeployment = {
    network: "Custom",
    dappHash: FIXTURE.oneWaySpend.hash,
    beaconPolicy: FIXTURE.oneWayBeacon.hash,
    makerStakeHash: "0".repeat(56), // unused: benchmark orders are key-staked
    adamBotPkh: "0".repeat(56), // unused: fills are permissionless
    spendRefUtxo: { txHash: deployHash, outputIndex: 0 },
    beaconRefUtxo: { txHash: deployHash, outputIndex: 1 },
  };

  // ---- create the book: paired opposite one-way orders at 1:1 ----
  lucid.selectWallet.fromSeed(maker.seedPhrase);
  const makerDetails = getAddressDetails(maker.address);
  const stakeKey = makerDetails.stakeCredential ?? makerDetails.paymentCredential!;
  const stake = { type: "key" as const, hash: stakeKey.hash };
  const orderAddress = orderAddressFor(deployment, stake);

  const PAIRS = 17; // 34 orders → probe past the expected wall
  const beaconRef = (await lucid.utxosByOutRef([{ txHash: deployHash, outputIndex: 1 }]))[0]!;
  for (let i = 0; i < PAIRS * 2; i++) {
    const sellSide = i % 2 === 0; // even: offer TOKEN ask ADA; odd: offer ADA ask TOKEN
    const recipe = planCreateOneWaySwap({
      deployment,
      offer: sellSide
        ? { policyId: TOKEN_POLICY, assetName: TOKEN_NAME, amount: 20_000_000n }
        : { policyId: "", assetName: "", amount: 20_000_000n },
      ask: sellSide ? { policyId: "", assetName: "" } : { policyId: TOKEN_POLICY, assetName: TOKEN_NAME },
      price: { num: 1n, den: 1n },
      stake,
    });
    const out = recipe.outputs[0]!;
    const mint = recipe.mints[0]!;
    const bag: Record<string, bigint> = {};
    for (const m of mint.assets) bag[m.unit] = m.quantity;
    const tx = await lucid
      .newTx()
      .readFrom([beaconRef])
      .mintAssets(bag, mint.redeemerHex)
      .pay.ToAddressWithData(out.addressBech32, { kind: "inline", value: out.inlineDatumHex }, out.assets)
      .complete();
    await (await tx.sign.withWallet().complete()).submit();
    emulator.awaitBlock(1);
  }
  console.log(`created ${PAIRS * 2} orders (${PAIRS} TOKEN→ADA + ${PAIRS} ADA→TOKEN) at ${orderAddress.slice(0, 24)}…`);

  // ---- discover the book back off the emulator ledger ----
  const bookUtxos = await lucid.utxosAt(orderAddress);
  const orders: Array<{ order: OneWayOrder; utxo: UTxO }> = [];
  for (const u of bookUtxos) {
    const value: { lovelace: bigint; assets: Record<string, bigint> } = { lovelace: 0n, assets: {} };
    for (const [k, v] of Object.entries(u.assets)) {
      if (k === "lovelace") value.lovelace = v;
      else value.assets[k] = v;
    }
    const decoded = decodeOneWayOrder({
      txHash: u.txHash,
      outputIndex: u.outputIndex,
      address: u.address,
      value,
      inlineDatumHex: u.datum ?? undefined,
    });
    if (decoded) orders.push({ order: decoded, utxo: u });
  }
  const sells = orders.filter((o) => o.order.datum.offerId !== ""); // offer TOKEN
  const buys = orders.filter((o) => o.order.datum.offerId === ""); // offer ADA
  console.log(`discovered ${sells.length} TOKEN→ADA + ${buys.length} ADA→TOKEN orders\n`);

  // ---- K ladder ----
  lucid.selectWallet.fromSeed(taker.seedPhrase);
  const rows: KRow[] = [];
  let consecutiveFailures = 0;
  for (let k = 1; k <= sells.length + buys.length && consecutiveFailures < 3; k++) {
    // interleave directions; odd K gets the extra TOKEN→ADA leg so the ADA-only
    // taker never needs token funding
    const legs: OneWayFillLeg[] = [];
    for (let i = 0; i < k; i++) {
      const pool = i % 2 === 0 ? sells : buys;
      const idx = Math.floor(i / 2);
      if (idx >= pool.length) break;
      legs.push({ order: pool[idx]!.order, orderUtxo: pool[idx]!.utxo, offerTaken: TAKE });
    }
    if (legs.length < k) break;
    try {
      const plan = planOneWayMultiFill(legs);
      const { unsignedCbor, txSizeBytes } = await assembleOneWayMultiFillTx({
        lucid,
        deployment,
        plan,
        changeAddress: taker.address,
      });
      const witnessSet = CML.Transaction.from_cbor_hex(unsignedCbor).witness_set();
      const redeemers = witnessSet.redeemers();
      if (!redeemers) throw new Error("no redeemers in built tx");
      const total = CML.compute_total_ex_units(redeemers);
      const mem = total.mem();
      const steps = total.steps();
      // mainnet fee analytics: fills reference ONLY the spend script
      const refBytes = BigInt(FIXTURE.oneWaySpend.sizeBytes);
      const fee =
        MAINNET.minFeeB +
        MAINNET.minFeeA * BigInt(txSizeBytes) +
        (mem * MAINNET.priceMem) / 10_000n +
        (steps * MAINNET.priceStep) / 10_000_000n +
        refBytes * MAINNET.refScriptFeePerByte;
      const txPerBlock = Math.min(
        Number(MAINNET.maxBlockMem) / Number(mem),
        Number(MAINNET.maxBlockSteps) / Number(steps),
        MAINNET.maxBlockSize / txSizeBytes,
      );
      rows.push({
        k,
        ok: true,
        sizeBytes: txSizeBytes,
        mem,
        steps,
        mainnetFeeLovelace: fee,
        txPerBlock,
        fillsPerBlock: k * txPerBlock,
        grossNotionalLovelace: plan.grossNotionalLovelace,
      });
      consecutiveFailures = 0;
      console.log(
        `K=${String(k).padStart(2)}  ok   ${txSizeBytes}B  mem=${mem}  steps=${steps}  fee≈${(Number(fee) / 1e6).toFixed(3)} ADA  fills/block≈${(k * txPerBlock).toFixed(1)}`,
      );
    } catch (e) {
      consecutiveFailures++;
      const msg = e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : String(e).slice(0, 160);
      rows.push({ k, ok: false, error: msg });
      console.log(`K=${String(k).padStart(2)}  FAIL ${msg}`);
    }
  }

  // ---- netting proof: submit the largest passing even-K round-trip for real ----
  const proofK = [...rows].reverse().find((r) => r.ok && r.k % 2 === 0)?.k;
  let nettingProof: { k: number; txHash: string } | undefined;
  if (proofK) {
    const legs: OneWayFillLeg[] = [];
    for (let i = 0; i < proofK; i++) {
      const pool = i % 2 === 0 ? sells : buys;
      legs.push({ order: pool[Math.floor(i / 2)]!.order, orderUtxo: pool[Math.floor(i / 2)]!.utxo, offerTaken: TAKE });
    }
    const plan = planOneWayMultiFill(legs);
    if (Object.keys(plan.netTokenDelta).length !== 0) throw new Error("round-trip batch should net token delta to zero");
    const { unsignedCbor } = await assembleOneWayMultiFillTx({ lucid, deployment, plan, changeAddress: taker.address });
    const signed = await lucid.fromTx(unsignedCbor).sign.withWallet().complete();
    const txHash = await signed.submit();
    emulator.awaitBlock(1);
    nettingProof = { k: proofK, txHash };
    console.log(`\nnetting proof SUBMITTED: K=${proofK} round-trip settled by an ADA-only taker, tx ${txHash}`);
  }

  const results = {
    method:
      "Lucid Evolution Emulator (mainnet-equal protocol params), ceremony script bytes hash-verified, CIP-33 refs, paired 1:1 one-way orders, ADA-only taker",
    perFillTakeLovelaceEquivalent: String(TAKE),
    kMax: [...rows].reverse().find((r) => r.ok)?.k ?? 0,
    bestFillsPerBlock: rows.filter((r) => r.ok).sort((a, b) => (b.fillsPerBlock ?? 0) - (a.fillsPerBlock ?? 0))[0] ?? null,
    nettingProof,
    rows,
  };
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "compose-ceiling-results.json"),
    JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  console.log(`\nK_max = ${results.kMax}; results written to fixtures/compose-ceiling-results.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
