// Canonical cardano-swaps maker lifecycle (SaturnSwap inventory) — PURE recipe
// planners for create / reprice / cancel, plus a thin @lucid-evolution assembler.
//
// SaturnSwap's inventory rests at the shared canonical spend script with the
// maker_stake staking script as its stake credential:
//   Address(Script(dapp_hash), Some(Inline(Script(maker_stake_hash))))
// Canonical owner-auth (common/utils.ak staking_credential_approves) then requires
// maker_stake to appear in tx.withdrawals — the withdraw-0 trick — and maker_stake
// only succeeds when the ADAM bot key signed. So:
//   create  — CreateOrCloseSwaps beacon MINT (permissionless; minting is the gate).
//   reprice — SpendWithStake + beacon UpdateSwaps withdraw-0 + maker_stake withdraw-0
//             + ADAM bot required signer (one bot sig authorises a whole batch).
//   cancel  — SpendWithMint + beacon burn + maker_stake withdraw-0 + ADAM bot signer.

import {
  credentialToAddress,
  credentialToRewardAddress,
  type Network,
  type LucidEvolution,
  type UTxO,
  type Assets,
} from "@lucid-evolution/lucid";
import { PConstr, plutusToHex } from "./plutus.js";
import { minUtxoLovelace } from "./minUtxo.js";
import type { OutputRef, Credential } from "./datum.js";
import type { ChainValue } from "./discovery.js";
import { pairBeacon, offerBeacon, askBeacon, type AssetClass } from "./cardanoSwapsBeacons.js";
import type { Rational } from "./cardanoSwapsRatio.js";
import { chainValueToAssets, type OneWayOrder } from "./cardanoSwapsFill.js";
import {
  encodeOneWaySwapDatumHex,
  SPEND_WITH_MINT_HEX,
  SPEND_WITH_STAKE_HEX,
  CREATE_OR_CLOSE_SWAPS_HEX,
  UPDATE_SWAPS_HEX,
  type OneWaySwapDatum,
} from "./cardanoSwapsDatum.js";

export const CARDANO_SWAPS_COINS_PER_UTXO_BYTE = 4310n;

/** maker_stake ignores its withdrawal redeemer, so any Data works — use unit. */
export const MAKER_STAKE_REDEEMER_HEX = plutusToHex(PConstr(0, []));

export interface CardanoSwapsDeployment {
  network: Network;
  /** canonical spend script hash (shared dApp validator) */
  dappHash: string;
  /** beacon minting/staking policy id (== SwapDatum.beacon_id) */
  beaconPolicy: string;
  /** maker_stake staking-script hash (SaturnSwap's inventory owner) */
  makerStakeHash: string;
  /** ADAM maker-bot pubkey hash — the required signer for reprice/cancel */
  adamBotPkh: string;
  /** reference-script UTxO carrying the spend validator */
  spendRefUtxo: OutputRef;
  /** reference-script UTxO carrying the beacon policy/staking script */
  beaconRefUtxo: OutputRef;
}

// ---- recipe shape ----

export interface CsRecipeOutput {
  role: "order" | "continuation" | "payout";
  addressBech32: string;
  assets: Assets;
  inlineDatumHex: string;
}
export interface CsRecipeMintGroup {
  redeemerHex: string;
  assets: Array<{ unit: string; quantity: bigint }>;
}
/** A withdraw-0 of a staking script (the classic owner-auth trick). */
export interface CsWithdrawal {
  stakeScriptHash: string;
  redeemerHex: string;
}
export interface CsSpendLeg {
  orderRef: OutputRef;
  redeemerHex: string;
}
export interface CardanoSwapsRecipe {
  action: "create" | "reprice" | "cancel";
  outputs: CsRecipeOutput[];
  mints: CsRecipeMintGroup[];
  withdrawals: CsWithdrawal[];
  spends: CsSpendLeg[];
  requiredSigners: string[];
  refInputs: OutputRef[];
  validToUnixMs: number | null;
}

// ---- address derivation ----

function scriptStakeAddress(network: Network, scriptHash: string, stake: Credential): string {
  return credentialToAddress(
    network,
    { type: "Script", hash: scriptHash },
    { type: stake.type === "key" ? "Key" : "Script", hash: stake.hash },
  );
}

