import type { GetServerSideProps } from 'next';
import { api } from '../lib/api';
import { IS_TESTNET } from '../lib/network';
import {
  originOf, sitemapIndexXml, writeXml, URLS_PER_BLOCKS_CHUNK,
} from '../lib/sitemap';

/**
 * Sitemap index — points at the three child sitemaps. Search engines
 * fetch this first; chunking lets us keep every child under the
 * 50k-URL / 50MB limit Google enforces.
 *
 *   /sitemaps/static.xml      top-level pages
 *   /sitemaps/archive.xml     year/month/day URLs
 *   /sitemaps/blocks-N.xml    per-block canonical URLs (50k each)
 *
 * Mainnet only: testnet is noindex/nofollow, no sitemap should be
 * exposed there.
 */
export default function SitemapIndex() { return null; }

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  if (IS_TESTNET) return { notFound: true };
  const origin = originOf(ctx);

  // Probe tip height from the explorer API so we know how many block-
  // sitemap chunks to enumerate. Falls back to a 0-block tip on error
  // — the static + archive children still work, only the block chunks
  // are skipped until the API recovers.
  let tip = 0;
  try {
    const r = await api.get('/network');
    const indexed = r.data?.data?.attributes?.indexed_height;
    if (typeof indexed === 'number') tip = indexed;
  } catch { /* leave at 0 */ }

  const blockChunkCount = tip > 0 ? Math.ceil((tip + 1) / URLS_PER_BLOCKS_CHUNK) : 0;
  const today = new Date().toISOString().slice(0, 10);

  const entries = [
    { loc: `${origin}/sitemaps/static.xml`,  lastmod: today },
    { loc: `${origin}/sitemaps/archive.xml`, lastmod: today },
  ];
  for (let i = 0; i < blockChunkCount; i += 1) {
    entries.push({ loc: `${origin}/sitemaps/blocks-${i}.xml`, lastmod: today });
  }

  writeXml(ctx, sitemapIndexXml(entries));
  return { props: {} };
};
