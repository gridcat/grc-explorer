import { query } from './db';

// Current money supply (Halford), for share-of-supply percentages.
// Shared by the address and CPID combined-balance views (API path).
//
// money_supply is a monotonic per-block counter, so the current supply is
// simply the tip block's value — read via the height PK (ORDER BY height
// DESC LIMIT 1, 0.03 s). The previous `max(money_supply)` had no index on
// money_supply and so full-scanned the ~3.9M-row blocks table (~8.5 s
// warm, ~8 min cold on prod), starving an API reader on every address
// page load.
export async function getMoneySupplyRaw(): Promise<bigint> {
  try {
    const rows = await query<{ s: string | null }>(
      'SELECT CAST(money_supply AS VARCHAR) AS s FROM blocks ORDER BY height DESC LIMIT 1',
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
