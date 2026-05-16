-- Projection: superblock_magnitudes ordered by superblock_height.
--
-- The table is ORDER BY (cpid, superblock_height) — keyed for the
-- per-CPID magnitude-history access. But the superblock-detail page
-- asks the opposite: "all magnitudes for ONE superblock"
-- (`WHERE superblock_height = ?`). superblock_height is the trailing
-- key, so that lookup can't prune and scanned ~4M rows (measured),
-- and a minmax skip index is useless here (every granule spans many
-- heights, like the address_balance_history case). A projection
-- physically re-sorted by superblock_height turns it into a range
-- read of just that superblock's rows.
--
-- Matched pair: the consuming query must DROP FINAL (FINAL ignores
-- projections, see 0027-0032) and dedup the ReplacingMergeTree in
-- query via `_seq DESC LIMIT 1 BY cpid`.
--
-- deduplicate_merge_projection_mode='rebuild' keeps the projection
-- consistent across ReplacingMergeTree merges (same as 0028/0029).
-- MATERIALIZE PROJECTION is a one-time background mutation — watch
-- `system.mutations WHERE is_done = 0`.

ALTER TABLE superblock_magnitudes
MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';

ALTER TABLE superblock_magnitudes
DROP PROJECTION IF EXISTS proj_by_superblock_height;

ALTER TABLE superblock_magnitudes
ADD PROJECTION proj_by_superblock_height (
  SELECT cpid, superblock_height, magnitude, _seq
  ORDER BY superblock_height
);

ALTER TABLE superblock_magnitudes
MATERIALIZE PROJECTION proj_by_superblock_height;
