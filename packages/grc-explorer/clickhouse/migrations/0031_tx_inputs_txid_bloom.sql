-- Bloom skip index on tx_inputs.tx_id.
--
-- tx_inputs is ORDER BY (block_height, tx_id, vin_n) — tx_id is NOT a
-- leading key, so the tx-detail page's "inputs of this tx" lookup
-- (`WHERE tx_id = ?`) can't prune and full-scans the table (~13.9M
-- rows, measured) whether or not FINAL is used. The existing blooms
-- cover `address` and `prev_tx` (and proj_by_prevout serves the
-- spend-status join `WHERE prev_tx = ?`), but nothing serves the
-- by-tx_id vin fetch — the dominant remaining cost of /transactions
-- /:tx_id after the 0027-0029 projection work.
--
-- A bloom on tx_id mirrors the pattern already used for address /
-- prev_tx here and for tx_id on the `transactions` table. The paired
-- code change drops FINAL on that read so the bloom can prune (FINAL
-- forces the merge path and ignores skip indexes — same reason as
-- 0027-0030).
--
-- MATERIALIZE INDEX queues a one-time non-blocking background mutation
-- over existing parts — watch `system.mutations WHERE is_done = 0`.

ALTER TABLE tx_inputs
ADD INDEX IF NOT EXISTS idx_tx_inputs_txid tx_id TYPE bloom_filter(0.01) GRANULARITY 32;

ALTER TABLE tx_inputs
MATERIALIZE INDEX idx_tx_inputs_txid;