/** A swap order address for an arbitrary stake credential (user pubkey or maker script). */
export function orderAddressFor(deployment: CardanoSwapsDeployment, stake: Credential): string {
  return scriptStakeAddress(deployment.network, deployment.dappHash, stake);
}

/** SaturnSwap's maker inventory address: dApp script + maker_stake stake script. */
export function makerOrderAddress(deployment: CardanoSwapsDeployment): string {
  return scriptStakeAddress(deployment.network, deployment.dappHash, { type: "script", hash: deployment.makerStakeHash });
}

// ---- shared helpers ----

function floorMinUtxo(assets: Assets, addressBech32: string, coinsPerUtxoByte: bigint, inlineDatumHex?: string): Assets {
  const sizing: Record<string, bigint> = { ...assets };
  if (!sizing["lovelace"] || sizing["lovelace"] < 1_000_000n) sizing["lovelace"] = 2_000_000n;
  const floor = minUtxoLovelace({ addressBech32, assets: sizing, inlineDatumHex }, coinsPerUtxoByte);
  const current = assets["lovelace"] ?? 0n;
  return { ...assets, lovelace: current > floor ? current : floor };
}

function assertExpiration(expiration: bigint | null): void {
  if (expiration !== null && expiration % 60000n !== 0n)
    throw new Error("expiration must fall on a 1-min interval (canonical % 60000 == 0)");
}

function oneWayBeaconNames(offer: AssetClass, ask: AssetClass): { pair: string; offer: string; ask: string } {
  return {
    pair: pairBeacon(offer, ask),
    offer: offerBeacon(offer.policyId, offer.assetName),
    ask: askBeacon(ask.policyId, ask.assetName),
  };
}

// ---- create ----

export interface PlanCreateOneWaySwapArgs {
  deployment: CardanoSwapsDeployment;
  offer: { policyId: string; assetName: string; amount: bigint };
  ask: { policyId: string; assetName: string };
  price: Rational;
  /** the order address's stake credential (maker_stake script, or a user pubkey) */
  stake: Credential;
  expiration?: bigint | null;
  depositLovelace?: bigint;
  coinsPerUtxoByte?: bigint;
}

export function planCreateOneWaySwap(args: PlanCreateOneWaySwapArgs): CardanoSwapsRecipe {
  const { deployment, offer, ask, price } = args;
  const coinsPerUtxoByte = args.coinsPerUtxoByte ?? CARDANO_SWAPS_COINS_PER_UTXO_BYTE;
  const expiration = args.expiration ?? null;
  if (offer.policyId === ask.policyId && offer.assetName === ask.assetName)
    throw new Error("offer asset must differ from ask asset");
  if (offer.amount <= 0n) throw new Error("offer amount must be > 0");
  if (price.num <= 0n || price.den <= 0n) throw new Error("price num & den must be > 0");
  assertExpiration(expiration);

  const names = oneWayBeaconNames(offer, ask);
  const datum: OneWaySwapDatum = {
    beaconId: deployment.beaconPolicy,
    pairBeacon: names.pair,
    offerId: offer.policyId,
    offerName: offer.assetName,
    offerBeacon: names.offer,
    askId: ask.policyId,
    askName: ask.assetName,
    askBeacon: names.ask,
    price,
    prevInput: null,
    expiration,
  };

  const deposit = args.depositLovelace ?? 2_000_000n;
  const offerIsAda = offer.policyId === "";
  const value: Assets = { lovelace: offerIsAda ? deposit + offer.amount : deposit };
  if (!offerIsAda) value[offer.policyId + offer.assetName] = offer.amount;
  value[deployment.beaconPolicy + names.pair] = 1n;
  value[deployment.beaconPolicy + names.offer] = 1n;
  value[deployment.beaconPolicy + names.ask] = 1n;

  const datumHex = encodeOneWaySwapDatumHex(datum);
  const orderAddress = orderAddressFor(deployment, args.stake);

  return {
    action: "create",
    outputs: [
      { role: "order", addressBech32: orderAddress, assets: floorMinUtxo(value, orderAddress, coinsPerUtxoByte, datumHex), inlineDatumHex: datumHex },
    ],
    mints: [
      {
        redeemerHex: CREATE_OR_CLOSE_SWAPS_HEX,
        assets: [
          { unit: deployment.beaconPolicy + names.pair, quantity: 1n },
          { unit: deployment.beaconPolicy + names.offer, quantity: 1n },
          { unit: deployment.beaconPolicy + names.ask, quantity: 1n },
        ],
      },
    ],
    withdrawals: [],
    spends: [],
    requiredSigners: [],
    refInputs: [deployment.beaconRefUtxo],
    validToUnixMs: expiration !== null ? Number(expiration) : null,
  };
}

