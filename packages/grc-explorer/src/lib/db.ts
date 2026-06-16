import { DuckDBInstance, DuckDBConnection, listValue } from '@duckdb/node-api';
import { config } from '../config';

// Embedded DuckDB client — the explorer's source of truth for chain
// data (replaces the old ClickHouse client in lib/ch.ts). One process
// owns the database file read-write; this module is the single entry
// point to it.
//
// Two long-lived connections: a writer (indexer path) and a reader (api
// path). DuckDB gives each connection its own MVCC snapshot, so a long
// analytical time-machine read on the reader doesn't head-of-line-block
// indexer writes on the writer. A connection pool is the next step if
// read concurrency ever outgrows one connection; for a low-traffic
// explorer one reader is enough.
//
// threads / memory_limit are capped from config so a heavy scan can't
// saturate the shared host — the good-neighbour trade we picked DuckDB
// for over ClickHouse. DuckDB is in-process with no network connection
// pool to exhaust, so the old CH abort-on-disconnect mitigation has no
// analogue here; the resource caps are the equivalent bound.

export type Row = Record<string, unknown>;
export type Params = readonly unknown[] | Record<string, unknown>;

// DuckDB's binder can't infer the element type of a bare JS array, so a
// plain `[1,2,3]` param throws "Cannot create values of type ANY". Wrap
// arrays in listValue() so callers can pass JS arrays directly and use
// `WHERE col = ANY($param)` (the IN-list pattern that replaced CH's
// `IN ({param: Array(T)})`). Non-array values pass through untouched —
// numbers, bigints (halford), strings, booleans bind natively.
// Callers must still guard empty arrays (an empty list has no inferable
// element type); every porting site early-returns on empty input.
function wrapArrays(params: Params): Params {
  const wrap = (v: unknown): unknown => (Array.isArray(v) ? listValue(v) : v);
  if (Array.isArray(params)) return params.map(wrap);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = wrap(v);
  return out;
}

let instancePromise: Promise<DuckDBInstance> | null = null;

function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    instancePromise = DuckDBInstance.create(config.DUCKDB_PATH, {
      threads: String(config.DUCKDB_THREADS),
      memory_limit: config.DUCKDB_MEMORY_LIMIT,
      // Don't buffer rows to preserve insertion order. Production runs on
      // the 2GB default and only serves reads (it's seeded with a
      // backfilled DuckDB file, never backfills itself), so the memory
      // ceiling is hit by large recompute-on-read scans, not writes.
      // Insertion-order preservation forces DuckDB to materialise those
      // scans in order; disabling it keeps the working set bounded. Safe
      // here: every list query paginates with an explicit ORDER BY, so no
      // result depends on natural row order.
      preserve_insertion_order: 'false',
    });
  }
  return instancePromise;
}

let writeConnPromise: Promise<DuckDBConnection> | null = null;
let readConnPromise: Promise<DuckDBConnection> | null = null;

export function writeConnection(): Promise<DuckDBConnection> {
  if (!writeConnPromise) writeConnPromise = getInstance().then((i) => i.connect());
  return writeConnPromise;
}

export function readConnection(): Promise<DuckDBConnection> {
  if (!readConnPromise) readConnPromise = getInstance().then((i) => i.connect());
  return readConnPromise;
}

// Read query → array of plain JS objects via getRowObjectsJson(), which
// produces the same shape the old CH JSONEachRow path did: 32-bit ints
// as `number`, 64-bit ints (halford) and DECIMAL as decimal strings,
// TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' strings, NULL as null. Callers that
// already parse string-encoded bigints/decimals keep working unchanged.
export async function query<T = Row>(sql: string, params?: Params): Promise<T[]> {
  const conn = await readConnection();
  const reader = params === undefined
    ? await conn.runAndReadAll(sql)
    : await conn.runAndReadAll(sql, wrapArrays(params) as never);
  return reader.getRowObjectsJson() as T[];
}

export async function queryOne<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

// Write / DDL on the writer connection. No result set is returned.
export async function run(sql: string, params?: Params): Promise<void> {
  const conn = await writeConnection();
  if (params === undefined) await conn.run(sql);
  else await conn.run(sql, wrapArrays(params) as never);
}

