/**
 * The amount reaches the ASSEMBLER, not just the planner.
 *
 * The only shipped behaviour change in the withdrawal work is two lines inside
 * `assembleCardanoSwapsTx`, and nothing exercised them: every other test passes
 * `amountLovelace: 0n`, a value indistinguishable from the hardcoded zero it replaced. A security
 * review proved it by mutation — reverting the assembler to `0n` AND deleting its guard left the
 * whole suite green. A planner test cannot cover this; the planner is not what talks to lucid.
 *
 * The lucid tx builder is stubbed rather than driven, because what is under test is which bigint
 * reaches `tx.withdraw` — not lucid's ability to build a transaction.
 */
import { describe, it, expect, vi } from 'vitest';
import { assembleCardanoSwapsTx, CARDANO_SWAPS_MAINNET } from '../../src/index.js';

const HASH = '3227e1438302c680307273d6dc2e3261e4b60c364d5eb5b0cf7b0151';

function stubLucid(withdraw: ReturnType<typeof vi.fn>) {
  const tx: Record<string, unknown> = {};
  for (const m of ['collectFrom', 'readFrom', 'mintAssets', 'addSignerKey', 'validTo']) tx[m] = () => tx;
  tx.pay = { ToAddress: () => tx, ToAddressWithData: () => tx };
  tx.attach = { WithdrawalValidator: () => tx };
  tx.withdraw = (...a: unknown[]) => { withdraw(...a); return tx; };
  tx.complete = async () => ({ toCBOR: () => 'CBOR', toHash: () => 'HASH' });
  return {
    newTx: () => tx,
    selectWallet: { fromAddress: () => {} },
    utxosByOutRef: async (refs: unknown[]) =>
      refs.map((r) => ({ ...(r as object), address: 'addr1', assets: { lovelace: 1n }, datum: null })),
  };
}

const recipeWith = (amountLovelace: unknown) => ({
  action: 'reprice' as const,
  outputs: [],
  mints: [],
  withdrawals: [{ stakeScriptHash: CARDANO_SWAPS_MAINNET.beaconPolicy, redeemerHex: 'd87980', amountLovelace }],
  spends: [],
  requiredSigners: [],
  refInputs: [CARDANO_SWAPS_MAINNET.beaconRefUtxo],
  validToUnixMs: null,
});

const assemble = (amountLovelace: unknown, withdraw = vi.fn()) =>
  assembleCardanoSwapsTx({
    lucid: stubLucid(withdraw),
    deployment: CARDANO_SWAPS_MAINNET,
    recipe: recipeWith(amountLovelace),
    changeAddress: 'addr1',
    collateralUtxo: { txHash: '7e'.repeat(32), outputIndex: 1, address: 'addr1', assets: { lovelace: 6_000_000n } },
    fundingUtxos: [],
  } as never);

describe('assembleCardanoSwapsTx — the withdrawal amount', () => {
  it('hands lucid the exact bigint the recipe states', async () => {
    const withdraw = vi.fn();
    await assemble(7_654_321n, withdraw);
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw.mock.calls[0]![1]).toBe(7_654_321n);
  });

  it('still hands it a zero when the recipe says zero', async () => {
    const withdraw = vi.fn();
    await assemble(0n, withdraw);
    expect(withdraw.mock.calls[0]![1]).toBe(0n);
  });

  it('REFUSES a negative amount', async () => {
    await expect(assemble(-1n)).rejects.toThrow(/non-negative/);
  });

  it('REFUSES an undefined amount rather than passing it to the WASM binding', async () => {
    // `undefined < 0n` is false, so a bare comparison would let this through to CML, which fails
    // with a message naming no credential.
    await expect(assemble(undefined)).rejects.toThrow(/non-negative/);
  });
});
