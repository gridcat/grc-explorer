import { query, run, upsert } from '../../lib/db';
import { events } from '../../lib/emitter';
import { halford2grc } from '../../lib/halford';
import { log } from '../../lib/log';
import { enqueueMeiliBatch, MeiliEnvelope } from '../../lib/meili';
import { normalizeProjectName } from '../../lib/projectName';
import { applyAddressStateDeltas, WalletDelta } from '../../lib/addressState';
import { getCursor, setCursor } from '../../lib/redis';
import { ParsedBlock } from './ContractParser';
import { markPhantomSpends } from './PhantomSpendDetector';
import { refreshRollups } from '../jobs/RollupMaintainer';

// Chain tables are insert-only per primary key: every row is derived from
// a block and is never mutated in place (spent_in_* is resolved at read
// time via join, not stored). Write them ON CONFLICT DO NOTHING so a
// re-apply — crash recovery, fetch-span overlap, a cursor that lagged the
// data — is an idempotent no-op rather than an in-place UPDATE. The UPDATE
// path mis-maintains DuckDB's non-unique secondary ART indexes (e.g.
// idx_tx_outputs_address) and eventually corrupts them, throwing "Failed
// to delete all rows from index" and fatally invalidating the connection.
// Reorgs delete the abandoned height range first (ChainReorgHandler), so
// DO NOTHING never masks a genuinely changed row.
function insertChain(
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: { pk: readonly string[]; tsCols?: readonly string[]; chunk?: number },
): Promise<void> {
  return upsert(table, rows, { ...opts, onConflict: 'nothing' });
}

// Apply ParsedBlocks to DuckDB. Every chain table carries a PRIMARY KEY
// and is written via `insertChain` (ON CONFLICT DO NOTHING — see above),
// so a re-apply (crash recovery, fetch-span overlap) is an idempotent
// no-op. Chain rows are immutable per PK, so "skip if present" loses
// nothing; reorgs delete the abandoned height range first
// (ChainReorgHandler) and then re-apply forward into the gap.
//
// Multi-table atomicity: each table insert is independently committed.
// The order below matters for crash recovery: if we die mid-batch, the
// next call re-applies all of it (existing rows are skipped, missing
// rows fill in). Block-row coming last keeps the SSE/cursor advance from
// announcing height H to readers before its child rows have landed — and
// makes `max(height) FROM blocks` a reliable "fully-committed" watermark.

export interface ApplyBlockOptions {
  // SSE on/off. Backfiller passes false so the dashboard isn't drowned
  // in historical events.
  emitLiveEvents?: boolean;
  // Defer SSE/Meili fanout so the next batch can start writing while
  // post-commit hooks fan out. Set by the backfiller.
  deferPostCommit?: boolean;
}

export async function applyBlock(parsed: ParsedBlock, options: ApplyBlockOptions = {}): Promise<void> {
  await applyBlocks([parsed], options);
}

export async function applyBlocks(parsedList: ParsedBlock[], options: ApplyBlockOptions = {}): Promise<void> {
  if (parsedList.length === 0) return;

  // markPhantomSpends mutates parsedList in place (an indexed tx_inputs scan
  // over Halford-era kernel reuses); it must complete before the per-
  // table writes — insertTxInputs and insertAddressBalanceHistory consume
  // the phantom-spend annotations.
  await markPhantomSpends(parsedList);

  // Per-table upserts run in parallel — each writes to a different
  // table (no row-level dependencies between them at the storage layer).
  // `insertBlocks` is the only ordering requirement: the cursor + SSE
  // advance off blocks, and announcing height H before its children are
  // queryable would race readers.
  //
  // Spent-output annotations are still deferred — we use tx_inputs as
  // the source of truth for "is spent" via JOIN on the read path
  // rather than rewriting tx_outputs rows on spend.
  //
  // `insertVotes` reads polls + poll_options to resolve legacy v1
  // votes; an in-batch index inside that function handles the case
  // where a poll lands in this same call, so it's safe to fire
  // alongside insertPolls/insertPollOptions.
  await Promise.all([
    insertTxOutputs(parsedList),
    insertTxInputs(parsedList),
    insertAddressTxs(parsedList),
    insertTransactions(parsedList),
    insertAddressBalanceHistory(parsedList),
    insertClaims(parsedList),
    insertClaimMrcs(parsedList),
    insertSuperblocks(parsedList),
    insertSuperblockMagnitudes(parsedList),
    insertSuperblockProjects(parsedList),
    insertBeacons(parsedList),
    insertPolls(parsedList),
    insertPollOptions(parsedList),
    insertVotes(parsedList),
    insertTxMessages(parsedList),
    insertProjectContracts(parsedList),
    insertSidestakeContracts(parsedList),
    insertCoinstakeSidestakes(parsedList),
    insertProtocolEntries(parsedList),
    insertMrcRequests(parsedList),
    reconcileMempool(parsedList),
    captureMempoolSnapshots(parsedList),
  ]);
  await insertBlocks(parsedList);

  const last = parsedList[parsedList.length - 1].block;
  // Preserve whatever status the lifecycle owners (HistoricalBackfiller,
  // TipFollower) last set. BlockWriter only advances height/hash —
  // hard-coding `status: 'live'` here used to flicker the dashboard's
  // backfill progress bar because TipFollower re-flips to 'backfilling'
  // every 8 s on lag detection.
  const prev = await getCursor();
  await setCursor({
    height: last.height,
    hash: last.hash,
    status: prev?.status ?? 'backfilling',
  });

  if (options.deferPostCommit) {
    void runPostCommit(parsedList, options).catch((err) => {
      log.warn(`runPostCommit (deferred) failed at ${last.height}`, err);
    });
  } else {
    await runPostCommit(parsedList, options);
  }
}

