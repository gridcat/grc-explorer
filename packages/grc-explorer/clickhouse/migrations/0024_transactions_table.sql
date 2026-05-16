-- Consensus-meaningful tx-header fields from the daemon's BlockTx
-- JSON that the existing `transactions` table never persisted:
--
--   * `n_version` — V14 BIP68 sequence-lock validation only activates
--     when tx.nVersion >= 2. Distinguishing "this tx opted into
--     sequence locks" from "this tx didn't" is impossible without it.
--     Most pre-V14 txs are nVersion=1; V14-aware wallets emit 2.
--   * `n_lock_time` — BIP65 OP_CHECKLOCKTIMEVERIFY validates the
--     spending tx's nLockTime against the script. Storing it lets
--     us reconstruct lock validity offline.
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS n_version UInt32 DEFAULT 1;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS n_lock_time UInt32 DEFAULT 0;
