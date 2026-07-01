// Order discovery: read UTxOs at the saturn_swap script address(es), decode each
// inline SwapDatum, resolve the validator + reference script PER ORDER, and
// normalize into an order book. All amounts stay in BASE UNITS (SPEC §6) — decimals
// are applied out-of-band only for display/pricing.

import { decodeSwapDatumHex, type SwapDatum } from "./datum.js";
import { decodeSwapDatumV3Hex, type Coverage } from "./datumV3.js";
import {
  DEPLOYMENTS,
  deploymentByOrderAddress,
  deploymentByScriptHash,
  type Deployment,
  type PlutusVersion,
  type Version,
} from "./contract.js";

export interface AssetAmount {
  policyId: string; // "" = ADA
  assetName: string; // "" = ADA
  amount: bigint; // base units
}

export interface ChainValue {
  lovelace: bigint;
  assets: Record<string, bigint>; // unit (policyId+assetName hex) -> qty
}

export interface RawUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  value: ChainValue;
  inlineDatumHex?: string;
  /** payment credential (script hash) of `address`, if the provider supplies it */
  paymentCred?: string;
}

export interface Order {
  utxo: { txHash: string; outputIndex: number };
  orderAddress: string;
  version: Version;
  plutusVersion: PlutusVersion;
  scriptHash: string;
  refScript: { txHash: string; outputIndex: number };
  feePercentX100: number;
  feeAddress: string;
  datum: SwapDatum;
  scriptValue: ChainValue;
  sell: AssetAmount;
  buy: AssetAmount;
  /** amountSell / amountBuy in BASE units (apply decimals out-of-band for a human price) */
  priceBaseUnits: number;
  validBeforeTime: bigint | null;
  /** V3: minimum buy-asset size of a partial fill (0 = no floor / V2 parity) */
  minPartialFill: bigint;
  /** V3: Aegis coverage — Some ⇒ a per-fill premium output to `coverage.vault` is REQUIRED (null for V2) */
  coverage: Coverage | null;
}

export interface ChainProvider {
  utxosAtAddress(address: string): Promise<RawUtxo[]>;
}

export function unit(policyId: string, assetName: string): string {
  return policyId + assetName;
}

function resolveDeployment(u: RawUtxo): Deployment | undefined {
  return deploymentByOrderAddress(u.address) ?? (u.paymentCred ? deploymentByScriptHash(u.paymentCred) : undefined);
}

/** Pure: turn a script-address UTxO into a normalized Order (undefined if not decodable). */
export function decodeOrderUtxo(u: RawUtxo): Order | undefined {
  const dep = resolveDeployment(u);
  if (!dep) return undefined;
  if (!u.inlineDatumHex) return undefined;
  let datum: SwapDatum;
  let minPartialFill = 0n;
  let coverage: Coverage | null = null;
  try {
    if (dep.plutusVersion === "v3") {
      const v3 = decodeSwapDatumV3Hex(u.inlineDatumHex);
      datum = v3;
      minPartialFill = v3.minPartialFill;
      coverage = v3.coverage;
    } else {
      datum = decodeSwapDatumHex(u.inlineDatumHex);
    }
  } catch {
    return undefined;
  }
  const sell: AssetAmount = {
    policyId: datum.policyIdSell,
    assetName: datum.assetNameSell,
    amount: datum.amountSell,
  };
  const buy: AssetAmount = {
    policyId: datum.policyIdBuy,
    assetName: datum.assetNameBuy,
    amount: datum.amountBuy,
  };
  return {
    utxo: { txHash: u.txHash, outputIndex: u.outputIndex },
    orderAddress: u.address,
    version: dep.version,
    plutusVersion: dep.plutusVersion,
    scriptHash: dep.scriptHash,
    refScript: dep.refScript,
    feePercentX100: dep.feePercentX100,
    feeAddress: dep.feeAddress,
    datum,
    scriptValue: u.value,
    sell,
    buy,
    priceBaseUnits: Number(datum.amountSell) / Number(datum.amountBuy),
    validBeforeTime: datum.validBeforeTime,
    minPartialFill,
    coverage,
  };
}

export function normalizeBook(utxos: RawUtxo[]): Order[] {
  const out: Order[] = [];
  for (const u of utxos) {
    const o = decodeOrderUtxo(u);
    if (o) out.push(o);
  }
  return out;
}

/** Human price (sell-per-buy), applying each asset's own decimals (SPEC §6). */
export function humanPrice(order: Order, decimalsSell: number, decimalsBuy: number): number {
  const sell = Number(order.sell.amount) / 10 ** decimalsSell;
  const buy = Number(order.buy.amount) / 10 ** decimalsBuy;
  return sell / buy;
}

export interface DiscoverOptions {
  provider: ChainProvider;
  /** which deployments to scan; default: all known */
  versions?: Version[];
}

export async function discoverOrders(opts: DiscoverOptions): Promise<Order[]> {
  const versions = opts.versions ?? DEPLOYMENTS.map((d) => d.version);
  const deps = DEPLOYMENTS.filter((d) => versions.includes(d.version));
  const all: Order[] = [];
  for (const dep of deps) {
    const utxos = await opts.provider.utxosAtAddress(dep.orderAddress);
    all.push(...normalizeBook(utxos));
  }
  return all;
}

// ------------------------------------------------------------------
// Keyless Koios mainnet provider (default). Any object implementing
// ChainProvider (Kupo, Ogmios, Blockfrost, a fixture) can be used instead.
// ------------------------------------------------------------------

export class KoiosProvider implements ChainProvider {
  constructor(private baseUrl = "https://api.koios.rest/api/v1") {}

  async utxosAtAddress(address: string): Promise<RawUtxo[]> {
    const res = await fetch(`${this.baseUrl}/address_utxos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ _addresses: [address], _extended: true }),
    });
    if (!res.ok) throw new Error(`Koios address_utxos ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as KoiosUtxoRow[];
    return rows.map(koiosRowToRawUtxo);
  }
}

interface KoiosAsset {
  policy_id: string;
  asset_name: string;
  quantity: string;
}
interface KoiosUtxoRow {
  tx_hash: string;
  tx_index: number;
  address: string;
  value: string;
  payment_cred?: string;
  inline_datum?: { bytes?: string } | null;
  asset_list?: KoiosAsset[] | null;
}

export function koiosRowToRawUtxo(r: KoiosUtxoRow): RawUtxo {
  const assets: Record<string, bigint> = {};
  for (const a of r.asset_list ?? []) {
    assets[unit(a.policy_id, a.asset_name)] = BigInt(a.quantity);
  }
  return {
    txHash: r.tx_hash,
    outputIndex: r.tx_index,
    address: r.address,
    value: { lovelace: BigInt(r.value), assets },
    inlineDatumHex: r.inline_datum?.bytes ?? undefined,
    paymentCred: r.payment_cred ?? undefined,
  };
}
