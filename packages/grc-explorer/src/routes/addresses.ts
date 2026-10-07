import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { byBalanceDesc, computeCombined } from '../lib/combined';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { getBlockTimes, getTipAnchor } from '../lib/indexerTip';
import { log } from '../lib/log';
import { getPagination, heightOrder } from '../lib/pagination';
import {
  getRichList, getWallet, getWalletCount, WalletState,
} from '../lib/addressState';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { getMoneySupplyRaw, sharePct } from '../lib/supply';
import { parseAt, resolveAtHeight } from '../lib/timeMachine';
import { fetchSidestakeSummary } from './mandatorySidestakes';
import { AddressPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

export const addressesRouter = Router();
registerParamValidators(addressesRouter);

interface LinkedWalletRow {
  cpid: string | null; // null when linked only by poll votes
  address: string;
  beaconCount: number;
  stakedBlocks: number;
  mrcPayouts: number;
  voteClaims: number; // votes that signed for both addresses
  firstHeight: number;
  lastHeight: number;
  // Set only by enrichCombined() (the address page's combined-balance
  // view); absent on the raw linkage rows.
  balance?: string;
}

interface LinkedCpidContext {
  cpids: string[];
  wallets: LinkedWalletRow[];
}

interface CombinedResult {
  wallets: LinkedWalletRow[];
  combinedBalance: string;
  combinedSharePct: number;
  selfSharePct: number;
  combinedCount: number;
}

// The displayed table stays the CPID-signal set (beacon/stake/MRC
// activity columns). The combined TOTAL spans the full common-input-
// ownership cluster (the actual wallet — what gridcoinstats sums):
// viewed address + CPID siblings, expanded by co-spend. The cluster
// always contains the seed, so `balMap` covers every displayed wallet
// and the self balance — no extra Redis batch. Degrades to the narrow
// set if the cluster table is empty/absent.
async function enrichCombined(
  ctx: LinkedCpidContext,
  supply: bigint,
  selfAddress: string,
): Promise<CombinedResult> {
  const seen = new Set<string>();
  const uniqueWallets: LinkedWalletRow[] = [];
  for (const w of ctx.wallets) {
    if (seen.has(w.address)) continue;
    seen.add(w.address);
    uniqueWallets.push(w);
  }

  const {
    combinedBalance, combinedSharePct, combinedCount, balMap,
  } = await computeCombined(
    [selfAddress, ...uniqueWallets.map((w) => w.address)],
    supply,
  );
  const wallets = uniqueWallets
    .map((w) => ({ ...w, balance: halford2grc(balMap.get(w.address) ?? 0n) }))
    .sort(byBalanceDesc(balMap));
  return {
    wallets,
    combinedBalance,
    combinedSharePct,
    selfSharePct: sharePct(balMap.get(selfAddress) ?? 0n, supply),
    combinedCount,
  };
}

interface LinkedBlock {
  linkedCpids: string[];
  linkedWallets: LinkedWalletRow[];
  combinedBalance: string;
  combinedSharePct: number;
  shareOfSupplyPct: number;
  combinedCount: number;
}

// Per-step wall times of one detail request, logged only when the
// request is slow enough to matter (cold buffer pool on prod's HDD).
type Timings = Record<string, number>;
const SLOW_REQUEST_MS = 2_000;

function timed<T>(timings: Timings, name: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  return p.finally(() => { timings[name] = Date.now() - t0; });
}

// The linked-wallets + combined-balance block: CPID linkage, then the
// co-spend cluster expansion and a balance lookup per member. The one
// part of the address page whose cost scales with something other than
// the address itself (a big cluster is thousands of random reads cold),
// so the detail route bounds it with LINKED_DEADLINE_MS and the client
// fetches it from GET /:address/linked when it was deferred. In-flight
// calls are shared per address so that follow-up joins the abandoned
// computation instead of starting a second one.
const LINKED_DEADLINE_MS = 3_000;
const linkedInFlight = new Map<string, Promise<LinkedBlock>>();

function fetchLinkedBlock(address: string, timings: Timings = {}): Promise<LinkedBlock> {
  const existing = linkedInFlight.get(address);
  if (existing) return existing;
  const p = (async () => {
    const [ctx, supply] = await Promise.all([
      timed(timings, 'linked', fetchLinkedWallets(address)),
      timed(timings, 'supply', getMoneySupplyRaw()),
    ]);
    const combined = await timed(timings, 'combined', enrichCombined(ctx, supply, address));
    return {
      linkedCpids: ctx.cpids,
      linkedWallets: combined.wallets,
      combinedBalance: combined.combinedBalance,
      combinedSharePct: combined.combinedSharePct,
      shareOfSupplyPct: combined.selfSharePct,
      combinedCount: combined.combinedCount,
    };
  })().finally(() => { linkedInFlight.delete(address); });
  linkedInFlight.set(address, p);
  return p;
}

// fetchLinkedBlock bounded by LINKED_DEADLINE_MS. Past the deadline the
// response carries `linkedDeferred: true` instead of the block; the
// query keeps running (warming the buffer pool) and its outcome is
// dropped.
async function linkedOrDeferred(
  address: string,
  timings: Timings,
): Promise<LinkedBlock | { linkedDeferred: true }> {
  const work = fetchLinkedBlock(address, timings);
  work.catch(() => { /* surfaced via the race below, or dropped once deferred */ });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ linkedDeferred: true }>((resolve) => {
    timer = setTimeout(() => {
      timings.deferred = LINKED_DEADLINE_MS;
      resolve({ linkedDeferred: true });
    }, LINKED_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function logIfSlow(address: string, t0: number, timings: Timings): void {
  const total = Date.now() - t0;
  if (total < SLOW_REQUEST_MS) return;
  const steps = Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(' ');
  log.warn(`slow address detail ${address} total=${total}ms ${steps}`);
}

// Linked wallets: the CPID-signal set plus addresses signed for in the
// same poll vote. A vote-linked address already in the CPID set gets
// its vote count; the others join with cpid null.
async function fetchLinkedWallets(address: string): Promise<LinkedCpidContext> {
  const [ctx, voteRows] = await Promise.all([
    fetchCpidLinkedWallets(address),
    fetchVoteLinkedWallets(address),
  ]);
  const votesByAddress = new Map(voteRows.map((r) => [r.address, r]));
  const wallets = ctx.wallets.map((w) => ({
    ...w, voteClaims: Number(votesByAddress.get(w.address)?.votes ?? 0),
  }));
  const cpidLinked = new Set(wallets.map((w) => w.address));
  for (const r of voteRows) {
    if (cpidLinked.has(r.address)) continue;
    wallets.push({
      cpid: null,
      address: r.address,
      beaconCount: 0,
      stakedBlocks: 0,
      mrcPayouts: 0,
      voteClaims: Number(r.votes),
      firstHeight: Number(r.first_height),
      lastHeight: Number(r.last_height),
    });
  }
  return { cpids: ctx.cpids, wallets };
}

// Addresses whose verified balance claims sit in the same vote tx as
// this address's (vote_claim_addresses, filled by VoteClaimJob): the
// voter held both keys when signing, CPID or not. One hop.
async function fetchVoteLinkedWallets(address: string): Promise<Array<{
  address: string; votes: number | string; first_height: number; last_height: number;
}>> {
  return query(
    `
      SELECT o.address,
             COUNT(*) AS votes,
             MIN(o.block_height) AS first_height,
             MAX(o.block_height) AS last_height
      FROM vote_claim_addresses AS s
      JOIN vote_claim_addresses AS o ON o.tx_id = s.tx_id AND o.address != s.address
      WHERE s.address = $addr
      GROUP BY o.address
      ORDER BY votes DESC, last_height DESC
      LIMIT 100
    `,
    { addr: address },
  );
}

// Cross-reference an address against the three on-chain CPID-linkage
// signals (beacons, staked blocks, MRC payouts). Returns:
//   • `cpids`  — every CPID this address has provably acted under.
//                Surfaced even when there are no sibling addresses
//                (single-wallet researcher case), so the page can
//                show "this address is the wallet for CPID X".
//   • `wallets` — every OTHER address tied to any of those CPIDs.
// Two round-trips because the second query's IN-list depends on
// the first; the alternative single-query CTE has poorer planner
// behaviour here.
async function fetchCpidLinkedWallets(address: string): Promise<LinkedCpidContext> {
  const cpidsResult = await query<{ cpid: string }>(
    `
      SELECT DISTINCT cpid FROM (
        SELECT cpid FROM beacons
        WHERE address = $addr AND cpid != ''
        UNION ALL
        SELECT staker_cpid AS cpid FROM blocks
        WHERE miner_address = $addr
          AND staker_cpid IS NOT NULL AND staker_cpid != ''
        UNION ALL
        SELECT cpid FROM mrc_requests
        WHERE pay_to_address = $addr
          AND cpid != '' AND block_height IS NOT NULL
      ) AS u
    `,
    { addr: address },
  );
  const cpids = cpidsResult.map((r) => r.cpid);
  if (cpids.length === 0) return { cpids: [], wallets: [] };

  const rows = await query<{
    cpid: string; address: string;
    beacon_count: number; staked_blocks: number; mrc_payouts: number;
    first_height: number; last_height: number;
  }>(
    `
      SELECT
        cpid,
        address,
        CAST(SUM(CASE WHEN source = 'beacon' THEN c ELSE 0 END) AS UNSIGNED) AS beacon_count,
        CAST(SUM(CASE WHEN source = 'staked' THEN c ELSE 0 END) AS UNSIGNED) AS staked_blocks,
        CAST(SUM(CASE WHEN source = 'mrc'    THEN c ELSE 0 END) AS UNSIGNED) AS mrc_payouts,
        CAST(min(first_h) AS UNSIGNED)                AS first_height,
        CAST(max(last_h) AS UNSIGNED)                 AS last_height
      FROM (
        SELECT cpid, address, count(*) AS c, 'beacon' AS source,
               min(block_height) AS first_h, max(block_height) AS last_h
        FROM beacons
        WHERE cpid IN ($cpids)
          AND address != '' AND address != $addr
        GROUP BY cpid, address
        UNION ALL
        SELECT staker_cpid AS cpid, miner_address AS address, count(*) AS c, 'staked' AS source,
               min(height) AS first_h, max(height) AS last_h
        FROM blocks
        WHERE staker_cpid IN ($cpids)
          AND miner_address IS NOT NULL AND miner_address != ''
          AND miner_address != $addr
        GROUP BY staker_cpid, miner_address
        UNION ALL
        SELECT cpid, pay_to_address AS address, count(*) AS c, 'mrc' AS source,
               min(block_height) AS first_h, max(block_height) AS last_h
        FROM mrc_requests
        WHERE cpid IN ($cpids)
          AND pay_to_address IS NOT NULL AND pay_to_address != ''
          AND pay_to_address != $addr
          AND block_height IS NOT NULL
        GROUP BY cpid, pay_to_address
      ) AS s
      GROUP BY cpid, address
      ORDER BY beacon_count DESC, staked_blocks DESC, mrc_payouts DESC, last_height DESC
      LIMIT 100
    `,
    { cpids, addr: address },
  );
  return {
    cpids,
    wallets: rows.map((r) => ({
      cpid: r.cpid,
      address: r.address,
      beaconCount: r.beacon_count,
      stakedBlocks: r.staked_blocks,
      mrcPayouts: r.mrc_payouts,
      voteClaims: 0,
      firstHeight: r.first_height,
      lastHeight: r.last_height,
    })),
  };
}

// Presenter expects the legacy snake_case shape produced by the old
// MySQL `addresses` row. Map our WalletState onto that shape.
// `firstSeenTime` / `lastSeenTime` are looked up from `blocks` by
// the detail handler — pass null when not relevant (rich list, stubs).
function presentWallet(
  w: WalletState,
  times: { firstSeenTime?: number | null; lastSeenTime?: number | null } = {},
  cpid: string | null = null,
): {
  address: string; balance: bigint; total_received: bigint; total_sent: bigint;
  tx_count: number; first_seen_block: number | null; last_seen_block: number | null;
  first_seen_time: number | null; last_seen_time: number | null; cpid: string | null;
} {
  return {
    address: w.address,
    balance: w.balance,
    total_received: w.totalReceived,
    total_sent: w.totalSent,
    tx_count: w.txCount,
    first_seen_block: w.firstSeenBlock,
    last_seen_block: w.lastSeenBlock,
    first_seen_time: times.firstSeenTime ?? null,
    last_seen_time: times.lastSeenTime ?? null,
    cpid,
  };
}

// Look up block times for first/last seen heights via the shared
// `getBlockTimes` helper. Returns null when the height itself is null
// or when the block isn't yet indexed.
async function fetchSeenTimes(
  firstSeen: number | null,
  lastSeen: number | null,
): Promise<{ firstSeenTime: number | null; lastSeenTime: number | null }> {
  const heights = [firstSeen, lastSeen].filter((h): h is number => h !== null);
  const byHeight = await getBlockTimes(heights);
  return {
    firstSeenTime: firstSeen !== null ? byHeight.get(firstSeen) ?? null : null,
    lastSeenTime: lastSeen !== null ? byHeight.get(lastSeen) ?? null : null,
  };
}

// Rich list. Backed by address_state: a backward scan of the balance
// index for the page slice + the page's row lookups.
addressesRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const [wallets, total] = await Promise.all([
    getRichList(offset, limit),
    getWalletCount(),
  ]);
  // Cross-link each rich-list wallet to its researcher CPID when the
  // address registered a beacon (the canonical "this address belongs
  // to CPID X" signal). One bounded query for the page's ≤100
  // addresses. arg_max(cpid, block_height) takes the latest beacon's
  // CPID, keeping the otherwise Redis-only rich list fast.
  const cpidByAddr = new Map<string, string>();
  const addrs = wallets.map((w) => w.address);
  if (addrs.length > 0) {
    try {
      const r = await query<{ address: string; latest_cpid: string }>(
        // arg_max(cpid, block_height) per address → latest beacon's cpid,
        // via ROW_NUMBER picking the highest-block_height row per address.
        `
          SELECT address, cpid AS latest_cpid
          FROM (
            SELECT address, cpid,
                   ROW_NUMBER() OVER (PARTITION BY address ORDER BY block_height DESC) AS rn
            FROM beacons
            WHERE address IN ($addrs) AND cpid != ''
          ) AS r
          WHERE rn = 1
        `,
        { addrs },
      );
      for (const row of r) {
        if (row.latest_cpid) cpidByAddr.set(row.address, row.latest_cpid);
      }
    } catch {
      // beacons absent (pre-migration) / transient — degrade to no
      // CPID links; the rest of the rich list still renders.
    }
  }
  const body = AddressPresenter.render(
    wallets.map((w) => presentWallet(w, {}, cpidByAddr.get(w.address) ?? null)),
    { meta: { count: total } },
  );
  res.status(StatusCodes.OK).send(withMeta(body));
});

interface AddressTxResource {
  type: 'address_tx';
  id: string;
  attributes: { txId: string; height: number; delta: string; ts: number };
}

// One page of an address's movements, straight off the address_txs
// projection (one row per (address, tx) with the net delta, maintained
// at write time) — a clustered-PK range read of `limit` entries instead
// of the old UNION + GROUP BY over the address's entire
// tx_outputs/tx_inputs history, which cost O(history) per page view
// (~0.6 s warm for a 50k-movement staker). Times come from a second
// bounded PK lookup on transactions. Tie-break within a block is tx_id
// DESC so the ordering is exactly the PK read backwards. Shared by
// GET /:address/transactions and the detail route's include=transactions.
async function fetchAddressTxPage(
  address: string,
  offset: number,
  limit: number,
  atHeight: number | null,
): Promise<AddressTxResource[]> {
  const cap = atHeight !== null ? 'AND block_height <= $h' : '';
  const params: Record<string, unknown> = { addr: address };
  if (atHeight !== null) params.h = atHeight;
  const rows = await query<{
    tx_id: string; height: number; delta_sum: string;
  }>(
    `
      SELECT tx_id, block_height AS height, CAST(delta AS CHAR) AS delta_sum
      FROM address_txs
      WHERE address = $addr ${cap}
      ORDER BY block_height DESC, tx_id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `,
    params,
  );

  const timesByTx = new Map<string, number>();
  if (rows.length > 0) {
    const timeRows = await query<{ tx_id: string; ts: number | string | null }>(
      'SELECT tx_id, UNIX_TIMESTAMP(time) AS ts FROM transactions WHERE tx_id IN ($ids)',
      { ids: rows.map((r) => r.tx_id) },
    );
    for (const t of timeRows) {
      if (t.ts !== null) timesByTx.set(t.tx_id, Number(t.ts));
    }
  }

  return rows.map((r) => ({
    type: 'address_tx',
    id: `${address}:${r.height}:${r.tx_id}`,
    attributes: {
      txId: r.tx_id,
      height: r.height,
      delta: halford2grc(BigInt(r.delta_sum)),
      ts: timesByTx.get(r.tx_id) ?? 0,
    },
  }));
}

// `?include=transactions,sidestakes` on GET /:address folds the address
// page's two side lookups into the one response — `transactions` (the
// first page, honouring the usual page[size]) and `mandatorySidestake`
// (badge summary, or null for the non-recipient majority) — so SSR makes
// one API call instead of three: one TCP round trip, one limiter
// consume, one JSON parse. The standalone endpoints are unchanged and
// the client-side refreshes keep using them. Not applied on the
// time-machine (`?at=`) path.
function parseInclude(req: Request): Set<string> {
  const raw = req.query.include;
  const joined = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return new Set(joined.split(',').map((x) => x.trim()).filter(Boolean));
}

async function fetchIncluded(
  req: Request,
  address: string,
  timings: Timings = {},
): Promise<Record<string, unknown>> {
  const include = parseInclude(req);
  const extra: Record<string, unknown> = {};
  const tasks: Promise<void>[] = [];
  if (include.has('transactions')) {
    const { offset, limit } = getPagination(req);
    tasks.push(timed(timings, 'txs', fetchAddressTxPage(address, offset, limit, null))
      .then((d) => { extra.transactions = d; }));
  }
  if (include.has('sidestakes')) {
    tasks.push(timed(timings, 'sidestakes', fetchSidestakeSummary(address))
      .then((m) => { extra.mandatorySidestake = m; }));
  }
  await Promise.all(tasks);
  return extra;
}

addressesRouter.get('/:address', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);

  // Time-machine path: derive running totals from address_balance_history
  // by summing deltas at-or-before the requested chain-time → height.
  if (at !== undefined) {
    const atHeight = await resolveAtHeight(at);
    if (atHeight === null) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'No indexed blocks at that moment')],
      });
      return;
    }
    const histRows = await query<{
      bal: string; total_received: string; total_sent: string;
      tx_count: number; last_seen: number;
    }>(
      `
        SELECT
          CAST(sum(delta) AS CHAR)    AS bal,
          CAST(sum(received) AS CHAR) AS total_received,
          CAST(sum(sent) AS CHAR)     AS total_sent,
          sum(tx_count_delta)            AS tx_count,
          max(valid_from_height)         AS last_seen
        FROM address_balance_history
        WHERE address = $addr AND valid_from_height <= $h
      `,
      { addr: address, h: atHeight },
    );
    if (histRows.length === 0 || histRows[0].last_seen === 0) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Address not seen at that moment')],
      });
      return;
    }
    const h = histRows[0];
    const seenTimes = await fetchSeenTimes(null, h.last_seen);
    const synth = presentWallet({
      address,
      balance: BigInt(h.bal),
      totalReceived: BigInt(h.total_received),
      totalSent: BigInt(h.total_sent),
      txCount: Number(h.tx_count),
      firstSeenBlock: null,
      lastSeenBlock: h.last_seen,
    }, seenTimes);
    const body = AddressPresenter.render(synth);
    res.status(StatusCodes.OK).send(withMeta(body, { pendingBalance: '0', at, atHeight }));
    return;
  }

  // Live path: point lookup on the address_state projection.
  const t0 = Date.now();
  const timings: Timings = {};
  const wallet = await timed(timings, 'state', getWallet(address));
  if (!wallet) {
    // Beacon-only addresses are real but may never have transacted —
    // a researcher advertises a beacon address and then stakes/spends
    // from a different one. Without this fallback every beacon page's
    // address links 404. If the address is registered as a beacon,
    // render a zero-stub so the page resolves with empty totals plus
    // the beacon table the page already pulls separately.
    const beaconRows = await query<{ '1': number }>(
      'SELECT 1 FROM beacons WHERE address = $addr LIMIT 1',
      { addr: address },
    );
    const isBeaconAddress = beaconRows.length > 0;
    if (!isBeaconAddress) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Address not found')],
      });
      return;
    }
    const stub = presentWallet({
      address,
      balance: 0n,
      totalReceived: 0n,
      totalSent: 0n,
      txCount: 0,
      firstSeenBlock: null,
      lastSeenBlock: null,
    });
    const [stubLinked, stubIncluded] = await Promise.all([
      linkedOrDeferred(address, timings),
      fetchIncluded(req, address, timings),
    ]);
    const body = AddressPresenter.render(stub);
    res.status(StatusCodes.OK).send(withMeta(body, {
      pendingBalance: '0',
      ...stubLinked,
      ...stubIncluded,
    }));
    logIfSlow(address, t0, timings);
    return;
  }

  // Pending balance + linked-wallets + seen-block times (+ any
  // `include`d side lookups) in parallel — all extra attributes on the
  // same response, none depend on each other.
  const [pendingRows, linked, seenTimes, included] = await Promise.all([
    timed(timings, 'pending', query<{ pending: string | null }>(
      `
        SELECT CAST(sum(o.value) AS CHAR) AS pending
        FROM tx_outputs AS o
        WHERE o.address = $addr
          AND o.tx_id IN (
            SELECT tx_id FROM mempool_txs
            WHERE confirmed_at IS NULL AND evicted_at IS NULL
          )
      `,
      { addr: address },
    )),
    linkedOrDeferred(address, timings),
    timed(timings, 'seen', fetchSeenTimes(wallet.firstSeenBlock, wallet.lastSeenBlock)),
    fetchIncluded(req, address, timings),
  ]);
  const pendingSum = pendingRows[0]?.pending && pendingRows[0].pending !== '0'
    ? BigInt(pendingRows[0].pending)
    : null;
  const body = AddressPresenter.render(presentWallet(wallet, seenTimes));
  res.status(StatusCodes.OK).send(withMeta(body, {
    pendingBalance: pendingSum ? halford2grc(pendingSum) : '0',
    ...linked,
    ...included,
  }));
  logIfSlow(address, t0, timings);
});

