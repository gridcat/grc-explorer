import type { GetServerSideProps } from 'next';
import { IS_TESTNET } from '../../lib/network';
import { originOf, urlsetXml, writeXml } from '../../lib/sitemap';

/**
 * Top-level pages. Hand-curated so we don't ship URLs for routes that
 * aren't user-facing (API endpoints, sitemap files themselves, the
 * developer docs sub-pages, etc.). Priority/changefreq tuned for an
 * explorer — landing + history are high-traffic, the rest moderate.
 */
export default function StaticSitemap() { return null; }

const PAGES: Array<{ path: string; priority: number; changefreq: 'daily' | 'weekly' | 'monthly' }> = [
  { path: '/',             priority: 1.0, changefreq: 'daily' },
  { path: '/blocks',       priority: 0.9, changefreq: 'daily' },
  { path: '/history',      priority: 0.9, changefreq: 'weekly' },
  { path: '/wallets',      priority: 0.7, changefreq: 'daily' },
  { path: '/superblocks',  priority: 0.7, changefreq: 'daily' },
  { path: '/beacons',      priority: 0.6, changefreq: 'weekly' },
  { path: '/polls',        priority: 0.6, changefreq: 'weekly' },
  { path: '/mempool',      priority: 0.5, changefreq: 'daily' },
  { path: '/developers',   priority: 0.5, changefreq: 'monthly' },
];

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  if (IS_TESTNET) return { notFound: true };
  const origin = originOf(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const entries = PAGES.map((p) => ({
    loc: `${origin}${p.path}`,
    lastmod: today,
    changefreq: p.changefreq,
    priority: p.priority,
  }));
  writeXml(ctx, urlsetXml(entries));
  return { props: {} };
};
