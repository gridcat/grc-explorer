import { query } from './db';

export interface BlockActivity {
  value_moved: string;
  fee_total: string;
}

// Per-block user activity: sum(total_out) + sum(fee) over the
// non-coinbase / non-coinstake txs of the given block heights, keyed by
// height. Shared by the /blocks list and the date-archive day leaf so
// both report identical Amount/Fees (and distinguish "what users moved"
// from the block's own mint). Cheap: `transactions` is sort-keyed by
// (block_height, index_in_blk), so the ANY-list lookup is a multi-range
// sorted scan over just the page's blocks. Heights with no user txs are
// simply absent from the map (callers default to '0').
export async function blockUserActivity(
  heights: number[],
): Promise<Map<number, BlockActivity>> {
  const map = new Map<number, BlockActivity>();
  if (heights.length === 0) return map;
  const rows = await query<{ block_height: number } & BlockActivity>(
    `
      SELECT
        block_height,
        CAST(sum(total_out) AS VARCHAR) AS value_moved,
        CAST(sum(fee) AS VARCHAR)       AS fee_total
      FROM transactions
      WHERE block_height = ANY($heights)
        AND NOT is_coinbase AND NOT is_coinstake
      GROUP BY block_height
    `,
    { heights },
  );
  for (const r of rows) {
    map.set(r.block_height, { value_moved: r.value_moved, fee_total: r.fee_total });
  }
  return map;
}