// The linked-wallets + combined-balance block on its own, for clients
// whose GET /:address answered `linkedDeferred: true`. Not bounded by
// the deadline: this request exists to wait for it.
addressesRouter.get('/:address/linked', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const t0 = Date.now();
  const timings: Timings = {};
  const linked = await fetchLinkedBlock(address, timings);
  res.status(StatusCodes.OK).send(withMeta({ meta: {} }, { ...linked }));
  logIfSlow(address, t0, timings);
});

addressesRouter.get('/:address/transactions', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const { offset, limit } = getPagination(req);
  const data = await fetchAddressTxPage(address, offset, limit, atHeight);
  res.status(StatusCodes.OK).send(withMeta({ data, meta: { count: data.length } }));
});

// Blocks staked by this address, newest first (`?sort=height` for oldest
// first). Same shape as GET /cpids/:cpid/blocks plus stakerCpid (null
// for investor stakes). Served by idx_blocks_miner_height (0022): the
// page is an index range read, the count an index-only range scan.
addressesRouter.get('/:address/blocks', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const { offset, limit } = getPagination(req);
  const order = heightOrder(req);
  const cap = atHeight !== null ? 'AND height <= $h' : '';
  const params: Record<string, unknown> = { addr: address };
  if (atHeight !== null) params.h = atHeight;

  const [rows, countRows] = await Promise.all([
    query<{
      height: number; hash: string; time: number | string; is_superblock: boolean;
      staker_cpid: string | null;
    }>(
      `
        SELECT height, hash, UNIX_TIMESTAMP(time) AS time, is_superblock, staker_cpid
        FROM blocks
        WHERE miner_address = $addr ${cap}
        ORDER BY height ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `,
      params,
    ),
    query<{ c: string | number }>(
      `SELECT count(*) AS c FROM blocks WHERE miner_address = $addr ${cap}`,
      params,
    ),
  ]);

  const claimsByHeight = new Map<number, { research_subsidy: string; block_subsidy: string; magnitude: number }>();
  if (rows.length > 0) {
    const cR = await query<{
      block_height: number; research_subsidy: string; block_subsidy: string; magnitude: number;
    }>(
      `
        SELECT block_height,
               CAST(research_subsidy AS CHAR) AS research_subsidy,
               CAST(block_subsidy AS CHAR)    AS block_subsidy,
               magnitude
        FROM claims WHERE block_height IN ($heights)
      `,
      { heights: rows.map((b) => b.height) },
    );
    for (const c of cR) claimsByHeight.set(c.block_height, c);
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: rows.map((b) => {
      const c = claimsByHeight.get(b.height);
      return {
        type: 'blocks',
        id: String(b.height),
        attributes: {
          height: b.height,
          hash: b.hash,
          time: Number(b.time),
          isSuperblock: b.is_superblock,
          stakerCpid: b.staker_cpid || null,
          researchSubsidy: c ? halford2grc(BigInt(c.research_subsidy)) : '0',
          blockSubsidy: c ? halford2grc(BigInt(c.block_subsidy)) : '0',
          magnitude: c?.magnitude ?? null,
        },
      };
    }),
    meta: { count: Number(countRows[0]?.c ?? 0) },
  }));
});

