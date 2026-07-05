import { query, maintenanceQuery, run } from './db';
import { swrCached } from './swrCache';

// Wallet current-state projection, backed by the `address_state` table
// (migration 0007). Replaces the Redis projection (`wallet:{addr}` HSET
// + wallets:by_balance / by_last_seen ZSETs) that had grown to ~2.9 GB —
// see the migration header for the sizing rationale. The API surface
// mirrors what lib/redis exposed so call sites swap an import path, not
// their shape.
//
// address_balance_history stays the immutable event log; this table is
// the running-total projection over it, maintained additively per batch
// by the indexer (applyAddressStateDeltas) and rebuildable from scratch
// (scripts/rebuildAddressState) or repaired exactly after a reorg
// (repairAddressState).

export interface WalletState {
  address: string;
  balance: bigint;
  totalReceived: bigint;
  totalSent: bigint;
  txCount: number;
  firstSeenBlock: number | null;
  lastSeenBlock: number | null;
}

export interface WalletDelta {
  address: string;
  delta: bigint;
  received: bigint;
  sent: bigint;
  txCountDelta: number;
  height: number;
}

interface StateRow {
  address: string;
  balance: string;
  total_received: string;
  total_sent: string;
  tx_count: number;
  first_seen_block: number | null;
  last_seen_block: number | null;
}

const STATE_COLS = `
  address,
  CAST(balance AS CHAR)        AS balance,
  CAST(total_received AS CHAR) AS total_received,
  CAST(total_sent AS CHAR)     AS total_sent,
  tx_count,
  first_seen_block,
  last_seen_block
`;

function fromRow(r: StateRow): WalletState {
  return {
    address: r.address,
    balance: BigInt(r.balance),
    totalReceived: BigInt(r.total_received),
    totalSent: BigInt(r.total_sent),
    txCount: Number(r.tx_count),
    firstSeenBlock: r.first_seen_block === null ? null : Number(r.first_seen_block),
    lastSeenBlock: r.last_seen_block === null ? null : Number(r.last_seen_block),
  };
}

/**
 * Batched projection update — collapses every (address, block) delta in
 * an applyBlocks call into ONE additive multi-row upsert. Same
 * per-address aggregation the Redis pipeline did; the ON DUPLICATE KEY
 * arithmetic replaces HINCRBY. Uses the writer pool (run), so it is
 * serialized with the batch's other inserts.
 *
 * Idempotent under forward re-apply: a delta at (address, height) is
 * skipped when height ≤ the stored last_seen_block. Chain re-applies
 * (crash recovery, fetch-span overlap) replay heights the projection
 * already absorbed — the event-log INSERT IGNORE makes those no-ops,
 * and this filter makes the projection match instead of drifting (the
 * Redis pipeline just double-applied and waited for a manual rebuild).
 * Blocks only ever apply forward in height order, so a filtered delta
 * is always a replay, never new information; reorgs bypass this via
 * repairAddressState after the height-range delete.
 *
 * NOT the generic upsert() helper: that one REPLACES column values on
 * conflict ("newest write wins"); this projection needs `col = col +
 * VALUES(col)` accumulation.
 */
