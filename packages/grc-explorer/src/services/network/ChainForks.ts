import { config } from '../../config';
import { ch } from '../../lib/ch';

/**
 * Canonical Gridcoin consensus-fork table. Mirrors the gates pinned in
 * src/chainparams.cpp (`CMainParams::CMainParams()` / `CTestNetParams::
 * CTestNetParams()`); see `reference_gridcoin_protocol_gates.md` for the
 * full audit-relevance discussion.
 *
 * Each row's `key` is a stable slug used by the frontend route + SEO
 * anchors. `mainnet`/`testnet` are the activation heights from
 * chainparams. `chartLabel` is the short string we render on the
 * difficulty chart's vertical marker; `summary` is the one-liner used
 * on the /protocol reference page and as the marker's tooltip.
 *
 * The block-time for each fork height is resolved at request time
 * from `blocks.time`, so once the indexer has crossed a fork it shows
 * up on the chart without a deploy. Forks the indexer hasn't reached
 * yet (e.g. testnet's V14 boundary if testing a hypothetical) emit
 * `timestamp = null` and are filtered out client-side.
 */
export interface ChainFork {
  key: string;
  /** Activation height on mainnet, or null if the fork never landed
   *  on mainnet. */
  mainnet: number | null;
  /** Activation height on testnet, or null if the fork never landed
   *  on testnet (Halford patches are mainnet-only, for example). */
  testnet: number | null;
  chartLabel: string;
  summary: string;
  category: 'consensus' | 'patch';
}

export const CHAIN_FORKS: ChainFork[] = [
  {
    key: 'halford-reset',
    mainnet: 91387,
    testnet: null,
    chartLabel: 'Halford reset',
    summary: 'Blocks 91,387–91,500 force-reset to PROOF_OF_STAKE_LIMIT — fix for diff stuck at 2065 (R Halford, 2014-12-19)',
    category: 'patch',
  },
  {
    key: 'halford-cap',
    mainnet: 118000,
    testnet: null,
    chartLabel: '900k cap',
    summary: 'Permanent retarget clamp: difficulty > 900,000 snaps back to PROOF_OF_STAKE_LIMIT (R Halford, 2015-01-14)',
    category: 'patch',
  },
  {
    key: 'protocolv2',
    mainnet: 85400,
    testnet: 2060,
    chartLabel: 'PoSv2',
    summary: 'Target spacing changes from 60s to 90s; new kernel rules',
    category: 'consensus',
  },
  {
    key: 'researchage',
    mainnet: 364501,
    testnet: 36501,
    chartLabel: 'ResearchAge',
    summary: 'DPOR research-age accrual model activates; `IsResearchAgeEnabled` returns true',
    category: 'consensus',
  },
  {
    key: 'grandfather',
    mainnet: 1034700,
    testnet: 196550,
    chartLabel: 'nGrandfather',
    summary: 'Above this height, all claim/SB/coinbase-height/reward validation tightens; pre-grandfather blocks bypassed most checks',
    category: 'consensus',
  },
  {
    key: 'v8',
    mainnet: 1010000,
    testnet: 311999,
    chartLabel: 'V8',
    summary: 'Kernel hash switches to V8 (CalculateStakeHashV8); claim subsidy parsed at 8 decimal places',
    category: 'consensus',
  },
  {
    key: 'v9',
    mainnet: 1144000,
    testnet: 399000,
    chartLabel: 'V9',
    summary: 'Tally system V9 activates; `IsV9Enabled` returns true (with a 120-block lag for `IsV9Enabled_Tally`)',
    category: 'consensus',
  },
  {
    key: 'v10',
    mainnet: 1420000,
    testnet: 629409,
    chartLabel: 'V10',
    summary: 'Coinstake recipient-count check enforced; sidestake validation tightens',
    category: 'consensus',
  },
  {
    key: 'v11',
    mainnet: 2053000,
    testnet: 1301500,
    chartLabel: 'V11 (Fern)',
    summary: 'The big binary-contract fork: claim moves from hashBoinc into a coinbase tx contract, all contracts become binary, superblock format changes',
    category: 'consensus',
  },
  {
    key: 'v12',
    mainnet: 2671700,
    testnet: 1871830,
    chartLabel: 'V12',
    summary: 'Stricter timestamp drift (±128s); coinstake `tx.nTime` mask enforced; PollV3 + ProjectV2 + new master pubkey land',
    category: 'consensus',
  },
  {
    key: 'v13',
    mainnet: 3989800,
    testnet: 2870000,
    chartLabel: 'V13',
    summary: 'Magnitude unit exceeds 1/4; MRC 256-bit overflow guard; SuperblockV3 + ProjectV4 + auto-greylist audit + ScraperEntry v2 all activate',
    category: 'consensus',
  },
  {
    key: 'v14',
    mainnet: 3990000,
    testnet: 3126500,
    chartLabel: 'V14',
    summary: 'BIP68 sequence locks enabled for non-coinbase txs; beacon v3 payloads (ownership proofs) accepted',
    category: 'consensus',
  },
];

