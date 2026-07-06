// V4 fill/deposit/fee arithmetic — an exact port of the on-chain Aiken math
// so an off-chain planner computes byte-identical quantities to what the
// validators enforce:
//   lib/saturn_swap_v4/utils.ak            ratio_released (floor)
//   lib/saturn_swap_v4/two_way_validation  required_deposit (ceil)
//   lib/saturn_swap_v4/validation.ak       fee_paid (max(1, ...))
//   lib/saturn_swap_v4/validation.ak       coverage premium (max(1, ...))
//
// All values are base units (lovelace / token base units). BigInt throughout —
// Plutus integers are bignums, so there is no overflow to mirror.

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** One-way: sell released for a delivered buy amount, at the order's fixed
 *  ratio. Floor division — rounding favors the maker (exactly ratio_released). */
export function ratioReleased(amountSell: bigint, amountBuy: bigint, buyAmount: bigint): bigint {
  if (amountBuy <= 0n) throw new Error("amountBuy must be > 0");
  return (amountSell * buyAmount) / amountBuy;
}

/** Two-way: asset the taker must deposit to withdraw `takeAmount` of the
 *  other side, at price num/den. Ceiling division — favors the maker
 *  (exactly required_deposit). */
export function requiredDeposit(takeAmount: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("den must be > 0");
  return (takeAmount * num + den - 1n) / den;
}

/** Model-A protocol fee on a fill (in the SELL asset), or 0n under Model B
 *  (feePercentBps <= 0). Matches fee_paid: max(1, released*bps/10000). */
export function feeAmount(released: bigint, feePercentBps: number): bigint {
  if (feePercentBps <= 0) return 0n;
  return bigMax(1n, (released * BigInt(feePercentBps)) / 10000n);
}

/** Aegis coverage premium on a fill (in the BUY asset). Matches
 *  coverage_premium_paid: max(1, buyAmount*premiumBps/10000). */
export function coveragePremium(buyAmount: bigint, premiumBps: bigint): bigint {
  if (premiumBps < 0n) throw new Error("premiumBps must be >= 0");
  return bigMax(1n, (buyAmount * premiumBps) / 10000n);
}

/** Partial-fill continuation amounts (the datum the taker must relist). */
export function partialFillContinuation(
  amountSell: bigint,
  amountBuy: bigint,
  buyAmount: bigint,
): { released: bigint; newAmountSell: bigint; newAmountBuy: bigint } {
  const released = ratioReleased(amountSell, amountBuy, buyAmount);
  return {
    released,
    newAmountSell: amountSell - released,
    newAmountBuy: amountBuy - buyAmount,
  };
}
