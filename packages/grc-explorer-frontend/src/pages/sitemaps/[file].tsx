import type { GetServerSideProps } from 'next';
import { api } from '../../lib/api';
import { IS_TESTNET } from '../../lib/network';
import { clientHeaders } from '../../lib/ssr';
import {
  originOf, urlsetXml, writeXml, URLS_PER_BLOCKS_CHUNK,
} from '../../lib/sitemap';

/**
 * Per-block canonical sitemap, served as `/sitemaps/blocks-N.xml` and
 * chunked at 50,000 URLs per file. The route is `[file]` because the
 * pages router only matches whole-segment params: a `blocks-[chunk].xml`
 * filename registers as a literal path and every real chunk URL 404s.
 * static.xml / archive.xml are fixed routes, so they win over this one.
 * Each
 * chunk represents heights `[chunk * URLS_PER_BLOCKS_CHUNK,
 * (chunk + 1) * URLS_PER_BLOCKS_CHUNK)` — heights past the indexer's
 * tip are skipped so search engines never see a /block/<future> URL.
 *
 * Confirmed-deep blocks never change content, so changefreq=never +
 * priority=0.3 (low — these are leaves, not navigation hubs). The
 * actually-fresh URLs (year/month/day archive, /blocks landing) carry
 * the higher priority in the static + archive sitemaps.
 */
export default function BlocksChunkSitemap() { return null; }

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  if (IS_TESTNET) return { notFound: true };
  const origin = originOf(ctx);
  const fileParam = ctx.params?.file;
  const match = typeof fileParam === 'string' ? /^blocks-(\d+)\.xml$/.exec(fileParam) : null;
  if (!match) return { notFound: true };
  const chunk = parseInt(match[1], 10);

  // No catch: a failed tip lookup must surface as a retryable 500, not
  // as a 404 that tells crawlers the chunk is gone.
  const r = await api.get('/network', { headers: clientHeaders(ctx.req) });
  const indexed = r.data?.data?.attributes?.indexed_height;
  const tip = typeof indexed === 'number' ? indexed : 0;

  const start = chunk * URLS_PER_BLOCKS_CHUNK;
  const end = Math.min(start + URLS_PER_BLOCKS_CHUNK - 1, tip);
  if (start > tip) return { notFound: true };

  const entries: Array<{ loc: string; changefreq?: 'never'; priority?: number }> = [];
  for (let h = start; h <= end; h += 1) {
    entries.push({
      loc: `${origin}/block/${h}`,
      changefreq: 'never',
      priority: 0.3,
    });
  }

  writeXml(ctx, urlsetXml(entries));
  return { props: {} };
};
