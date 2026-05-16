import { TupleParam } from '@clickhouse/client';
import { ch } from '../../lib/ch';
import { chunked } from '../../lib/chunked';
import { grc2halford } from '../../lib/halford';
import { ParsedTxOutputRow, PrevOutputsLookup } from './ContractParser';

interface CacheEntry {
  address: string | null;
  value: bigint;
}

/**
 * Resolve `(prev_tx, prev_vout)` → `(address, value)` for vin attribution.
 * Forward-only backfill guarantees that any input we encounter at height
 * H has its source UTXO already written by some height < H, so a single
 * SELECT against tx_outputs is enough.
 *
 * Single-block variant — see `buildPrevOutputsLookupMulti` for the
 * batch path used by `HistoricalBackfiller`.
 */
export async function buildPrevOutputsLookup(
  blockTxs: Array<TxLite>,
): Promise<PrevOutputsLookup> {
  return buildPrevOutputsLookupMulti([blockTxs]);
}

interface VoutLite {
  n: number;
  value: number | string;
  scriptPubKey?: { addresses?: string[]; type?: string };
}

interface TxLite {
  txid: string;
  vin: Array<{ txid?: string; vout?: number; coinbase?: string }>;
  vout?: VoutLite[];
}

/**
 * Multi-block variant. Collects every `(prev_tx, prev_vout)` referenced
 * across `blocksTxs` and fetches them in a single IN-clause query.
 *
 * Crucially, the returned lookup also covers the *batch's own*
 * outputs — a tx in block H can spend an output produced by an
 * earlier tx in block H (or any earlier block in the same batch),
 * and those rows aren't in `tx_outputs` at lookup time because
 * we're still inside the same indexer transaction. Without this
 * in-batch enrichment, those vins resolve to `null` value and the
 * fee for the spending tx is computed wrong (sometimes wildly so).
 *
 * `parsedPending` covers a subtler case: HistoricalBackfiller's drain
 * loop can build a new lookup while a previously-parsed batch is
 * still sitting in the `pending` buffer waiting on flush (when the
 * earlier rawGroup ran shorter than txBatchSize and the eager-flush
 * gate held it back). Without including those parsed-but-not-flushed
 * outputs here, a vin in this rawGroup that spends one of them
 * silently resolves to `null` — the tx_inputs row goes in with
 * address=NULL and value=NULL, `bumpDelta` skips the debit, and the
 * matching credit on the output side becomes a permanent overcount
 * in `address_balance_history`. Empirically (pre-fix mainnet replay)
 * this produced 14,436 leaked inputs summing to ~2.11 B GRC of
 * phantom balance — a 6.6× inflation of total tracked balance vs
 * money_supply. See WealthSnapshotJob notes for the audit.
 */
export async function buildPrevOutputsLookupMulti(
  blocksTxs: Array<Array<TxLite>>,
  parsedPending: ReadonlyArray<ParsedTxOutputRow> = [],
): Promise<PrevOutputsLookup> {
  const refs: Array<{ prev_tx: string; prev_vout: number }> = [];
  const seen = new Set<string>();
  for (const blockTxs of blocksTxs) {
    for (const tx of blockTxs) {
      for (const v of tx.vin) {
        if (typeof v.coinbase === 'string') continue;
        if (typeof v.txid !== 'string' || typeof v.vout !== 'number') continue;
        const key = `${v.txid}:${v.vout}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ prev_tx: v.txid, prev_vout: v.vout });
      }
    }
  }

  // Build the in-batch lookup first. We index every vout across the
  // batch by `(txid, n)`. Halford conversion mirrors the indexer's
  // top-level `grc2halford` (string GRC with up to 8 decimals →
  // bigint halford) — copied here to avoid a circular import.
  const cache = new Map<string, CacheEntry>();
  // Pre-seed from any already-parsed batches that haven't been
  // flushed to CH yet. Drain-loop callers pass these in; if a vin
  // here spends one of those outputs, we resolve from memory rather
  // than firing a CH query that would miss.
  for (const o of parsedPending) {
    cache.set(`${o.txId}:${o.voutN}`, { address: o.address, value: o.value });
  }
  for (const blockTxs of blocksTxs) {
    for (const tx of blockTxs) {
      const vouts = tx.vout ?? [];
      for (const vout of vouts) {
        const addrList = vout.scriptPubKey?.addresses;
        const address = Array.isArray(addrList) && addrList.length > 0 ? addrList[0] : null;
        const value = grc2halford(vout.value);
        cache.set(`${tx.txid}:${vout.n}`, { address, value });
      }
    }
  }

  if (refs.length > 0) {
    // Only query CH for refs we haven't already covered from the
    // in-batch index. Filter on the pair `(tx_id, vout_n)` so the row
    // predicate is exact — the previous shape used two separate `IN`
    // clauses and matched the cartesian product, then narrowed in JS,
    // shipping every output of every interesting tx over the wire.
    // The `tx_id_bloom` skip index still prunes granules off the
    // tuple's first element.
    //
    // No FINAL: address+value for a given (tx_id, vout_n) are
    // deterministic from tx content, so even when reorg leaves a stale
    // pre-merge row sitting next to the new one, both carry identical
    // values — the duplicate just causes one redundant Map.set. Skipping
    // FINAL avoids the merge-time scan that dominates batch latency.
    const dbRefs = refs.filter((r) => !cache.has(`${r.prev_tx}:${r.prev_vout}`));
    if (dbRefs.length > 0) {
      // The @clickhouse/client formatter writes JS arrays with brackets
      // (`[…]`) — fine for `Array(String)`, wrong for `Array(Tuple(…))`,
      // which the CH parameter parser wants as `[(…),(…)]`. `TupleParam`
      // is the lib's escape hatch: each instance serializes to a paren-
      // wrapped tuple literal, leaving the outer array intact.
      //
      // Chunking guard: query parameters travel as URL query string in
      // the @clickhouse/client transport (`?param_pairs=[...]`). CH /
      // Poco's HTTP server enforces a per-field length limit, ~8KB
      // by default, beyond which the request is rejected with
      // "HTML Form Exception: Field value too long" — this surfaced
      // during backfill at BACKFILL_TX_BATCH_SIZE=500 because a busy
      // batch can carry several thousand prev-output refs (~70 chars
      // per tuple literal → ~200KB payload). Chunking at 400 pairs
      // keeps every request well under the limit at the cost of a
      // few extra round trips per batch on dense periods.
      type Row = { tx_id: string; vout_n: number; address: string; value: string };
      for (const slice of chunked(dbRefs, 400)) {
        const pairs = slice.map((r) => new TupleParam([r.prev_tx, r.prev_vout]));
        // eslint-disable-next-line no-await-in-loop
        const result = await ch.query({
          query: `
            SELECT tx_id, vout_n, address, value
            FROM tx_outputs
            WHERE (tx_id, vout_n) IN ({pairs: Array(Tuple(String, UInt16))})
          `,
          query_params: { pairs },
          format: 'JSONEachRow',
        });
        // eslint-disable-next-line no-await-in-loop
        const rows = await result.json<Row>();
        for (const r of rows) {
          const key = `${r.tx_id}:${r.vout_n}`;
          // Empty-string sentinel from the writer means "no address" —
          // surface it as null to keep the parser's existing semantics.
          cache.set(key, { address: r.address === '' ? null : r.address, value: BigInt(r.value) });
        }
      }
    }
  }

  if (cache.size === 0) return () => null;
  return (prevTx, prevVout) => cache.get(`${prevTx}:${prevVout}`) ?? null;
}