addressesRouter.get('/:address/utxos', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const isAt = atHeight !== null && at !== undefined;

  // The spent lookup is bounded to the tx_inputs rows whose prev_tx is
  // one of THIS address's output txs (`prev_tx IN (SELECT tx_id ...)`),
  // served by idx_tx_inputs_prevout (prev_tx, prev_vout); the address
  // CTE is a covering range scan on tx_outputs (idx_tx_outputs_addr_val).
  //
  // Time-machine mode: outputs created at-or-before H (applied in the
  // CTE) whose spending input doesn't exist yet OR landed after H (i.e.
  // still unspent at H). Live mode just drops spent UTXOs via the
  // s.tx_id IS NULL LEFT-JOIN miss.
  const outHeightFilter = isAt ? 'AND block_height <= $h' : '';
  // DuckDB LEFT JOIN misses yield NULL (unlike CH, which fills the
  // column type's default — '' for a String). So "unspent" is the
  // s.tx_id IS NULL case here, not s.tx_id = ''.
  const spentWhere = isAt
    ? '(s.tx_id IS NULL OR s.block_height > $h)'
    : 's.tx_id IS NULL';
  const params: Record<string, unknown> = { addr: address };
  if (isAt) params.h = atHeight;
  const rows = await query<{
    tx_id: string; vout_n: number; value: string; address: string;
    script_type: string; script_hex: string;
  }>(
    `
      WITH addr_outs AS (
        SELECT tx_id, vout_n, value, address, script_type, script_hex
        FROM tx_outputs
        WHERE address = $addr ${outHeightFilter}
      )
      SELECT o.tx_id AS tx_id, o.vout_n AS vout_n, CAST(o.value AS CHAR) AS value,
             o.address AS address, o.script_type AS script_type, o.script_hex AS script_hex
      FROM addr_outs AS o
      LEFT JOIN (
        -- ROW_NUMBER replaces DuckDB DISTINCT ON: collapse the rare phantom
        -- multi-spend (Halford-era coinstakes re-claiming one UTXO) to one
        -- spend row per outpoint (lowest block_height, matching the original
        -- ORDER BY prev_tx, prev_vout, block_height first-row pick).
        SELECT prev_tx, prev_vout, tx_id, block_height FROM (
          SELECT prev_tx, prev_vout, tx_id, block_height,
                 ROW_NUMBER() OVER (PARTITION BY prev_tx, prev_vout ORDER BY block_height) AS rn
          FROM tx_inputs
          WHERE prev_tx IN (SELECT tx_id FROM addr_outs)
        ) AS ranked
        WHERE rn = 1
      ) AS s ON s.prev_tx = o.tx_id AND s.prev_vout = o.vout_n
      WHERE ${spentWhere}
      ORDER BY o.tx_id, o.vout_n
    `,
    params,
  );

  const body = {
    data: rows.map((r) => ({
      type: 'tx_outputs',
      id: `${r.tx_id}:${r.vout_n}`,
      attributes: {
        txId: r.tx_id,
        voutN: r.vout_n,
        value: halford2grc(BigInt(r.value)),
        address: r.address === '' ? null : r.address,
        scriptType: r.script_type,
        scriptHex: r.script_hex,
        isSpent: false,
      },
    })),
    meta: { count: rows.length },
  };
  res.status(StatusCodes.OK).send(withMeta(body));
});

