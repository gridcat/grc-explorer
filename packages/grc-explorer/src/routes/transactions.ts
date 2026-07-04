import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { ErrorModel } from '../lib/errors';
import { liveRpc } from '../lib/gridcoin';
import { grc2halford, halford2grc } from '../lib/halford';
import { redeemScriptIsHtlc } from '../lib/htlc';
import { log } from '../lib/log';
import { getCursor, redis } from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { disassembleScript } from '../lib/scriptAsm';
import { tsToUnix } from '../lib/time';
import { TransactionPresenter } from '../presenters';
import { forkHeight } from '../services/network/ChainForks';
import { registerParamValidators } from '../lib/validators';

export const transactionsRouter = Router();
registerParamValidators(transactionsRouter);

// HTLC detection lives in lib/htlc.ts (proper redeemScript opcode
// parse). The V14 activation gate is applied at the call site.

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

function presentTx(r: TxRow) {
  return {
    ...r,
    time: tsToUnix(r.time) ?? 0,
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

transactionsRouter.get('/:tx_id/raw', async (req: Request, res: Response) => {
  const txId = param(req, 'tx_id').toLowerCase();
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
    const cachedRows = await query<{ raw_json: string }>(
      'SELECT raw_json FROM mempool_txs WHERE tx_id = $tx LIMIT 1',
      { tx: txId },
    );
    let decoded: unknown = null;
    if (cachedRows[0]?.raw_json) {
      try { decoded = JSON.parse(cachedRows[0].raw_json); } catch { decoded = null; }
    }
    if (!decoded) {
      decoded = await (liveRpc as unknown as {
        getRawTransaction: (id: string, verbose: boolean) => Promise<unknown>;
      }).getRawTransaction(txId, true);
    }
    // The verbose payload already embeds the wire `hex`, so the common
    // (confirmed-tx) path needs a single RPC round trip. getrawtransaction
    // is ~5s/call on this daemon; the extra hex-only call pushed the
    // uncached response past the frontend's 15s axios timeout, so the first
    // view always failed and only the Redis-cached retry succeeded. Fall
    // back to a dedicated hex fetch only when the decoded tree lacks it.
    let hex = (decoded as { hex?: string } | null)?.hex;
    if (typeof hex !== 'string') {
      hex = await (liveRpc as unknown as {
        getRawTransaction: (id: string, verbose: boolean) => Promise<string>;
      }).getRawTransaction(txId, false);
    }
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
  // tx_id is the PRIMARY KEY (one row per tx via upsert), so this is a
  // unique point lookup — no dedup needed.
  const txRows = await query<TxRow>(
    'SELECT * FROM transactions WHERE tx_id = $tx LIMIT 1',
    { tx: txId },
  );
  if (txRows.length === 0) return null;
  const row = presentTx(txRows[0]);
  const [vinResult, voutResult, mrcRow, cursor] = await Promise.all([
    // Inputs for this tx, keyed by (tx_id, vin_n) PK — a unique point
    // lookup, ordered for display.
    query<{
      vin_n: number; prev_tx: string | null; prev_vout: number | null;
      address: string | null; value: string | null;
      script_sig_hex: string; sequence: number;
    }>(
      `
        SELECT vin_n, prev_tx, prev_vout, address, value, script_sig_hex, sequence
        FROM tx_inputs
        WHERE tx_id = $tx
        ORDER BY vin_n ASC
      `,
      { tx: txId },
    ),
    // Every output here belongs to one transaction ($tx), so its
    // spends are exactly the tx_inputs rows with prev_tx = $tx. Both
    // sides are unique point lookups on their PKs.
    query<{
      vout_n: number; value: string; address: string;
      script_type: string; is_spent: boolean; spent_in_tx: string | null;
    }>(
      `
        SELECT
          o.vout_n AS vout_n,
          o.value AS value,
          o.address AS address,
          o.script_type AS script_type,
          (s.tx_id IS NOT NULL) AS is_spent,
          s.tx_id AS spent_in_tx
        FROM tx_outputs AS o
        LEFT JOIN (
          SELECT prev_vout, tx_id
          FROM tx_inputs
          WHERE prev_tx = $tx
        ) AS s ON s.prev_vout = o.vout_n
        WHERE o.tx_id = $tx
        ORDER BY o.vout_n ASC
      `,
      { tx: txId },
    ),
    loadMrcRow(txId),
    getCursor(),
  ]);
  const tipHeight = cursor?.height ?? row.block_height;
  const confirmations = Math.max(0, tipHeight - row.block_height + 1);

  // HTLC marking is gated on V14 activation: CLTV/CSV only become
  // consensus-meaningful at the V14 fork, and (more importantly) the
  // proper redeemScript parser should not surface a badge for a
  // network/height where these contracts can't exist. forkHeight()
  // resolves the active network's V14 height (null if N/A).
  const v14Height = forkHeight('v14');
  const htlcGateOpen = v14Height !== null && row.block_height >= v14Height;

  const body = TransactionPresenter.render(row);
  return withMeta(body, {
    vins: vinResult.map((v) => ({
      vinN: v.vin_n,
      prevTx: v.prev_tx,
      prevVout: v.prev_vout,
      address: v.address,
      value: v.value === null ? null : halford2grc(BigInt(v.value)),
      // True only when (a) the tx is at/after V14 and (b) the
      // scriptSig's final push parses as a redeemScript whose
      // OPCODES form a hashlock+timelock+branch HTLC shape — see
      // lib/htlc.ts. Coincidental 0xb1/0xb2 bytes inside signatures
      // (the old byte-scan's flaw) cannot match.
      isHtlcRedemption: htlcGateOpen && redeemScriptIsHtlc(v.script_sig_hex),
      sequence: v.sequence,
      // BIP68 enables semantic nSequence at V14. Any non-default
      // value flags the input as sequence-locked for the tx detail
      // page; the daemon's mempool acceptance + miner enforcement
      // does the actual sequence-lock validation.
      isSequenceLocked: v.sequence !== 0xffffffff,
    })),
    vouts: voutResult.map((o) => ({
      voutN: o.vout_n,
      value: halford2grc(BigInt(o.value)),
      address: o.address === '' ? null : o.address,
      scriptType: o.script_type,
      isSpent: Boolean(o.is_spent),
      // A LEFT JOIN no-match leaves spent_in_tx NULL; trimNullBytes
      // passes NULL through unchanged.
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
  const rows = await query<{
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
  }>(
    `
      SELECT
        version,
        cpid,
        client_version,
        organization,
        CAST(research_subsidy AS CHAR) AS research_subsidy,
        CAST(fee_offered AS CHAR)      AS fee_offered,
        magnitude, magnitude_unit, last_block_hash, signature, pay_to_address,
        UNIX_TIMESTAMP(first_seen) AS first_seen,
        block_height,
        UNIX_TIMESTAMP(block_time) AS block_time
      FROM mrc_requests
      WHERE tx_id = $tx LIMIT 1
    `,
    { tx: txId },
  );
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
  const rows = await query<MempoolRow>(
    `
      SELECT tx_id,
             UNIX_TIMESTAMP(first_seen) AS first_seen,
             CAST(fee_estimate AS CHAR)     AS fee_estimate,
             size, vin_count, vout_count, raw_json,
             UNIX_TIMESTAMP(confirmed_at) AS confirmed_at,
             UNIX_TIMESTAMP(evicted_at)   AS evicted_at
      FROM mempool_txs
      WHERE tx_id = $tx LIMIT 1
    `,
    { tx: txId },
  );
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
    const value = grc2halford(o.value ?? 0);
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
  type Row = { tx_id: string; vout_n: number; address: string; value: string };
  const rows = await query<Row>(
    `
      SELECT tx_id, vout_n, address, value
      FROM tx_outputs
      WHERE tx_id IN ($txIds) AND vout_n IN ($vouts)
    `,
    { txIds, vouts },
  );
  const wanted = new Set(refs.map((r) => `${r.txid}:${r.vout}`));
  for (const r of rows) {
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
    out.set(`${ref.txid}:${ref.vout}`, { address, value: grc2halford(o.value) });
  }
  return out;
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
