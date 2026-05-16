-- Widen `tx_inputs.proj_by_prevout` (added in 0028) to also carry
-- `block_height`. The address UTXO query (`routes/addresses.ts`
-- /:address/utxos) is being rewritten the same way tx-detail was —
-- the unbounded `ANY LEFT JOIN tx_inputs` becomes a subquery filtered
-- by `prev_tx IN (the address's output tx_ids)` so the spent lookup
-- is served by proj_by_prevout instead of a full tx_inputs scan.
--
-- But that query's time-machine mode also reads the spending input's
-- `block_height` (UTXO-as-of-height: keep outputs spent only AFTER H).
-- 0028's projection stops at (prev_tx, prev_vout, tx_id, _seq), so a
-- query selecting `block_height` can't be projection-served — exactly
-- the `script_type`-not-in-proj_by_outpoint trap 0028 itself fixed.
--
-- A projection's column list is immutable, so DROP + ADD + MATERIALIZE
-- is the only way to add the column. 0028 is append-only history and
-- already records itself as applied, so this correction ships as its
-- own migration. On a fresh DB this recreates the projection once more
-- than strictly needed (0028 builds the narrow form, 0029 the wide
-- one) — correct over minimal. tx-detail's narrower subquery
-- (prev_vout, tx_id only) is still covered by the wider projection.
--
-- `deduplicate_merge_projection_mode = 'rebuild'` was already set on
-- tx_inputs by 0028; re-asserted here so this migration is self-
-- contained. MATERIALIZE queues a non-blocking background mutation —
-- watch `SELECT * FROM system.mutations WHERE is_done = 0`; run on a
-- settled box.

ALTER TABLE tx_inputs
MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';

ALTER TABLE tx_inputs
DROP PROJECTION IF EXISTS proj_by_prevout;

ALTER TABLE tx_inputs
ADD PROJECTION IF NOT EXISTS proj_by_prevout (
  SELECT prev_tx, prev_vout, tx_id, block_height, _seq
  ORDER BY (prev_tx, prev_vout)
);

ALTER TABLE tx_inputs MATERIALIZE PROJECTION proj_by_prevout;
