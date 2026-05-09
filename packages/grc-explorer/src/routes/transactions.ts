import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { liveRpc } from '../lib/gridcoin';
import { halford2grc } from '../lib/halford';
import { log } from '../lib/log';
import { getCursor, redis } from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { disassembleScript } from '../lib/scriptAsm';
import { TransactionPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

export const transactionsRouter = Router();
registerParamValidators(transactionsRouter);

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

// Redis cache for the raw-tx payload. Confirmed-tx bytes are
// immutable, so a long TTL is safe; mempool-tx bytes are also stable
// in practice (serialisation doesn't change between observation and
// confirmation). Negative cache stops `/raw/$RANDOMHEX` flooding the
// daemon with -5 lookups (audit P0 #2).
const RAW_TX_CACHE_TTL_S = 24 * 3600;
const RAW_TX_NEGATIVE_TTL_S = 5 * 60;
const TXID_RE = /^[0-9a-f]{64}$/;

transactionsRouter.get('/:tx_id/raw', async (req: Request, res: Response) => {
  const txId = param(req, 'tx_id').toLowerCase();
  if (!TXID_RE.test(txId)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad txid', 'txid must be 64 hex characters')],
    });
    return;
  }

  const cacheKey = `raw:${txId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    if (cached === 'NOTFOUND') {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Raw transaction not available')],
      });
      return;
    }
    res.status(StatusCodes.OK).send(withMeta({
      data: { type: 'raw_transaction', id: txId, attributes: JSON.parse(cached) },
    }));
    return;
  }

  try {
    // Single RPC pair — no second pass for the decoded tree if
    // mempool_txs already cached it.
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
      decoded = await (liveRpc as unknown as {
        getRawTransaction: (id: string, verbose: boolean) => Promise<unknown>;
      }).getRawTransaction(txId, true);
    }
    const hex = await (liveRpc as unknown as {
      getRawTransaction: (id: string, verbose: boolean) => Promise<string>;
    }).getRawTransaction(txId, false);
    rewriteAsmFields(decoded);
    const attributes = { hex, decoded };
    await redis.set(cacheKey, JSON.stringify(attributes), 'EX', RAW_TX_CACHE_TTL_S);
    res.status(StatusCodes.OK).send(withMeta({
      data: { type: 'raw_transaction', id: txId, attributes },
    }));
  } catch (err) {
    if ((err as { code?: number })?.code === -5) {
      await redis.set(cacheKey, 'NOTFOUND', 'EX', RAW_TX_NEGATIVE_TTL_S);
    } else {
      log.warn(`getrawtransaction failed for ${txId}`, err);
    }
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Raw transaction not available', String(err))],
    });
  }
});

// Tx detail with two-tier lookup. The previous tier-3 RPC fallback
// (`getrawtransaction` for txs the indexer hadn't reached) was removed
// for the public-mainnet hardening pass: `/transactions/$RANDOMHEX`
// flooding from outside trips the same RpcBreaker the indexer uses,
// halting block ingestion (audit P0 #2). Tier 1 + Tier 2 cover every
// in-flight or confirmed tx the explorer has actually observed; the
// brief 404 window during deep backfill is the deliberate tradeoff.
//
// Response shape stays stable across tiers so the frontend's
// `inMempool = !tx.blockHeight || confirmations === 0` branch keeps
// working: indexed → blockHeight set + positive confirmations;
// pending → blockHeight 0 / null + 0 confirmations.
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

  res.status(StatusCodes.NOT_FOUND).send({
    errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Transaction not found')],
  });
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
  const [vinResult, voutResult, mrcRow, cursor] = await Promise.all([
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
    loadMrcRow(txId),
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
    mrc: mrcRow,
    confirmations,
  });
}

interface MrcRowOut {
  version: number;
  cpid: string;
  clientVersion: string;
  organization: string;
  researchSubsidy: string;
  feeOffered: string;
  magnitude: number;
  magnitudeUnit: number;
  lastBlockHash: string;
  signature: string;
  payToAddress: string | null;
  firstSeen: number;
  blockHeight: number | null;
  blockTime: number | null;
}

async function loadMrcRow(txId: string): Promise<MrcRowOut | null> {
  const result = await ch.query({
    query: `
      SELECT
        version,
        cpid,
        client_version,
        organization,
        toString(research_subsidy) AS research_subsidy,
        toString(fee_offered)      AS fee_offered,
        magnitude, magnitude_unit, last_block_hash, signature, pay_to_address,
        toUnixTimestamp(first_seen) AS first_seen,
        block_height,
        toUnixTimestamp(block_time) AS block_time
      FROM mrc_requests FINAL
      WHERE tx_id = {tx: String} LIMIT 1
    `,
    query_params: { tx: txId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    version: number;
    cpid: string;
    client_version: string;
    organization: string;
    research_subsidy: string;
    fee_offered: string;
    magnitude: number;
    magnitude_unit: number;
    last_block_hash: string;
    signature: string;
    pay_to_address: string | null;
    first_seen: number | string;
    block_height: number | null;
    block_time: number | string | null;
  }>();
  if (rows.length === 0) return null;
  const r = rows[0];
  const firstSeen = typeof r.first_seen === 'number'
    ? r.first_seen
    : Math.floor(new Date(r.first_seen).getTime() / 1000);
  let blockTime: number | null = null;
  if (r.block_time !== null) {
    blockTime = typeof r.block_time === 'number'
      ? r.block_time
      : Math.floor(new Date(r.block_time).getTime() / 1000);
  }
  return {
    version: r.version,
    cpid: r.cpid,
    clientVersion: r.client_version,
    organization: r.organization,
    researchSubsidy: halford2grc(BigInt(r.research_subsidy)),
    feeOffered: halford2grc(BigInt(r.fee_offered)),
    magnitude: r.magnitude,
    magnitudeUnit: r.magnitude_unit,
    lastBlockHash: r.last_block_hash,
    signature: r.signature,
    payToAddress: r.pay_to_address,
    firstSeen,
    blockHeight: r.block_height,
    blockTime,
  };
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
  // vins are skipped (no prev_tx). The MRC lookup is independent —
  // run both in parallel.
  const [prevAttrs, mrcRow] = await Promise.all([
    resolvePrevOutAttrs(vinList),
    loadMrcRow(txId),
  ]);

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

  const allInputsResolved = !isCoinbase && !isCoinstake
    && prevAttrs.size === vinList.filter((v) => typeof v.coinbase !== 'string').length;
  const computedFee = allInputsResolved && totalIn > totalOut ? totalIn - totalOut : 0n;
  const fee = args.fee ?? computedFee;

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
    mrc: mrcRow,
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
        prev = await (liveRpc as unknown as {
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
