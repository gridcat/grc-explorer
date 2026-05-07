import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { log } from '../lib/log';
import { getCursor } from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';

export const projectsRouter = Router();

// Project state is reconstructed from `project_contracts` at the
// indexer's current cursor height. Earlier iterations of this route
// pulled from the wallet daemon's `listprojects` RPC, but that gave
// the chain-tip view (block 3.16M today) regardless of where the
// explorer's indexer was — which made the Live board dishonest about
// what the rest of the page reflected. Now everything is consistent:
// blocks shown, RAC shown, and project state shown all reflect the
// same chain state at the indexer's cursor.
//
// Greylisted is intentionally NOT computed here yet. Auto-greylist is
// derived state — ZCD ≥ 7 OR red WAS recomputed each superblock from
// `superblock_projects.total_credit` history — that needs the daemon's
// algorithm reimplemented against our indexed data. That's queued as a
// follow-up; for now the column stays empty with a clear placeholder.
//
// Cache key is the cursor height: same height → same answer. The board
// only refreshes when the indexer advances, which is what we want.

const SNAPSHOT_TTL_MS = 30_000;

interface ProjectEntry {
  /** Verbatim project name from the chain contract body. */
  name: string;
  /** Same as `name` for now — daemon's `display_name` was nicer (Title
   *  Case, spaces) but lived only in the RPC view. We can derive
   *  display from the on-chain name later if needed. */
  displayName: string;
  /** Base URL from the most recent ADD event for this project. */
  baseUrl: string;
  /** 'Active' | 'Deleted' — derived from latest `project_contracts`
   *  action ≤ cursor. 'Manually/Automatically Greylisted' will be
   *  filled in when Stage 4 lands. */
  status: 'Active' | 'Deleted' | 'Manually Greylisted' | 'Automatically Greylisted';
  /** Block height where the latest add/remove for this project landed. */
  asOfBlock: number;
  /** Chain-time at that latest event. */
  asOfTime: number;
  // Auto-greylist criteria are null until the algorithm is ported.
  zcd: number | null;
  was: number | null;
  meetsGreylistCriteria: boolean | null;
  // GDPR / requires-external-adapter come only from the daemon's view —
  // the on-chain ProjectToJson body is just `{ version, name, url }`.
  // Null for now; can be enriched separately if a per-project page
  // wants the daemon's current take.
  gdprControls: boolean | null;
  requiresExternalAdapter: boolean | null;
}

interface ProjectSnapshot {
  cursorHeight: number;
  cursorHash: string;
  cursorTime: number | null;
  active: ProjectEntry[];
  greylisted: ProjectEntry[];
  delisted: ProjectEntry[];
  fetchedAt: number;
}

let cached: { value: ProjectSnapshot; expiresAt: number; cursorHeight: number } | null = null;
let inflight: Promise<ProjectSnapshot> | null = null;

interface LatestEventRow {
  project_name: string;
  latest_action: string;
  latest_url: string;
  at_height: number;
  at_time: number;
}