export async function applyAddressStateDeltas(deltas: WalletDelta[]): Promise<void> {
  if (deltas.length === 0) return;

  const touched = Array.from(new Set(deltas.map((d) => d.address)));
  const seenRows = await query<{ address: string; last_seen_block: number | null }>(
    'SELECT address, last_seen_block FROM address_state WHERE address IN ($addrs)',
    { addrs: touched },
  );
  const lastSeen = new Map<string, number>();
  for (const r of seenRows) {
    if (r.last_seen_block !== null) lastSeen.set(r.address, Number(r.last_seen_block));
  }
  const fresh = deltas.filter((d) => {
    const seen = lastSeen.get(d.address);
    return seen === undefined || d.height > seen;
  });
  if (fresh.length === 0) return;

  type Agg = {
    delta: bigint; received: bigint; sent: bigint;
    txCountDelta: number; firstHeight: number; lastHeight: number;
  };
  const agg = new Map<string, Agg>();
  for (const d of fresh) {
    const found = agg.get(d.address);
    if (found) {
      found.delta += d.delta;
      found.received += d.received;
      found.sent += d.sent;
      found.txCountDelta += d.txCountDelta;
      if (d.height < found.firstHeight) found.firstHeight = d.height;
      if (d.height > found.lastHeight) found.lastHeight = d.height;
    } else {
      agg.set(d.address, {
        delta: d.delta,
        received: d.received,
        sent: d.sent,
        txCountDelta: d.txCountDelta,
        firstHeight: d.height,
        lastHeight: d.height,
      });
    }
  }

  // db.compile() only binds $-tokens (raw `?` would reach the server
  // as literal text), so number the placeholders explicitly.
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const [address, a] of agg) {
    const base = values.length;
    values.push(
      address,
      a.delta.toString(),
      a.received.toString(),
      a.sent.toString(),
      a.txCountDelta,
      a.firstHeight,
      a.lastHeight,
    );
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
  }
  await run(
    `
      INSERT INTO address_state
        (address, balance, total_received, total_sent, tx_count,
         first_seen_block, last_seen_block)
      VALUES ${tuples.join(', ')}
      ON DUPLICATE KEY UPDATE
        balance          = balance + VALUES(balance),
        total_received   = total_received + VALUES(total_received),
        total_sent       = total_sent + VALUES(total_sent),
        tx_count         = tx_count + VALUES(tx_count),
        first_seen_block = LEAST(
          COALESCE(first_seen_block, VALUES(first_seen_block)),
          VALUES(first_seen_block)
        ),
        last_seen_block  = GREATEST(
          COALESCE(last_seen_block, 0),
          VALUES(last_seen_block)
        )
    `,
    values,
  );
}

export async function getWallet(address: string): Promise<WalletState | null> {
  const rows = await query<StateRow>(
    `SELECT ${STATE_COLS} FROM address_state WHERE address = $addr`,
    { addr: address },
  );
  return rows.length > 0 ? fromRow(rows[0]) : null;
}

// Batched balance-only lookup. Backs combined-balance over a wallet's
// cluster; the input is bounded by CLUSTER_MEMBER_CAP (lib/cluster).
// One IN-list query replaces the per-address HGET fan-out. Missing → 0n.
export async function getWalletBalances(
  addresses: ReadonlyArray<string>,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const unique = Array.from(new Set(addresses));
  if (unique.length === 0) return out;
  const rows = await query<{ address: string; balance: string }>(
    `SELECT address, CAST(balance AS CHAR) AS balance
     FROM address_state WHERE address IN ($addrs)`,
    { addrs: unique },
  );
  for (const a of unique) out.set(a, 0n);
  for (const r of rows) out.set(r.address, BigInt(r.balance));
  return out;
}

// Rich-list slice, two-phase on purpose. Phase 1 resolves the page's
// addresses with a query fully covered by idx_address_state_balance
// (backward scan, ~100 entries — the DESC tie-break matches the index
// read in reverse); phase 2 fetches the rows by PK and restores the
// phase-1 order in JS. A single query selecting all columns cannot be
// made to use the index here: the 11.4 planner prices it as one row
// lookup per index ENTRY (ignoring the LIMIT) and flips to a 3.4M-row
// filesort (~1.5s vs ~1ms) — FORCE INDEX and FORCE INDEX FOR ORDER BY
// are both ignored for the uncovered ORDER BY, verified live.
export async function getRichList(offset: number, limit: number): Promise<WalletState[]> {
  const page = await query<{ address: string }>(
    `
      SELECT address
      FROM address_state
      ORDER BY balance DESC, address DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `,
  );
  if (page.length === 0) return [];
  const order = new Map<string, number>();
  page.forEach((r, i) => order.set(r.address, i));
  const rows = await query<StateRow>(
    `SELECT ${STATE_COLS} FROM address_state WHERE address IN ($addrs)`,
    { addrs: page.map((r) => r.address) },
  );
  return rows
    .map(fromRow)
    .sort((a, b) => (order.get(a.address) ?? 0) - (order.get(b.address) ?? 0));
}

