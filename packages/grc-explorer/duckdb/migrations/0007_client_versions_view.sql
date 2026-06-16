-- Per-day staking-client version mix. One row per (day, raw
-- client_version) — the raw on-chain string, NOT yet grouped by release.
-- Normalization (strip the leading `v` and the -g<hash>/-unk build
-- suffix) and the top-N + 'other' rollup happen in the route, so the
-- normalization rule can change without a migration.
--
-- NULL/'' versions (pre-Fern blocks, no-claim blocks) are excluded: the
-- on-chain client version only exists from the Fern/v11 contract
-- refactor onward, so the series is only meaningful from there.
--
-- Like the 0004 rollups this is a plain VIEW recomputed on read — DuckDB
-- scans these two columns of `claims` in tens of ms (benchmarked at
-- ~4M rows) and a view always reflects current base-table state, so
-- there's no write-path maintenance and no reorg double-count.
CREATE VIEW client_versions_daily AS
SELECT
  CAST(block_time AS DATE) AS bucket_date,
  client_version           AS raw_version,
  count(*)                 AS blocks
FROM claims
WHERE client_version IS NOT NULL AND client_version <> ''
GROUP BY bucket_date, client_version;
