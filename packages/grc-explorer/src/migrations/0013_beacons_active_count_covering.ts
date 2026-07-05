import { Kysely, sql } from 'kysely';

// Covering index for the "active beacons at height H" count — same
// medicine as 0010/0011/0012, this time for the superblock-detail
// endpoint (routes/superblocks.ts GET /:height).
//
// The count is:
//   SELECT count(*) FROM beacons
//   WHERE block_height <= H
//     AND timestamp  <= FROM_UNIXTIME(T)
//     AND expiration >  FROM_UNIXTIME(T)
//     AND status != 'revoked'
//     AND (superseded_at_height IS NULL OR superseded_at_height > H)
//
// With only idx_beacons_height_tx (block_height, tx_id) available the
// planner resolves the `block_height <= H` range from that index and
// then does ONE random row lookup per matched entry just to read
// expiration / timestamp / status / superseded_at_height. For a recent
// superblock `block_height <= H` matches nearly every beacon, so the
// count degrades to ~one random HDD seek per beacon row — 10-15 s cold
// on the 1-2 GB / HDD prod slice, which blows past the 15 s SSR axios
// timeout and 500s the whole /superblocks/:height page. The latency
// scales monotonically with H (recent = slower) exactly because the
// number of in-range random lookups does.
//
// (expiration, block_height, timestamp, superseded_at_height, status)
// carries every column the predicate touches, so MariaDB evaluates the
// residual filters via index condition pushdown — the count becomes a
// pure in-index scan with no base-table row lookups at all.
//
// `expiration` LEADS deliberately. Only one column can be the true range
// bound; the rest are in-index filters over that range. The 500s hit
// RECENT superblocks, where `block_height <= H` matches ~every beacon
// (so leading with height would scan the whole index), whereas
// `expiration > T` at a recent T matches only beacons still unexpired
// then — the active set, a few thousand rows. Leading with expiration
// makes the failing case "unexpired beacons, then filter" instead of
// "all beacons ever, then filter". Buried superblocks stay index-only
// and sub-second either way (they were never the ones timing out).
//
// beacons is small and rarely written, so a wider covering index is
// cheap. idx_beacons_height_tx is KEPT: the list's two-phase page fetch
// relies on its (block_height, tx_id) prefix for the ORDER BY backward
// scan, which the planner won't reliably take from the suffix columns
// of this wider index (see the rich-list saga).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_beacons_active_count
      ON beacons (expiration, block_height, \`timestamp\`, superseded_at_height, status)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE beacons DROP INDEX IF EXISTS idx_beacons_active_count`.execute(db);
}
