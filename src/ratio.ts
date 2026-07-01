// Exact port of the saturn_swap validator's ratio + fee helpers (on-chain behavior).
// All BigInt. Roundings match
// Aiken integer division (truncate toward zero == floor for non-negative operands;
// every operand here is non-negative).

import { RATIO_SCALE } from "./contract.js";

/** calculate_ratio — rounds UP */
export function calculateRatio(divisor: bigint, dividend: bigint, scale = RATIO_SCALE): bigint {
  return (divisor * scale + dividend - 1n) / dividend;
}

/** calculate_from_ratio — rounds UP */
export function calculateFromRatio(amount: bigint, ratio: bigint, scale = RATIO_SCALE): bigint {
  return (amount * ratio + scale - 1n) / scale;
}

/** get_ratio_amount(old_token_amount, new_token_amount, old_amount) — rounds UP */
export function getRatioAmount(oldTokenAmount: bigint, newTokenAmount: bigint, oldAmount: bigint): bigint {
  const ratio = calculateRatio(newTokenAmount, oldTokenAmount, RATIO_SCALE);
  return calculateFromRatio(oldAmount, ratio, RATIO_SCALE);
}

/** calculate_fee — rounds DOWN. fee_percent_x100 = 100 (1%) or 400 (4%). */
export function calculateFee(amount: bigint, feePercentX100: number): bigint {
  return (amount * BigInt(feePercentX100)) / 10_000n;
}

/**
 * Proportional sell released this fill, and the fee on it (paid in the SELL asset).
 *   new_swap_amount_sell = get_ratio_amount(amount_buy, user_sell_amount, amount_sell)
 *   total_fee            = calculate_fee(new_swap_amount_sell, feePercentX100)
 */
export function fillSellAndFee(
  amountSell: bigint,
  amountBuy: bigint,
  userSellAmount: bigint,
  feePercentX100: number,
): { newSwapAmountSell: bigint; totalFee: bigint } {
  const newSwapAmountSell = getRatioAmount(amountBuy, userSellAmount, amountSell);
  const totalFee = calculateFee(newSwapAmountSell, feePercentX100);
  // Dust fill: the released sell is so small the 1% fee floors to 0 (released < 100 base units).
  // A 0-fee fill emits a fee output carrying none of the sell asset — refuse rather than ship it.
  if (feePercentX100 > 0 && newSwapAmountSell > 0n && totalFee === 0n)
    throw new Error(
      `dust fill: released sell ${newSwapAmountSell} floors the fee to 0 — fill at least 100 base units of the sell asset`,
    );
  return { newSwapAmountSell, totalFee };
}

/**
 * V3 Aegis premium for this fill (the validator's `premium_paid_to_vault`):
 *   required = filled_buy_amount * premium_bps / 10000   (integer division, rounds DOWN)
 * denominated in the order's BUY asset, paid to the coverage vault. `filled_buy_amount` is the
 * user_sell_amount (the buy asset delivered this fill). required <= 0 ⇒ no premium output.
 */
export function premiumForFill(filledBuyAmount: bigint, premiumBps: bigint): bigint {
  if (filledBuyAmount <= 0n || premiumBps <= 0n) return 0n;
  return (filledBuyAmount * premiumBps) / 10_000n;
}

const TWO_ADA = 2_000_000n;

/**
 * Relist (swap_split) amounts for a PARTIAL fill, exact port of
 * the validator's swap_split path. There `new_amount_buy` = amount_buy - userSellAmount.
 *   new_amount_sell           = get_ratio_amount(amount_buy, remaining_buy, amount_sell)
 *   sell_amount_buffer        = (sell is ADA && new_amount_sell > 2 ADA) ? 2 ADA : 0
 *   corrected_new_amount_sell = new_amount_sell - buffer
 *   corrected_new_amount_buy  = buffer>0 ? get_ratio_amount(amount_sell, corrected_new_amount_sell, amount_buy)
 *                                        : remaining_buy
 * The continuation datum's amount_sell/amount_buy may sit anywhere in
 * [corrected_*, uncorrected_*]; this lib pins them to the corrected (minimum) values.
 */
export function swapSplitAmounts(
  amountSell: bigint,
  amountBuy: bigint,
  userSellAmount: bigint,
  isLimitSellAda: boolean,
): {
  remainingBuy: bigint;
  newAmountSell: bigint;
  sellBuffer: bigint;
  correctedNewAmountSell: bigint;
  correctedNewAmountBuy: bigint;
} {
  const remainingBuy = amountBuy - userSellAmount;
  const newAmountSell = getRatioAmount(amountBuy, remainingBuy, amountSell);
  const sellBuffer = isLimitSellAda && newAmountSell > TWO_ADA ? TWO_ADA : 0n;
  const correctedNewAmountSell = newAmountSell - sellBuffer;
  const correctedNewAmountBuy =
    sellBuffer > 0n ? getRatioAmount(amountSell, correctedNewAmountSell, amountBuy) : remainingBuy;
  return { remainingBuy, newAmountSell, sellBuffer, correctedNewAmountSell, correctedNewAmountBuy };
}
