-- Beacon auth method. V14 introduces v3 beacons — `advertisebeaconv3`
-- backed by a BOINC-project-server RSA-SHA512 ownership-proof signature
-- (m_ownership_proof on the BeaconPayload). The release notes call
-- this out as the headline researcher-onboarding improvement: the v2
-- email-verify flow remains valid, but new researchers should use v3
-- because it's the cleaner UX. We capture the auth method per beacon
-- row so dashboards can show "v3" badges + chart adoption over time.
--
-- Derived from the BeaconPayload `m_version` field (src/gridcoin/beacon.h):
--   1 → 'legacy'           (pre-Fern hashboinc-derived)
--   2 → 'v2_email_verify'  (Fern email-verification flow)
--   3 → 'v3_boinc_signed'  (V14 RSA-SHA512 ownership proof)
--   * → 'unknown'
--
-- LowCardinality(String) — four enum values across the table's
-- lifetime. Default '' so existing rows from the parser before this
-- column existed don't need a full re-ingest to remain queryable;
-- the explorer treats '' as 'unknown' on read.
ALTER TABLE beacons
ADD COLUMN IF NOT EXISTS auth_method LowCardinality(String) DEFAULT '';
