// Canonical ledger input sort. Conway sorts tx inputs by tx_id bytes (lexicographic),
// then output_index. The SwapAction.input_index must be the order input's position in
// THIS sorted list (consumed by get_own_input_fast). This is the canonical Conway ledger order.

import { hexToBytes } from "./cbor.js";

export interface TxIn {
  txHash: string;
  outputIndex: number;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

export function compareTxIn(a: TxIn, b: TxIn): number {
  const d = compareBytes(hexToBytes(a.txHash), hexToBytes(b.txHash));
  if (d !== 0) return d;
  return a.outputIndex - b.outputIndex;
}

export function sortInputs<T extends TxIn>(inputs: T[]): T[] {
  return [...inputs].sort(compareTxIn);
}

/** Index of `target` in the canonically-sorted input list. -1 if absent. */
export function inputIndexOf(inputs: TxIn[], target: TxIn): number {
  const sorted = sortInputs(inputs);
  return sorted.findIndex((i) => i.txHash === target.txHash && i.outputIndex === target.outputIndex);
}

/** The dedicated collateral UTxO must be disjoint from the spend (funding) inputs: an overlap
 *  lets Lucid pledge the same UTxO as collateral AND spend it, which the ledger rejects. */
export function assertCollateralDisjoint(collateral: TxIn, funding: TxIn[]): void {
  const key = `${collateral.txHash}#${collateral.outputIndex}`;
  if (funding.some((f) => `${f.txHash}#${f.outputIndex}` === key))
    throw new Error(
      `collateral UTxO ${key} also appears in fundingUtxos — collateral must be disjoint from the spend inputs`,
    );
}
