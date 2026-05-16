-- Bloom skip index on project_users.name.
--
-- project_users is ORDER BY (cpid, project_name) with a bloom only on
-- project_name. The researcher-name search / `/cpids/resolve` exact
-- match (`WHERE name = ?`) had no supporting index AND used FINAL, so
-- it full-scanned the whole table (~5.8M rows / 372 MiB, ~3s — the
-- single slowest page on the site). `name` is high-cardinality, so a
-- bloom turns the equality lookup into a few-granule read.
--
-- Paired with the code change that drops FINAL on those reads (FINAL
-- forces the merge path and ignores skip indexes — same rule as
-- 0027-0031). MATERIALIZE INDEX is a one-time background mutation
-- over existing parts — watch `system.mutations WHERE is_done = 0`.

ALTER TABLE project_users
ADD INDEX IF NOT EXISTS idx_project_users_name name TYPE bloom_filter(0.01) GRANULARITY 4;

ALTER TABLE project_users
MATERIALIZE INDEX idx_project_users_name;
