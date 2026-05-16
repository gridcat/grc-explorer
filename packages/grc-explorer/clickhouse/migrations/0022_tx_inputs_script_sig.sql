-- Capture per-vin scriptSig hex and nSequence on tx_inputs. Two
-- distinct V14 readiness needs:
--
--   1) HTLC detection — V14 HTLCs are P2SH-wrapped (the on-chain
--      output is just `OP_HASH160 <hash> OP_EQUAL`, indistinguishable
--      from any other P2SH at the output level). The HTLC nature
--      only surfaces in the SPENDING input's scriptSig, where the
--      redeemScript is revealed and OP_CHECKLOCKTIMEVERIFY (0xb1)
--      or OP_CHECKSEQUENCEVERIFY (0xb2) bytes appear. Storing the
--      hex lets the API tag HTLC redemptions retroactively without
--      another reingest pass when V14 activates.
--
--   2) BIP68 sequence-locked inputs — V14 enables BIP68/BIP112 which
--      makes nSequence semantic (relative locktime). Capturing it
--      lets us flag the rare-but-real sequence-locked transactions
--      for the tx detail page.
--
-- Defaults: empty hex / 0xffffffff (the default-disabled BIP68
-- value). Existing rows from before this migration get the defaults
-- on read; a reingest will populate them with the real values from
-- the daemon's getrawtransaction output. Reingest IS recommended
-- here so historical HTLC redemptions (if any test ones exist) get
-- correctly tagged.
ALTER TABLE tx_inputs
ADD COLUMN IF NOT EXISTS script_sig_hex String DEFAULT '' CODEC(ZSTD(3));

ALTER TABLE tx_inputs
ADD COLUMN IF NOT EXISTS sequence UInt32 DEFAULT 4294967295;