async function buildSnapshot(): Promise<ProjectSnapshot> {
  const cursor = await getCursor();
  const cursorHeight = cursor?.height ?? 0;
  const cursorHash = cursor?.hash ?? '';

  // Latest project_contracts row per project_name, capped at the
  // indexer's cursor. argMax(action, block_height) collapses the per-
  // project history to its most recent state. Capping by cursor makes
  // the result a faithful chain-state-at-cursor snapshot — even if
  // future events have already been parsed (which can happen if the
  // user runs replays), the snapshot stays consistent with the rest
  // of the page.
  let rows: LatestEventRow[] = [];
  let cursorTime: number | null = null;
  try {
    const result = await ch.query({
      query: `
        SELECT
          project_name,
          argMax(action, block_height)   AS latest_action,
          argMax(base_url, block_height) AS latest_url,
          max(block_height)              AS at_height,
          toUnixTimestamp(argMax(time, block_height)) AS at_time
        FROM project_contracts FINAL
        WHERE block_height <= {cursor: UInt32}
        GROUP BY project_name
      `,
      query_params: { cursor: cursorHeight },
      format: 'JSONEachRow',
    });
    rows = await result.json<LatestEventRow>();
  } catch (err) {
    log.warn('projects snapshot: project_contracts query failed', err);
  }

  // Best-effort: read the cursor block's time so the frontend can label
  // the snapshot ("as of block N · 5 May 2020"). Cheap point lookup.
  if (cursorHeight > 0) {
    try {
      const tres = await ch.query({
        query: 'SELECT toUnixTimestamp(time) AS t FROM blocks FINAL WHERE height = {h: UInt32} LIMIT 1',
        query_params: { h: cursorHeight },
        format: 'JSONEachRow',
      });
      const trow = (await tres.json<{ t: number }>())[0];
      if (trow) cursorTime = trow.t;
    } catch (err) {
      log.warn('projects snapshot: cursor-time lookup failed', err);
    }
  }

  const active: ProjectEntry[] = [];
  const delisted: ProjectEntry[] = [];
  const greylisted: ProjectEntry[] = []; // Stage 4 follow-up.

  for (const r of rows) {
    const isActive = r.latest_action === 'add';
    const entry: ProjectEntry = {
      name: r.project_name,
      displayName: r.project_name,
      baseUrl: r.latest_url,
      status: isActive ? 'Active' : 'Deleted',
      asOfBlock: r.at_height,
      asOfTime: r.at_time,
      zcd: null,
      was: null,
      meetsGreylistCriteria: null,
      gdprControls: null,
      requiresExternalAdapter: null,
    };
    if (isActive) active.push(entry);
    else delisted.push(entry);
  }

  const byName = (a: ProjectEntry, b: ProjectEntry) => a.name.localeCompare(b.name);
  active.sort(byName);
  greylisted.sort(byName);
  delisted.sort(byName);

  return {
    cursorHeight,
    cursorHash,
    cursorTime,
    active,
    greylisted,
    delisted,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

async function getSnapshot(): Promise<ProjectSnapshot> {
  const now = Date.now();
  const cursor = await getCursor();
  const cursorHeight = cursor?.height ?? 0;
  // Cache invalidates when (a) it expires OR (b) the cursor advances —
  // a fresh block means new project state to (potentially) reveal.
  if (cached && cached.expiresAt > now && cached.cursorHeight === cursorHeight) {
    return cached.value;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const v = await buildSnapshot();
      cached = {
        value: v,
        expiresAt: Date.now() + SNAPSHOT_TTL_MS,
        cursorHeight: v.cursorHeight,
      };
      return v;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

projectsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const snap = await getSnapshot();
    res.status(StatusCodes.OK).send(withMeta({
      data: {
        type: 'project_status',
        id: `block:${snap.cursorHeight}`,
        attributes: {
          fetchedAt: snap.fetchedAt,
          cursorHeight: snap.cursorHeight,
          cursorHash: snap.cursorHash,
          cursorTime: snap.cursorTime,
          counts: {
            active: snap.active.length,
            greylisted: snap.greylisted.length,
            delisted: snap.delisted.length,
            total: snap.active.length + snap.greylisted.length + snap.delisted.length,
          },
          active: snap.active,
          greylisted: snap.greylisted,
          delisted: snap.delisted,
        },
      },
    }));
  } catch (err) {
    log.warn('GET /projects failed', err);
    res.status(StatusCodes.BAD_GATEWAY).send({
      errors: [new ErrorModel(StatusCodes.BAD_GATEWAY, 'Project snapshot unavailable')],
    });
  }
});

// /history — daily timeline of project counts. Whitelist size and
// cumulative de-listed count over time, plus per-day delisting events
// so the chart can show the "spikes" researchers care about.
//
// Greylisted is intentionally NOT computed here (yet). Auto-greylist
// is a derived per-superblock state — ZCD ≥ 7 OR red WAS — that needs
// the daemon's algorithm reimplemented against `superblock_projects`.
// That's queued as a follow-up; for now the route emits a flat
// greylisted=null and the frontend hides the line.
//
// Caching: the underlying data only changes when backfill rolls over
// a project ADD/REMOVE event (rare; <100 events ever). 1h cache is
// generous and effectively free for the API path.

interface HistoryPoint {
  ts: number;
  date: string;
  active: number;
  delisted: number;
  delistedToday: number;
  events: Array<{ project: string; action: 'add' | 'remove' | string }>;
}

const HISTORY_TTL_MS = 60 * 60 * 1000;
let historyCached: { value: HistoryPoint[]; expiresAt: number } | null = null;
let historyInflight: Promise<HistoryPoint[]> | null = null;

interface ProjectEventRow {
  project_name: string;
  action: string;
  date: string;
  ts: number;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nextDay(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return dayKey(d);
}

function dayToTs(s: string): number {
  return Math.floor(new Date(`${s}T00:00:00Z`).getTime() / 1000);
}

async function buildHistory(): Promise<HistoryPoint[]> {
  // The whole project_contracts table is small (well under 1000 rows
  // even on mainnet over a decade) — pulling it all and computing the
  // timeline in JS is straightforward and cheap.
  let events: ProjectEventRow[] = [];
  try {
    const result = await ch.query({
      query: `
        SELECT project_name, action,
               toString(toDate(time)) AS date,
               toUnixTimestamp(time)  AS ts
        FROM project_contracts FINAL
        ORDER BY time ASC, action ASC
      `,
      format: 'JSONEachRow',
    });
    events = await result.json<ProjectEventRow>();
  } catch (err) {
    log.warn('projects history: project_contracts query failed', err);
    return [];
  }
  if (events.length === 0) return [];

  const firstDate = events[0].date;
  const today = dayKey(new Date());
  const lastDate = today >= firstDate ? today : firstDate;

  const active = new Set<string>();
  const delisted = new Set<string>();
  const points: HistoryPoint[] = [];

  let evIdx = 0;
  let day = firstDate;
  for (let i = 0; i < 20_000 && day <= lastDate; i += 1) {
    let delistedToday = 0;
    const todayEvents: HistoryPoint['events'] = [];
    while (evIdx < events.length && events[evIdx].date === day) {
      const e = events[evIdx];
      todayEvents.push({ project: e.project_name, action: e.action });
      if (e.action === 'add') {
        active.add(e.project_name);
        delisted.delete(e.project_name);
      } else if (e.action === 'remove') {
        if (active.delete(e.project_name)) delistedToday += 1;
        delisted.add(e.project_name);
      }
      evIdx += 1;
    }
    points.push({
      ts: dayToTs(day),
      date: day,
      active: active.size,
      delisted: delisted.size,
      delistedToday,
      events: todayEvents,
    });
    if (day === lastDate) break;
    day = nextDay(day);
  }
  return points;
}

async function getHistory(): Promise<HistoryPoint[]> {
  const now = Date.now();
  if (historyCached && historyCached.expiresAt > now) return historyCached.value;
  if (historyInflight) return historyInflight;
  historyInflight = (async () => {
    try {
      const v = await buildHistory();
      historyCached = { value: v, expiresAt: Date.now() + HISTORY_TTL_MS };
      return v;
    } finally {
      historyInflight = null;
    }
  })();
  return historyInflight;
}

projectsRouter.get('/history', async (req: Request, res: Response) => {
  const range = String(req.query.range ?? 'all').toLowerCase();
  const yearRaw = parseInt(String(req.query.year ?? ''), 10);
  const isYear = range === 'year';
  if (isYear && (!Number.isInteger(yearRaw) || yearRaw < 2000 || yearRaw > 2999)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [{ status: '400', title: 'Bad Request', detail: 'range=year requires year=YYYY' }],
    });
    return;
  }

  const all = await getHistory();
  const points = isYear
    ? all.filter((p) => p.date.startsWith(`${yearRaw}-`))
    : all;

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'projects_history',
      id: isYear ? `year:${yearRaw}` : 'all',
      attributes: {
        range: isYear ? 'year' : 'all',
        year: isYear ? yearRaw : null,
        points,
      },
    },
  }));
});

