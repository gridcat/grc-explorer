import { Kysely, MysqlDialect } from 'kysely';
import { createPool, Pool } from 'mysql2';
import { config } from '../config';
import { chunked } from './chunked';
import { getRequestSignal } from './requestContext';

// MariaDB data layer — the explorer's source of truth for chain data
// (replaces the embedded DuckDB client in lib/db.ts). The whole codebase
// is hand-written SQL through `query()`/`run()`, so this module keeps
// that exact interface and only swaps the engine + dialect underneath;
// Kysely is used solely for the migration runner (lib/migrate.ts).
//
// Two pools: a writer (indexer path) and a reader (api path). InnoDB MVCC
// gives each statement a consistent snapshot, so a long analytical read
// never blocks indexer writes — the reader/writer split is kept for
// resource isolation (separate sizing / the "good-neighbour" bound we
// picked a row store for) rather than for snapshot correctness.

export type Row = Record<string, unknown>;
export type Params = readonly unknown[] | Record<string, unknown>;

// Reproduce the read contract every route depends on (the same shape the
// old DuckDB / ClickHouse paths produced):
//   - 32-bit ints (INT/SMALLINT/TINYINT UNSIGNED) → JS number
//   - 64-bit ints (BIGINT, halford) and DECIMAL    → decimal strings
//   - DATETIME                                      → 'YYYY-MM-DD HH:MM:SS'
//   - TINYINT(1) booleans                           → true/false
//   - NULL                                          → null
// `bigNumberStrings`/`dateStrings`/(default `decimalNumbers:false`) cover
// the first three; the typeCast hook is needed only for TINYINT(1), which
// mysql2 would otherwise hand back as 0/1. Returning `next()` for every
// other column keeps the default parser (which honours the options above).
function poolFor(connectionLimit: number, queueLimit = 0): Pool {
  return createPool({
    uri: config.DATABASE_URL,
    connectionLimit,
    queueLimit,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    // All chain timestamps are UTC (DuckDB stored them that way). Pin the
    // driver to UTC; the server also runs default-time-zone=+00:00, so
    // FROM_UNIXTIME / UNIX_TIMESTAMP / DATE() all operate in UTC and the
    // rollup bucketing matches the old DuckDB epoch()/CAST(... AS DATE).
    timezone: 'Z',
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      return next();
    },
  });
}

let writePool: Pool | null = null;
let readPool: Pool | null = null;
let maintReadPool: Pool | null = null;

function writer(): Pool {
  if (!writePool) writePool = poolFor(config.DB_POOL_WRITE);
  return writePool;
}
function reader(): Pool {
  if (!readPool) readPool = poolFor(config.DB_POOL_READ, config.DB_POOL_QUEUE_LIMIT);
  return readPool;
}
// Reader pool for the periodic background jobs' long analytical scans.
// Physically separate from reader() so those tens-of-minutes queries
// can't seize the API request path's connections (see DB_POOL_MAINT_READ).
function maintReader(): Pool {
  if (!maintReadPool) maintReadPool = poolFor(config.DB_POOL_MAINT_READ);
  return maintReadPool;
}

// Kysely instance over the writer pool — used ONLY by the migration
// runner (Migrator + FileMigrationProvider). Runtime reads/writes go
// through query()/run() with raw SQL, not the query builder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kyselyDb: Kysely<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migratorDb(): Kysely<any> {
  if (!kyselyDb) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kyselyDb = new Kysely<any>({ dialect: new MysqlDialect({ pool: writer() as any }) });
  }
  return kyselyDb;
}

// Compile our `$name` / `$n` placeholder SQL down to mysql2 positional
// `?` + a flat values array. This replaces DuckDB's wrapArrays/listValue:
// an array-valued param expands in place to `?, ?, …` so callers keep
// using `col IN ($list)` with a JS array. An empty array expands to NULL
// (so `IN (NULL)` matches nothing) — call-sites still guard empties, this
// is just defence. A named param used N times pushes its value N times,
// which is exactly what positional binding needs.
const TOKEN = /\$([a-zA-Z_][a-zA-Z0-9_]*|\d+)/g;
export function compile(sql: string, params?: Params): { text: string; values: unknown[] } {
  if (params === undefined) return { text: sql, values: [] };
  const isArray = Array.isArray(params);
  const lookup = (key: string): unknown => (isArray
    ? (params as readonly unknown[])[Number(key) - 1]
    : (params as Record<string, unknown>)[key]);
  const values: unknown[] = [];
  const text = sql.replace(TOKEN, (_m, key: string) => {
    const v = lookup(key);
    if (Array.isArray(v)) {
      if (v.length === 0) return 'NULL';
      for (const el of v) values.push(el);
      return v.map(() => '?').join(', ');
    }
    values.push(v);
    return '?';
  });
  return { text, values };
}

// Reads made for an HTTP request are killed after this long. The
// frontend's SSR gives up at 15 s, so a read past that only holds one of
// the reader pool's few connections while cheap requests queue behind
// it. Cache rebuilds run outside the request (swrCache → outsideRequest)
// and stay uncapped.
const REQUEST_STATEMENT_TIMEOUT_S = 12;

// Read path (reader pool). Returns plain row objects in the contract
// shape above.
export async function query<T = Row>(sql: string, params?: Params): Promise<T[]> {
  const { text, values } = compile(sql, params);
  const capped = getRequestSignal()
    ? `SET STATEMENT max_statement_time=${REQUEST_STATEMENT_TIMEOUT_S} FOR ${text}`
    : text;
  const [rows] = await reader().promise().query(capped, values);
  return rows as T[];
}