// Total wallet count for the rich-list header ("N addresses indexed in
// total" — cosmetic display value; no pagination depends on it). Uses
// InnoDB's row-count estimate from information_schema (an instant metadata
// read) instead of COUNT(*) over the ~3.3M-row address_state table: that
// count is index-only but still walks every entry — ~78 s COLD on the
// HDD / small-buffer-pool prod slice (observed in the processlist), which
// blocks the /wallets page (its SSR fetch times out at 15 s) and holds an
// API reader connection the whole time, once per 10-min cache cycle. The
// estimate is well within tolerance for a display total (measured ~3 %
// under exact). Falls back to the exact count only if the estimate is
// unavailable (0/NULL — e.g. stats not yet gathered after a fresh import),
// so the header is never blank. Still memoised so even the metadata read
// is amortised.
const cachedWalletCount = swrCached(async () => {
  const est = await query<{ c: number | string | null }>(
    `SELECT table_rows AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'address_state'`,
  );
  const approx = Number(est[0]?.c ?? 0);
  if (approx > 0) return approx;
  const rows = await query<{ c: number | string }>(
    'SELECT count(*) AS c FROM address_state',
  );
  return Number(rows[0]?.c ?? 0);
}, 10 * 60_000);

export async function getWalletCount(): Promise<number> {
  return cachedWalletCount();
}

// Every positive balance, descending — the wealth snapshot's
// current-bucket input (Gini / top-N / holder count need magnitudes
// only). Index-only backward scan of idx_address_state_balance; same
// f64 truncation stance as the Redis ZSET scores it replaces.
//
// Reads on the MAINTENANCE pool: the only caller is the periodic
// WealthSnapshotJob, and this scans all ~3.3M positive balances — a
// full index scan that must not sit on an API reader connection. (The
// alias trick in the job file doesn't reach here: this helper closes
// over addressState's own `query` import, not the caller's.)
export async function positiveBalancesDesc(): Promise<number[]> {
  const rows = await maintenanceQuery<{ balance: number | string }>(
    `
      SELECT CAST(balance AS DOUBLE) AS balance
      FROM address_state
      WHERE balance > 0
      ORDER BY balance DESC
    `,
  );
  return rows.map((r) => Number(r.balance));
}

// Prefix lookup for the search bar. PK range scan via LIKE 'prefix%'
// with the user's wildcards escaped ('\' is LIKE's default escape
// char). The table's case-insensitive collation widens matches across
// case — acceptable (arguably friendlier) for a search box.
export async function searchWalletsByPrefix(prefix: string, limit: number): Promise<string[]> {
  if (prefix.length === 0) return [];
  const escaped = prefix.replace(/[\\%_]/g, (m) => `\\${m}`);
  const rows = await query<{ address: string }>(
    `
      SELECT address FROM address_state
      WHERE address LIKE $p
      ORDER BY address
      LIMIT ${Number(limit)}
    `,
    { p: `${escaped}%` },
  );
  return rows.map((r) => r.address);
}

// Exact post-reorg repair. The reorg handler captures the set of
// addresses that had address_balance_history rows above the fork
// BEFORE deleting them (deleteChainRowsAtOrAboveHeight); afterwards
// this recomputes those addresses from the surviving event log.
// Recompute-in-place FIRST, then delete only the addresses left with
// no surviving history: a crash between the two statements then
// affects just that rare all-history-was-reorged remnant, instead of
// leaving every touched address missing (the delete-then-reinsert
// ordering's failure mode). Bounded by MAX_REORG_DEPTH blocks' worth
// of addresses.
export async function repairAddressState(addresses: ReadonlyArray<string>): Promise<void> {
  if (addresses.length === 0) return;
  await run(
    `
      INSERT INTO address_state
        (address, balance, total_received, total_sent, tx_count,
         first_seen_block, last_seen_block)
      SELECT
        address,
        COALESCE(SUM(delta), 0),
        COALESCE(SUM(received), 0),
        COALESCE(SUM(sent), 0),
        COALESCE(SUM(tx_count_delta), 0),
        MIN(valid_from_height),
        MAX(valid_from_height)
      FROM address_balance_history
      WHERE address IN ($addrs)
      GROUP BY address
      ON DUPLICATE KEY UPDATE
        balance          = VALUES(balance),
        total_received   = VALUES(total_received),
        total_sent       = VALUES(total_sent),
        tx_count         = VALUES(tx_count),
        first_seen_block = VALUES(first_seen_block),
        last_seen_block  = VALUES(last_seen_block)
    `,
    { addrs: [...addresses] },
  );
  await run(
    `
      DELETE FROM address_state
      WHERE address IN ($addrs)
        AND address NOT IN (
          SELECT DISTINCT address FROM address_balance_history
          WHERE address IN ($addrs2)
        )
    `,
    { addrs: [...addresses], addrs2: [...addresses] },
  );
}