addressesRouter.get('/:address/balance-history', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const now = await getTipAnchor();
  const to = parseInt(String(req.query.to ?? ''), 10);
  const toTs = Number.isFinite(to) && to > 0 ? to : now;
  const from = parseInt(String(req.query.from ?? ''), 10);
  const fromTs = Number.isFinite(from) && from > 0 ? from : toTs - 30 * 86_400;
  const granularity = String(req.query.granularity ?? 'raw');

  // Running balance = balance at the window start + cumulative deltas
  // inside the window. address_balance_history stores per-block deltas
  // only. The seed comes from the address_state projection (Σ of every
  // delta, maintained at write time) minus the deltas at/after `from`,
  // so the request reads rows from `from` onwards and nothing older.
  // The previous form ran the window function over the address's whole
  // history and only then dropped everything before `from` — O(history)
  // per chart view, ~126k rows for a busy staker.
  const [wallet, suffixRows, rows] = await Promise.all([
    getWallet(address),
    query<{ s: string }>(
      `
        SELECT CAST(coalesce(sum(delta), 0) AS CHAR) AS s
        FROM address_balance_history
        WHERE address = $addr
          AND valid_from_time >= FROM_UNIXTIME($from)
      `,
      { addr: address, from: fromTs },
    ),
    query<{ height: number; ts: number; running: string }>(
      `
        SELECT
          valid_from_height AS height,
          UNIX_TIMESTAMP(valid_from_time) AS ts,
          CAST(sum(delta) OVER (
            ORDER BY valid_from_height
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS CHAR) AS running
        FROM address_balance_history
        WHERE address = $addr
          AND valid_from_time >= FROM_UNIXTIME($from)
          AND valid_from_time <= FROM_UNIXTIME($to)
        ORDER BY valid_from_height ASC
      `,
      { addr: address, from: fromTs, to: toTs },
    ),
  ]);
  const seed = (wallet?.balance ?? 0n) - BigInt(suffixRows[0]?.s ?? '0');

  type Point = { height: number; ts: number; balance: string };
  let points: Point[] = rows.map((r) => ({
    height: r.height,
    ts: r.ts,
    balance: halford2grc(seed + BigInt(r.running)),
  }));

  const bucketSec = ({ '1h': 3600, '1d': 86_400, '1w': 604_800 } as Record<string, number>)[granularity];
  if (bucketSec) {
    const byBucket = new Map<number, Point>();
    for (const p of points) {
      const key = Math.floor(p.ts / bucketSec) * bucketSec;
      byBucket.set(key, { ...p, ts: key });
    }
    points = Array.from(byBucket.values()).sort((a, b) => a.ts - b.ts);
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'address_balance_history',
      id: address,
      attributes: {
        address, from: fromTs, to: toTs, granularity, points,
      },
    },
  }));
});
