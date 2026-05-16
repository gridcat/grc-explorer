-- Projection for `(tx_id, vout_n)` point lookups. The base table is
-- sorted by `(address, block_height, tx_id, vout_n)` — efficient for
-- the address-history view, but useless for the indexer's prev-output
-- enrichment (`prevOutputs.ts`) which filters on `(tx_id, vout_n)` only.
-- That predicate was triggering full-table scans on every backfill batch
-- — 3.2 B rows/min observed during a partial re-ingest, saturating 3 CH
-- cores. Same pattern in `MempoolWatcher` and `routes/transactions`.
--
-- The projection re-stores just the columns those hot paths read
-- (~1/3 the width of the base table) sorted by the lookup key. CH picks
-- it transparently whenever the WHERE matches; no application change.
-- `_seq` carries the ReplacingMergeTree version so projection-served
-- rows survive dedup correctly on FINAL queries.
--
-- CH 24.x rejects projections on ReplacingMergeTree by default
-- (`deduplicate_merge_projection_mode = 'throw'`) because the dedup
-- merge can drop rows the projection had already absorbed.  `rebuild`
-- tells CH to recompute the projection over the post-dedup merged part
-- — correct, at the cost of a little extra I/O during merges. The
-- alternative (`drop`) would silently disable the projection on any
-- merged part; we want consistent point-lookup performance, so rebuild.
--
-- `MATERIALIZE PROJECTION` queues a background mutation — non-blocking.
-- New inserts use the projection from the next part forward; existing
-- parts catch up over time. Monitor via `SELECT * FROM system.mutations
-- WHERE is_done = 0`.
ALTER TABLE tx_outputs
MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';

ALTER TABLE tx_outputs
ADD PROJECTION IF NOT EXISTS proj_by_outpoint (
  SELECT tx_id, vout_n, address, value, block_height, _seq
  ORDER BY (tx_id, vout_n)
);

ALTER TABLE tx_outputs MATERIALIZE PROJECTION proj_by_outpoint;
