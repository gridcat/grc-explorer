// Lifecycle of an MRC request as observed by the explorer:
//   confirmed — staker bundled the payout (`block_height` set)
//   evicted   — never confirmed, the mempool tx fell out of the network
//   pending   — neither; still in mempool waiting for a stake
//
// `block_height` lives on `mrc_requests`, eviction on `mempool_txs`.
// Routes that JOIN both tables call `statusOf` to derive the label
// from whichever signals they have to hand.
export type MrcStatus = 'pending' | 'confirmed' | 'evicted';

export function statusOf(input: {
  blockHeight: number | null;
  evicted: boolean;
}): MrcStatus {
  if (input.blockHeight !== null) return 'confirmed';
  if (input.evicted) return 'evicted';
  return 'pending';
}

// Wait-time has meaning only when `first_seen` predates `block_time`.
// Historical replay rows and same-second confirmations both surface as
// null so dashboards don't average in 0s for "instant" pseudo-inclusions.
export function waitSecondsOf(input: {
  blockHeight: number | null;
  firstSeen: number;
  blockTime: number | null;
}): number | null {
  if (input.blockHeight === null) return null;
  if (input.blockTime === null) return null;
  if (input.blockTime <= input.firstSeen) return null;
  return input.blockTime - input.firstSeen;
}
