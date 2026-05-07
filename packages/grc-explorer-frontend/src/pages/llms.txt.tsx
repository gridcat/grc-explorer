import type { GetServerSideProps } from 'next';
import { originOf, writeText } from '../lib/sitemap';
import { IS_TESTNET } from '../lib/network';

// /llms.txt — plain-text summary for LLMs / AEO per https://llmstxt.org/.
// Mainnet only: testnet is noindex/nofollow, so an llms.txt on testnet
// would be wasted bytes. The route returns 404 there.

function buildContent(origin: string): string {
  const networkLabel = 'Gridcoin';
  const summary = 'Block explorer for the Gridcoin mainnet. Browse every block, transaction, beacon, researcher claim, poll, and superblock streamed in real time. Built for the Gridcoin community: BOINC researchers, node operators, and developers.';

  const lines: string[] = [];
  lines.push(`# ${networkLabel} Explorer`);
  lines.push('');
  lines.push(`> ${summary}`);
  lines.push('');
  lines.push(
    'The explorer is a CQRS-style read model: the indexer streams every block from a Gridcoin node into ClickHouse (source of truth) with a thin Redis layer for O(1) point lookups. Every page is server-rendered against the indexer cursor, so what you read is always the chain state the indexer has actually committed.',
  );
  lines.push('');

  lines.push('## Browse the chain');
  lines.push('');
  lines.push(`- [Home](${origin}/): live network stats and the latest blocks`);
  lines.push(`- [Blocks](${origin}/blocks): paginated block list with date-archive drill-down`);
  lines.push(`- [Block detail](${origin}/block/<height-or-hash>): per-block transactions, claim, magnitude, beacon ack`);
  lines.push(`- [Mempool](${origin}/mempool): unconfirmed transactions currently waiting to be mined`);
  lines.push(`- [Network](${origin}/network): node version distribution, difficulty, supply, indexer cursor`);
  lines.push('');

  lines.push('## Research network');
  lines.push('');
  lines.push(`- [CPIDs](${origin}/cpids): every BOINC researcher seen on chain, with claim history`);
  lines.push(`- [Beacons](${origin}/beacons): beacon directory — active and expired researcher beacons`);
  lines.push(`- [Projects](${origin}/projects): whitelisted BOINC projects and their on-chain status`);
  lines.push(`- [Polls](${origin}/polls): governance polls, contracts, and vote tallies`);
  lines.push('');

  lines.push('## Search & history');
  lines.push('');
  lines.push(`- [Search](${origin}/search): jump to a block, transaction, address, CPID, or beacon`);
  lines.push(`- [Addresses](${origin}/addresses): address detail with balance and full transaction history`);
  lines.push(`- [History archive](${origin}/history): browse the chain by year and month`);
  lines.push('');

  lines.push('## Pages');
  lines.push('');
  lines.push(`- [Developers](${origin}/developers): API and integration notes`);
  lines.push(`- [Disclaimer](${origin}/disclaimer): legal small-print`);
  lines.push('');

  lines.push('## Optional');
  lines.push('');
  lines.push(`- [Sitemap](${origin}/sitemap.xml): three-tier sitemap index — static, archive, and per-block chunks`);
  lines.push(
    '- [Gridcoin Research source](https://github.com/gridcoin-community/Gridcoin-Research): authoritative reference for chain protocol details',
  );
  lines.push('');

  return lines.join('\n');
}

export default function LlmsTxt() { return null; }

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  if (IS_TESTNET) return { notFound: true };
  writeText(ctx, buildContent(originOf(ctx)), 86400);
  return { props: {} };
};
