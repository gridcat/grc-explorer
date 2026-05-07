import { ch } from './ch';

// Block-time of the indexer's most recent applied block, or 0 when the
// blocks table is empty. Used by routes and jobs that need to anchor
// "what does the dashboard mean by `now`?" on the indexer's progress
// rather than wall-clock — during a deep backfill those diverge by
// years, and showing today's peer count alongside a 2016-era tip would
// mislead the user.
export async function getIndexerTipTime(): Promise<number> {
  const result = await ch.query({
    query: 'SELECT max(time) AS t FROM blocks',
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ t: number | string | null }>();
  const raw = rows[0]?.t;
  if (raw === null || raw === undefined || raw === '' || raw === 0) return 0;
  // CH JSONEachRow returns DateTime as ISO string by default; coerce.
  const n = typeof raw === 'number' ? raw : Math.floor(new Date(raw).getTime() / 1000);
  return Number.isFinite(n) ? n : 0;
}

// If the indexer is more than ~5 minutes behind wall-clock, return its
// tip-time as the anchor; otherwise return wall-clock now. The 5-min
// threshold avoids flicking between modes during normal block cadence.
export async function getTipAnchor(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const tip = await getIndexerTipTime();
  if (tip > 0 && now - tip > 300) return tip;
  return now;
}