// Memoised "are these columns present?" probe. Routes that read columns
// from a later migration call this so the page keeps rendering if a fresh
// container is deployed before the migration runner has caught up. True
// is cached; false is not (false negatives self-heal once the migration
// lands). Replaces the ClickHouse system.columns probe in lib/ch.
const columnsPresenceCache = new Map<string, true>();
export async function hasColumns(table: string, names: readonly string[]): Promise<boolean> {
  const key = `${table}:${[...names].sort().join(',')}`;
  if (columnsPresenceCache.has(key)) return true;
  try {
    const rows = await query<{ c: number | string }>(
      `SELECT count(*) AS c FROM information_schema.columns
       WHERE table_name = $table AND column_name = ANY($names)`,
      { table, names: [...names] },
    );
    if (Number(rows[0]?.c ?? 0) >= names.length) {
      columnsPresenceCache.set(key, true);
      return true;
    }
  } catch {
    // Probe failure → "not present"; caller falls back to the
    // pre-migration shape.
  }
  return false;
}

// Drop duplicate-PK rows, keeping the last occurrence (newest write
// wins). PK parts are scalars (string/number/bigint/boolean/null), so a
// joined string is a safe composite key. Returns `rows` untouched when
// there's nothing to collapse — the common no-duplicate path pays only
// one O(n) scan, no re-allocation.
function dedupeByPk(
  rows: ReadonlyArray<Record<string, unknown>>,
  pk: readonly string[],
): ReadonlyArray<Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = pk
      .map((c) => (row[c] == null ? '\u0000' : String(row[c])))
      .join('\u0001');
    byKey.set(key, row);
  }
  if (byKey.size === rows.length) return rows;
  return Array.from(byKey.values());
}

