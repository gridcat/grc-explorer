-- Per-MRC fee (halford), deducted from the claimant's research subsidy
-- before payout. The block-level foundation/staker split of these fees
-- lives on claims.mrc_foundation_fees / mrc_staker_fees. NULL on rows
-- indexed before this column existed — readers (block flow view) fall
-- back to beacon-address matching for those.
ALTER TABLE claim_mrcs ADD COLUMN IF NOT EXISTS fee UBIGINT;