async function insertBlocks(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('blocks', parsedList.map((p) => ({
    height: p.block.height,
    hash: p.block.hash,
    prev_hash: p.block.prevHash,
    merkle_root: p.block.merkleRoot,
    time: p.block.time,
    n_version: p.block.nVersion,
    difficulty: p.block.difficulty,
    size: p.block.size,
    tx_count: p.block.txCount,
    is_pos: p.block.isPos,
    miner_address: p.block.minerAddress,
    staker_cpid: p.block.stakerCpid,
    is_superblock: p.block.isSuperblock,
    mint: p.block.mint,
    money_supply: p.block.moneySupply,
    nonce: p.block.nonce,
    bits: p.block.bits,
  })), { pk: ['height'], tsCols: ['time'] });
}

async function insertTransactions(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('transactions', parsedList.flatMap((p) => p.transactions.map((tx) => ({
    tx_id: tx.txId,
    block_height: tx.blockHeight,
    block_hash: tx.blockHash,
    time: tx.time,
    size: tx.size,
    fee: tx.fee,
    vin_count: tx.vinCount,
    vout_count: tx.voutCount,
    total_in: tx.totalIn,
    total_out: tx.totalOut,
    is_coinbase: tx.isCoinbase,
    is_coinstake: tx.isCoinstake,
    index_in_blk: tx.indexInBlk,
    hashboinc: tx.hashboinc,
    n_version: tx.nVersion,
    n_lock_time: tx.nLockTime,
  }))), { pk: ['tx_id'], tsCols: ['time'] });
}

async function insertTxOutputs(parsedList: ParsedBlock[]): Promise<void> {
  // tx_outputs.address is non-nullable in the schema (it's part of the
  // primary key — see duckdb/migrations/0001_init.sql). The parser emits
  // null for OP_RETURN / anyone-can-spend / exotic scripts; translate
  // to empty-string sentinel here.
  await insertChain('tx_outputs', parsedList.flatMap((p) => p.txOutputs.map((o) => ({
    tx_id: o.txId,
    vout_n: o.voutN,
    block_height: p.block.height,
    value: o.value,
    address: o.address ?? '',
    script_type: o.scriptType,
    script_hex: o.scriptHex,
    req_sigs: o.reqSigs,
    spent_in_tx: null,
    spent_in_vin_n: null,
    spent_in_height: null,
  }))), { pk: ['tx_id', 'vout_n'] });
}

async function insertTxInputs(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('tx_inputs', parsedList.flatMap((p) => p.txInputs.map((i) => ({
    tx_id: i.txId,
    vin_n: i.vinN,
    prev_tx: i.prevTx || null,
    prev_vout: i.prevTx ? i.prevVout : null,
    address: i.address,
    value: i.value !== null ? i.value : null,
    block_height: p.block.height,
    is_phantom_spend: Boolean(i.isPhantomSpend),
    script_sig_hex: i.scriptSigHex,
    sequence: i.sequence,
  }))), { pk: ['tx_id', 'vin_n'] });
}

async function insertAddressTxs(parsedList: ParsedBlock[]): Promise<void> {
  // Per-(address, tx) net movement projection backing the address
  // page's transactions list (migration 0009) — O(page) reads instead
  // of re-aggregating the address's whole history per view. Runs
  // after markPhantomSpends: phantom re-claims are excluded, matching
  // address_balance_history's debit semantics. A (address, tx)
  // aggregate is complete within its block, so INSERT IGNORE makes
  // replays no-ops and reorgs roll back by height (chainTables).
  const rows: Record<string, unknown>[] = [];
  for (const p of parsedList) {
    const perTx = new Map<string, { height: number; delta: bigint }>();
    for (const o of p.txOutputs) {
      if (!o.address) continue;
      const key = `${o.address} ${o.txId}`;
      const cur = perTx.get(key);
      if (cur) cur.delta += o.value;
      else perTx.set(key, { height: p.block.height, delta: o.value });
    }
    for (const i of p.txInputs) {
      if (!i.address || i.value === null || i.isPhantomSpend) continue;
      const key = `${i.address} ${i.txId}`;
      const cur = perTx.get(key);
      if (cur) cur.delta -= i.value;
      else perTx.set(key, { height: p.block.height, delta: -i.value });
    }
    for (const [key, v] of perTx) {
      const sep = key.indexOf(' ');
      rows.push({
        address: key.slice(0, sep),
        block_height: v.height,
        tx_id: key.slice(sep + 1),
        delta: v.delta,
      });
    }
  }
  await insertChain('address_txs', rows, { pk: ['address', 'block_height', 'tx_id'] });
}

