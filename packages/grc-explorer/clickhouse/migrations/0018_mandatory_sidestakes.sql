-- Mandatory sidestake registry — protocol-driven allocations of a
-- fraction of the CoinStake reward to designated addresses. Each row
-- is a single `type: "sidestake"` contract from the chain, action
-- `A` (mandatory entry) or `D` (deletion). Activates at the V13
-- height (mainnet 3,989,800 / testnet 2,870,000) per the 5.5.0.0
-- "Natasha" release; pre-V13 sidestake contracts are rejected by the
-- daemon and therefore never make it here in the first place.
--
-- Source-of-truth shape: src/gridcoin/sidestake.{h,cpp} in
-- Gridcoin-Research, class MandatorySideStake. On-chain the
-- allocation is a Fraction(num, denom); the daemon's
-- SideStakePayloadToJson (src/rpc/rawtransaction.cpp) emits it via
-- `Allocation::ToPercent()` as a plain double, so we store the
-- percent verbatim. Consensus cap is 25% summed across all active
-- entries (Fraction(1, 4)), enforced by the daemon.
--
-- Reorg discipline: same as every other contract table. Re-extract
-- on reorg with bumped _seq, ReplacingMergeTree picks the latest.
--
-- ORDER BY (address, block_height, tx_id) makes "give me this
-- destination's allocation history" a sorted scan (the dominant
-- /mandatory-sidestakes/:address read). LowCardinality(address) —
-- the mandatory set is small by design (≤ 4 active outputs per
-- coinstake, cap of 25% total, growth tied to governance).
CREATE TABLE IF NOT EXISTS mandatory_sidestakes (
  address            LowCardinality(String),
  action             LowCardinality(String),   -- 'A' (mandatory) or 'D' (deleted)
  status             LowCardinality(String),   -- 'MANDATORY' or 'DELETED' from the contract body
  allocation_pct     Float64,                  -- Allocation::ToPercent() result, e.g. 25.0 = 25%
  description        String CODEC(ZSTD(3)),
  contract_version   UInt8,
  tx_id              FixedString(64),
  block_height       UInt32,
  time               DateTime CODEC(Delta, ZSTD(3)),
  _seq               UInt64,
  _ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(time)
ORDER BY (address, block_height, tx_id)
SETTINGS index_granularity = 8192;
