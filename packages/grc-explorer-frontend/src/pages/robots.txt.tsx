import type { GetServerSideProps } from 'next';
import { IS_TESTNET } from '../lib/network';
import { originOf, writeText } from '../lib/sitemap';

/**
 * Plain-text robots.txt. SSR so the testnet deployment can serve a
 * deny-all without forking the static file — same pattern as
 * stamp.gridcoin.club.
 */
export default function RobotsTxt() { return null; }

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const origin = originOf(ctx);
  const body = IS_TESTNET
    ? `User-agent: *
Disallow: /
`
    : `User-agent: *
Allow: /

# Don't waste crawl budget on paginated archive query strings —
# every block is reachable via /block/<height> in sitemaps/blocks-*.xml,
# and ?page=N pages carry rel=canonical pointing to the unpaginated parent.
Disallow: /*?page=

Sitemap: ${origin}/sitemap.xml

# LLMs
llms.txt: ${origin}/llms.txt
`;
  writeText(ctx, body);
  return { props: {} };
};
