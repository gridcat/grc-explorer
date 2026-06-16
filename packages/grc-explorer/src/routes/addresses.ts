import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { byBalanceDesc, computeCombined } from '../lib/combined';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { getBlockTimes, getTipAnchor } from '../lib/indexerTip';
import { getPagination } from '../lib/pagination';
import {
  getRichList, getWallet, getWalletCount, WalletState,
} from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { getMoneySupplyRaw, sharePct } from '../lib/supply';
import { parseAt, resolveAtHeight } from '../lib/timeMachine';
import { AddressPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

export const addressesRouter = Router();
registerParamValidators(addressesRouter);

interface LinkedWalletRow {
  cpid: string;
  address: string;
  beaconCount: number;
  stakedBlocks: number;
  mrcPayouts: number;
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
async function fetchLinkedWallets(address: string): Promise<LinkedCpidContext> {
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
      )
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
        CAST(sum(c) FILTER (WHERE source = 'beacon') AS UINTEGER) AS beacon_count,
        CAST(sum(c) FILTER (WHERE source = 'staked') AS UINTEGER) AS staked_blocks,
        CAST(sum(c) FILTER (WHERE source = 'mrc')    AS UINTEGER) AS mrc_payouts,
        CAST(min(first_h) AS UINTEGER)                AS first_height,
        CAST(max(last_h) AS UINTEGER)                 AS last_height
      FROM (
        SELECT cpid, address, count(*) AS c, 'beacon' AS source,
               min(block_height) AS first_h, max(block_height) AS last_h
        FROM beacons
        WHERE cpid = ANY($cpids)
          AND address != '' AND address != $addr
        GROUP BY cpid, address
        UNION ALL
        SELECT staker_cpid AS cpid, miner_address AS address, count(*) AS c, 'staked' AS source,
               min(height) AS first_h, max(height) AS last_h
        FROM blocks
        WHERE staker_cpid = ANY($cpids)
          AND miner_address IS NOT NULL AND miner_address != ''
          AND miner_address != $addr
        GROUP BY staker_cpid, miner_address
        UNION ALL
        SELECT cpid, pay_to_address AS address, count(*) AS c, 'mrc' AS source,
               min(block_height) AS first_h, max(block_height) AS last_h
        FROM mrc_requests
        WHERE cpid = ANY($cpids)
          AND pay_to_address IS NOT NULL AND pay_to_address != ''
          AND pay_to_address != $addr
          AND block_height IS NOT NULL
        GROUP BY cpid, pay_to_address
      )
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
      firstHeight: r.first_height,
      lastHeight: r.last_height,
    })),
  };
}

// Presenter expects the legacy snake_case shape produced by the old
// MySQL `addresses` row. Map our Redis WalletState onto that shape.
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

