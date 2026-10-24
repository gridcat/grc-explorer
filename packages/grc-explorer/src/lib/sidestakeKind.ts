// Mandatory vs voluntary sidestakes. `coinstake_sidestakes` holds every
// extra coinstake output (vout >= 2, minus MRC payouts and stake splits).
// An output is a MANDATORY sidestake when its recipient was in the
// on-chain registry with status MANDATORY at that block's height; every
// other output is a voluntary sidestake the staker configured locally.
//
// Each registry row starts an interval [from_h, next row's height) for
// its address. Intervals don't overlap, so the join matches at most one
// row per payout: `mss.address IS NULL` ⇔ voluntary. Expects the payout
// table aliased `cs`.
export const MSS_INTERVAL_JOIN = `
  LEFT JOIN (
    SELECT address, status,
           block_height AS from_h,
           LEAD(block_height) OVER (PARTITION BY address ORDER BY block_height, tx_id) AS to_h
    FROM mandatory_sidestakes
  ) mss
    ON mss.address = cs.address
   AND mss.status = 'MANDATORY'
   AND cs.block_height >= mss.from_h
   AND (mss.to_h IS NULL OR cs.block_height < mss.to_h)
`;
