import type { GetServerSideProps } from 'next';
import { IS_TESTNET } from '../lib/network';
import { originOf, writeText } from '../lib/sitemap';

/**
 * Plain-text robots.txt. SSR so the testnet deployment can serve a
 * deny-all without forking the static file — same pattern as
 * stamp.gridcoin.club.
 */
export default function RobotsTxt() { return null; }

/**
 * Fetchers that pull pages to feed an LLM (training, retrieval or
 * live answer citation). They stay allowed — llms.txt is the cheap
 * path and citations are the point — but on a slower lane than the
 * classic search crawlers.
 *
 * Not listed: Google-Extended and Applebot-Extended. Those tokens
 * only gate AI *training use* of what Googlebot/Applebot already
 * fetched; they crawl nothing themselves, so a crawl-delay on them
 * is meaningless.
 */
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'CCBot',
  'Bytespider',
  'Amazonbot',
  'Applebot',
  'facebookexternalhit',
  'meta-externalagent',
  'Meta-ExternalFetcher',
  'FacebookBot',
  'cohere-ai',
  'Diffbot',
  'omgili',
  'YouBot',
  'Timpibot',
];

// Seconds between requests. Advisory: Googlebot ignores Crawl-delay,
// Bing/Yandex and most of the AI fetchers honour it.
export const CRAWL_DELAY = 10;
export const AI_CRAWL_DELAY = 10;

// Paths every group blocks. A crawler obeys exactly one group — the
// most specific User-agent match — so the AI group has to restate
// these rather than inherit them from `*`.
const SHARED_DISALLOW = [
  '/*?page=',
  '/search',
];

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const origin = originOf(ctx);
  const disallow = SHARED_DISALLOW.map((p) => `Disallow: ${p}`).join('\n');
  const body = IS_TESTNET
    ? `User-agent: *
Disallow: /
`
    : `User-agent: *
Allow: /

# Don't waste crawl budget on paginated archive query strings —
# every block is reachable via /block/<height> in sitemaps/blocks-*.xml,
# and ?page=N pages carry rel=canonical pointing to the unpaginated parent.
# /search is a query-string trap: each distinct ?q= is a live lookup and
# none of it is worth indexing.
${disallow}
Crawl-delay: ${CRAWL_DELAY}

# AI crawlers — allowed, rate-limited harder than the search engines.
${AI_CRAWLERS.map((ua) => `User-agent: ${ua}`).join('\n')}
Allow: /
${disallow}
Crawl-delay: ${AI_CRAWL_DELAY}

Sitemap: ${origin}/sitemap.xml

# LLMs
llms.txt: ${origin}/llms.txt
`;
  writeText(ctx, body);
  return { props: {} };
};
