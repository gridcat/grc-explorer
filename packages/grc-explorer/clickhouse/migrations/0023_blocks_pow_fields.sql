-- Raw PoW header fields the daemon's getblock JSON has emitted since
-- forever but the explorer's `blocks` schema dropped on the floor.
--
--   * `nonce` — the PoW work-target nonce. Meaningless for PoS blocks
--     (Gridcoin moved to PoS at block 91387) but a clean forensic
--     anchor for the early-chain PoW era.
--   * `bits` — the compact-difficulty encoding (8-hex form, e.g.
--     "1d00ffff"). The derived `difficulty` Float64 we already store
--     is a lossy view of `nBits`; storing the canonical form lets
--     audits reconstruct the exact target without rounding.
ALTER TABLE blocks
ADD COLUMN IF NOT EXISTS nonce UInt32 DEFAULT 0;

ALTER TABLE blocks
ADD COLUMN IF NOT EXISTS bits FixedString(8) DEFAULT '00000000';
