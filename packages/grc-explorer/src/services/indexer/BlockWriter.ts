import { ch } from '../../lib/ch';
import { events } from '../../lib/emitter';
import { halford2grc } from '../../lib/halford';
import { log } from '../../lib/log';
import { enqueueMeiliBatch, MeiliEnvelope } from '../../lib/meili';
import {
  applyWalletDeltasBatch, getCursor, nextSeq, setCursor, WalletDelta,
} from '../../lib/redis';
import { ParsedBlock } from './ContractParser';

// Apply ParsedBlocks to ClickHouse. The new architecture is "every row
// carries a `_seq` UInt64 that comes from a single Redis INCR; the
// engine is ReplacingMergeTree(_seq), so reorgs and deferred annotations
// are just re-inserts with a bumped seq."
//
// Multi-table atomicity: ClickHouse has none. Each table insert is
// independently atomic. The order below matters for crash recovery: if
// we die mid-batch, the next call re-applies all of it under a fresh
// _seq and ReplacingMergeTree picks the latest. Block-row coming last
// keeps the SSE/cursor advance from announcing height H to readers
// before its child rows have landed.

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

  // One _seq per call. Every row in this batch shares it; reorg
  // re-applies bump _seq globally so newer always wins.
  const seq = await nextSeq();

  // Per-table inserts run in parallel — each writes to a different CH
  // table (no row-level dependencies between them at the storage
  // layer), and parallelising 14 sequential HTTP round trips into one
  // wallclock wait pays per batch. `insertBlocks` is the only ordering
  // requirement: the cursor + SSE advance off blocks, and announcing
  // height H before its children are queryable would race readers.
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
    insertTxOutputs(parsedList, seq),
    insertTxInputs(parsedList, seq),
    insertTransactions(parsedList, seq),
    insertAddressBalanceHistory(parsedList, seq),
    insertClaims(parsedList, seq),
    insertClaimMrcs(parsedList, seq),
    insertSuperblocks(parsedList, seq),
    insertSuperblockMagnitudes(parsedList, seq),
    insertSuperblockProjects(parsedList, seq),
    insertBeacons(parsedList, seq),
    insertPolls(parsedList, seq),
    insertPollOptions(parsedList, seq),
    insertVotes(parsedList, seq),
    insertTxMessages(parsedList, seq),
    insertProjectContracts(parsedList, seq),
    insertProtocolEntries(parsedList, seq),
    insertMrcRequests(parsedList, seq),
    reconcileMempool(parsedList, seq),
    captureMempoolSnapshots(parsedList, seq),
  ]);
  await insertBlocks(parsedList, seq);

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

async function insertBlocks(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  await ch.insert({
    table: 'blocks',
    format: 'JSONEachRow',
    values: parsedList.map((p) => ({
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
      mint: p.block.mint.toString(),
      money_supply: p.block.moneySupply.toString(),
      _seq: seq.toString(),
    })),
  });
}

