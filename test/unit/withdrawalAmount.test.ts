/**
 * A withdrawal has to say how much it withdraws.
 *
 * Every builder in this stack emitted `tx.withdraw(rewardAddr, 0n, redeemer)` — a hardcoded zero —
 * because `CsWithdrawal` had no field for an amount. That is correct exactly while the credential's
 * reward balance is zero, and the ledger refuses the transaction outright the moment it is not:
 * a withdrawal must drain the balance EXACTLY.
 *
 * MMaaS is about to let clients delegate their own vault (task #379), so the balance stops being
 * zero ~4 epochs later. From that instant a client's cancel BUILDS cleanly — cardano-api's
 * queryStateForBalancedTx never queries a reward account — gets SIGNED, and is refused by the node.
 *
 * `amountLovelace` is REQUIRED, not optional-defaulting-to-zero. An optional field with a zero
 * default would leave every un-updated call site emitting exactly the bug this exists to kill,
 * and would do it silently. Required means the compiler names every site.
 */
import { describe, it, expect } from 'vitest';
import type { CsWithdrawal } from '../../src/cardanoSwapsLifecycle.js';

describe('CsWithdrawal — the amount is part of the recipe', () => {
  it('carries an explicit amountLovelace', () => {
    const w: CsWithdrawal = { stakeScriptHash: 'aa'.repeat(28), redeemerHex: 'd87980', amountLovelace: 0n };
    expect(w.amountLovelace).toBe(0n);
  });

  it('is a bigint, so a lovelace amount can never lose precision on the way to the ledger', () => {
    const w: CsWithdrawal = { stakeScriptHash: 'aa'.repeat(28), redeemerHex: 'd87980', amountLovelace: 9_007_199_254_740_993n };
    expect(typeof w.amountLovelace).toBe('bigint');
    // one past Number.MAX_SAFE_INTEGER — a number here would round and the ledger would refuse
    expect(w.amountLovelace).not.toBe(BigInt(Number(9_007_199_254_740_993n)));
  });
});
