-- Block-level MRC fee accounting from `block.claim`. Splits the bid
-- fees of every MRC bundled into the block between the Foundation
-- (a chain-defined burn-or-redirect path) and the staker (the
-- inclusion incentive). Already emitted by the daemon's verbose
-- getblock; we just weren't storing it.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS mrc_foundation_fees UInt64 DEFAULT 0;

ALTER TABLE claims ADD COLUMN IF NOT EXISTS mrc_staker_fees UInt64 DEFAULT 0;

-- Per-MRC body version (m_version, currently 1). Tracking it lets us
-- spot v2/v3 rollouts in the wild without a schema change.
ALTER TABLE mrc_requests ADD COLUMN IF NOT EXISTS version UInt8 DEFAULT 1;

-- Base64 ECDSA signature the wallet emits in MRCToJson. ~96 bytes/row,
-- ZSTD-friendly. Lets us offer client-verifiable history.
ALTER TABLE mrc_requests ADD COLUMN IF NOT EXISTS signature String DEFAULT '' CODEC(ZSTD(6));