async function insertAddressBalanceHistory(parsedList: ParsedBlock[]): Promise<void> {
  // Pure event-log writes. Each (address, height-where-balance-changed)
  // becomes one row carrying just the per-block delta + the
  // received/sent/tx-count breakdown. Running totals are NOT computed
  // here — they live in Redis (`wallet:{addr}` HSET + `wallets:by_balance`
  // ZSET) and are updated below. This eliminates the prior-state DB
  // read every block-write used to do.

  const rows: Record<string, unknown>[] = [];
  for (const p of parsedList) {
    for (const [addr, delta] of p.addressDeltas) {
      rows.push({
        address: addr,
        valid_from_height: p.block.height,
        valid_from_time: p.block.time,
        delta: delta.delta,
        received: delta.received,
        sent: delta.sent,
        tx_count_delta: delta.txIds.size,
      });
    }
  }
  await insertChain('address_balance_history', rows, {
    pk: ['address', 'valid_from_height'], tsCols: ['valid_from_time'],
  });

  // Current-state projection — one additive multi-row upsert into
  // address_state for the whole batch (per-address sums collapse the
  // same-address-in-multiple-blocks case). Re-applied heights are
  // filtered against last_seen_block inside applyAddressStateDeltas,
  // so a batch replay stays consistent with the INSERT IGNORE
  // event-log no-op above; a failure here is healed by
  // scripts/rebuildAddressState or, after a reorg, repairAddressState.
  const walletDeltas: WalletDelta[] = [];
  for (const p of parsedList) {
    for (const [addr, delta] of p.addressDeltas) {
      walletDeltas.push({
        address: addr,
        delta: delta.delta,
        received: delta.received,
        sent: delta.sent,
        txCountDelta: delta.txIds.size,
        height: p.block.height,
      });
    }
  }
  // Propagate failures: unlike the old best-effort Redis pipeline, the
  // projection lives in the same MariaDB as everything else, and the
  // batch is idempotent under re-apply (INSERT IGNORE + the last_seen
  // filter). Failing the batch here keeps the cursor from advancing
  // past deltas the projection never absorbed — swallowing the error
  // would silently detach address_state until a manual rebuild.
  await applyAddressStateDeltas(walletDeltas);
}

async function insertClaims(parsedList: ParsedBlock[]): Promise<void> {
  const rows = parsedList.flatMap((p) => (p.claim ? [{
    block_height: p.claim.blockHeight,
    block_time: p.block.time,
    cpid: p.claim.cpid,
    mining_id: p.claim.miningId,
    client_version: p.claim.clientVersion,
    organization: p.claim.organization,
    block_subsidy: p.claim.blockSubsidy,
    research_subsidy: p.claim.researchSubsidy,
    magnitude: p.claim.magnitude,
    magnitude_unit: p.claim.magnitudeUnit,
    quorum_hash: p.claim.quorumHash,
    quorum_address: p.claim.quorumAddress,
    signature: p.claim.signature,
    is_mrc: p.claim.isMrc,
    mrc_tx_map_size: p.claim.mrcTxMapSize,
    mrc_foundation_fees: p.claim.mrcFoundationFees,
    mrc_staker_fees: p.claim.mrcStakerFees,
  }] : []));
  await insertChain('claims', rows, { pk: ['block_height'], tsCols: ['block_time'] });
}

async function insertClaimMrcs(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('claim_mrcs', parsedList.flatMap((p) => p.claimMrcs.map((m) => ({
    block_height: m.blockHeight,
    cpid: m.cpid,
    mining_id: m.miningId,
    client_version: m.clientVersion,
    research_subsidy: m.researchSubsidy,
    fee: m.fee,
    magnitude: m.magnitude,
    pay_to_address: m.payToAddress,
  }))), { pk: ['block_height', 'cpid'] });
}

async function insertSuperblocks(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('superblocks', parsedList.flatMap((p) => (p.superblock ? [{
    height: p.superblock.height,
    quorum_hash: p.superblock.quorumHash,
    total_magnitude: p.superblock.totalMagnitude,
    cpid_count: p.superblock.cpidCount,
    project_count: p.superblock.projectCount,
    payload_size: p.superblock.payloadSize,
    contract_version: p.superblock.contractVersion,
  }] : [])), { pk: ['height'] });
}

async function insertSuperblockMagnitudes(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('superblock_magnitudes', parsedList.flatMap((p) => p.superblockMagnitudes.map((m) => ({
    superblock_height: m.superblockHeight,
    cpid: m.cpid,
    magnitude: m.magnitude,
  }))), { pk: ['cpid', 'superblock_height'] });
}

async function insertSuperblockProjects(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('superblock_projects', parsedList.flatMap((p) => p.superblockProjects.map((proj) => ({
    superblock_height: proj.superblockHeight,
    project_name: normalizeProjectName(proj.projectName),
    average_rac: proj.averageRac,
    rac: proj.rac,
    total_credit: proj.totalCredit,
  }))), { pk: ['superblock_height', 'project_name'] });
}

async function insertBeacons(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('beacons', parsedList.flatMap((p) => p.beacons.map((b) => ({
    cpid: b.cpid,
    address: b.address,
    status: b.status,
    tx_id: b.txId,
    block_height: b.blockHeight,
    timestamp: b.timestamp,
    expiration: b.expiration,
    superseded_at_height: null,
    auth_method: b.authMethod,
  }))), { pk: ['cpid', 'block_height', 'tx_id'], tsCols: ['timestamp', 'expiration'] });
}

async function insertPolls(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('polls', parsedList.flatMap((p) => p.polls.map((poll) => ({
    poll_id: poll.pollId,
    title: poll.title,
    question: poll.question,
    url: poll.url,
    poll_type: poll.pollType,
    response_type: poll.responseType,
    weight_type: poll.weightType,
    start_time: poll.startTime,
    end_time: poll.endTime,
    claim_tx: poll.claimTx,
    block_height: poll.blockHeight,
    creator_address: poll.creatorAddress,
    magnitude_weight_factor: null,
    av_w_balance: null,
    av_w_magnitude: null,
    weights_computed_at_height: null,
  }))), { pk: ['poll_id'], tsCols: ['start_time', 'end_time'] });
}

async function insertPollOptions(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('poll_options', parsedList.flatMap((p) => p.polls.flatMap((poll) => poll.options.map((opt) => ({
    poll_id: poll.pollId,
    idx: opt.idx,
    label: opt.label,
  })))), { pk: ['poll_id', 'idx'] });
}

