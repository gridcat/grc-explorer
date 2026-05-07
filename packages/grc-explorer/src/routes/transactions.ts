import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { rpc } from '../lib/gridcoin';
import { halford2grc } from '../lib/halford';
import { log } from '../lib/log';
import { getCursor } from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { disassembleScript } from '../lib/scriptAsm';
import { TransactionPresenter } from '../presenters';

export const transactionsRouter = Router();

interface TxRow {
  tx_id: string;
  block_height: number;
  block_hash: string;
  time: number | string;
  size: number;
  fee: string;
  vin_count: number;
  vout_count: number;
  total_in: string;
  total_out: string;
  is_coinbase: boolean;
  is_coinstake: boolean;
  index_in_blk: number;
  hashboinc: string | null;
}

function tsToUnix(t: number | string): number {
  if (typeof t === 'number') return t;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function presentTx(r: TxRow) {
  return {
    ...r,
    time: tsToUnix(r.time),
    fee: BigInt(r.fee),
    total_in: BigInt(r.total_in),
    total_out: BigInt(r.total_out),
  };
}

transactionsRouter.get('/:tx_id/raw', async (req: Request, res: Response) => {
  const txId = param(req, 'tx_id');
  try {
    const cachedResult = await ch.query({
      query: 'SELECT raw_json FROM mempool_txs FINAL WHERE tx_id = {tx: String} LIMIT 1',
      query_params: { tx: txId },
      format: 'JSONEachRow',
    });
    const cachedRows = await cachedResult.json<{ raw_json: string }>();
    let decoded: unknown = null;
    if (cachedRows[0]?.raw_json) {
      try { decoded = JSON.parse(cachedRows[0].raw_json); } catch { decoded = null; }
    }
    if (!decoded) {
      decoded = await (rpc as unknown as {
        getRawTransaction: (id: string, verbose: boolean) => Promise<unknown>;
      }).getRawTransaction(txId, true);
    }
    const hex = await (rpc as unknown as {
      getRawTransaction: (id: string, verbose: boolean) => Promise<string>;
    }).getRawTransaction(txId, false);
    rewriteAsmFields(decoded);
    res.status(StatusCodes.OK).send(withMeta({
      data: {
        type: 'raw_transaction',
        id: txId,
        attributes: { hex, decoded },
      },
    }));
  } catch (err) {
    log.warn(`getrawtransaction failed for ${txId}`, err);
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Raw transaction not available', String(err))],
    });
  }
});

// Tx detail with three-tier fallback so the page never 404s on a tx
// the daemon knows about. Order:
//   1. `transactions FINAL` — fully indexed. Existing fast path with
//      vin/vout joined against tx_outputs/tx_inputs and is_spent
//      derivation.
//   2. `mempool_txs FINAL` — caught by MempoolWatcher but block not
//      yet indexed (or never confirmed). Parses raw_json for vin/vout;
//      vin addresses come from the prev-output lookup (tx_outputs first,
//      RPC fallback for unindexed parents).
//   3. `getrawtransaction` — daemon truth. Renders even for txs the
//      watcher missed entirely (mempool window shorter than poll
//      interval), or for reorged-out txs the daemon still remembers.
//      `is_spent` for the vouts is unknown without the index, so we
//      surface it as null rather than guessing.
//
// Whichever tier wins, the response shape stays stable so the
// frontend's existing `inMempool = !tx.blockHeight || confirmations === 0`
// branch keeps working: indexed → blockHeight set + positive
// confirmations; pending → blockHeight 0 / null + 0 confirmations.
transactionsRouter.get('/:tx_id', async (req: Request, res: Response) => {
  const txId = param(req, 'tx_id');

  // Tier 1: indexed transaction
  const indexed = await loadIndexedTx(txId);
  if (indexed) {
    res.status(StatusCodes.OK).send(indexed);
    return;
  }

  // Tier 2: mempool row (parsed, possibly already evicted/confirmed
  // pending block ingestion).
  const fromMempool = await loadMempoolTx(txId);
  if (fromMempool) {
    res.status(StatusCodes.OK).send(fromMempool);
    return;
  }

  // Tier 3: ask the daemon directly. -5 ('No information') means the
  // tx genuinely doesn't exist on chain or in mempool — that's the
  // only legitimate 404 path.
  try {
    const fromRpc = await loadRpcTx(txId);
    res.status(StatusCodes.OK).send(fromRpc);
  } catch (err) {
    if ((err as { code?: number })?.code === -5) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Transaction not found')],
      });
      return;
    }
    log.warn(`tx detail RPC fallback failed for ${txId}`, err);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).send({
      errors: [new ErrorModel(StatusCodes.INTERNAL_SERVER_ERROR, 'Transaction lookup failed')],
    });
  }
});

