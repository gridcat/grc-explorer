import type { GetServerSideProps } from 'next';
import { api } from '../../lib/api';
import { IS_TESTNET } from '../../lib/network';
import {
  originOf, urlsetXml, writeXml, URLS_PER_BLOCKS_CHUNK,
} from '../../lib/sitemap';

/**
 * Per-block canonical sitemap, chunked at 50,000 URLs per file. Each
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
  const chunkParam = ctx.params?.chunk;
  const chunk = parseInt(typeof chunkParam === 'string' ? chunkParam : '', 10);
  if (!Number.isInteger(chunk) || chunk < 0) return { notFound: true };

  let tip = 0;
  try {
    const r = await api.get('/network');
    const indexed = r.data?.data?.attributes?.indexed_height;
    if (typeof indexed === 'number') tip = indexed;
  } catch { /* leave at 0 — empty chunk, harmless */ }

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
