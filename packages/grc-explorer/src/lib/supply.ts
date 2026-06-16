import { query } from './db';

// Current money supply (Halford), for share-of-supply percentages.
// money_supply is a monotonic per-block counter, so max() is a cheap
// read. Shared by the address and CPID combined-balance views.
export async function getMoneySupplyRaw(): Promise<bigint> {
  try {
    const rows = await query<{ s: string | null }>(
      'SELECT CAST(max(money_supply) AS VARCHAR) AS s FROM blocks',
    );
    return BigInt(rows[0]?.s ?? '0');
  } catch {
    return 0n;
  }
}

// part / supply as a percentage with 4 decimal places (e.g. 0.0118).
export function sharePct(part: bigint, supply: bigint): number {
  if (supply <= 0n || part <= 0n) return 0;
  return Number((part * 1_000_000n) / supply) / 10_000;
}