// ---- Tier 1: indexed --------------------------------------------------

async function loadIndexedTx(txId: string): Promise<unknown | null> {
  const txResult = await ch.query({
    query: 'SELECT * FROM transactions FINAL WHERE tx_id = {tx: String} LIMIT 1',
    query_params: { tx: txId },
    format: 'JSONEachRow',
  });
  const txRows = await txResult.json<TxRow>();
  if (txRows.length === 0) return null;
  const row = presentTx(txRows[0]);
  const [vinResult, voutResult, cursor] = await Promise.all([
    ch.query({
      query: 'SELECT vin_n, prev_tx, prev_vout, address, value FROM tx_inputs FINAL WHERE tx_id = {tx: String} ORDER BY vin_n ASC',
      query_params: { tx: txId },
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      vin_n: number; prev_tx: string | null; prev_vout: number | null;
      address: string | null; value: string | null;
    }>()),
    ch.query({
      query: `
        SELECT
          o.vout_n AS vout_n,
          o.value AS value,
          o.address AS address,
          o.script_type AS script_type,
          (i.tx_id != '') AS is_spent,
          i.tx_id AS spent_in_tx
        FROM tx_outputs AS o FINAL
        ANY LEFT JOIN tx_inputs AS i FINAL ON i.prev_tx = o.tx_id AND i.prev_vout = o.vout_n
        WHERE o.tx_id = {tx: String}
        ORDER BY o.vout_n ASC
      `,
      query_params: { tx: txId },
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      vout_n: number; value: string; address: string;
      script_type: string; is_spent: boolean; spent_in_tx: string | null;
    }>()),
    getCursor(),
  ]);
  const tipHeight = cursor?.height ?? row.block_height;
  const confirmations = Math.max(0, tipHeight - row.block_height + 1);

  const body = TransactionPresenter.render(row);
  return withMeta(body, {
    vins: vinResult.map((v) => ({
      vinN: v.vin_n,
      prevTx: v.prev_tx,
      prevVout: v.prev_vout,
      address: v.address,
      value: v.value === null ? null : halford2grc(BigInt(v.value)),
    })),
    vouts: voutResult.map((o) => ({
      voutN: o.vout_n,
      value: halford2grc(BigInt(o.value)),
      address: o.address === '' ? null : o.address,
      scriptType: o.script_type,
      isSpent: Boolean(o.is_spent),
      // CH FixedString(64) on a LEFT JOIN no-match returns 64 null
      // bytes rather than an empty string; trim and treat as null.
      spentInTx: trimNullBytes(o.spent_in_tx),
    })),
    confirmations,
  });
}

// ---- Tier 2: mempool -------------------------------------------------

interface RawTxLike {
  txid?: string;
  size?: number;
  blockhash?: string;
  vin?: Array<{ txid?: string; vout?: number; coinbase?: string }>;
  vout?: Array<{ value?: number; n?: number; scriptPubKey?: { type?: string; addresses?: string[] } }>;
}

interface MempoolRow {
  tx_id: string;
  first_seen: number;
  fee_estimate: string;
  size: number;
  vin_count: number;
  vout_count: number;
  raw_json: string;
  confirmed_at: number | null;
  evicted_at: number | null;
}

