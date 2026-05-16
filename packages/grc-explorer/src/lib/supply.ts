import { ch } from './ch';

// Current money supply (Halford), for share-of-supply percentages.
// No FINAL: money_supply is a monotonic per-block counter, so max()
// is unaffected by un-merged duplicate rows — a cheap PK-edge read.
// Shared by the address and CPID combined-balance views.
export async function getMoneySupplyRaw(): Promise<bigint> {
  try {
    const r = await ch.query({
      query: 'SELECT toString(max(money_supply)) AS s FROM blocks',
      format: 'JSONEachRow',
    });
    return BigInt((await r.json<{ s: string | null }>())[0]?.s ?? '0');
  } catch {
    return 0n;
  }
}

// part / supply as a percentage with 4 decimal places (e.g. 0.0118).
export function sharePct(part: bigint, supply: bigint): number {
  if (supply <= 0n || part <= 0n) return 0;
  return Number((part * 1_000_000n) / supply) / 10_000;
}