async function insertVotes(parsedList: ParsedBlock[]): Promise<void> {
  // Legacy v1 votes carry the poll TITLE, not the poll txid (the chain
  // didn't standardise on poll_txid until fern). Parser leaves pollId
  // null + sets legacyTitleKey/choiceLabel. Resolution joins against
  // polls.title and poll_options.label, with an in-batch index for the
  // case where a poll + its first vote land in the same applyBlocks
  // call. Unresolvable legacy votes are skipped — they almost always
  // mean a malformed/orphan vote with no matching poll.

  // Build the in-batch index first so polls created earlier in this
  // group of blocks resolve without an extra DB round trip.
  const titleToPollId = new Map<string, string>();
  const optionsByPoll = new Map<string, Map<string, number>>();
  const legacyKeys = new Set<string>();
  for (const p of parsedList) {
    for (const poll of p.polls) {
      if (poll.title) titleToPollId.set(poll.title.toLowerCase(), poll.pollId);
      const opts = optionsByPoll.get(poll.pollId) ?? new Map<string, number>();
      for (const opt of poll.options) opts.set(opt.label.toLowerCase(), opt.idx);
      optionsByPoll.set(poll.pollId, opts);
    }
    for (const v of p.votes) {
      if (v.pollId === null && v.legacyTitleKey) legacyKeys.add(v.legacyTitleKey);
    }
  }

  // Pull anything still unresolved from the DB. Title lookup is a full
  // scan, but the table is tiny — thousands of rows over the whole
  // chain — so it's a sub-ms read.
  const dbKeys = Array.from(legacyKeys).filter((k) => !titleToPollId.has(k));
  if (dbKeys.length > 0) {
    const result = await query<{ poll_id: string; title_lower: string }>(
      `
        SELECT poll_id, lower(title) AS title_lower
        FROM polls
        WHERE lower(title) IN ($titles)
      `,
      { titles: dbKeys },
    );
    for (const r of result) {
      titleToPollId.set(r.title_lower, r.poll_id);
    }
  }

  // Pull options for any poll we resolved from the DB (we already have
  // in-batch options for in-batch polls). Vote choice labels come
  // lowercased from the parser, so the lookup map keys on lower(label).
  const needOptionsFor = Array.from(new Set(Array.from(titleToPollId.values())))
    .filter((pid) => !optionsByPoll.has(pid));
  if (needOptionsFor.length > 0) {
    const result = await query<{ poll_id: string; idx: number; label: string }>(
      `
        SELECT poll_id, idx, label
        FROM poll_options
        WHERE poll_id IN ($pids)
      `,
      { pids: needOptionsFor },
    );
    for (const r of result) {
      const m = optionsByPoll.get(r.poll_id) ?? new Map<string, number>();
      m.set(r.label.toLowerCase(), r.idx);
      optionsByPoll.set(r.poll_id, m);
    }
  }

  const rows: Record<string, unknown>[] = [];
  for (const p of parsedList) {
    for (const v of p.votes) {
      let { pollId } = v;
      let { choiceIdx } = v;

      if (pollId === null) {
        const resolved = v.legacyTitleKey ? titleToPollId.get(v.legacyTitleKey) : undefined;
        if (!resolved) continue;
        pollId = resolved;
        if (v.choiceLabel != null) {
          const idx = optionsByPoll.get(pollId)?.get(v.choiceLabel);
          if (idx == null) continue;
          choiceIdx = idx;
        } else if (choiceIdx < 0) {
          continue;
        }
      }

      rows.push({
        poll_id: pollId,
        voter_address: v.voterAddress,
        voter_cpid: v.voterCpid,
        mining_id: v.miningId,
        choice_idx: choiceIdx >= 0 ? choiceIdx : 0,
        weight: v.weight,
        weight_balance: v.weightBalance,
        weight_magnitude: v.weightMagnitude,
        tx_id: v.txId,
        block_height: v.blockHeight,
      });
    }
  }

  await insertChain('votes', rows, { pk: ['tx_id', 'choice_idx'] });
}

// Repair past mempool_txs labels when the block carrying a mempool tx
// finally gets ingested. MempoolWatcher.handleExit makes its best
// confirmed/evicted determination from RPC at exit time — correct in
// almost every case. This pass is the safety net for two scenarios:
//
//   1. Pre-fix history: rows that were stamped `evicted_at` because
//      the previous handleExit consulted our local `transactions`
//      table while the indexer was behind tip. Those rows have
//      `confirmed_at IS NULL` and are now sitting permanently
//      mislabeled. Re-stamping with confirmed_at = block.time
//      surfaces them correctly in the time-machine views.
//   2. Post-fix RPC hiccup: handleExit fell through the
//      transient-error branch and best-effort marked evicted; once
//      the indexer reaches the block, we discover it was actually
//      mined and overwrite.
//
// Operates per-batch: for any tx in this batch whose mempool_txs row
// hasn't been stamped confirmed yet, UPDATE it in place — set
// confirmed_at to the carrying block's time and clear evicted_at. The
// `confirmed_at IS NULL` guard keeps us from clobbering a row already
// stamped by MempoolWatcher.handleExit. confirmed_at differs per tx, so
// we group the txids by block time and issue one UPDATE per distinct
// time.
async function reconcileMempool(parsedList: ParsedBlock[]): Promise<void> {
  // Group tx_ids by their carrying block's time so each distinct time is
  // one UPDATE (most batches span only a handful of block times).
  const idsByTime = new Map<number, string[]>();
  for (const p of parsedList) {
    for (const tx of p.transactions) {
      const list = idsByTime.get(p.block.time) ?? [];
      list.push(tx.txId);
      idsByTime.set(p.block.time, list);
    }
  }
  if (idsByTime.size === 0) return;

  await Promise.all(Array.from(idsByTime.entries()).map(([time, ids]) => run(
    `
      UPDATE mempool_txs
      SET confirmed_at = FROM_UNIXTIME($t), evicted_at = NULL
      WHERE tx_id IN ($ids) AND confirmed_at IS NULL
    `,
    { t: time, ids },
  )));
}

