import { Kysely, sql } from 'kysely';

// Block detail's contract map (services/blockFlow/buildBlockFlow.ts,
// buildContractMap) asks seven tables "what contract did this block
// carry?" — one `WHERE block_height = $h` each. Only beacons had a
// height index (0012); the other six had none, so every uncached
// /blocks/:height view full-scanned all of them. EXPLAIN on the
// mainnet dataset before this migration:
//
//   votes             index (PK scan)   34,053 rows
//   mrc_requests      ALL                5,763
//   tx_messages       ALL                3,082
//   project_contracts ALL                1,038
//   polls             ALL                  271
//   protocol_entries  ALL                   47
//
// ~75 MB of pages re-read per uncached height. Warm that's ~250 ms of
// pure waste; on the 2 GB / HDD prod slice the 768 MB buffer pool is
// already losing the fight against a ~35 GB working set, so these
// scans come off the disk again and again — and a crawler walking
// /blocks/N sequentially never hits the 24 h detail cache that would
// spare them. Same medicine as 0012/0013, this time for the block
// page rather than the beacons/superblock ones.
//
// The reorg path pays it too: lib/chainTables.ts rolls back with
// `DELETE FROM <table> WHERE block_height >= $h` across all six, which
// is a full scan per reorg on a chain that reorgs at the tip routinely.
//
// Single-column (block_height) is deliberate — InnoDB appends the PK
// to every secondary index, which is exactly the covering suffix each
// query wants: votes gets (block_height, tx_id, choice_idx) for its
// DISTINCT tx_id, tx_messages and mrc_requests get (block_height,
// tx_id), protocol_entries gets (block_height, `key`, time, tx_id).
// polls' title and project_contracts' action still need a row lookup,
// but those tables carry ~1 row per block, so widening the index to
// cover them would duplicate most of the row for nothing.

const TABLES = [
  'votes',
  'polls',
  'tx_messages',
  'project_contracts',
  'mrc_requests',
  'protocol_entries',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of TABLES) {
    // eslint-disable-next-line no-await-in-loop
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.raw(`idx_${t}_block`)}
        ON ${sql.ref(t)} (block_height)
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of TABLES) {
    // eslint-disable-next-line no-await-in-loop
    await sql`
      ALTER TABLE ${sql.ref(t)} DROP INDEX IF EXISTS ${sql.raw(`idx_${t}_block`)}
    `.execute(db);
  }
}
