import { chunked } from '../../lib/chunked';
import { query } from '../../lib/db';
import { ParsedBlock } from './ContractParser';

// Phantom-spend (Halford-era kernel-reuse coinstake) detection,
// backed by tx_inputs itself instead of the old Redis `utxo:spent`
// membership set. That set had grown to ~11M members (~1.2 GB of
// Redis) mirroring data the DB already holds: an outpoint is spent
// iff a non-phantom tx_inputs row references it, and
// idx_tx_inputs_prevout makes that a point lookup. Dropping the
// mirror also removes its whole maintenance surface — reorg SREM
// release, partial-wipe reseed, cold-start rebuild — because deleting
// the abandoned tx_inputs rows IS the release.
//
// First-spender-wins ordering: earlier blocks are already in the DB
// when a batch is checked (BlockWriter applies batches in ascending
// height order and markPhantomSpends runs before the batch's own
// inserts), and within the batch we walk inputs in chain order with a
// local first-claim set.

/**
 * Identify phantom spends across a batch and cancel their debits in
 * the per-block addressDeltas before applyBlocks writes anything.
 *
 * Must be called with parsedList in strict ascending block-height
 * order — the first vin (in chain order: block, then tx index, then
 * vin_n) to reference a UTXO is the canonical spender; every later
 * reference is a phantom.
 *
 * Side effects on the input:
 *  - `txInput.isPhantomSpend = true` for every re-claim.
 *  - The matching `addressDeltas` entry is credited back the input's
 *    value (delta += value, sent -= value). When that fully cancels
 *    the address out, no row clean-up is necessary because
 *    insertAddressBalanceHistory still emits a row carrying the
 *    deltaless `received`/`tx_count_delta`; downstream sum(delta)
 *    queries see a zero contribution from the phantom.
 */
export async function markPhantomSpends(parsedList: ParsedBlock[]): Promise<void> {
  if (parsedList.length === 0) return;

  // Flatten in chain order. parsedList is already height-sorted by
  // the caller; within a block, ContractParser pushes txInputs in
  // tx-index then vin_n order (block.tx.forEach → vin.forEach).
  type Item = {
    blockIdx: number;
    inputIdx: number;
    key: string;
    txId: string;
    vinN: number;
    address: string | null;
    value: bigint;
  };
  const items: Item[] = [];
  for (let bi = 0; bi < parsedList.length; bi += 1) {
    const p = parsedList[bi];
    for (let ii = 0; ii < p.txInputs.length; ii += 1) {
      const inp = p.txInputs[ii];
      // Coinbase-style inputs have no prev_tx; nothing to dedupe.
      if (!inp.prevTx) continue;
      items.push({
        blockIdx: bi,
        inputIdx: ii,
        key: `${inp.prevTx}:${inp.prevVout}`,
        txId: inp.txId,
        vinN: inp.vinN,
        address: inp.address,
        value: inp.value ?? 0n,
      });
    }
  }
  if (items.length === 0) return;

  // One indexed lookup for every referenced outpoint's existing
  // canonical spender. Keyed by prev_tx (idx_tx_inputs_prevout leading
  // column) — a prev_tx has at most a handful of spent outputs, so the
  // result set stays proportional to the batch. Self-rows (same
  // (tx_id, vin_n) as the input being checked) are the crash-replay
  // case — the row this very input wrote before the cursor advanced —
  // and must not phantom their own re-apply.
  const claimedBy = new Map<string, { txId: string; vinN: number }>();
  const prevTxs = Array.from(new Set(items.map((it) => it.key.slice(0, it.key.lastIndexOf(':')))));
  for (const slice of chunked(prevTxs, 5_000)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await query<{
      prev_tx: string; prev_vout: number; tx_id: string; vin_n: number;
    }>(
      `
        SELECT prev_tx, prev_vout, tx_id, vin_n
        FROM tx_inputs
        WHERE prev_tx IN ($txs) AND is_phantom_spend = false
      `,
      { txs: [...slice] },
    );
    for (const r of rows) {
      claimedBy.set(`${r.prev_tx}:${r.prev_vout}`, { txId: r.tx_id, vinN: Number(r.vin_n) });
    }
  }

  const claimedInBatch = new Set<string>();
  for (const it of items) {
    const existing = claimedBy.get(it.key);
    const claimedByOther = existing !== undefined
      && !(existing.txId === it.txId && existing.vinN === it.vinN);
    const isPhantom = claimedByOther || claimedInBatch.has(it.key);
    if (!isPhantom) {
      claimedInBatch.add(it.key);
      continue;
    }

    parsedList[it.blockIdx].txInputs[it.inputIdx].isPhantomSpend = true;

    // Cancel the debit that ContractParser already booked into
    // addressDeltas. No-op when the input never resolved an address
    // (script-only spends): we didn't bump in the first place.
    if (it.address && it.value > 0n) {
      const entry = parsedList[it.blockIdx].addressDeltas.get(it.address);
      if (entry) {
        entry.delta += it.value;
        if (entry.sent >= it.value) entry.sent -= it.value;
        else entry.sent = 0n;
      }
    }
  }
}