// Per-section CH query wrapper. Returns an empty array on any error
// and warns; the per-project page is read-only and can render its
// other sections without one of them. Most common cause: an absent
// table immediately after a fresh deploy where migrate.mjs hasn't run
// yet (e.g. 0009 lands but the explorer hasn't restarted).
async function runOrEmpty<T>(
  query: string,
  params: Record<string, unknown>,
  context: string,
): Promise<T[]> {
  try {
    const result = await ch.query({ query, query_params: params, format: 'JSONEachRow' });
    return await result.json<T>();
  } catch (err) {
    log.warn(`projects route: ${context} query failed`, err);
    return [];
  }
}

interface ProjectContractRow {
  action: 'add' | 'remove' | string;
  base_url: string;
  contract_version: number;
  tx_id: string;
  block_height: number;
  time: number;
}

interface SuperblockSampleRow {
  superblock_height: number;
  rac: number;
  average_rac: number;
  total_credit: number;
}

interface PollMatchRow {
  poll_id: string;
  title: string;
  block_height: number;
  end_time: number;
}

projectsRouter.get('/:name', async (req: Request, res: Response) => {
  const name = param(req, 'name');
  try {
    const snap = await getSnapshot();
    const status = [...snap.active, ...snap.greylisted, ...snap.delisted]
      .find((p) => p.name === name) ?? null;

    // Per-project history pulls from three CH tables we already index:
    //   • project_contracts: ADD / REMOVE events from chain.
    //   • superblock_projects: every superblock's RAC / total_credit.
    //   • polls (filtered by title) for community-driven listing /
    //     greylist proposals — best-effort string-match since Gridcoin
    //     doesn't tag polls with a structured "subject project" field.
    //
    // Each query is independently wrapped: one section's CH failure
    // (e.g. project_contracts table absent before migration 0009 has
    // been applied) shouldn't blank the whole page. The remaining
    // sections still render.
    const [contracts, samples, polls] = await Promise.all([
      runOrEmpty<ProjectContractRow>(`
        SELECT
          action, base_url, contract_version, tx_id, block_height,
          toUnixTimestamp(time) AS time
        FROM project_contracts FINAL
        WHERE project_name = {name: String}
        ORDER BY block_height ASC
      `, { name }, 'project_contracts'),
      // Sample one row per ~256 superblocks for the chart so the
      // payload stays under ~1KB regardless of chain age. Full
      // resolution is one row per superblock (~daily); a 4000+
      // superblock chart shipped at full fidelity is wasteful for
      // a sparkline.
      runOrEmpty<SuperblockSampleRow>(`
        SELECT
          superblock_height,
          argMin(rac, superblock_height)         AS rac,
          argMin(average_rac, superblock_height) AS average_rac,
          argMin(total_credit, superblock_height) AS total_credit
        FROM superblock_projects FINAL
        WHERE project_name = {name: String}
        GROUP BY intDiv(superblock_height, 256), superblock_height
        ORDER BY superblock_height ASC
      `, { name }, 'superblock_projects'),
      // Loose matching: a poll about "asteroids@home" usually puts
      // the project name in the title verbatim. Imperfect but cheap;
      // the table is small (a few thousand polls over chain history).
      runOrEmpty<PollMatchRow>(`
        SELECT poll_id, title, block_height, toUnixTimestamp(end_time) AS end_time
        FROM polls FINAL
        WHERE positionCaseInsensitive(title, {needle: String}) > 0
        ORDER BY block_height ASC
        LIMIT 50
      `, { needle: name }, 'polls'),
    ]);

    if (!status && contracts.length === 0 && samples.length === 0) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Project not found')],
      });
      return;
    }

    res.status(StatusCodes.OK).send(withMeta({
      data: {
        type: 'project',
        id: name,
        attributes: {
          name,
          status: status?.status ?? null,
          displayName: status?.displayName ?? name,
          baseUrl: status?.baseUrl ?? contracts[contracts.length - 1]?.base_url ?? null,
          gdprControls: status?.gdprControls ?? null,
          requiresExternalAdapter: status?.requiresExternalAdapter ?? null,
          zcd: status?.zcd ?? null,
          was: status?.was ?? null,
          meetsGreylistCriteria: status?.meetsGreylistCriteria ?? null,
          asOfBlock: status?.asOfBlock ?? null,
          asOfTime: status?.asOfTime ?? null,
          contractEvents: contracts.map((c) => ({
            action: c.action,
            baseUrl: c.base_url,
            contractVersion: c.contract_version,
            txId: c.tx_id,
            blockHeight: c.block_height,
            time: c.time,
          })),
          racHistory: samples.map((s) => ({
            superblockHeight: s.superblock_height,
            rac: s.rac,
            averageRac: s.average_rac,
            totalCredit: s.total_credit,
          })),
          relatedPolls: polls.map((p) => ({
            pollId: p.poll_id,
            title: p.title,
            blockHeight: p.block_height,
            endTime: p.end_time,
          })),
        },
      },
    }));
  } catch (err) {
    log.warn(`GET /projects/${name} failed`, err);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).send({
      errors: [new ErrorModel(StatusCodes.INTERNAL_SERVER_ERROR, 'Project lookup failed')],
    });
  }
});
