// Pure owner / fee / premium output-value sizing, shared by the V2 (fill.ts) and V3
// (fillV3.ts) planners. Token-bearing outputs are floored to the ledger min-UTxO computed
// from the live coinsPerUtxoByte; the inline PaymentDatum is counted in the size.

import type { Assets } from "@lucid-evolution/lucid";
import { minUtxoLovelace } from "./minUtxo.js";

/** 4-byte-width placeholder coin used only for sizing token-bearing outputs. */
export const MINUTXO_SIZING_LOVELACE = 2_000_000n;

/** Owner-payment output value (SPEC §7.5 / owner_value_has_correct_amount + §8 buffer). */
export function ownerOutputAssets(params: {
  buyIsAda: boolean;
  buyUnit: string;
  amountBuy: bigint;
  isFullFill: boolean;
  userSellAmount: bigint;
  scriptLovelace: bigint;
  sellBuffer: bigint;
  ownerAddressBech32: string;
  paymentDatumHex: string;
  coinsPerUtxoByte: bigint;
}): Assets {
  const out: Assets = {};
  if (params.buyIsAda) {
    // owner receives ADA. Full fill of a non-ADA-sell order needs lovelace >= amount_buy +
    // script lovelace; partial needs lovelace >= user_sell_amount (+ buffer, 0 when sell is a token).
    const required = params.isFullFill
      ? params.amountBuy + params.scriptLovelace
      : params.userSellAmount + params.sellBuffer;
    const min = minUtxoLovelace(
      { addressBech32: params.ownerAddressBech32, assets: { lovelace: required }, inlineDatumHex: params.paymentDatumHex },
      params.coinsPerUtxoByte,
    );
    out["lovelace"] = required > min ? required : min;
  } else {
    // owner receives the buy TOKEN. The §8 ADA-sell buffer must land on the owner; otherwise
    // just the output's min-utxo.
    const tokenAmt = params.isFullFill ? params.amountBuy : params.userSellAmount;
    out[params.buyUnit] = tokenAmt;
    const min = minUtxoLovelace(
      { addressBech32: params.ownerAddressBech32, assets: { lovelace: MINUTXO_SIZING_LOVELACE, [params.buyUnit]: tokenAmt }, inlineDatumHex: params.paymentDatumHex },
      params.coinsPerUtxoByte,
    );
    out["lovelace"] = params.sellBuffer > min ? params.sellBuffer : min;
  }
  return out;
}

/** Fee output value (SPEC §7.6): >= total_fee of the SELL asset, floored to min-UTxO. */
export function feeOutputAssets(params: {
  sellIsAda: boolean;
  sellUnit: string;
  totalFee: bigint;
  feeAddress: string;
  paymentDatumHex: string;
  coinsPerUtxoByte: bigint;
}): Assets {
  const out: Assets = {};
  if (params.sellIsAda) {
    const min = minUtxoLovelace(
      { addressBech32: params.feeAddress, assets: { lovelace: MINUTXO_SIZING_LOVELACE }, inlineDatumHex: params.paymentDatumHex },
      params.coinsPerUtxoByte,
    );
    out["lovelace"] = params.totalFee > min ? params.totalFee : min;
  } else {
    out[params.sellUnit] = params.totalFee;
    out["lovelace"] = minUtxoLovelace(
      { addressBech32: params.feeAddress, assets: { lovelace: MINUTXO_SIZING_LOVELACE, [params.sellUnit]: params.totalFee }, inlineDatumHex: params.paymentDatumHex },
      params.coinsPerUtxoByte,
    );
  }
  return out;
}

/** §8 relist continuation value: exactly [ADA] (ADA-sell) or [ADA, sell-token], sized so the
 *  continuation clears the ledger min-UTxO and (non-ADA-sell) preserves the spent script's ADA. */
export function relistContinuationAssets(params: {
  sellIsAda: boolean;
  sellUnit: string;
  correctedNewAmountSell: bigint;
  scriptLovelace: bigint;
  orderAddress: string;
  datumHex: string;
  coinsPerUtxoByte: bigint;
}): Assets {
  const out: Assets = {};
  if (params.sellIsAda) {
    const min = minUtxoLovelace(
      { addressBech32: params.orderAddress, assets: { lovelace: params.correctedNewAmountSell || MINUTXO_SIZING_LOVELACE }, inlineDatumHex: params.datumHex },
      params.coinsPerUtxoByte,
    );
    out["lovelace"] = params.correctedNewAmountSell > min ? params.correctedNewAmountSell : min;
  } else {
    out[params.sellUnit] = params.correctedNewAmountSell;
    const min = minUtxoLovelace(
      { addressBech32: params.orderAddress, assets: { lovelace: MINUTXO_SIZING_LOVELACE, [params.sellUnit]: params.correctedNewAmountSell }, inlineDatumHex: params.datumHex },
      params.coinsPerUtxoByte,
    );
    out["lovelace"] = params.scriptLovelace > min ? params.scriptLovelace : min;
  }
  return out;
}

/** V3 Aegis premium output value: >= required of the BUY asset to the coverage vault, floored
 *  to min-UTxO, tagged with the same PaymentDatum so it is uniquely located (§7.6-style). */
export function premiumOutputAssets(params: {
  buyIsAda: boolean;
  buyUnit: string;
  required: bigint;
  vaultAddressBech32: string;
  paymentDatumHex: string;
  coinsPerUtxoByte: bigint;
}): Assets {
  const out: Assets = {};
  if (params.buyIsAda) {
    const min = minUtxoLovelace(
      { addressBech32: params.vaultAddressBech32, assets: { lovelace: MINUTXO_SIZING_LOVELACE }, inlineDatumHex: params.paymentDatumHex },
      params.coinsPerUtxoByte,
    );
    out["lovelace"] = params.required > min ? params.required : min;
  } else {
    out[params.buyUnit] = params.required;
    out["lovelace"] = minUtxoLovelace(
      { addressBech32: params.vaultAddressBech32, assets: { lovelace: MINUTXO_SIZING_LOVELACE, [params.buyUnit]: params.required }, inlineDatumHex: params.paymentDatumHex },
      params.coinsPerUtxoByte,
    );
  }
  return out;
}