// Bulk upsert — the write path's workhorse, replacing CH's
// `ch.insert({table, values})` + ReplacingMergeTree(_seq) dedup. `rows`
// is an array of uniform objects (same keys, derived from the first
// row). On PK conflict every non-PK column is overwritten from the new
// row, so a reorg re-apply or a crash-recovery re-apply is idempotent
// ("newest write wins", exactly what _seq gave us).
//
// tsCols names columns whose values are unix-second numbers (the
// parser's time format) — they get make_timestamp() wrapping so they
// land in TIMESTAMP columns; null stays null. The `::BIGINT` cast avoids
// INT32 overflow when multiplying seconds → microseconds. Halford
// bigints bind natively to UBIGINT; pass them as JS bigint (not strings).
//
// Rows are chunked so one statement never carries an unwieldy parameter
// count on large backfill batches.
//
// `onConflict` selects the conflict resolution:
//   - 'update' (default): DO UPDATE SET every non-PK column — "newest
//     write wins", for mutable rows (e.g. mempool state transitions).
//   - 'nothing': DO NOTHING — for insert-only tables whose rows are
//     immutable per PK. Prefer this for any table carrying a non-unique
//     secondary ART index: DuckDB mis-maintains those indexes under the
//     DO UPDATE delete-reinsert path and eventually corrupts them
//     ("Failed to delete all rows from index", which fatally invalidates
//     the connection). DO NOTHING skips conflicting rows, so the index is
//     never touched on re-apply. See BlockWriter / ChainReorgHandler.
//
// `preserveOnConflict` names columns to KEEP from the existing row on
// conflict — they're still inserted on a fresh row, but omitted from the
// DO UPDATE SET so a later write can't overwrite them. Used for
// "first-writer-wins" fields like mrc_requests.first_seen, where the
// mempool watcher records the real arrival time and the later block
// confirmation must not clobber it with block_time.
export async function upsert(
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: {
    pk: readonly string[];
    tsCols?: readonly string[];
    chunk?: number;
    onConflict?: 'update' | 'nothing';
    preserveOnConflict?: readonly string[];
  },
): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const tsSet = new Set(opts.tsCols ?? []);
  const pkSet = new Set(opts.pk);
  const preserveSet = new Set(opts.preserveOnConflict ?? []);
  const updateCols = cols.filter((c) => !pkSet.has(c) && !preserveSet.has(c));
  const onConflict = opts.onConflict !== 'nothing' && updateCols.length > 0
    ? `DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(', ')}`
    : 'DO NOTHING';
  const chunkSize = opts.chunk ?? 1000;

  // Collapse duplicate-PK rows before building any statement. DuckDB's
  // ON CONFLICT DO UPDATE can't touch the same row twice in one command
  // — it fails deep in the ART index ("Failed to delete all rows from
  // index") — and the chain legitimately produces repeats: duplicate
  // coinbase txids in early (pre-BIP30) history collide on tx_outputs'
  // (tx_id, vout_n). Keep the last occurrence so "newest write wins"
  // still holds, then chunk the deduped set.
  const deduped = dedupeByPk(rows, opts.pk);

  const conn = await writeConnection();
  for (let i = 0; i < deduped.length; i += chunkSize) {
    const slice = deduped.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const valuesSql = slice.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        const n = params.length;
        return tsSet.has(c) ? `make_timestamp($${n}::BIGINT * 1000000)` : `$${n}`;
      });
      return `(${placeholders.join(', ')})`;
    }).join(', ');
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valuesSql} `
      + `ON CONFLICT (${opts.pk.join(', ')}) ${onConflict}`;
    // eslint-disable-next-line no-await-in-loop
    await conn.run(sql, params as never);
  }
}

// Explicit boot hook — open the instance and warm both connections so
// the first request / first write doesn't pay the open cost. Called from
// index.ts during startup.
export async function initDb(): Promise<void> {
  await Promise.all([writeConnection(), readConnection()]);
}

// True when `err` is a DuckDB fatal that invalidates the whole database —
// every subsequent query on any connection then throws the same error, so
// there is no in-process recovery. The two we hit: the ART secondary-index
// corruption surfaced by a range delete ("Failed to delete all rows from
// index"), and the follow-on guard DuckDB raises for every later statement
// ("database has been invalidated" / "must be restarted"). Callers use this
// to trigger a graceful exit-for-restart instead of looping on the error.
export function isFatalDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Failed to delete all rows from index')
    || msg.includes('database has been invalidated')
    || msg.includes('must be restarted prior to being used')
  );
}

// Rebuild secondary (non-PK, non-unique) ART indexes by dropping and
// recreating them from their catalog definition. CREATE INDEX rebuilds the
// index from the table's current rows, so this clears the dangling entries
// that the index+upsert path can leave behind — the corruption that fatals
// a later delete. Unique/primary indexes are left alone: they don't exhibit
// the bug and a rebuild could fail on data DuckDB already considers valid.
// `tables` filters the scope; omit it to rebuild every eligible index.
// Returns the names rebuilt (for logging). Runs on the writer connection so
// the DDL doesn't race a concurrent write.
export async function rebuildSecondaryIndexes(
  tables?: readonly string[],
): Promise<string[]> {
  const conn = await writeConnection();
  const baseSql = 'SELECT index_name, sql FROM duckdb_indexes() '
    + 'WHERE is_primary = false AND is_unique = false';
  const reader = tables && tables.length > 0
    ? await conn.runAndReadAll(
      `${baseSql} AND table_name = ANY($t)`,
      wrapArrays({ t: [...tables] }) as never,
    )
    : await conn.runAndReadAll(baseSql);
  const indexes = reader.getRowObjectsJson() as Array<{ index_name: string; sql: string }>;
  for (const { index_name: name, sql } of indexes) {
    // eslint-disable-next-line no-await-in-loop
    await conn.run(`DROP INDEX IF EXISTS ${name}`);
    // eslint-disable-next-line no-await-in-loop
    await conn.run(sql);
  }
  return indexes.map((i) => i.index_name);
}

// Best-effort clean close for graceful shutdown. CHECKPOINT flushes the WAL
// into the main file so a subsequent open doesn't replay it, then both
// connections and the instance are released. Every step is wrapped: if the
// database is already in a fatal/invalidated state none of this can run, and
// shutdown must still complete. Resets the memoised promises so a re-open
// (only relevant in tests) starts fresh.
export async function closeDb(): Promise<void> {
  try {
    const conn = await writeConnection();
    await conn.run('CHECKPOINT');
  } catch {
    // Fataled, busy, or never opened — nothing recoverable to flush.
  }
  for (const connPromise of [writeConnPromise, readConnPromise]) {
    if (!connPromise) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      (await connPromise).disconnectSync();
    } catch {
      // Already gone.
    }
  }
  try {
    (await instancePromise)?.closeSync();
  } catch {
    // Already closed.
  }
  writeConnPromise = null;
  readConnPromise = null;
  instancePromise = null;
}