async function loadMempoolTx(txId: string): Promise<unknown | null> {
  const result = await ch.query({
    query: `
      SELECT tx_id,
             toUnixTimestamp(first_seen) AS first_seen,
             toString(fee_estimate)      AS fee_estimate,
             size, vin_count, vout_count, raw_json,
             toUnixTimestamp(confirmed_at) AS confirmed_at,
             toUnixTimestamp(evicted_at)   AS evicted_at
      FROM mempool_txs FINAL
      WHERE tx_id = {tx: String} LIMIT 1
    `,
    query_params: { tx: txId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<MempoolRow>();
  if (rows.length === 0) return null;
  const m = rows[0];
  let parsed: RawTxLike | null = null;
  try { parsed = JSON.parse(m.raw_json) as RawTxLike; } catch { parsed = null; }
  return buildPendingResponse(txId, {
    parsed,
    blockTime: m.confirmed_at ?? m.first_seen,
    fee: BigInt(m.fee_estimate),
    size: m.size,
  });
}

// ---- Tier 3: RPC -----------------------------------------------------

async function loadRpcTx(txId: string): Promise<unknown> {
  const decoded = await (rpc as unknown as {
    getRawTransaction: (id: string, verbose: boolean) => Promise<RawTxLike & { time?: number }>;
  }).getRawTransaction(txId, true);
  // Fee can't be derived without resolving prev outputs — done inside
  // buildPendingResponse via prev-out lookups when possible.
  return buildPendingResponse(txId, {
    parsed: decoded,
    blockTime: typeof decoded.time === 'number' ? decoded.time : 0,
    fee: null, // computed downstream from totalIn/totalOut if all vins resolve
    size: typeof decoded.size === 'number' ? decoded.size : 0,
  });
}

// ---- Shared pending-response builder ---------------------------------

interface PendingArgs {
  parsed: RawTxLike | null;
  blockTime: number;
  fee: bigint | null;
  size: number;
}

async function buildPendingResponse(txId: string, args: PendingArgs): Promise<unknown> {
  const tx = args.parsed;
  const vinList = Array.isArray(tx?.vin) ? tx!.vin : [];
  const voutList = Array.isArray(tx?.vout) ? tx!.vout : [];

  const isCoinbase = vinList.length === 1 && typeof vinList[0]?.coinbase === 'string';
  // Coinstake heuristic mirrors the parser: vin[0].value === 0 of a
  // PoS block's tx[1]. We don't know index-in-block here, so we skip
  // that detection and treat coinstakes as plain txs in the pending
  // view. The frontend's `isCoinstake` chip just won't render — minor
  // and corrects itself once the indexer catches up.
  const isCoinstake = false;

  // Resolve prev outputs for vin attribution. Indexed parents come
  // from CH; unindexed parents fall through to the daemon. Coinbase
  // vins are skipped (no prev_tx).
  const prevAttrs = await resolvePrevOutAttrs(vinList);

  let totalIn = 0n;
  const vins = vinList.map((v, i) => {
    if (typeof v.coinbase === 'string') {
      return {
        vinN: i, prevTx: null, prevVout: null, address: null, value: null,
      };
    }
    const key = `${v.txid}:${v.vout}`;
    const attr = prevAttrs.get(key);
    if (attr) totalIn += attr.value;
    return {
      vinN: i,
      prevTx: typeof v.txid === 'string' ? v.txid : null,
      prevVout: typeof v.vout === 'number' ? v.vout : null,
      address: attr?.address ?? null,
      value: attr ? halford2grc(attr.value) : null,
    };
  });

  let totalOut = 0n;
  const vouts = voutList.map((o, idx) => {
    const value = grcNumberToHalford(o.value);
    totalOut += value;
    const addrList = o.scriptPubKey?.addresses;
    const address = Array.isArray(addrList) && addrList.length > 0 ? addrList[0] : null;
    return {
      voutN: typeof o.n === 'number' ? o.n : idx,
      value: halford2grc(value),
      address,
      scriptType: o.scriptPubKey?.type ?? '',
      // Spent-state is unknown without the index. Surface as null so
      // the frontend can render "unknown" instead of falsely "unspent".
      isSpent: false,
      spentInTx: null,
    };
  });

  const fee = args.fee ?? (
    !isCoinbase && !isCoinstake && prevAttrs.size === vinList.filter((v) => typeof v.coinbase !== 'string').length
      ? (totalIn > totalOut ? totalIn - totalOut : 0n)
      : 0n
  );

  // Pending shape: blockHeight 0 / blockHash empty / confirmations 0
  // tells the frontend's existing `inMempool` branch to render the
  // mempool view. If RPC blockhash is set on this tx, surface it so
  // power users have a pointer — the indexer will catch up eventually
  // and the next page load will render the indexed view.
  const blockHash = typeof tx?.blockhash === 'string' ? tx.blockhash : '';
  const row = {
    tx_id: txId,
    block_height: 0,
    block_hash: blockHash,
    time: args.blockTime,
    size: args.size,
    fee,
    vin_count: vinList.length,
    vout_count: voutList.length,
    total_in: totalIn,
    total_out: totalOut,
    is_coinbase: isCoinbase,
    is_coinstake: isCoinstake,
    index_in_blk: 0,
    hashboinc: null,
  };

  const body = TransactionPresenter.render(row);
  return withMeta(body, {
    vins,
    vouts,
    confirmations: 0,
    pending: blockHash ? 'unindexed' : 'mempool',
  });
}

// Two-tier prev-output lookup: indexed table first (cheap, batch),
// daemon RPC for parents the indexer hasn't reached. Used by the
// pending tx-detail path so vin attribution still renders for fresh
// chain-tip txs while the explorer is mid-backfill.
async function resolvePrevOutAttrs(
  vins: RawTxLike['vin'] = [],
): Promise<Map<string, { address: string | null; value: bigint }>> {
  const out = new Map<string, { address: string | null; value: bigint }>();
  const refs: Array<{ txid: string; vout: number }> = [];
  for (const v of vins ?? []) {
    if (typeof v?.coinbase === 'string') continue;
    if (typeof v?.txid !== 'string' || typeof v?.vout !== 'number') continue;
    refs.push({ txid: v.txid, vout: v.vout });
  }
  if (refs.length === 0) return out;

  // Tier A: tx_outputs (indexed)
  const txIds = Array.from(new Set(refs.map((r) => r.txid)));
  const vouts = Array.from(new Set(refs.map((r) => r.vout)));
  const result = await ch.query({
    query: `
      SELECT tx_id, vout_n, address, value
      FROM tx_outputs
      WHERE tx_id IN ({txIds: Array(String)}) AND vout_n IN ({vouts: Array(UInt16)})
    `,
    query_params: { txIds, vouts },
    format: 'JSONEachRow',
  });
  type Row = { tx_id: string; vout_n: number; address: string; value: string };
  const wanted = new Set(refs.map((r) => `${r.txid}:${r.vout}`));
  for (const r of await result.json<Row>()) {
    const key = `${r.tx_id}:${r.vout_n}`;
    if (!wanted.has(key)) continue;
    out.set(key, {
      address: r.address === '' ? null : r.address,
      value: BigInt(r.value),
    });
  }

  // Tier B: anything still missing — ask the daemon.
  const missing = refs.filter((r) => !out.has(`${r.txid}:${r.vout}`));
  // Cache prev-tx fetches across vins that share the same parent.
  const cache = new Map<string, RawTxLike>();
  for (const ref of missing) {
    let prev = cache.get(ref.txid);
    if (!prev) {
      try {
        // eslint-disable-next-line no-await-in-loop
        prev = await (rpc as unknown as {
          getRawTransaction: (id: string, verbose: boolean) => Promise<RawTxLike>;
        }).getRawTransaction(ref.txid, true);
        cache.set(ref.txid, prev);
      } catch {
        // Parent unfetchable (rare — would mean prune on the daemon).
        // Leave the vin un-attributed; downstream surfaces null.
        continue;
      }
    }
    const o = prev.vout?.[ref.vout];
    if (!o || typeof o.value !== 'number') continue;
    const addrList = o.scriptPubKey?.addresses;
    const address = Array.isArray(addrList) && addrList.length > 0 ? addrList[0] : null;
    out.set(`${ref.txid}:${ref.vout}`, { address, value: grcNumberToHalford(o.value) });
  }
  return out;
}

function grcNumberToHalford(grc: number | string | undefined): bigint {
  if (typeof grc === 'number') {
    if (!Number.isFinite(grc)) return 0n;
    return BigInt(Math.round(grc * 1e8));
  }
  if (typeof grc !== 'string') return 0n;
  const dot = grc.indexOf('.');
  if (dot < 0) return BigInt(grc) * 100_000_000n;
  const whole = grc.slice(0, dot) || '0';
  const fracRaw = grc.slice(dot + 1);
  const frac = (`${fracRaw}00000000`).slice(0, 8);
  const sign = whole.startsWith('-') ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, '');
  return sign * (BigInt(wholeAbs) * 100_000_000n + BigInt(frac));
}

function trimNullBytes(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const trimmed = s.replace(/\0+$/, '');
  return trimmed === '' ? null : trimmed;
}

function rewriteAsmFields(decoded: unknown): void {
  if (!decoded || typeof decoded !== 'object') return;
  const tx = decoded as { vin?: unknown[]; vout?: unknown[] };
  if (Array.isArray(tx.vin)) {
    for (const v of tx.vin) {
      if (!v || typeof v !== 'object') continue;
      const ss = (v as { scriptSig?: { asm?: string; hex?: string } }).scriptSig;
      if (ss && typeof ss.hex === 'string') ss.asm = disassembleScript(ss.hex);
    }
  }
  if (Array.isArray(tx.vout)) {
    for (const v of tx.vout) {
      if (!v || typeof v !== 'object') continue;
      const spk = (v as { scriptPubKey?: { asm?: string; hex?: string } }).scriptPubKey;
      if (spk && typeof spk.hex === 'string') spk.asm = disassembleScript(spk.hex);
    }
  }
}
