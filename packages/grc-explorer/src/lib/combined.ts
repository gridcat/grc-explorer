import { getClustersForAddresses } from './cluster';
import { halford2grc } from './halford';
import { getWalletBalances } from './redis';
import { sharePct } from './supply';

export interface Combined {
  combinedBalance: string;
  combinedSharePct: number;
  combinedCount: number;
  // address -> raw balance for every cluster member (a superset of
  // `seed`, since getClustersForAddresses always returns the seed):
  // callers reuse it for per-row display + self share without a
  // second Redis batch.
  balMap: Map<string, bigint>;
}

// Combined balance over the full common-input-ownership cluster of
// `seed`. Shared by the address and CPID profile views. `supply` is
// passed in — callers already fetch it in their request Promise.all.
export async function computeCombined(
  seed: string[],
  supply: bigint,
): Promise<Combined> {
  const members = await getClustersForAddresses(seed);
  const balMap = await getWalletBalances(members);
  let raw = 0n;
  for (const a of members) raw += balMap.get(a) ?? 0n;
  return {
    combinedBalance: halford2grc(raw),
    combinedSharePct: sharePct(raw, supply),
    combinedCount: members.length,
    balMap,
  };
}

// Descending-by-balance comparator over a `computeCombined` balMap.
export function byBalanceDesc(balMap: Map<string, bigint>) {
  return (a: { address: string }, b: { address: string }): number => {
    const x = balMap.get(a.address) ?? 0n;
    const y = balMap.get(b.address) ?? 0n;
    if (x < y) return 1;
    if (x > y) return -1;
    return 0;
  };
}
