import { ch } from '../../lib/ch';
import { events } from '../../lib/emitter';
import { rpc } from '../../lib/gridcoin';
import { grc2halford, halford2grc, sumHalford } from '../../lib/halford';
import { log } from '../../lib/log';
import { nextSeq } from '../../lib/redis';
import { parseMrcContract } from './ContractParser';
import { ContractEnvelope } from './types';

interface RawTxInfo {
  txid: string;
  size: number;
  vin: Array<{ txid?: string; vout?: number; coinbase?: string }>;
  vout: Array<{
    value: number;
    n?: number;
    scriptPubKey?: { type?: string; addresses?: string[] };
  }>;
  contracts?: ContractEnvelope[];
}

// Polls `getrawmempool` every MEMPOOL_POLL_INTERVAL_MS, diffs against
// the in-memory snapshot from the previous tick, persists into
// ClickHouse `mempool_txs` (ReplacingMergeTree(_seq), so confirm /
// evict are re-inserts with bumped _seq, not in-place updates).
//
// Mempool rows are kept forever — confirmation/eviction stamps the
// existing row with a timestamp rather than deleting it. /mempool?at=T
// reconstructs the snapshot at any past T.
export class MempoolWatcher {
  private lastSnapshot = new Set<string>();

  private lastAggregateAt = 0;

  private prevTxCache = new Map<string, RawTxInfo>();

  async tick(): Promise<void> {
    const ids = await this.getRawMempool();
    const current = new Set(ids);

    const entered: string[] = [];
    const exited: string[] = [];
    for (const id of current) if (!this.lastSnapshot.has(id)) entered.push(id);
    for (const id of this.lastSnapshot) if (!current.has(id)) exited.push(id);

    for (const txId of entered) {
      // eslint-disable-next-line no-await-in-loop
      await this.handleEntry(txId);
    }
    for (const txId of exited) {
      // eslint-disable-next-line no-await-in-loop
      await this.handleExit(txId);
    }

    this.lastSnapshot = current;
    this.prevTxCache.clear();

    const now = Date.now();
    if (now - this.lastAggregateAt >= 10_000) {
      await this.publishAggregate();
      this.lastAggregateAt = now;
    }
  }

  private async handleEntry(txId: string): Promise<void> {
    try {
      const raw = await this.getRawTransaction(txId);
      const totalOut = sumHalford(raw.vout.map((v) => grc2halford(v.value)));
      const totalIn = await this.resolveInputs(raw);

      // Coinbase / coinstake txs never sit in the mempool — but defend
      // against a malformed tx with no resolvable inputs by clamping
      // negative fees to zero (would mean we missed a prev_output).
      const fee = totalIn !== null && totalIn >= totalOut ? totalIn - totalOut : 0n;
      const firstSeen = Math.floor(Date.now() / 1000);
      const seq = await nextSeq();

      await ch.insert({
        table: 'mempool_txs',
        format: 'JSONEachRow',
        values: [{
          tx_id: txId,
          first_seen: firstSeen,
          fee_estimate: fee.toString(),
          size: raw.size ?? 0,
          vin_count: raw.vin?.length ?? 0,
          vout_count: raw.vout?.length ?? 0,
          raw_json: JSON.stringify(raw),
          confirmed_at: null,
          evicted_at: null,
          _seq: seq.toString(),
        }],
      });
      // MRC requests get a dedicated `mrc_requests` row alongside the
      // generic mempool_txs persist, so consumers don't have to parse
      // raw_json. block_height/block_time stay NULL until BlockWriter's
      // `insertMrcRequests` re-stamps the same tx_id with the carrying
      // block. Multiple MRC contracts in one tx are theoretical only —
      // the daemon serialises one MRC per tx — but the loop is harmless.
      let mrcCount = 0;
      const firstPayoutAddress = raw.vout?.find(
        (v) => v.scriptPubKey?.type !== 'nulldata' && (v.scriptPubKey?.addresses?.length ?? 0) > 0,
      )?.scriptPubKey?.addresses?.[0] ?? null;
      for (const contract of raw.contracts ?? []) {
        const mrc = parseMrcContract(contract, txId, firstSeen, firstPayoutAddress, null, null);
        if (!mrc) continue;
        mrcCount += 1;
        // eslint-disable-next-line no-await-in-loop
        await ch.insert({
          table: 'mrc_requests',
          format: 'JSONEachRow',
          values: [{
            tx_id: mrc.txId,
            version: mrc.version,
            cpid: mrc.cpid,
            client_version: mrc.clientVersion,
            organization: mrc.organization,
            research_subsidy: mrc.researchSubsidy.toString(),
            fee_offered: mrc.feeOffered.toString(),
            magnitude: mrc.magnitude,
            magnitude_unit: mrc.magnitudeUnit,
            last_block_hash: mrc.lastBlockHash,
            signature: mrc.signature,
            pay_to_address: mrc.payToAddress,
            first_seen: mrc.firstSeen,
            block_height: null,
            block_time: null,
            _seq: seq.toString(),
          }],
        });
      }

      events.publish({
        topic: 'mempool.entered',
        payload: {
          tx_id: txId,
          fee: halford2grc(fee),
          size: raw.size ?? 0,
          vin_count: raw.vin?.length ?? 0,
          vout_count: raw.vout?.length ?? 0,
          first_seen: firstSeen,
          is_mrc: mrcCount > 0,
        },
      });
    } catch (err) {
      log.warn(`MempoolWatcher: failed to fetch/persist ${txId}`, err);
    }
  }

