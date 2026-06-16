import { query } from '../../lib/db';
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
  // flushed to the DB yet. Drain-loop callers pass these in; if a vin
  // here spends one of those outputs, we resolve from memory rather
  // than firing a query that would miss.
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
    // Only query for refs we haven't already covered from the in-batch
    // index. Match the exact `(tx_id, vout_n)` pairs via a positional
    // zip of two parallel arrays unnested into a join table — the
    // DuckDB equivalent of CH's `(tx_id, vout_n) IN Array(Tuple(...))`.
    // No dedup needed: (tx_id, vout_n) is the PRIMARY KEY (one row per
    // outpoint via upsert). DuckDB binds params in-process, so there's
    // no URL-length limit and the whole ref set goes in one query.
    const dbRefs = refs.filter((r) => !cache.has(`${r.prev_tx}:${r.prev_vout}`));
    if (dbRefs.length > 0) {
      type Row = { tx_id: string; vout_n: number; address: string; value: string };
      const rows = await query<Row>(
        `
          SELECT o.tx_id, o.vout_n, o.address, CAST(o.value AS VARCHAR) AS value
          FROM tx_outputs AS o
          JOIN (SELECT unnest($txs) AS tx_id, unnest($vouts) AS vout_n) AS p
            ON o.tx_id = p.tx_id AND o.vout_n = p.vout_n
        `,
        { txs: dbRefs.map((r) => r.prev_tx), vouts: dbRefs.map((r) => r.prev_vout) },
      );
      for (const r of rows) {
        const key = `${r.tx_id}:${r.vout_n}`;
        // Empty-string sentinel from the writer means "no address" —
        // surface it as null to keep the parser's existing semantics.
        cache.set(key, { address: r.address === '' ? null : r.address, value: BigInt(r.value) });
      }
    }
  }

  if (cache.size === 0) return () => null;
  return (prevTx, prevVout) => cache.get(`${prevTx}:${prevVout}`) ?? null;
}