/**
 * Activation height for one fork on the active network, or null if
 * the fork doesn't apply to this network (Halford patches on testnet,
 * for example). Lets callers reach for one canonical height without
 * each one re-encoding the `config.NETWORK === 'testnet'` switch.
 */
export function forkHeight(key: string): number | null {
  const fork = CHAIN_FORKS.find((f) => f.key === key);
  if (!fork) return null;
  return config.NETWORK === 'testnet' ? fork.testnet : fork.mainnet;
}

/**
 * Per-fork activation status keyed off the indexer's tip height on
 * the active network. Used by the home dashboard to hide V13/V14 UI
 * panels (mandatory sidestakes, v3 beacons, HTLC) until the fork
 * actually lands on chain — so a pre-V13 view doesn't show a row of
 * zeroes or empty cards for functionality that's still pending.
 *
 * Returns one boolean per known consensus fork (v8 through v14).
 * Non-consensus / informational forks are not exposed here.
 */
export function forksActivated(indexedHeight: number | null): Record<string, boolean> {
  const isTestnet = config.NETWORK === 'testnet';
  const heightOf = (f: ChainFork) => (isTestnet ? f.testnet : f.mainnet);
  const out: Record<string, boolean> = {};
  for (const f of CHAIN_FORKS) {
    if (f.category !== 'consensus') continue;
    const h = heightOf(f);
    if (h === null) {
      out[f.key] = false;
      continue;
    }
    out[f.key] = typeof indexedHeight === 'number' && indexedHeight >= h;
  }
  return out;
}

export interface ResolvedFork extends ChainFork {
  /** Activation height on the *current* network only (the one this
   *  indexer is following). Other-network height stripped to keep the
   *  API surface small. */
  height: number;
  /** Block-time of the activation block, UNIX seconds. Null if the
   *  indexer hasn't reached this height yet. */
  timestamp: number | null;
}

/**
 * Resolve every fork's activation block-time against the indexed
 * `blocks` table. Single CH query joining all heights at once — cheap
 * (12 rows) and the result is monotonic so the route layer can cache
 * with a long TTL.
 */
export async function resolveChainForks(): Promise<ResolvedFork[]> {
  const isTestnet = config.NETWORK === 'testnet';
  const heightOf = (f: ChainFork) => (isTestnet ? f.testnet : f.mainnet);
  // Drop forks that don't apply to the active network (e.g. Halford
  // patches on testnet) so the /protocol page and chart markers don't
  // claim activations that never happened.
  const applicable = CHAIN_FORKS.filter((f) => heightOf(f) !== null);
  const heights = Array.from(new Set(applicable.map((f) => heightOf(f) as number)));
  const result = await ch.query({
    query: `
      SELECT height, toUnixTimestamp(time) AS ts
      FROM blocks
      WHERE height IN ({heights: Array(UInt32)})
    `,
    query_params: { heights },
    format: 'JSONEachRow',
  });
  const tsByHeight = new Map<number, number>();
  for (const r of await result.json<{ height: number; ts: number }>()) {
    tsByHeight.set(r.height, r.ts);
  }
  return applicable.map((f) => {
    const height = heightOf(f) as number;
    return {
      ...f,
      height,
      timestamp: tsByHeight.get(height) ?? null,
    };
  });
}