  // Resolve inputs by walking the indexer's tx_outputs, falling back
  // to RPC for parents that haven't been confirmed/indexed yet.
  // Returns null if any input is unresolvable — caller stores fee=0
  // so the dashboard chart doesn't display a misleading negative.
  private async resolveInputs(raw: RawTxInfo): Promise<bigint | null> {
    const refs: Array<{ txid: string; vout: number }> = [];
    for (const vin of raw.vin ?? []) {
      if (typeof vin.coinbase === 'string') return null;
      if (typeof vin.txid !== 'string' || typeof vin.vout !== 'number') return null;
      refs.push({ txid: vin.txid, vout: vin.vout });
    }
    if (refs.length === 0) return 0n;

    const txIds = Array.from(new Set(refs.map((r) => r.txid)));
    const vouts = Array.from(new Set(refs.map((r) => r.vout)));
    const result = await ch.query({
      query: `
        SELECT tx_id, vout_n, value FROM tx_outputs FINAL
        WHERE tx_id IN ({txIds: Array(String)}) AND vout_n IN ({vouts: Array(UInt16)})
      `,
      query_params: { txIds, vouts },
      format: 'JSONEachRow',
    });
    type Row = { tx_id: string; vout_n: number; value: string };
    const found = new Map<string, bigint>();
    for (const r of await result.json<Row>()) {
      found.set(`${r.tx_id}:${r.vout_n}`, BigInt(r.value));
    }

    let total = 0n;
    for (const ref of refs) {
      const key = `${ref.txid}:${ref.vout}`;
      const dbValue = found.get(key);
      if (dbValue !== undefined) {
        total += dbValue;
        continue;
      }
      // Not in DB — fetch the prev tx via RPC. Cache for the rest of
      // this tick in case multiple new mempool entries share a parent.
      let prev = this.prevTxCache.get(ref.txid);
      if (!prev) {
        try {
          // eslint-disable-next-line no-await-in-loop
          prev = await this.getRawTransaction(ref.txid);
        } catch (_err) {
          return null;
        }
        this.prevTxCache.set(ref.txid, prev);
      }
      const out = prev.vout?.[ref.vout];
      if (!out || typeof out.value !== 'number') return null;
      total += grc2halford(out.value);
    }
    return total;
  }