// Earliest first_seen in mempool_txs as unix seconds; null when the
// table is empty (deep backfill, watcher hasn't seen anything yet).
// Memoised for ~30s: the watermark only grows, and a stale value
// merely means we run a few snapshot inserts that would have been
// skipped — never the inverse (we'd never wrongly skip a snapshot we
// should have written). On reorg-driven re-applies of a small range,
// the memoisation also collapses N watermark probes to 1.
let watermarkCache: { value: number | null; expiresAt: number } | null = null;
const WATERMARK_TTL_MS = 30_000;
async function mempoolFirstSeenWatermark(): Promise<number | null> {
  const now = Date.now();
  if (watermarkCache && now < watermarkCache.expiresAt) return watermarkCache.value;
  const rows = await query<{ w: number | string | null }>(
    'SELECT CAST(UNIX_TIMESTAMP(min(first_seen)) AS SIGNED) AS w FROM mempool_txs',
  );
  const w = rows[0]?.w != null ? Number(rows[0].w) : null;
  const value = w != null && w > 0 ? w : null;
  watermarkCache = { value, expiresAt: now + WATERMARK_TTL_MS };
  return value;
}

// Per-block snapshot of the active mempool at block.time. Materialises
// the same `at=T` view that the /mempool route already supports, but
// frozen for the moment a block landed — useful for studying the
// candidate set the staker had in view, fee-priority behaviour, and
// how long txs waited before confirmation.
//
// `was_included` is decided against the block's parsed tx list (the
// canonical source of truth) rather than mempool_txs.confirmed_at —
// `confirmed_at` is written by both MempoolWatcher.handleExit (with
// wall-clock time) and reconcileMempool (with block.time), and which
// one wins the race is undefined under Promise.all, so any predicate
// over confirmed_at is unreliable.
//
// Old blocks (pre-watcher era, deep backfill) snapshot to zero rows
// because mempool_txs has no first_seen <= block.time matches there.
// The watermark probe below short-circuits the entire batch when the
// most recent parsed block is still older than anything in mempool_txs
// — turns 1 query/block × N blocks into 1 query/batch.
async function captureMempoolSnapshots(parsedList: ParsedBlock[]): Promise<void> {
  const newestTime = parsedList[parsedList.length - 1].block.time;
  const watermark = await mempoolFirstSeenWatermark();
  if (watermark === null || newestTime < watermark) return;

  await Promise.all(parsedList.map(({ block, transactions }) => run(
    `
      INSERT INTO mempool_snapshots
        (block_height, block_hash, block_time, captured_at, tx_id,
         first_seen, fee_estimate, size, vin_count, vout_count, was_included)
      SELECT
        $height                          AS block_height,
        $hash                            AS block_hash,
        FROM_UNIXTIME($time)             AS block_time,
        NOW()                            AS captured_at,
        tx_id,
        first_seen,
        fee_estimate,
        size,
        vin_count,
        vout_count,
        (tx_id IN ($block_tx_ids))       AS was_included
      FROM mempool_txs
      WHERE first_seen <= FROM_UNIXTIME($time)
        AND (confirmed_at IS NULL OR confirmed_at >= FROM_UNIXTIME($time))
        AND (evicted_at   IS NULL OR evicted_at   >= FROM_UNIXTIME($time))
      ON DUPLICATE KEY UPDATE
        block_hash = VALUES(block_hash),
        block_time = VALUES(block_time),
        captured_at = VALUES(captured_at),
        first_seen = VALUES(first_seen),
        fee_estimate = VALUES(fee_estimate),
        size = VALUES(size),
        vin_count = VALUES(vin_count),
        vout_count = VALUES(vout_count),
        was_included = VALUES(was_included)
    `,
    {
      height: block.height,
      hash: block.hash,
      time: block.time,
      block_tx_ids: transactions.map((t) => t.txId),
    },
  )));
}

async function insertProjectContracts(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('project_contracts', parsedList.flatMap((p) => p.projectContracts.map((pc) => ({
    project_name: normalizeProjectName(pc.projectName),
    action: pc.action,
    base_url: pc.baseUrl,
    contract_version: pc.contractVersion,
    tx_id: pc.txId,
    block_height: pc.blockHeight,
    time: pc.time,
  }))), { pk: ['project_name', 'block_height', 'tx_id'], tsCols: ['time'] });
}

async function insertSidestakeContracts(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('mandatory_sidestakes', parsedList.flatMap((p) => p.sidestakeContracts.map((sc) => ({
    address: sc.address,
    action: sc.action,
    status: sc.status,
    allocation_pct: sc.allocationPct,
    description: sc.description,
    contract_version: sc.contractVersion,
    tx_id: sc.txId,
    block_height: sc.blockHeight,
    time: sc.time,
  }))), { pk: ['address', 'block_height', 'tx_id'], tsCols: ['time'] });
}

async function insertCoinstakeSidestakes(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('coinstake_sidestakes', parsedList.flatMap((p) => p.coinstakeSidestakes.map((cs) => ({
    address: cs.address,
    block_height: cs.blockHeight,
    vout_idx: cs.voutIdx,
    tx_id: cs.txId,
    amount: cs.amount,
    // allocation_pct snapshot is filled by the API query path that
    // joins against the active registry. We write 0 here so the
    // column is non-null; readers should treat 0 as "look it up".
    allocation_pct: 0,
    time: cs.time,
  }))), { pk: ['address', 'block_height', 'vout_idx'], tsCols: ['time'] });
}

