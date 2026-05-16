-- Backfill: re-derive received/sent for coinstake-affected address rows
-- using the net-per-address accounting the indexer now writes
-- (ContractParser.ts bumpDelta 'deltaOnly' + the coinstake net block).
--
-- Why this exists
-- ---------------
-- A coinstake recirculates the staker's own principal back to the same
-- address on every block it stakes. The pre-this accounting booked
-- that gross — the entire staked UTXO as `sent` and principal+reward
-- as `received` — so a long-running staker's lifetime totals inflated
-- into the millions of GRC while the real inflow was just the reward.
-- The indexer now nets a coinstake per address (positive net = reward
-- / sidestake / MRC inflow → received; negative net = value the staker
-- redirected out → sent). This migration retro-applies that to history.
--
-- Scope: ONLY coinstake transactions, and within them only addresses
-- that had an input (the stakers). Sidestake / MRC recipients have an
-- output but no input, so their net == their output == the old gross —
-- d == 0, untouched. Ordinary (non-coinstake) txs keep gross accounting
-- (change still counted, the standard explorer convention), so they
-- are not in scope here. `delta` (the true balance) was never affected
-- by the bug and is left exactly as-is — only received/sent move.
--
-- No reindex: recomputed purely from CH's own tx_inputs / tx_outputs /
-- transactions, joined to the immutable address_balance_history event
-- log. address_balance_history is ReplacingMergeTree(_seq) ORDER BY
-- (address, valid_from_height); received/sent are non-key, so we use
-- the 0017 idiom — re-insert the corrected full row for each affected
-- (address, valid_from_height) with a fresh larger _seq; the merge (and
-- read-time FINAL) keeps the corrected copy. The correction can only
-- shrink received/sent (new ≤ old), and is clamped at 0 defensively.
--
-- AFTER this migration, Redis wallet:{addr} totals must be rebuilt
-- from the corrected table: run `node dist/scripts/rebuildWallets.js`
-- (or the ts entrypoint) once. rebuildWallets walks
-- address_balance_history, so it picks up the corrected received/sent
-- with no further work. delta-derived projections (balances, wealth
-- snapshots) are unaffected and need no rebuild.
--
-- IMPORTANT (same trap as 0017): the positional INSERT column list
-- matches by position; the SELECT aliases are cosmetic and must NOT
-- shadow column names used in predicates.

INSERT INTO address_balance_history
  (address, valid_from_height, valid_from_time, delta,
   received, sent, tx_count_delta, _seq)
SELECT
  h.address,
  h.valid_from_height,
  h.valid_from_time,
  h.delta,
  toUInt64(greatest(0, toInt64(h.received) + adj.d_recv)) AS received_fixed,
  toUInt64(greatest(0, toInt64(h.sent)    + adj.d_sent)) AS sent_fixed,
  h.tx_count_delta,
  toUInt64(toUnixTimestamp64Milli(now64(3)))             AS new_seq
FROM address_balance_history AS h FINAL
INNER JOIN
(
  -- Per (address, block) coinstake correction = sum over the block's
  -- coinstake legs of (net contribution - old gross contribution).
  -- recv_old = outputs to addr; sent_old = inputs from addr;
  -- net = out_sum - in_sum; recv_new = max(0,net); sent_new = max(0,-net).
  SELECT
    addr                                            AS address,
    block_height,
    sum(greatest(0,  net) - out_sum)                AS d_recv,
    sum(greatest(0, -net) - in_sum)                 AS d_sent
  FROM
  (
    SELECT
      io.tx_id        AS tx_id,
      io.block_height AS block_height,
      io.addr         AS addr,
      io.out_sum      AS out_sum,
      io.in_sum       AS in_sum,
      toInt64(io.out_sum) - toInt64(io.in_sum) AS net
    FROM
    (
      -- Union of per-(coinstake tx, address) output sums and input
      -- sums. FULL JOIN so an address that only inputs (or only
      -- outputs) within the coinstake still gets a row.
      SELECT
        coalesce(o.tx_id, i.tx_id)               AS tx_id,
        coalesce(o.block_height, i.block_height) AS block_height,
        coalesce(o.addr, i.addr)                 AS addr,
        toInt64(ifNull(o.out_sum, 0))            AS out_sum,
        toInt64(ifNull(i.in_sum, 0))             AS in_sum
      FROM
      (
        SELECT t.tx_id AS tx_id, any(o.block_height) AS block_height,
               o.address AS addr, sum(o.value) AS out_sum
        FROM tx_outputs AS o FINAL
        INNER JOIN
          (SELECT tx_id FROM transactions FINAL WHERE is_coinstake GROUP BY tx_id) AS t
          ON o.tx_id = t.tx_id
        WHERE o.address != ''
        GROUP BY t.tx_id, o.address
      ) AS o
      FULL OUTER JOIN
      (
        SELECT t.tx_id AS tx_id, any(i.block_height) AS block_height,
               i.address AS addr, sum(ifNull(i.value, 0)) AS in_sum
        FROM tx_inputs AS i FINAL
        INNER JOIN
          (SELECT tx_id FROM transactions FINAL WHERE is_coinstake GROUP BY tx_id) AS t
          ON i.tx_id = t.tx_id
        WHERE i.address IS NOT NULL
        GROUP BY t.tx_id, i.address
      ) AS i
      ON o.tx_id = i.tx_id AND o.addr = i.addr
    ) AS io
  ) AS legs
  GROUP BY addr, block_height
  HAVING d_recv != 0 OR d_sent != 0
) AS adj
ON adj.address = h.address AND adj.block_height = h.valid_from_height;
