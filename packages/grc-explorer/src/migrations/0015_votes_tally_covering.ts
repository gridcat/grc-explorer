import { Kysely, sql } from 'kysely';

// Covering index for the poll-result tally — same medicine as 0013/0014.
//
//   SELECT poll_id, choice_idx, sum(weight), count(*)
//   FROM votes WHERE poll_id IN (...) GROUP BY poll_id, choice_idx
//
// This runs on the poll LIST (one tally over every poll on the page) and
// the poll detail winner calc. The only usable index was idx_votes_poll
// (poll_id), so the planner found each poll's vote rows by poll_id and
// then did ONE random row lookup per vote just to read `choice_idx` and
// `weight`, plus a temporary table + filesort for the GROUP BY. EXPLAIN
// before: type=ref, key=idx_votes_poll, "Using index condition; Using
// where; Using temporary; Using filesort". Warm that's a few ms; on the
// HDD/768 MB-pool prod slice the per-vote random seeks go cold and the
// list page (25 tallies at once) stacks them.
//
// (poll_id, choice_idx, weight) carries every column the tally touches,
// and because it leads with the GROUP BY columns (poll_id, choice_idx)
// the aggregate streams straight off the index — no temporary, no
// filesort, no base-table lookups. EXPLAIN after (validated on the
// replica): type=ref, key=idx_votes_poll_choice_weight, "Using where;
// Using index".
//
// ADDITIVE: idx_votes_poll is KEPT. The poll-detail full-vote-list query
// (routes/polls.ts, SELECT nearly every column WHERE poll_id=? ORDER BY
// block_height DESC) reads the whole row anyway and orders by a column in
// neither index, so it filesorts regardless — the narrow index is its
// natural, smallest access path. votes is small + low-write, so carrying
// both indexes is cheap.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_votes_poll_choice_weight
      ON votes (poll_id, choice_idx, weight)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE votes DROP INDEX IF EXISTS idx_votes_poll_choice_weight`.execute(db);
}