// ---- reprice (in place, cheap staking-exec) ----

export interface MakerOrder {
  datum: OneWaySwapDatum;
  utxo: OutputRef;
  scriptValue: ChainValue;
  address: string;
}

export interface PlanRepriceOneWaySwapArgs {
  deployment: CardanoSwapsDeployment;
  order: MakerOrder;
  newPrice: Rational;
  newExpiration?: bigint | null;
  /** continuation reserves; defaults to the current value (a pure reprice keeps value) */
  newValue?: ChainValue;
  coinsPerUtxoByte?: bigint;
}

export function planRepriceOneWaySwap(args: PlanRepriceOneWaySwapArgs): CardanoSwapsRecipe {
  const { deployment, order } = args;
  const coinsPerUtxoByte = args.coinsPerUtxoByte ?? CARDANO_SWAPS_COINS_PER_UTXO_BYTE;
  if (args.newPrice.num <= 0n || args.newPrice.den <= 0n) throw new Error("price num & den must be > 0");
  const expiration = args.newExpiration === undefined ? order.datum.expiration : args.newExpiration;
  assertExpiration(expiration);

  const contDatum: OneWaySwapDatum = { ...order.datum, price: args.newPrice, expiration, prevInput: null };
  const value = args.newValue ?? order.scriptValue;
  const datumHex = encodeOneWaySwapDatumHex(contDatum);

  return {
    action: "reprice",
    outputs: [
      {
        role: "continuation",
        addressBech32: order.address,
        assets: floorMinUtxo(chainValueToAssets(value), order.address, coinsPerUtxoByte, datumHex),
        inlineDatumHex: datumHex,
      },
    ],
    mints: [], // net-zero beacons — the beacon policy runs as a staking script, not a mint
    withdrawals: [
      { stakeScriptHash: deployment.beaconPolicy, redeemerHex: UPDATE_SWAPS_HEX },
      { stakeScriptHash: deployment.makerStakeHash, redeemerHex: MAKER_STAKE_REDEEMER_HEX },
    ],
    spends: [{ orderRef: order.utxo, redeemerHex: SPEND_WITH_STAKE_HEX }],
    requiredSigners: [deployment.adamBotPkh],
    refInputs: [deployment.spendRefUtxo, deployment.beaconRefUtxo],
    validToUnixMs: expiration !== null ? Number(expiration) : null,
  };
}

// ---- cancel / close ----

export interface PlanCancelOneWaySwapArgs {
  deployment: CardanoSwapsDeployment;
  order: MakerOrder;
  /** where the reclaimed inventory + deposit go (a SaturnSwap-controlled address) */
  payoutAddressBech32: string;
  coinsPerUtxoByte?: bigint;
}