async function insertProtocolEntries(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('protocol_entries', parsedList.flatMap((p) => p.protocolEntries.map((pe) => ({
    key: pe.key,
    value: pe.value,
    status: pe.status,
    contract_version: pe.contractVersion,
    tx_id: pe.txId,
    previous_hash: pe.previousHash,
    block_height: pe.blockHeight,
    time: pe.time,
  }))), { pk: ['key', 'time', 'tx_id'], tsCols: ['time'] });
}

async function insertTxMessages(parsedList: ParsedBlock[]): Promise<void> {
  await insertChain('tx_messages', parsedList.flatMap((p) => p.messages.map((m) => ({
    tx_id: m.txId,
    block_height: m.blockHeight,
    time: m.time,
    sender_address: m.senderAddress,
    message: m.message,
  }))), { pk: ['tx_id'], tsCols: ['time'] });
}

// Confirmed MRC request rows. The mempool path (MempoolWatcher) inserts
// the same tx_id with NULL block_height when first seen; the PK upsert
// overwrites that pending row with this confirmed version in place — so
// this one stays DO UPDATE (not insertChain). Safe to do so: mrc_requests
// carries only its PRIMARY KEY (tx_id) index, no non-unique secondary
// index, so it can't hit the index-corruption path that forced the rest
// of the chain tables onto DO NOTHING.
//
// `first_seen` is preserved on conflict: the mempool watcher recorded the
// real mempool-arrival time, but the block-parse path has no mempool info
// and passes block.time as first_seen. Without preserving it the
// confirmation would overwrite first_seen with block_time, making
// block_time > first_seen false for every confirmed row — which empties
// the wait-time distribution. Keep the earlier mempool value.
async function insertMrcRequests(parsedList: ParsedBlock[]): Promise<void> {
  await upsert('mrc_requests', parsedList.flatMap((p) => p.mrcRequests.map((m) => ({
    tx_id: m.txId,
    version: m.version,
    cpid: m.cpid,
    client_version: m.clientVersion,
    organization: m.organization,
    research_subsidy: m.researchSubsidy,
    fee_offered: m.feeOffered,
    magnitude: m.magnitude,
    magnitude_unit: m.magnitudeUnit,
    last_block_hash: m.lastBlockHash,
    signature: m.signature,
    pay_to_address: m.payToAddress,
    first_seen: m.firstSeen,
    block_height: m.blockHeight,
    block_time: m.blockTime,
  }))), {
    pk: ['tx_id'],
    tsCols: ['first_seen', 'block_time'],
    preserveOnConflict: ['first_seen'],
  });
}

async function runPostCommit(parsedList: ParsedBlock[], options: ApplyBlockOptions): Promise<void> {
  // Rollup maintenance runs ALWAYS (backfill + live) — the materialised
  // rollup tables (migration 0002) are built during backfill and kept
  // current at the tip. Recompute the trailing window from the batch's
  // earliest block time; reorg re-applies pass through here too, so the
  // affected recent buckets self-correct on the next forward batch.
  if (parsedList.length > 0) {
    try {
      await refreshRollups(parsedList[0].block.time);
    } catch (err) {
      log.warn('post-commit rollup refresh failed', err);
    }
  }

  // SSE fanouts are cheap and in-memory. Skipped in backfill to keep
  // the dashboard from drowning in historical events.
  if (options.emitLiveEvents !== false) {
    fanoutBlockEvents(parsedList);
    fanoutProjectEvents(parsedList);
    fanoutSidestakeEvents(parsedList);
    fanoutBeaconEvents(parsedList);
  }

  // Meili enqueue runs ALWAYS — the search index needs every block,
  // backfilled or live. Errors are warned, not thrown; a Meili outage
  // shouldn't stall chain ingestion.
  try {
    const envelopes = parsedList.flatMap(buildMeiliEnvelopes);
    if (envelopes.length > 0) await enqueueMeiliBatch(envelopes);
  } catch (err) {
    log.warn('post-commit Meili enqueue failed', err);
  }

  // metrics.tick — bucket aggregates the home dashboard's MoneyFlowChart
  // / ResearchSplitDonut subscribe to. One event per 5-min bucket the
  // batch touched, carrying that bucket's cumulative totals (frontend
  // dedupes by bucket_ts and replaces). Skipped when the caller turned
  // off live events (backfill in `emitLiveEvents: false` mode).
  if (options.emitLiveEvents !== false) {
    try {
      await emitMetricsTicks(parsedList);
    } catch (err) {
      log.warn('post-commit metrics.tick fanout failed', err);
    }
  }
}

