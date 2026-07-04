import { run } from './db';

// Every table whose rows are derived from a block at a known height,
// paired with the column that carries that height. This is the canonical
// list for height-range deletes — used by reorg rollback
// (ChainReorgHandler) and the partial wipe (scripts/wipeExplorer). Keep
// it in sync with the block-derived tables written by BlockWriter.
//
// `poll_options` is intentionally absent: it has no height column and is
// cascaded through `polls` instead (see deleteChainRowsAtOrAboveHeight).
export const CHAIN_HEIGHT_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'blocks', column: 'height' },
  { table: 'transactions', column: 'block_height' },
  { table: 'tx_outputs', column: 'block_height' },
  { table: 'tx_inputs', column: 'block_height' },
  { table: 'address_balance_history', column: 'valid_from_height' },
  { table: 'address_txs', column: 'block_height' },
  { table: 'tx_messages', column: 'block_height' },
  { table: 'claims', column: 'block_height' },
  { table: 'claim_mrcs', column: 'block_height' },
  { table: 'superblocks', column: 'height' },
  { table: 'superblock_magnitudes', column: 'superblock_height' },
  { table: 'superblock_projects', column: 'superblock_height' },
  { table: 'beacons', column: 'block_height' },
  { table: 'polls', column: 'block_height' },
  { table: 'votes', column: 'block_height' },
  { table: 'project_contracts', column: 'block_height' },
  { table: 'protocol_entries', column: 'block_height' },
  { table: 'mandatory_sidestakes', column: 'block_height' },
  { table: 'coinstake_sidestakes', column: 'block_height' },
  { table: 'mrc_requests', column: 'block_height' },
];

// Delete every chain-derived row at or above `fromHeight`. Used to roll
// back an abandoned chain on reorg (delete the range, then re-apply
// forward) and by the partial wipe. `onTable` is an optional per-table
// progress callback (the wipe script logs through it).
//
// `poll_options` carries no height, so it is cascaded through `polls`
// FIRST — before the polls rows the subquery depends on are deleted.
export async function deleteChainRowsAtOrAboveHeight(
  fromHeight: number,
  onTable?: (table: string) => void,
): Promise<void> {
  await run(
    `DELETE FROM poll_options
       WHERE poll_id IN (SELECT poll_id FROM polls WHERE block_height >= $h)`,
    { h: fromHeight },
  );
  onTable?.('poll_options');

  for (const t of CHAIN_HEIGHT_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    await run(`DELETE FROM ${t.table} WHERE ${t.column} >= $h`, { h: fromHeight });
    onTable?.(t.table);
  }
}
