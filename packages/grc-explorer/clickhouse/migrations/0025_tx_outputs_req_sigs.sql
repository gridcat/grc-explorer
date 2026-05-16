-- Multisig threshold per output. The daemon's scriptPubKey JSON
-- carries `reqSigs` when the script-type is multisig or P2SH —
-- otherwise the field is absent and we record 0. Useful for any
-- future "multisig adoption" chart and for audits that need to
-- reconstruct the original M-of-N script without re-parsing the
-- raw script bytes.
ALTER TABLE tx_outputs
ADD COLUMN IF NOT EXISTS req_sigs UInt8 DEFAULT 0;