// One block.new (and superblock.new on superblocks) per parsed block.
// LiveBlockTicker subscribes to block.new; magnitude-keyed dashboards
// (leaderboards, top movers) subscribe to superblock.new so they skip
// the ~1440 between-superblock refreshes where their response is
// byte-identical.
function fanoutBlockEvents(parsedList: ParsedBlock[]): void {
  for (const parsed of parsedList) {
    try {
      events.publish({
        topic: 'block.new',
        payload: {
          height: parsed.block.height,
          hash: parsed.block.hash,
          prev_hash: parsed.block.prevHash,
          time: parsed.block.time,
          tx_count: parsed.block.txCount,
          is_pos: parsed.block.isPos,
          is_superblock: parsed.block.isSuperblock,
          // Lets LiveBlockTicker render the MRC chip on new blocks
          // as they arrive over SSE without re-fetching.
          is_mrc: parsed.claim?.isMrc ?? false,
          miner_address: parsed.block.minerAddress,
          staker_cpid: parsed.block.stakerCpid,
          // Reuse the parser's metric rollup — same coinbase/coinstake
          // exclusion the /blocks list aggregate uses, so SSE-pushed
          // rows render identical Amount/Fee values to a manual refresh.
          value_moved: halford2grc(parsed.metrics.valueMoved),
          fee_total: halford2grc(parsed.metrics.feeTotal),
          // Difficulty / Size / Reward(mint), so the block-table columns
          // fed by SSE (home ticker + /blocks list) fill in live too.
          difficulty: parsed.block.difficulty,
          size: parsed.block.size,
          mint: halford2grc(parsed.block.mint),
        },
      });
      if (parsed.block.isSuperblock) {
        events.publish({
          topic: 'superblock.new',
          payload: {
            height: parsed.block.height,
            hash: parsed.block.hash,
            time: parsed.block.time,
          },
        });
      }
    } catch (err) {
      log.warn(`post-commit SSE fanout failed at height ${parsed.block.height}`, err);
    }
  }
}

// Project lifecycle events — rare (a few per year on chain) but
// visually striking. ProjectsBoard subscribes here so it "lights up"
// as backfill rolls past historical adds/removes.
function fanoutProjectEvents(parsedList: ParsedBlock[]): void {
  for (const parsed of parsedList) {
    for (const pc of parsed.projectContracts) {
      try {
        events.publish({
          topic: pc.action === 'add' ? 'project.added' : 'project.removed',
          payload: {
            // Normalised so SSE consumers link /projects/<name> at the
            // same canonical key the DuckDB tables now store.
            name: normalizeProjectName(pc.projectName),
            base_url: pc.baseUrl,
            tx_id: pc.txId,
            block_height: pc.blockHeight,
            time: pc.time,
          },
        });
      } catch (err) {
        log.warn(`post-commit project SSE fanout failed at height ${parsed.block.height}`, err);
      }
    }
  }
}

// One sidestake.update per registry add/delete (rare, governance-
// paced) + one sidestake.payout per V13+ PoS block that had any
// coinstake extras. MSS dashboards subscribe to these so they refresh
// exactly when there's something new to render, not on every block.
function fanoutSidestakeEvents(parsedList: ParsedBlock[]): void {
  for (const parsed of parsedList) {
    for (const sc of parsed.sidestakeContracts) {
      try {
        events.publish({
          topic: 'sidestake.update',
          payload: {
            address: sc.address,
            action: sc.action,
            status: sc.status,
            allocation_pct: sc.allocationPct,
            description: sc.description,
            height: sc.blockHeight,
            time: sc.time,
          },
        });
      } catch (err) {
        log.warn(`post-commit sidestake.update fanout failed at height ${parsed.block.height}`, err);
      }
    }
    if (parsed.coinstakeSidestakes.length > 0) {
      let total = 0n;
      for (const cs of parsed.coinstakeSidestakes) total += cs.amount;
      try {
        events.publish({
          topic: 'sidestake.payout',
          payload: {
            height: parsed.block.height,
            time: parsed.block.time,
            count: parsed.coinstakeSidestakes.length,
            total: total.toString(),
          },
        });
      } catch (err) {
        log.warn(`post-commit sidestake.payout fanout failed at height ${parsed.block.height}`, err);
      }
    }
  }
}

// One beacon.update per block carrying any beacon contract. BeaconFlux
// + BeaconSurvival subscribe here so they stop refetching ~1000× per
// real change. Status from ContractParser: pending/active → advertise,
// revoked → revoke; both kinds in one block → 'mixed'.
function fanoutBeaconEvents(parsedList: ParsedBlock[]): void {
  for (const parsed of parsedList) {
    if (parsed.beacons.length === 0) continue;
    let hasAdvertise = false;
    let hasRevoke = false;
    for (const b of parsed.beacons) {
      if (b.status === 'revoked') hasRevoke = true;
      else hasAdvertise = true;
    }
    let action: 'advertise' | 'revoke' | 'mixed' = 'advertise';
    if (hasAdvertise && hasRevoke) action = 'mixed';
    else if (hasRevoke) action = 'revoke';
    try {
      events.publish({
        topic: 'beacon.update',
        payload: {
          height: parsed.block.height,
          time: parsed.block.time,
          action,
        },
      });
    } catch (err) {
      log.warn(`post-commit beacon SSE fanout failed at height ${parsed.block.height}`, err);
    }
  }
}