async function insertTransactions(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.transactions.map((tx) => ({
    tx_id: tx.txId,
    block_height: tx.blockHeight,
    block_hash: tx.blockHash,
    time: tx.time,
    size: tx.size,
    fee: tx.fee.toString(),
    vin_count: tx.vinCount,
    vout_count: tx.voutCount,
    total_in: tx.totalIn.toString(),
    total_out: tx.totalOut.toString(),
    is_coinbase: tx.isCoinbase,
    is_coinstake: tx.isCoinstake,
    index_in_blk: tx.indexInBlk,
    hashboinc: tx.hashboinc,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'transactions', format: 'JSONEachRow', values: rows });
}

async function insertTxOutputs(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  // tx_outputs.address is non-nullable in the schema (it's in the sort
  // key — see clickhouse/migrations/0001_init.sql). The parser emits
  // null for OP_RETURN / anyone-can-spend / exotic scripts; translate
  // to empty-string sentinel here.
  const rows = parsedList.flatMap((p) => p.txOutputs.map((o) => ({
    tx_id: o.txId,
    vout_n: o.voutN,
    block_height: p.block.height,
    value: o.value.toString(),
    address: o.address ?? '',
    script_type: o.scriptType,
    script_hex: o.scriptHex,
    spent_in_tx: null,
    spent_in_vin_n: null,
    spent_in_height: null,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'tx_outputs', format: 'JSONEachRow', values: rows });
}

async function insertTxInputs(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.txInputs.map((i) => ({
    tx_id: i.txId,
    vin_n: i.vinN,
    prev_tx: i.prevTx || null,
    prev_vout: i.prevTx ? i.prevVout : null,
    address: i.address,
    value: i.value !== null ? i.value.toString() : null,
    block_height: p.block.height,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'tx_inputs', format: 'JSONEachRow', values: rows });
}

async function insertAddressBalanceHistory(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  // Pure event-log writes. Each (address, height-where-balance-changed)
  // becomes one CH row carrying just the per-block delta + the
  // received/sent/tx-count breakdown. Running totals are NOT computed
  // here — they live in Redis (`wallet:{addr}` HSET + `wallets:by_balance`
  // ZSET) and are updated below. This eliminates the prior-state CH
  // read every block-write used to do.

  const rows: Record<string, unknown>[] = [];
  for (const p of parsedList) {
    for (const [addr, delta] of p.addressDeltas) {
      rows.push({
        address: addr,
        valid_from_height: p.block.height,
        valid_from_time: p.block.time,
        delta: delta.delta.toString(),
        received: delta.received.toString(),
        sent: delta.sent.toString(),
        tx_count_delta: delta.txIds.size,
        _seq: seq.toString(),
      });
    }
  }
  if (rows.length > 0) {
    await ch.insert({ table: 'address_balance_history', format: 'JSONEachRow', values: rows });
  }

  // Redis projection — single pipelined round trip for the whole
  // batch instead of per-address awaits. The per-address variant was
  // doing ~2 RTTs per (address, block) pair; once chain density picks
  // up that dominated batch latency. applyWalletDeltasBatch collapses
  // the same-address-in-multiple-blocks case via per-address sums and
  // ships every command in one pipeline. Best-effort: if Redis
  // hiccups, the next `rebuildWallets` from CH heals it.
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
  try {
    await applyWalletDeltasBatch(walletDeltas);
  } catch (err) {
    log.warn(`applyWalletDeltasBatch failed (${walletDeltas.length} deltas)`, err);
  }
}

async function insertClaims(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => (p.claim ? [{
    block_height: p.claim.blockHeight,
    block_time: p.block.time,
    cpid: p.claim.cpid,
    mining_id: p.claim.miningId,
    client_version: p.claim.clientVersion,
    organization: p.claim.organization,
    block_subsidy: p.claim.blockSubsidy.toString(),
    research_subsidy: p.claim.researchSubsidy.toString(),
    magnitude: p.claim.magnitude,
    magnitude_unit: p.claim.magnitudeUnit,
    quorum_hash: p.claim.quorumHash,
    quorum_address: p.claim.quorumAddress,
    signature: p.claim.signature,
    is_mrc: p.claim.isMrc,
    mrc_tx_map_size: p.claim.mrcTxMapSize,
    mrc_foundation_fees: p.claim.mrcFoundationFees.toString(),
    mrc_staker_fees: p.claim.mrcStakerFees.toString(),
    _seq: seq.toString(),
  }] : []));
  if (rows.length === 0) return;
  await ch.insert({ table: 'claims', format: 'JSONEachRow', values: rows });
}

async function insertClaimMrcs(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.claimMrcs.map((m) => ({
    block_height: m.blockHeight,
    cpid: m.cpid,
    mining_id: m.miningId,
    client_version: m.clientVersion,
    research_subsidy: m.researchSubsidy.toString(),
    magnitude: m.magnitude,
    pay_to_address: m.payToAddress,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'claim_mrcs', format: 'JSONEachRow', values: rows });
}

async function insertSuperblocks(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => (p.superblock ? [{
    height: p.superblock.height,
    quorum_hash: p.superblock.quorumHash,
    total_magnitude: p.superblock.totalMagnitude,
    cpid_count: p.superblock.cpidCount,
    project_count: p.superblock.projectCount,
    payload_size: p.superblock.payloadSize,
    _seq: seq.toString(),
  }] : []));
  if (rows.length === 0) return;
  await ch.insert({ table: 'superblocks', format: 'JSONEachRow', values: rows });
}

async function insertSuperblockMagnitudes(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.superblockMagnitudes.map((m) => ({
    superblock_height: m.superblockHeight,
    cpid: m.cpid,
    magnitude: m.magnitude,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'superblock_magnitudes', format: 'JSONEachRow', values: rows });
}

async function insertSuperblockProjects(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.superblockProjects.map((proj) => ({
    superblock_height: proj.superblockHeight,
    project_name: proj.projectName,
    average_rac: proj.averageRac,
    rac: proj.rac,
    total_credit: proj.totalCredit,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'superblock_projects', format: 'JSONEachRow', values: rows });
}

async function insertBeacons(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.beacons.map((b) => ({
    cpid: b.cpid,
    address: b.address,
    status: b.status,
    tx_id: b.txId,
    block_height: b.blockHeight,
    timestamp: b.timestamp,
    expiration: b.expiration,
    superseded_at_height: null,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'beacons', format: 'JSONEachRow', values: rows });
}

async function insertPolls(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.polls.map((poll) => ({
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
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'polls', format: 'JSONEachRow', values: rows });
}

async function insertPollOptions(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.polls.flatMap((poll) => poll.options.map((opt) => ({
    poll_id: poll.pollId,
    idx: opt.idx,
    label: opt.label,
    _seq: seq.toString(),
  }))));
  if (rows.length === 0) return;
  await ch.insert({ table: 'poll_options', format: 'JSONEachRow', values: rows });
}

async function insertVotes(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  // Legacy v1 votes carry the poll TITLE, not the poll txid (the chain
  // didn't standardise on poll_txid until fern). Parser leaves pollId
  // null + sets legacyTitleKey/choiceLabel. Resolution joins against
  // polls.title and poll_options.label, with an in-batch index for the
  // case where a poll + its first vote land in the same applyBlocks
  // call. Unresolvable legacy votes are skipped — they almost always
  // mean a malformed/orphan vote with no matching poll.

  // Build the in-batch index first so polls created earlier in this
  // group of blocks resolve without an extra CH round trip.
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

  // Pull anything still unresolved from CH. Title lookup is a full
  // scan (`polls` is ORDER BY poll_id), but the table is tiny —
  // thousands of rows over the whole chain — so it's a sub-ms read.
  const dbKeys = Array.from(legacyKeys).filter((k) => !titleToPollId.has(k));
  if (dbKeys.length > 0) {
    const result = await ch.query({
      query: `
        SELECT poll_id, lower(title) AS title_lower
        FROM polls
        WHERE lower(title) IN ({titles: Array(String)})
      `,
      query_params: { titles: dbKeys },
      format: 'JSONEachRow',
    });
    for (const r of await result.json<{ poll_id: string; title_lower: string }>()) {
      titleToPollId.set(r.title_lower, r.poll_id);
    }
  }

  // Pull options for any poll we resolved from CH (we already have
  // in-batch options for in-batch polls). Vote choice labels come
  // lowercased from the parser, so the lookup map keys on lower(label).
  const needOptionsFor = Array.from(new Set(Array.from(titleToPollId.values())))
    .filter((pid) => !optionsByPoll.has(pid));
  if (needOptionsFor.length > 0) {
    const result = await ch.query({
      query: `
        SELECT poll_id, idx, label
        FROM poll_options
        WHERE poll_id IN ({pids: Array(String)})
      `,
      query_params: { pids: needOptionsFor },
      format: 'JSONEachRow',
    });
    for (const r of await result.json<{ poll_id: string; idx: number; label: string }>()) {
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
        weight: v.weight.toString(),
        weight_balance: v.weightBalance.toString(),
        weight_magnitude: v.weightMagnitude,
        tx_id: v.txId,
        block_height: v.blockHeight,
        _seq: seq.toString(),
      });
    }
  }

  if (rows.length === 0) return;
  await ch.insert({ table: 'votes', format: 'JSONEachRow', values: rows });
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
// Operates per-batch: query mempool_txs for any txid in this batch
// whose row hasn't been stamped confirmed yet, re-insert with
// confirmed_at populated and evicted_at cleared. ReplacingMergeTree
// merges to the highest _seq, and this batch's seq is the freshest
// for those rows.
async function reconcileMempool(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const txTime = new Map<string, number>();
  for (const p of parsedList) {
    for (const tx of p.transactions) {
      txTime.set(tx.txId, p.block.time);
    }
  }
  if (txTime.size === 0) return;
  const txIds = Array.from(txTime.keys());

  // Note: this preserves the row's invariants (first_seen, fee_estimate,
  // size, vin/vout counts, raw_json) by reading them from the existing
  // FINAL-merged row. mempool_txs is ORDER BY tx_id, so the IN-clause
  // lookup is a sorted-key scan. Skipping FINAL inside the WHERE would
  // miss the latest version's `confirmed_at IS NULL` predicate.
  //
  // Chunked because @clickhouse/client passes parameters as URL query
  // string and Poco rejects fields beyond ~8KB. At
  // BACKFILL_TX_BATCH_SIZE=500 + a few txs per block we'd hit ~1500
  // tx_ids × 64 chars each = ~100KB per call without chunking.
  type Row = {
    tx_id: string;
    first_seen: number;
    fee_estimate: string;
    size: number;
    vin_count: number;
    vout_count: number;
    raw_json: string;
  };
  const CHUNK = 100;
  const rows: Row[] = [];
  for (let i = 0; i < txIds.length; i += CHUNK) {
    const slice = txIds.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const result = await ch.query({
      query: `
        SELECT
          tx_id,
          toUnixTimestamp(first_seen)        AS first_seen,
          toString(fee_estimate)             AS fee_estimate,
          size, vin_count, vout_count, raw_json
        FROM mempool_txs FINAL
        WHERE tx_id IN ({txIds: Array(String)}) AND confirmed_at IS NULL
      `,
      query_params: { txIds: slice },
      format: 'JSONEachRow',
    });
    // eslint-disable-next-line no-await-in-loop
    const part = await result.json<Row>();
    rows.push(...part);
  }
  if (rows.length === 0) return;

  await ch.insert({
    table: 'mempool_txs',
    format: 'JSONEachRow',
    values: rows.map((r) => ({
      tx_id: r.tx_id,
      first_seen: r.first_seen,
      fee_estimate: r.fee_estimate,
      size: r.size,
      vin_count: r.vin_count,
      vout_count: r.vout_count,
      raw_json: r.raw_json,
      // confirmed_at = block time of the block that actually mined
      // this tx. block.time is chain time (seconds), matches the
      // DateTime column expectation.
      confirmed_at: txTime.get(r.tx_id) ?? null,
      evicted_at: null,
      _seq: seq.toString(),
    })),
  });
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
// one wins the race is undefined under Promise.all + shared _seq, so
// any predicate over confirmed_at is unreliable.
//
// Old blocks (pre-watcher era, deep backfill) snapshot to zero rows
// because mempool_txs has no first_seen <= block.time matches there.
// Partition pruning on first_seen makes the empty case cheap.
async function captureMempoolSnapshots(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  await Promise.all(parsedList.map(({ block, transactions }) => ch.command({
    query: `
      INSERT INTO mempool_snapshots
      SELECT
        {height: UInt32}                              AS block_height,
        {hash: String}                                AS block_hash,
        toDateTime({time: UInt32})                    AS block_time,
        now()                                         AS captured_at,
        tx_id,
        first_seen,
        fee_estimate,
        size,
        vin_count,
        vout_count,
        (tx_id IN ({block_tx_ids: Array(String)}))    AS was_included,
        {seq: UInt64}                                 AS _seq
      FROM mempool_txs FINAL
      WHERE first_seen <= toDateTime({time: UInt32})
        AND (confirmed_at IS NULL OR confirmed_at >= toDateTime({time: UInt32}))
        AND (evicted_at   IS NULL OR evicted_at   >= toDateTime({time: UInt32}))
    `,
    query_params: {
      height: block.height,
      hash: block.hash,
      time: block.time,
      seq: seq.toString(),
      block_tx_ids: transactions.map((t) => t.txId),
    },
  })));
}

async function insertProjectContracts(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.projectContracts.map((pc) => ({
    project_name: pc.projectName,
    action: pc.action,
    base_url: pc.baseUrl,
    contract_version: pc.contractVersion,
    tx_id: pc.txId,
    block_height: pc.blockHeight,
    time: pc.time,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'project_contracts', format: 'JSONEachRow', values: rows });
}

async function insertProtocolEntries(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.protocolEntries.map((pe) => ({
    key: pe.key,
    value: pe.value,
    status: pe.status,
    contract_version: pe.contractVersion,
    tx_id: pe.txId,
    previous_hash: pe.previousHash,
    block_height: pe.blockHeight,
    time: pe.time,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'protocol_entries', format: 'JSONEachRow', values: rows });
}

async function insertTxMessages(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.messages.map((m) => ({
    tx_id: m.txId,
    block_height: m.blockHeight,
    time: m.time,
    sender_address: m.senderAddress,
    message: m.message,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'tx_messages', format: 'JSONEachRow', values: rows });
}

// Confirmed MRC request rows. The mempool path (MempoolWatcher) inserts
// the same tx_id with NULL block_height when first seen; the
// ReplacingMergeTree(_seq) merge keeps this confirmed version on top.
async function insertMrcRequests(parsedList: ParsedBlock[], seq: bigint): Promise<void> {
  const rows = parsedList.flatMap((p) => p.mrcRequests.map((m) => ({
    tx_id: m.txId,
    version: m.version,
    cpid: m.cpid,
    client_version: m.clientVersion,
    organization: m.organization,
    research_subsidy: m.researchSubsidy.toString(),
    fee_offered: m.feeOffered.toString(),
    magnitude: m.magnitude,
    magnitude_unit: m.magnitudeUnit,
    last_block_hash: m.lastBlockHash,
    signature: m.signature,
    pay_to_address: m.payToAddress,
    first_seen: m.firstSeen,
    block_height: m.blockHeight,
    block_time: m.blockTime,
    _seq: seq.toString(),
  })));
  if (rows.length === 0) return;
  await ch.insert({ table: 'mrc_requests', format: 'JSONEachRow', values: rows });
}

async function runPostCommit(parsedList: ParsedBlock[], options: ApplyBlockOptions): Promise<void> {
  // SSE first (cheap, in-memory). Skipped in backfill to keep the
  // dashboard from drowning in historical events.
  if (options.emitLiveEvents !== false) {
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
          },
        });
      } catch (err) {
        log.warn(`post-commit SSE fanout failed at height ${parsed.block.height}`, err);
      }
    }
  }

  // Project lifecycle events. Rare (a few per year on chain) but
  // visually striking — a project add/remove flips one of the live
  // home-page columns. Cheap fanout, fires regardless of backfill mode
  // so the live ProjectsBoard "lights up" as backfill rolls past
  // historical adds/removes too.
  if (options.emitLiveEvents !== false) {
    for (const parsed of parsedList) {
      for (const pc of parsed.projectContracts) {
        try {
          events.publish({
            topic: pc.action === 'add' ? 'project.added' : 'project.removed',
            payload: {
              name: pc.projectName,
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

async function emitMetricsTicks(parsedList: ParsedBlock[]): Promise<void> {
  const buckets = new Set<number>();
  for (const p of parsedList) {
    buckets.add(Math.floor(p.block.time / 300) * 300);
  }
  if (buckets.size === 0) return;
  const bucketArray = Array.from(buckets);

  // Three small reads per granularity, all keyed on bucket_ts against
  // pre-aggregated MVs (network_*, claims_*, tx_*). Cost is O(buckets)
  // not O(table size), so per-batch latency stays flat as the chain
  // grows. SummingMergeTree partial sums collapse via GROUP BY in the
  // read instead of FINAL — order of magnitude cheaper. Both
  // granularities (5min, 1h) run in parallel so the post-commit hook
  // is bounded by one CH round trip wallclock, not two.
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
    const [networkResult, claimsResult, txResult] = await Promise.all([
      ch.query({
        query: `
          SELECT bucket_ts, sum(tx_count) AS tx_count, sum(block_count) AS block_count
          FROM ${g.networkMv}
          WHERE bucket_ts IN ({buckets: Array(UInt32)})
          GROUP BY bucket_ts
        `,
        query_params: { buckets: g.aligned },
        format: 'JSONEachRow',
      }),
      ch.query({
        query: `
          SELECT bucket_ts,
                 toString(sum(research_subsidy_total)) AS research_subsidy_total,
                 toString(sum(block_subsidy_total))    AS block_subsidy_total
          FROM ${g.claimsMv}
          WHERE bucket_ts IN ({buckets: Array(UInt32)})
          GROUP BY bucket_ts
        `,
        query_params: { buckets: g.aligned },
        format: 'JSONEachRow',
      }),
      ch.query({
        // Coinbase / coinstake are filtered at MV-write time (see
        // 0004_metric_aggregates.sql), so this MV only carries the
        // user-money txs the chart wants.
        query: `
          SELECT bucket_ts,
                 toString(sum(value_moved)) AS value_moved,
                 toString(sum(fee_total))   AS fee_total
          FROM ${g.txMv}
          WHERE bucket_ts IN ({buckets: Array(UInt32)})
          GROUP BY bucket_ts
        `,
        query_params: { buckets: g.aligned },
        format: 'JSONEachRow',
      }),
    ]);
    const [networkRows, claimsRows, txRows] = await Promise.all([
      networkResult.json<NetworkRow>(),
      claimsResult.json<ClaimsRow>(),
      txResult.json<TxRow>(),
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

  out.push({
    index: 'blocks',
    action: 'upsert',
    doc: {
      id: String(parsed.block.height),
      height: parsed.block.height,
      hash: parsed.block.hash,
      prev_hash: parsed.block.prevHash,
      time: parsed.block.time,
      is_pos: parsed.block.isPos,
      is_superblock: parsed.block.isSuperblock,
      miner_address: parsed.block.minerAddress,
      staker_cpid: parsed.block.stakerCpid,
    },
  });

  for (const tx of parsed.transactions) {
    out.push({
      index: 'transactions',
      action: 'upsert',
      doc: {
        id: tx.txId,
        tx_id: tx.txId,
        block_hash: tx.blockHash,
        block_height: tx.blockHeight,
        time: tx.time,
        is_coinbase: tx.isCoinbase,
        is_coinstake: tx.isCoinstake,
        has_contract: false, // refined below if any contract attaches
        hashboinc: tx.hashboinc,
      },
    });
  }

  if (parsed.claim) {
    out.push({
      index: 'claims',
      action: 'upsert',
      doc: {
        id: String(parsed.claim.blockHeight),
        block_height: parsed.claim.blockHeight,
        cpid: parsed.claim.cpid,
        organization: parsed.claim.organization,
        client_version: parsed.claim.clientVersion,
        mining_id: parsed.claim.miningId,
        is_mrc: parsed.claim.isMrc,
        block_subsidy_grc: halford2grc(parsed.claim.blockSubsidy),
        research_subsidy_grc: halford2grc(parsed.claim.researchSubsidy),
        magnitude: parsed.claim.magnitude,
      },
    });
  }

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
        // For free-text search across CPIDs / projects without storing
        // every magnitude row in Meili. Joined as a single string per
        // searchableAttribute setting.
        cpids: parsed.superblockMagnitudes.map((m) => m.cpid).join(' '),
        projects: parsed.superblockProjects.map((p) => p.projectName).join(' '),
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
        id: `${beacon.cpid}:${beacon.txId}`,
        cpid: beacon.cpid,
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
        tx_id: msg.txId,
        block_height: msg.blockHeight,
        time: msg.time,
        sender_address: msg.senderAddress,
        message: msg.message,
      },
    });
  }

  return out;
}

// Kept for compatibility with the old API surface — some callers
// (jobs that haven't been ported yet) imported this. After the
// metric_buckets table was retired in favour of the network_5m/1h/1d
// MVs, the indexer no longer needs to push metric ticks itself; this
// is now a no-op preserved only to keep the import surface stable
// during the migration window.
export async function emitMetricsTick(_parsed: ParsedBlock): Promise<void> {
  // intentionally empty — see file header
}