// Rich list. Backed entirely by Redis: ZREVRANGE wallets:by_balance
// for the page slice + N×HGETALL for the row details. Sub-millisecond.
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
        `
          SELECT address, arg_max(cpid, block_height) AS latest_cpid
          FROM beacons
          WHERE address = ANY($addrs) AND cpid != ''
          GROUP BY address
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
          CAST(sum(delta) AS VARCHAR)    AS bal,
          CAST(sum(received) AS VARCHAR) AS total_received,
          CAST(sum(sent) AS VARCHAR)     AS total_sent,
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

  // Live path: HGETALL the wallet projection.
  const wallet = await getWallet(address);
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
    const [stubLinkedContext, stubSupply] = await Promise.all([
      fetchLinkedWallets(address),
      getMoneySupplyRaw(),
    ]);
    const stubCombined = await enrichCombined(stubLinkedContext, stubSupply, address);
    const body = AddressPresenter.render(stub);
    res.status(StatusCodes.OK).send(withMeta(body, {
      pendingBalance: '0',
      linkedCpids: stubLinkedContext.cpids,
      linkedWallets: stubCombined.wallets,
      combinedBalance: stubCombined.combinedBalance,
      combinedSharePct: stubCombined.combinedSharePct,
      shareOfSupplyPct: stubCombined.selfSharePct,
      combinedCount: stubCombined.combinedCount,
    }));
    return;
  }

  // Pending balance + linked-wallets + seen-block times in parallel —
  // all three are extra attributes on the same response, none depend
  // on each other.
  const [pendingRows, linkedContext, seenTimes, supplyRaw] = await Promise.all([
    query<{ pending: string | null }>(
      `
        SELECT CAST(sum(o.value) AS VARCHAR) AS pending
        FROM tx_outputs AS o
        WHERE o.address = $addr
          AND o.tx_id IN (
            SELECT tx_id FROM mempool_txs
            WHERE confirmed_at IS NULL AND evicted_at IS NULL
          )
      `,
      { addr: address },
    ),
    fetchLinkedWallets(address),
    fetchSeenTimes(wallet.firstSeenBlock, wallet.lastSeenBlock),
    getMoneySupplyRaw(),
  ]);
  const pendingSum = pendingRows[0]?.pending && pendingRows[0].pending !== '0'
    ? BigInt(pendingRows[0].pending)
    : null;
  const combined = await enrichCombined(linkedContext, supplyRaw, address);
  const body = AddressPresenter.render(presentWallet(wallet, seenTimes));
  res.status(StatusCodes.OK).send(withMeta(body, {
    pendingBalance: pendingSum ? halford2grc(pendingSum) : '0',
    linkedCpids: linkedContext.cpids,
    linkedWallets: combined.wallets,
    combinedBalance: combined.combinedBalance,
    combinedSharePct: combined.combinedSharePct,
    shareOfSupplyPct: combined.selfSharePct,
    combinedCount: combined.combinedCount,
  }));
});

addressesRouter.get('/:address/transactions', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const { offset, limit } = getPagination(req);

  const cap = atHeight !== null && at !== undefined
    ? 'AND block_height <= $h'
    : '';
  // Paginate movements first, then JOIN transactions for time on the
  // page-sized result — pushes LIMIT/OFFSET past the union+group and
  // avoids a follow-up `tx_id IN (...)` round trip just to fetch times.
  // tx_outputs/tx_inputs are keyed by their PKs (one row per logical
  // (tx_id, vout_n/vin_n) via upsert), so no dedup is needed; the time
  // join is bounded to the page's tx_ids (the `m` CTE) so it stays a
  // point lookup against transactions (PK tx_id) rather than a full scan.
  const sql = `
    WITH m AS (
      SELECT tx_id, max(block_height) AS height, sum(delta) AS delta_sum
      FROM (
        SELECT tx_id, block_height, CAST(value AS BIGINT) AS delta
        FROM tx_outputs
        WHERE address = $addr ${cap}
        UNION ALL
        SELECT tx_id, block_height, -CAST(coalesce(value, 0) AS BIGINT) AS delta
        FROM tx_inputs
        WHERE address = $addr ${cap}
      ) AS movements
      GROUP BY tx_id
      ORDER BY height DESC, tx_id
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    )
    SELECT m.tx_id AS tx_id, m.height AS height, CAST(epoch(t.time) AS BIGINT) AS ts, m.delta_sum AS delta_sum
    FROM m
    LEFT JOIN (
      SELECT tx_id, time
      FROM transactions
      WHERE tx_id IN (SELECT tx_id FROM m)
    ) AS t USING (tx_id)
    ORDER BY m.height DESC, m.tx_id
  `;
  const params: Record<string, unknown> = { addr: address };
  if (atHeight !== null && at !== undefined) params.h = atHeight;
  const rows = await query<{
    tx_id: string; height: number; ts: number; delta_sum: string;
  }>(sql, params);

  const timesByTx = new Map<string, number>();
  for (const r of rows) timesByTx.set(r.tx_id, r.ts);

  const body = {
    data: rows.map((r) => ({
      type: 'address_tx',
      id: `${address}:${r.height}:${r.tx_id}`,
      attributes: {
        txId: r.tx_id,
        height: r.height,
        delta: halford2grc(BigInt(r.delta_sum)),
        ts: timesByTx.get(r.tx_id) ?? 0,
      },
    })),
    meta: { count: rows.length },
  };
  res.status(StatusCodes.OK).send(withMeta(body));
});

addressesRouter.get('/:address/utxos', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const isAt = atHeight !== null && at !== undefined;

  // The spent lookup is bounded to the tx_inputs rows whose prev_tx is
  // one of THIS address's output txs (`prev_tx IN (SELECT tx_id ...)`),
  // served by idx_tx_inputs_prevout (prev_tx, prev_vout); the address
  // CTE is an indexed range scan on tx_outputs (idx_tx_outputs_address).
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
      SELECT o.tx_id AS tx_id, o.vout_n AS vout_n, CAST(o.value AS VARCHAR) AS value,
             o.address AS address, o.script_type AS script_type, o.script_hex AS script_hex
      FROM addr_outs AS o
      LEFT JOIN (
        -- DISTINCT ON collapses the rare phantom multi-spend (Halford-era
        -- coinstakes re-claiming one UTXO) to one spend row per outpoint,
        -- replicating CH's ANY LEFT JOIN + LIMIT 1 BY (prev_tx, prev_vout).
        SELECT DISTINCT ON (prev_tx, prev_vout) prev_tx, prev_vout, tx_id, block_height
        FROM tx_inputs
        WHERE prev_tx IN (SELECT tx_id FROM addr_outs)
        ORDER BY prev_tx, prev_vout, block_height
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

  // Running balance reconstructed on read via a window function.
  // address_balance_history stores per-block deltas only; the OVER
  // clause re-derives running_balance up to each row's height. Bounded
  // by the [from, to] window so we don't have to scan the full
  // address history every call.
  const rows = await query<{ height: number; ts: number; balance: string }>(
    `
      SELECT
        valid_from_height AS height,
        CAST(epoch(valid_from_time) AS BIGINT) AS ts,
        CAST(running_balance AS VARCHAR) AS balance
      FROM (
        SELECT
          valid_from_height,
          valid_from_time,
          sum(delta) OVER (
            PARTITION BY address ORDER BY valid_from_height
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS running_balance
        FROM address_balance_history
        WHERE address = $addr
      )
      WHERE valid_from_time >= make_timestamp($from::BIGINT * 1000000)
        AND valid_from_time <= make_timestamp($to::BIGINT * 1000000)
      ORDER BY valid_from_height ASC
    `,
    { addr: address, from: fromTs, to: toTs },
  );

  type Point = { height: number; ts: number; balance: string };
  let points: Point[] = rows.map((r) => ({
    height: r.height,
    ts: r.ts,
    balance: halford2grc(BigInt(r.balance)),
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
