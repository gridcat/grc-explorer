import type { GetServerSideProps } from 'next';
import { api } from '../../lib/api';
import { IS_TESTNET } from '../../lib/network';
import { originOf, urlsetXml, writeXml } from '../../lib/sitemap';

/**
 * Date archive: every populated year, month, and day URL. Built by
 * walking the per-day MV (one query, ordered ascending) and emitting:
 *
 *   /blocks/YYYY                — once per distinct year (priority 0.8)
 *   /blocks/YYYY/MM             — once per distinct month (priority 0.7)
 *   /blocks/YYYY/MM/DD          — once per day        (priority 0.6)
 *
 * Skips per-day pagination URLs (`?page=N`) — those carry rel=canonical
 * back to page 1 anyway, and shipping them in the sitemap would just
 * waste crawl budget on near-duplicate listings.
 *
 * One CH query, ~5k rows for the whole chain — microsecond-cheap, and
 * since the response is cached for an hour the indexer can chew on
 * MV merges without affecting sitemap latency.
 */
export default function ArchiveSitemap() { return null; }

interface DayRow {
  bucket_date: string;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  if (IS_TESTNET) return { notFound: true };
  const origin = originOf(ctx);
  const entries: Array<{
    loc: string; lastmod?: string; changefreq?: 'daily' | 'weekly' | 'monthly';
    priority?: number;
  }> = [];

  let days: string[] = [];
  try {
    // archive_blocks_daily is the SummingMergeTree MV from migration
    // 0005 — one row per UTC date that has at least one indexed block.
    // We hit the explorer's /blocks/archive/years route to get years,
    // then walk a pseudo-daily set by listing days within each populated
    // month (cheaper than a dedicated /days endpoint and fast enough at
    // this scale).
    const r = await api.get('/blocks/archive/years');
    const years = (r.data?.data ?? []) as Array<{ attributes: { year: number } }>;
    // For each year, walk months and within each month, walk days.
    // Sequential to keep memory + connection count in check; total is
    // at most ~13 years × 12 months ≈ 150 round trips.
    for (const y of years) {
      const yearNum = y.attributes.year;
      // eslint-disable-next-line no-await-in-loop
      const yr = await api.get(`/blocks/archive/${yearNum}`);
      const months = (yr.data?.data?.attributes?.months ?? []) as Array<{ month: number }>;
      for (const m of months) {
        const fmtMonth = String(m.month).padStart(2, '0');
        // eslint-disable-next-line no-await-in-loop
        const mr = await api.get(`/blocks/archive/${yearNum}/${fmtMonth}`).catch(() => null);
        const monthDays = (mr?.data?.data?.attributes?.days ?? []) as Array<{ day: number }>;
        for (const d of monthDays) {
          const fmtDay = String(d.day).padStart(2, '0');
          days.push(`${yearNum}-${fmtMonth}-${fmtDay}`);
        }
      }
    }
  } catch {
    // Empty result is fine — sitemap is just empty until backfill
    // populates the archive aggregates.
    days = [];
  }

  // Group days into a year + month + day URL set, deduplicated.
  const yearsSeen = new Set<string>();
  const monthsSeen = new Set<string>();
  // Newest day in each year/month for accurate lastmod.
  const monthLastmod = new Map<string, string>();
  const yearLastmod = new Map<string, string>();
  for (const iso of days) {
    const [y, m] = iso.split('-');
    yearLastmod.set(y, iso);
    monthLastmod.set(`${y}-${m}`, iso);
  }

  for (const iso of days) {
    const [y, m, d] = iso.split('-');
    if (!yearsSeen.has(y)) {
      yearsSeen.add(y);
      entries.push({
        loc: `${origin}/blocks/${y}`,
        lastmod: yearLastmod.get(y),
        changefreq: 'weekly',
        priority: 0.8,
      });
    }
    const ym = `${y}-${m}`;
    if (!monthsSeen.has(ym)) {
      monthsSeen.add(ym);
      entries.push({
        loc: `${origin}/blocks/${y}/${m}`,
        lastmod: monthLastmod.get(ym),
        changefreq: 'weekly',
        priority: 0.7,
      });
    }
    entries.push({
      loc: `${origin}/blocks/${y}/${m}/${d}`,
      lastmod: iso,
      changefreq: 'monthly',
      priority: 0.6,
    });
  }

  writeXml(ctx, urlsetXml(entries));
  return { props: {} };
};
