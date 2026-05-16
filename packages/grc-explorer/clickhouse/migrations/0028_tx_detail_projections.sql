-- Tx-detail page perf. The query in `routes/transactions.ts` reads a
-- transaction's outputs and whether each is spent. EXPLAIN showed a
-- double full scan (~5.5s idle, >15s under load → request_timeout →
-- 500 → the frontend renders it as a 404):
--
--   1. tx_outputs: `proj_by_outpoint` (0027) is sorted by (tx_id,
--      vout_n) but does NOT carry `script_type`, which the tx-detail
--      SELECT needs — so CH can't use the projection and falls back to
--      scanning the base table (sorted by address) end to end.
--   2. tx_inputs: the spent-status `ANY LEFT JOIN tx_inputs` has no
--      WHERE predicate on the right side, so the join reads ALL of
--      tx_inputs to build its hash table.
--
-- Fix (1): re-create `proj_by_outpoint` WITH `script_type` so the
-- tx-detail read is a (tx_id, vout_n) point lookup. A projection's
-- column list is immutable, so the only way to add a column is
-- DROP + ADD + MATERIALIZE. The other consumers of this projection
-- (`prevOutputs.ts`, `MempoolWatcher`, the addresses UTXO view) don't
-- select `script_type`; a wider projection still covers their narrower
-- column set, so they keep their acceleration.
--
-- Fix (2): add `proj_by_prevout` sorted by (prev_tx, prev_vout). On
-- its own a projection can't speed up the unfiltered join — it needs a
-- WHERE to be selected — so this pairs with the `routes/transactions.ts`
-- rewrite that turns the join into a `WHERE prev_tx = {tx}` subquery
-- (every output of one tx shares that tx id, so its spends are exactly
-- the tx_inputs rows with prev_tx = that id). With the predicate + this
-- projection the spent lookup becomes a point lookup too.
--
-- ReplacingMergeTree + projection requires `rebuild` dedup mode (see
-- 0027 for the full rationale). `MATERIALIZE PROJECTION` queues a
-- non-blocking background mutation; until it finishes, affected parts
-- fall back to the base-table scan. Heavy one-time pass on a multi-10M
-- row table — run it on a settled box and watch
-- `SELECT * FROM system.mutations WHERE is_done = 0`.

ALTER TABLE tx_outputs
DROP PROJECTION IF EXISTS proj_by_outpoint;

ALTER TABLE tx_outputs
ADD PROJECTION IF NOT EXISTS proj_by_outpoint (
  SELECT tx_id, vout_n, address, value, block_height, script_type, _seq
  ORDER BY (tx_id, vout_n)
);

ALTER TABLE tx_outputs MATERIALIZE PROJECTION proj_by_outpoint;

ALTER TABLE tx_inputs
MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';

ALTER TABLE tx_inputs
ADD PROJECTION IF NOT EXISTS proj_by_prevout (
  SELECT prev_tx, prev_vout, tx_id, _seq
  ORDER BY (prev_tx, prev_vout)
);

ALTER TABLE tx_inputs MATERIALIZE PROJECTION proj_by_prevout;