export function planCancelOneWaySwap(args: PlanCancelOneWaySwapArgs): CardanoSwapsRecipe {
  const { deployment, order } = args;
  const coinsPerUtxoByte = args.coinsPerUtxoByte ?? CARDANO_SWAPS_COINS_PER_UTXO_BYTE;
  const names = oneWayBeaconNames(
    { policyId: order.datum.offerId, assetName: order.datum.offerName },
    { policyId: order.datum.askId, assetName: order.datum.askName },
  );

  const reclaim = chainValueToAssets(order.scriptValue);
  for (const name of [names.pair, names.offer, names.ask]) {
    const u = deployment.beaconPolicy + name;
    if (reclaim[u]) {
      reclaim[u] -= 1n;
      if (reclaim[u] === 0n) delete reclaim[u];
    }
  }

  return {
    action: "cancel",
    outputs: [
      {
        role: "payout",
        addressBech32: args.payoutAddressBech32,
        assets: floorMinUtxo(reclaim, args.payoutAddressBech32, coinsPerUtxoByte),
        inlineDatumHex: "",
      },
    ],
    mints: [
      {
        redeemerHex: CREATE_OR_CLOSE_SWAPS_HEX,
        assets: [
          { unit: deployment.beaconPolicy + names.pair, quantity: -1n },
          { unit: deployment.beaconPolicy + names.offer, quantity: -1n },
          { unit: deployment.beaconPolicy + names.ask, quantity: -1n },
        ],
      },
    ],
    withdrawals: [{ stakeScriptHash: deployment.makerStakeHash, redeemerHex: MAKER_STAKE_REDEEMER_HEX }],
    spends: [{ orderRef: order.utxo, redeemerHex: SPEND_WITH_MINT_HEX }],
    requiredSigners: [deployment.adamBotPkh],
    refInputs: [deployment.spendRefUtxo, deployment.beaconRefUtxo],
    validToUnixMs: null,
  };
}

// ---- thin @lucid-evolution assembler ----

export interface AssembleCardanoSwapsTxArgs {
  lucid: LucidEvolution;
  deployment: CardanoSwapsDeployment;
  recipe: CardanoSwapsRecipe;
  changeAddress: string;
  collateralUtxo: UTxO;
  fundingUtxos: UTxO[];
}

/**
 * Resolve reference scripts + any spent order UTxOs, attach every redeemer, pay each
 * pre-floored output, apply beacon mint/burn groups, execute each withdraw-0 staking
 * script, declare the required signers (the ADAM bot), set the ttl, and complete.
 */
export async function assembleCardanoSwapsTx(
  args: AssembleCardanoSwapsTxArgs,
): Promise<{ unsignedCbor: string; txHash: string }> {
  const { lucid, deployment, recipe } = args;

  const refUtxos = await lucid.utxosByOutRef(recipe.refInputs.map((r) => ({ txHash: r.txHash, outputIndex: r.outputIndex })));
  if (refUtxos.length !== recipe.refInputs.length) throw new Error("one or more reference-script UTxOs not found");

  lucid.selectWallet.fromAddress(args.changeAddress, [args.collateralUtxo]);
  let tx = lucid.newTx();

  for (const spend of recipe.spends) {
    const [orderUtxo] = await lucid.utxosByOutRef([{ txHash: spend.orderRef.txHash, outputIndex: spend.orderRef.outputIndex }]);
    if (!orderUtxo) throw new Error(`order UTxO ${spend.orderRef.txHash}#${spend.orderRef.outputIndex} not found`);
    tx = tx.collectFrom([orderUtxo], spend.redeemerHex);
  }
  if (args.fundingUtxos.length > 0) tx = tx.collectFrom(args.fundingUtxos);
  tx = tx.readFrom(refUtxos);

  for (const out of recipe.outputs) {
    tx =
      out.inlineDatumHex === ""
        ? tx.pay.ToAddress(out.addressBech32, out.assets)
        : tx.pay.ToAddressWithData(out.addressBech32, { kind: "inline", value: out.inlineDatumHex }, out.assets);
  }
  for (const group of recipe.mints) {
    if (group.assets.length === 0) continue;
    const bag: Assets = {};
    for (const m of group.assets) bag[m.unit] = m.quantity;
    tx = tx.mintAssets(bag, group.redeemerHex);
  }
  for (const w of recipe.withdrawals) {
    const rewardAddr = credentialToRewardAddress(deployment.network, { type: "Script", hash: w.stakeScriptHash });
    tx = tx.withdraw(rewardAddr, 0n, w.redeemerHex);
  }
  for (const pkh of recipe.requiredSigners) tx = tx.addSignerKey(pkh);
  if (recipe.validToUnixMs !== null) tx = tx.validTo(recipe.validToUnixMs);

  const signBuilder = await tx.complete({ changeAddress: args.changeAddress, setCollateral: 5_000_000n });
  return { unsignedCbor: signBuilder.toCBOR(), txHash: signBuilder.toHash() };
}

export type { OneWayOrder };