export async function queryOne<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

// Maintenance read path (separate maintenance reader pool). Identical
// contract to query(); use it for the LONG analytical reads in the
// periodic background jobs so they never contend for the API reader
// connections. Anything on the HTTP request path must use query().
export async function maintenanceQuery<T = Row>(sql: string, params?: Params): Promise<T[]> {
  const { text, values } = compile(sql, params);
  const [rows] = await maintReader().promise().query(text, values);
  return rows as T[];
}

export async function maintenanceQueryOne<T = Row>(
  sql: string,
  params?: Params,
): Promise<T | undefined> {
  const rows = await maintenanceQuery<T>(sql, params);
  return rows[0];
}

// Write / DDL (writer pool). No result set is returned.
export async function run(sql: string, params?: Params): Promise<void> {
  const { text, values } = compile(sql, params);
  await writer().promise().query(text, values);
}

// Memoised "are these columns present?" probe — lets a route that reads a
// column from a not-yet-run migration keep rendering the pre-migration
// shape until the runner catches up. True is cached; false self-heals.
const columnsPresenceCache = new Map<string, true>();
export async function hasColumns(table: string, names: readonly string[]): Promise<boolean> {
  const key = `${table}:${[...names].sort().join(',')}`;
  if (columnsPresenceCache.has(key)) return true;
  try {
    const rows = await query<{ c: number | string }>(
      `SELECT count(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = $table AND column_name IN ($names)`,
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
// wins) — MariaDB, like DuckDB, can't touch the same row twice in one
// INSERT … ON DUPLICATE KEY statement, and the chain legitimately
// produces repeats (e.g. duplicate pre-BIP30 coinbase txids colliding on
// tx_outputs' (tx_id, vout_n)).
function dedupeByPk(
  rows: ReadonlyArray<Record<string, unknown>>,
  pk: readonly string[],
): ReadonlyArray<Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = pk
      .map((c) => (row[c] == null ? ' ' : String(row[c])))
      .join('');
    byKey.set(key, row);
  }
  if (byKey.size === rows.length) return rows;
  return Array.from(byKey.values());
}

// Bulk upsert — the write path's workhorse. `rows` is an array of uniform
// objects (keys taken from the first row). Conflict handling:
//   - 'update' (default): ON DUPLICATE KEY UPDATE every non-PK column from
//     the new row ("newest write wins") — for mutable rows.
//   - 'nothing': INSERT IGNORE — for insert-only immutable-per-PK tables.
//     (Under DuckDB this also dodged an ART-index bug; on InnoDB it's just
//     the natural choice for append-only chain data, and re-apply on
//     reorg/crash-recovery stays an idempotent no-op.)
// `tsCols` names columns whose values are unix-second numbers; they get
// FROM_UNIXTIME() wrapping so they land in DATETIME columns (null stays
// null). `preserveOnConflict` keeps a column from the existing row on
// conflict (still inserted on a fresh row, omitted from the UPDATE set) —
// e.g. mrc_requests.first_seen, the mempool arrival time a later block
// confirmation must not clobber.
//
// Column identifiers are backticked unconditionally — `upsert` is the one
// place the layer holds each column name as a discrete token (vs. the
// opaque raw-SQL of query()/run()), so it can quote them and a reserved
// word like `protocol_entries.key` "just works" without the caller
// remembering. We use the classic VALUES(col) form in the UPDATE clause.
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
  const doUpdate = opts.onConflict !== 'nothing' && updateCols.length > 0;
  const chunkSize = opts.chunk ?? 1000;
  const ignore = doUpdate ? '' : 'IGNORE ';
  const onDup = doUpdate
    ? ` ON DUPLICATE KEY UPDATE ${updateCols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`
    : '';

  const deduped = dedupeByPk(rows, opts.pk);
  const colSql = (c: string, ph: string) => (tsSet.has(c) ? `FROM_UNIXTIME(${ph})` : ph);
  const colList = cols.map((c) => `\`${c}\``).join(', ');
  const conn = writer().promise();
  for (const slice of chunked(deduped, chunkSize)) {
    const values: unknown[] = [];
    const valuesSql = slice.map((row) => {
      const placeholders = cols.map((c) => {
        values.push(row[c]);
        return colSql(c, '?');
      });
      return `(${placeholders.join(', ')})`;
    }).join(', ');
    const sql = `INSERT ${ignore}INTO ${table} (${colList}) VALUES ${valuesSql}${onDup}`;
    // eslint-disable-next-line no-await-in-loop
    await conn.query(sql, values);
  }
}

// Boot hook — warm both pools so the first request / write doesn't pay
// the connect cost.
export async function initDb(): Promise<void> {
  await Promise.all([
    reader().promise().query('SELECT 1'),
    writer().promise().query('SELECT 1'),
    maintReader().promise().query('SELECT 1'),
  ]);
}

// Graceful shutdown — drain both pools (and the migrator's Kysely
// instance, which holds the writer pool).
export async function closeDb(): Promise<void> {
  if (kyselyDb) {
    try { await kyselyDb.destroy(); } catch { /* already gone */ }
    kyselyDb = null;
  }
  for (const p of [writePool, readPool, maintReadPool]) {
    if (!p) continue;
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => { p.end(() => resolve()); });
  }
  writePool = null;
  readPool = null;
  maintReadPool = null;
}