  private async handleExit(txId: string): Promise<void> {
    try {
      // Existence check: did this tx confirm into a block, or was it
      // evicted from the mempool? Asking the daemon directly via
      // `getrawtransaction <txid> 1` — if the response carries a
      // `blockhash`, it's mined; if RPC returns -5 ("no info"), it
      // was dropped from the network without confirming.
      //
      // The previous shape consulted our own `transactions FINAL`
      // table, which is correct only when the indexer is at chain tip.
      // During deep backfill, blocks at tip aren't ingested yet, so
      // *every* exiting tx looked "evicted" — the SSE feed told users
      // their just-mined stamp was dropped. Daemon RPC is canonical
      // regardless of indexer position.
      //
      // Transient-error policy: if the RPC fails for any reason other
      // than -5 (timeout, circuit breaker open, etc.), we log + mark
      // the row evicted as a best-effort terminal state. The reconcile
      // pass in BlockWriter (`reconcileMempool`) overwrites it with
      // `confirmed_at` once the actual block lands in `transactions`.
      let confirmed = false;
      try {
        const tx = await (rpc as unknown as {
          getRawTransaction: (id: string, verbose: boolean) => Promise<{ blockhash?: string }>;
        }).getRawTransaction(txId, true);
        confirmed = typeof tx?.blockhash === 'string';
      } catch (err) {
        const code = (err as { code?: number })?.code;
        if (code !== -5) {
          log.warn(
            `MempoolWatcher.handleExit: RPC check failed for ${txId} (code=${code}); `
            + 'marking evicted, BlockWriter reconciliation will repair if mined',
            err,
          );
        }
        // code === -5 → genuinely not on chain → confirmed stays false.
      }
      const reason: 'confirmed' | 'evicted' = confirmed ? 'confirmed' : 'evicted';
      const ts = Math.floor(Date.now() / 1000);

      // Re-insert the existing mempool row with confirmed_at or
      // evicted_at stamped. ReplacingMergeTree(_seq) collapses the two
      // versions on read; we have to fetch the existing row to pick up
      // its first_seen / fee_estimate / etc — they're invariants we
      // mustn't lose.
      const existing = await ch.query({
        query: `
          SELECT first_seen, fee_estimate, size, vin_count, vout_count, raw_json
          FROM mempool_txs FINAL WHERE tx_id = {tx: String} LIMIT 1
        `,
        query_params: { tx: txId },
        format: 'JSONEachRow',
      });
      const rows = await existing.json<{
        first_seen: number | string;
        fee_estimate: string;
        size: number;
        vin_count: number;
        vout_count: number;
        raw_json: string;
      }>();
      if (rows.length === 0) return; // never seen by us — nothing to mark
      const row = rows[0];
      const seq = await nextSeq();
      await ch.insert({
        table: 'mempool_txs',
        format: 'JSONEachRow',
        values: [{
          tx_id: txId,
          first_seen: typeof row.first_seen === 'number'
            ? row.first_seen
            : Math.floor(new Date(row.first_seen).getTime() / 1000),
          fee_estimate: row.fee_estimate,
          size: row.size,
          vin_count: row.vin_count,
          vout_count: row.vout_count,
          raw_json: row.raw_json,
          confirmed_at: confirmed ? ts : null,
          evicted_at: confirmed ? null : ts,
          _seq: seq.toString(),
        }],
      });
      events.publish({
        topic: 'mempool.exited',
        payload: { tx_id: txId, reason },
      });
    } catch (err) {
      log.warn(`MempoolWatcher: failed to clear ${txId}`, err);
    }
  }

  private async publishAggregate(): Promise<void> {
    // Active mempool only — `confirmed_at IS NULL AND evicted_at IS
    // NULL` after FINAL collapse picks rows still in the live pool.
    const result = await ch.query({
      query: `
        SELECT fee_estimate, size FROM mempool_txs FINAL
        WHERE confirmed_at IS NULL AND evicted_at IS NULL
      `,
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ fee_estimate: string; size: number }>();
    const totalFees = rows.reduce<bigint>((acc, r) => acc + BigInt(r.fee_estimate), 0n);
    const totalSize = rows.reduce<number>((acc, r) => acc + r.size, 0);

    events.publish({
      topic: 'mempool.tick',
      payload: { count: rows.length, total_fees: halford2grc(totalFees), total_size: totalSize },
    });

    const buckets = [0, 1, 5, 25, 100, Number.POSITIVE_INFINITY];
    const counts = new Array(buckets.length - 1).fill(0);
    rows.forEach((r) => {
      if (r.size === 0) return;
      const rate = Number(BigInt(r.fee_estimate)) / r.size;
      for (let i = 0; i < counts.length; i += 1) {
        if (rate >= buckets[i] && rate < buckets[i + 1]) {
          counts[i] += 1;
          break;
        }
      }
    });
    events.publish({
      topic: 'mempool.fee_histogram',
      payload: {
        buckets: counts.map((count, i) => ({
          fee_per_kb: buckets[i] * 1000,
          count,
        })),
      },
    });
  }

  private async getRawMempool(): Promise<string[]> {
    return (rpc as unknown as { getRawMemPool: () => Promise<string[]> }).getRawMemPool();
  }

  private async getRawTransaction(txId: string): Promise<RawTxInfo> {
    return (rpc as unknown as {
      getRawTransaction: (id: string, verbose: boolean) => Promise<RawTxInfo>;
    }).getRawTransaction(txId, true);
  }
}
