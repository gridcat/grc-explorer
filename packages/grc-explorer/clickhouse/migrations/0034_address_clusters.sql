-- Address clusters (common-input-ownership heuristic).
--
-- Every input of a transaction is signed by its owner, so all
-- addresses appearing together as inputs in ANY tx are the same
-- wallet. The transitive closure of that relation recovers a wallet's
-- full address set (main + change + receive that was ever spent) —
-- which CPID-bound signals (beacon/stake/MRC) alone miss. Populated
-- by AddressClusterJob (periodic full union-find over tx_inputs;
-- idempotent, reorg-self-healing).
--
-- cluster_id = the lexicographically smallest member (stable, human-
-- meaningful canonical id). Only addresses in MULTI-member clusters
-- are stored — a never-co-spent address is its own trivial cluster
-- and simply has no row (callers treat "no row" as "just itself").
-- Caveat: the heuristic over-merges on multi-party txs (CoinJoin/
-- PayJoin); rare on Gridcoin, accepted (label is "related", not
-- "proven owned"), same stance as gridcoinstats.
--
-- ReplacingMergeTree(_seq): each rebuild re-inserts with a fresh
-- Redis-INCR _seq; clusters only ever grow/merge so an address's
-- cluster_id changes monotonically and the latest _seq wins. ORDER BY
-- address serves the address→cluster_id point lookup; the bloom on
-- cluster_id serves the reverse (all members of a cluster). Both must
-- be queried WITHOUT FINAL (+ `_seq DESC LIMIT 1 BY address` dedup) —
-- FINAL ignores the skip index, same rule as 0030-0033.

CREATE TABLE IF NOT EXISTS address_clusters (
  address      String CODEC(ZSTD(3)),
  cluster_id   String CODEC(ZSTD(3)),
  cluster_size UInt32,
  _seq         UInt64,
  _ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
  INDEX idx_acl_cluster cluster_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY tuple()
ORDER BY (address)
SETTINGS index_granularity = 8192;