async function emitMetricsTicks(parsedList: ParsedBlock[]): Promise<void> {
  const buckets = new Set<number>();
  for (const p of parsedList) {
    buckets.add(Math.floor(p.block.time / 300) * 300);
  }
  if (buckets.size === 0) return;
  const bucketArray = Array.from(buckets);

  // Three small reads per granularity, all keyed on bucket_ts against
  // the rollup VIEWs (network_*, claims_*, tx_*). Each view already
  // returns one pre-aggregated row per bucket_ts, so the read is a plain
  // `bucket_ts = ANY(...)` slice — no GROUP BY needed. Cost is O(buckets)
  // not O(table size), so per-batch latency stays flat as the chain
  // grows. Both granularities (5min, 1h) run in parallel so the
  // post-commit hook is bounded by one DB round trip wallclock, not two.
  type NetworkRow = { bucket_ts: number; tx_count: number; block_count: number };
  type ClaimsRow = { bucket_ts: number; research_subsidy_total: string; block_subsidy_total: string };
  type TxRow = { bucket_ts: number; value_moved: string; fee_total: string };
  const granularities = (['5min', '1h'] as const).map((granularity) => {
    const step = granularity === '5min' ? 300 : 3600;
    const aligned = step === 300
      ? bucketArray
      : Array.from(new Set(bucketArray.map((b) => Math.floor(b / step) * step)));
    const networkMv = step === 300 ? 'network_5m' : 'network_1h';
    const claimsMv = step === 300 ? 'claims_5m' : 'claims_1h';
    const txMv = step === 300 ? 'tx_5m' : 'tx_1h';
    return {
      granularity, aligned, networkMv, claimsMv, txMv,
    };
  });

  const results = await Promise.all(granularities.map(async (g) => {
    const [networkRows, claimsRows, txRows] = await Promise.all([
      query<NetworkRow>(
        `
          SELECT bucket_ts, tx_count, block_count
          FROM ${g.networkMv}
          WHERE bucket_ts IN ($buckets)
        `,
        { buckets: g.aligned },
      ),
      query<ClaimsRow>(
        `
          SELECT bucket_ts, research_subsidy_total, block_subsidy_total
          FROM ${g.claimsMv}
          WHERE bucket_ts IN ($buckets)
        `,
        { buckets: g.aligned },
      ),
      // Coinbase / coinstake are filtered at view-definition time (see
      // 0004_rollup_views.sql), so this view only carries the
      // user-money txs the chart wants.
      query<TxRow>(
        `
          SELECT bucket_ts, value_moved, fee_total
          FROM ${g.txMv}
          WHERE bucket_ts IN ($buckets)
        `,
        { buckets: g.aligned },
      ),
    ]);
    return {
      granularity: g.granularity, networkRows, claimsRows, txRows,
    };
  }));

  for (const r of results) {
    const claimsByBucket = new Map<number, ClaimsRow>();
    for (const c of r.claimsRows) claimsByBucket.set(c.bucket_ts, c);
    const txByBucket = new Map<number, TxRow>();
    for (const t of r.txRows) txByBucket.set(t.bucket_ts, t);

    for (const row of r.networkRows) {
      const c = claimsByBucket.get(row.bucket_ts);
      const t = txByBucket.get(row.bucket_ts);
      // Halford → GRC for every amount field so the SSE payload matches
      // the units `/metrics` returns. The frontend's MoneyFlowChart and
      // ResearchSplitDonut do `Number(value)` on both — a unit mismatch
      // makes the chart jump 1e8× every time a new tick arrives.
      events.publish({
        topic: 'metrics.tick',
        payload: {
          granularity: r.granularity,
          bucket_ts: row.bucket_ts,
          tx_count: Number(row.tx_count),
          value_moved: halford2grc(BigInt(t?.value_moved ?? '0')),
          fee_total: halford2grc(BigInt(t?.fee_total ?? '0')),
          block_count: Number(row.block_count),
          research_subsidy_total: halford2grc(BigInt(c?.research_subsidy_total ?? '0')),
          block_subsidy_total: halford2grc(BigInt(c?.block_subsidy_total ?? '0')),
        },
      });
    }
  }
}

function buildMeiliEnvelopes(parsed: ParsedBlock): MeiliEnvelope[] {
  const out: MeiliEnvelope[] = [];

  // Only fuzzy-text corpora go to Meili. Block / transaction / claim
  // search is an exact-identifier lookup (height, hash, tx_id, cpid)
  // served straight from DuckDB in `search.ts` — see `MeiliIndexName`
  // for why those indexes were removed. Per-doc payload below is trimmed
  // to just the fields the search-result UI displays and the indexer
  // settings flag as searchable / filterable / sortable.
  if (parsed.superblock) {
    out.push({
      index: 'superblocks',
      action: 'upsert',
      doc: {
        id: String(parsed.superblock.height),
        height: parsed.superblock.height,
        height_str: String(parsed.superblock.height),
        quorum_hash: parsed.superblock.quorumHash,
        total_magnitude: parsed.superblock.totalMagnitude,
        cpid_count: parsed.superblock.cpidCount,
        project_count: parsed.superblock.projectCount,
        // Project-name search hits this joined string. The CPID list
        // used to be stored too but was multi-GB of inverted index
        // overhead — users hit /cpids/<id> direct instead.
        projects: parsed.superblockProjects.map((p) => normalizeProjectName(p.projectName)).join(' '),
      },
    });
  }

  for (const poll of parsed.polls) {
    out.push({
      index: 'polls',
      action: 'upsert',
      doc: {
        id: poll.pollId,
        title: poll.title,
        question: poll.question,
        options: poll.options.map((o) => o.label).join(' '),
        response_type: poll.responseType,
        weight_type: poll.weightType,
        start_time: poll.startTime,
        end_time: poll.endTime,
      },
    });
  }

  for (const beacon of parsed.beacons) {
    out.push({
      index: 'beacons',
      action: 'upsert',
      doc: {
        // Meili document ids allow only [a-zA-Z0-9_-]; cpid and txId are
        // hex, so an underscore join is legal. A colon (the old
        // separator) made Meili reject every beacon doc with
        // invalid_document_id — beacon fuzzy-search silently indexed
        // nothing. reindexMeili uses the same `_` join.
        id: `${beacon.cpid}_${beacon.txId}`,
        cpid: beacon.cpid,
        // Rendered as the search-result subtitle (`cpid · address`).
        address: beacon.address,
        status: beacon.status,
        block_height: beacon.blockHeight,
        timestamp: beacon.timestamp,
        expiration: beacon.expiration,
      },
    });
  }

  for (const msg of parsed.messages) {
    out.push({
      index: 'messages',
      action: 'upsert',
      doc: {
        id: msg.txId,
        block_height: msg.blockHeight,
        time: msg.time,
        message: msg.message,
      },
    });
  }

  return out;
}
