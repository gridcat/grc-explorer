import { maintenanceQuery } from '../../lib/db';
import { log } from '../../lib/log';
import { getCursor } from '../../lib/redis';
import {
  buildResearchersHistory,
  buildSeries,
  CHAIN_SERIES_KEY,
  deletePrecomputed,
  HISTORY_KEY,
  PRECOMPUTED_SERIES_LIMIT,
  readPrecomputedHeights,
  writePrecomputed,
  YEAR_SERIES_PREFIX,
  yearRanges,
  yearSeriesKey,
} from '../../lib/researchersHistory';

// Rebuilds the superblock-derived researcher payloads (history, the
// whole-chain top-N series, one top-N series per year) in the background
// and stores them in `precomputed_payloads`, so /researchers/history
// never builds them on a visitor's request.
//
// Each key carries the newest superblock height it reflects. A tick
// compares the stored history's height with MAX(superblocks.height);
// when they differ it reads the history (one ~3k-row rollup read) and
// rewrites only the keys whose height moved: on a new superblock that is the history, the
// chain series and the current year. A reorg or wipe that changes the
// newest superblock rewrites the same way; years that vanished are
// deleted. If a tick reads the rollups mid-rebuild (RollupMaintainer
// deletes then re-inserts on a superblock), it sees the previous
// superblock and writes nothing; the next tick catches up.
//
// Skipped while backfilling: the rollups move every batch, so the
// stored payloads stay at the last live state until the indexer is live.

export class SuperblockPrecomputeJob {
  async tick(): Promise<void> {
    const cursor = await getCursor();
    if (cursor?.status !== 'live') return;

    // Cheap gate (PK read): nothing to do while the stored history
    // already reflects the newest superblock.
    const stored = await readPrecomputedHeights();
    const newest = await maintenanceQuery<{ h: number | null }>('SELECT MAX(height) AS h FROM superblocks');
    if (stored.get(HISTORY_KEY) === Number(newest[0]?.h ?? 0)) return;

    const startedAt = Date.now();
    const history = await buildResearchersHistory();
    const latest = history.length > 0 ? history[history.length - 1].height : 0;
    const rebuilt: string[] = [];

    const write = async (key: string, sourceHeight: number, build: () => Promise<unknown>) => {
      if (stored.get(key) === sourceHeight) return;
      await writePrecomputed(key, sourceHeight, await build());
      rebuilt.push(key);
    };

    await write(HISTORY_KEY, latest, async () => history);
    await write(CHAIN_SERIES_KEY, latest, () => (history.length === 0
      ? Promise.resolve([])
      : buildSeries(0, history[0].height, latest, PRECOMPUTED_SERIES_LIMIT)));

    const years = yearRanges(history);
    for (const [year, { minH, maxH }] of years) {
      // eslint-disable-next-line no-await-in-loop
      await write(yearSeriesKey(year), maxH, () => buildSeries(year, minH, maxH, PRECOMPUTED_SERIES_LIMIT));
    }
    const vanished = [...stored.keys()].filter((k) => k.startsWith(YEAR_SERIES_PREFIX)
      && !years.has(Number(k.slice(YEAR_SERIES_PREFIX.length))));
    await deletePrecomputed(vanished);

    if (rebuilt.length > 0 || vanished.length > 0) {
      log.info(
        `SuperblockPrecomputeJob: superblock ${latest}, rebuilt ${rebuilt.join(', ') || 'nothing'}`
        + `${vanished.length > 0 ? `, deleted ${vanished.join(', ')}` : ''} (${Date.now() - startedAt}ms)`,
      );
    }
  }
}
