-- Superblock contract version. The daemon's SuperblockToJson
-- (src/rpc/blockchain.cpp:~173) emits `m_version` on every superblock
-- payload; v3 (activated at V13) is the format AutoGreylist needs
-- because it carries per-project all-CPID total_credit alongside the
-- magnitudes. Pre-v3 superblocks still get a row with the field set
-- to whatever version they emitted (1 or 2).
--
-- NULL-default for backfill compatibility: existing rows in the table
-- come from the parser before this column existed, so they'd otherwise
-- need a full re-ingest to populate. UInt8 zero means "indexed before
-- we tracked this" — the explorer treats 0 as "unknown, assume <=2".
ALTER TABLE superblocks
ADD COLUMN IF NOT EXISTS contract_version UInt8 DEFAULT 0;
