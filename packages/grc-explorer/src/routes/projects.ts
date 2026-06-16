import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { ErrorModel } from '../lib/errors';
import { liveRpc } from '../lib/gridcoin';
import { log } from '../lib/log';
import { getCursor } from '../lib/redis';
import { param, parseYearRange } from '../lib/req';
import { normalizeProjectName } from '../lib/projectName';
import { withMeta } from '../lib/responseMeta';
import { swrCached } from '../lib/swrCache';
import { forkHeight } from '../services/network/ChainForks';

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
// Cache key is the cursor height: same height → same answer. The board
// only refreshes when the indexer advances, which is what we want.

const SNAPSHOT_TTL_MS = 30_000;

interface ProjectEntry {
  /** Verbatim project name from the chain contract body. */
  name: string;
  /** Daemon's prettified `display_name` when available (Title Case
   *  + spaces); falls back to the chain `name`. Only present when
   *  the listprojects overlay below ran successfully. */
  displayName: string;
  /** Base URL from the most recent ADD event for this project. */
  baseUrl: string;
  /** 'Active' | 'Deleted' — derived from latest `project_contracts`
   *  action ≤ cursor. */
  status: 'Active' | 'Deleted';
  /** Block height where the latest add/remove for this project landed. */
  asOfBlock: number;
  /** Chain-time at that latest event. */
  asOfTime: number;
  /** Daemon-overlay fields. Live from listprojects when the indexer
   *  is caught up to the daemon's tip; null when backfilling so the
   *  page stays consistent with what the rest of the explorer shows
   *  at-cursor. The daemon's ProjectToJson strips `m_status` and
   *  `m_gdpr_controls` from contract bodies, so this overlay is the
   *  only way to surface AutoGreylist Override / Auto-greylisted /
   *  Manually Greylisted state. */
  gdprControls: boolean | null;
  requiresExternalAdapter: boolean | null;
  /** Daemon's `project.StatusToString()` — one of "Active",
   *  "Manually Greylisted", "Automatically Greylisted", "Deleted",
   *  "Active by Greylist Override", "Unknown". Null when the
   *  overlay couldn't run (backfill, RPC down). */
  currentChainStatus: string | null;
}

interface ProjectSnapshot {
  cursorHeight: number;
  cursorHash: string;
  cursorTime: number | null;
  active: ProjectEntry[];
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

interface ListProjectEntry {
  displayName: string;
  status: string;
  gdprControls: boolean | null;
  requiresExternalAdapter: boolean | null;
}

// Call the wallet daemon's `listprojects true` RPC and normalise the
// response into a `name → daemon fields` map. The `true` argument
// asks the daemon to include greylisted + deleted entries so we get
// status for every project we know about, not just the active set.
//
// Failure modes (RPC down, timeout, wallet on a different chain)
// degrade to an empty map — buildSnapshot just doesn't overlay the
// optional fields and the page renders the at-cursor derived state.
async function fetchListProjectsOverlay(): Promise<Map<string, ListProjectEntry>> {
  const out = new Map<string, ListProjectEntry>();
  try {
    interface ListProjectsRpcRow {
      version: number;
      displayName?: string;
      display_name?: string;
      baseUrl?: string;
      base_url?: string;
      status?: string;
      gdprControls?: boolean;
      gdpr_controls?: boolean;
      requiresExternalAdapter?: boolean;
      requires_external_adapter?: boolean;
    }
    type ListProjectsRpcResp = Record<string, ListProjectsRpcRow>;
    const raw = await (liveRpc as unknown as {
      listProjects: (showAll: boolean) => Promise<ListProjectsRpcResp>;
    }).listProjects(true);
    if (raw && typeof raw === 'object') {
      // Accept both camelCase (gridcoin-rpc applies camelcase-keys
      // globally) and snake_case (raw daemon output) on every optional
      // boolean — same defensive pattern the beacon parser uses.
      const firstBool = (a: unknown, b: unknown): boolean | null => {
        if (typeof a === 'boolean') return a;
        if (typeof b === 'boolean') return b;
        return null;
      };
      for (const [name, info] of Object.entries(raw)) {
        out.set(name, {
          displayName: info.displayName ?? info.display_name ?? name,
          status: typeof info.status === 'string' ? info.status : 'Unknown',
          gdprControls: firstBool(info.gdprControls, info.gdpr_controls),
          requiresExternalAdapter: firstBool(
            info.requiresExternalAdapter,
            info.requires_external_adapter,
          ),
        });
      }
    }
  } catch (err) {
    log.warn('projects snapshot: listprojects RPC failed; snapshot proceeding without overlay', err);
  }
  return out;
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
    rows = await query<LatestEventRow>(
      `
        -- Group case-INSENSITIVELY: project_contracts stores the name
        -- verbatim as submitted, so the same project recurs under
        -- several casings over time (asteroids@home vs Asteroids@home,
        -- einstein@home vs Einstein@Home, ...). Case-sensitive
        -- grouping split each into separate rows, so a project re-added
        -- under a new casing showed BOTH an Active entry and a phantom
        -- "Deleted" twin from its old casing. Collapse on
        -- lower(project_name); status = the newest action across all
        -- casings; display name = the casing of that newest contract.
        -- Inner alias is canonical_name (NOT project_name): aliasing
        -- the arg_max to project_name would shadow the column, so
        -- GROUP BY lower(project_name) binds to the aggregate. Rename
        -- back in the outer SELECT so consumers and LatestEventRow stay
        -- unchanged.
        SELECT
          canonical_name AS project_name,
          latest_action,
          latest_url,
          at_height,
          at_time
        FROM (
          SELECT
            arg_max(project_name, block_height) AS canonical_name,
            arg_max(action, block_height)       AS latest_action,
            arg_max(base_url, block_height)     AS latest_url,
            max(block_height)                   AS at_height,
            CAST(epoch(arg_max(time, block_height)) AS BIGINT) AS at_time
          FROM project_contracts
          WHERE block_height <= $cursor
          GROUP BY lower(project_name)
        )
      `,
      { cursor: cursorHeight },
    );
  } catch (err) {
    log.warn('projects snapshot: project_contracts query failed', err);
  }

  // Best-effort: read the cursor block's time so the frontend can label
  // the snapshot ("as of block N · 5 May 2020"). Cheap point lookup.
  if (cursorHeight > 0) {
    try {
      const trow = (await query<{ t: number }>(
        'SELECT CAST(epoch(time) AS BIGINT) AS t FROM blocks WHERE height = $h LIMIT 1',
        { h: cursorHeight },
      ))[0];
      if (trow) cursorTime = trow.t;
    } catch (err) {
      log.warn('projects snapshot: cursor-time lookup failed', err);
    }
  }

  // Daemon overlay — fetch listprojects only when the indexer's
  // cursor is in 'live' mode. During backfill we deliberately don't
  // overlay because the daemon's view is at-chain-tip (possibly 3M
  // blocks past our cursor), and applying that to an at-cursor
  // snapshot reintroduces the "live row shows status that the rest
  // of the page can't justify" inconsistency the route fought off
  // earlier. When backfilling, currentChainStatus / gdprControls /
  // requiresExternalAdapter come back null and the frontend simply
  // doesn't show those chips.
  const indexerLive = (cursor?.status ?? 'backfilling') === 'live';
  const overlay = indexerLive ? await fetchListProjectsOverlay() : new Map<string, ListProjectEntry>();

  const active: ProjectEntry[] = [];
  const delisted: ProjectEntry[] = [];

  // The modern binary-contract project whitelist was re-established at
  // the V11 (Fern) fork. A project whose most recent project_contract
  // action predates V11 and was never refreshed afterwards is a stale
  // legacy entry (e.g. the 2015 `grid1`/`grid2`/`rosetta2` bulk-adds at
  // block ~164k) — argMax(action) reads its last 'add' and would
  // wrongly mark it Active even though it is not on the current
  // whitelist (the daemon's listprojects, authoritative when live,
  // doesn't carry these). Require post-Fern contract activity so the
  // count matches reality (real projects were re-added at block 3.1M+).
  const v11Height = forkHeight('v11');
  // Only gate "active" on the post-Fern whitelist once the indexer has
  // actually crossed Fern. Below V11 every latest contract is pre-Fern,
  // so the gate would read "0 whitelisted" during backfill despite real
  // pre-Fern whitelist activity; fall back to plain "latest action = add"
  // until a post-Fern contract is seen. On the full chain (prod) this is
  // always true, so behaviour there is unchanged.
  const reachedFern = v11Height !== null && rows.some((r) => r.at_height >= v11Height);

  for (const r of rows) {
    const isActive = r.latest_action === 'add'
      && (!reachedFern || r.at_height >= v11Height);
    const daemon = overlay.get(r.project_name);
    const entry: ProjectEntry = {
      name: r.project_name,
      displayName: daemon?.displayName ?? r.project_name,
      baseUrl: r.latest_url,
      status: isActive ? 'Active' : 'Deleted',
      asOfBlock: r.at_height,
      asOfTime: r.at_time,
      gdprControls: daemon?.gdprControls ?? null,
      requiresExternalAdapter: daemon?.requiresExternalAdapter ?? null,
      currentChainStatus: daemon?.status ?? null,
    };
    if (isActive) active.push(entry);
    else delisted.push(entry);
  }

  const byName = (a: ProjectEntry, b: ProjectEntry) => a.name.localeCompare(b.name);
  active.sort(byName);
  delisted.sort(byName);

  return {
    cursorHeight,
    cursorHash,
    cursorTime,
    active,
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
            delisted: snap.delisted.length,
            total: snap.active.length + snap.delisted.length,
          },
          active: snap.active,
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

interface ProjectEventRow {
  project_name: string;
  action: string;
  date: string;
  ts: number;
  block_height: number;
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
    events = await query<ProjectEventRow>(`
      SELECT project_name, action, block_height,
             CAST(CAST(time AS DATE) AS VARCHAR) AS date,
             CAST(epoch(time) AS BIGINT)         AS ts
      FROM project_contracts
      ORDER BY time ASC, action ASC
    `);
  } catch (err) {
    log.warn('projects history: project_contracts query failed', err);
    return [];
  }
  if (events.length === 0) return [];

  const firstDate = events[0].date;
  const today = dayKey(new Date());
  const lastDate = today >= firstDate ? today : firstDate;

  // Same normalization as the /projects snapshot, applied to the
  // timeline: collapse case-variant names, and exclude legacy
  // pre-Fern-only projects (the 2015 grid1/grid2/rosetta2 bulk-adds
  // that were never re-added at/after V11 when the modern binary-
  // contract whitelist was re-established). Without this they linger
  // as phantom "active" forever and the case twins double-count.
  const v11Height = forkHeight('v11');
  const maxHeightByLc = new Map<string, number>();
  const canonicalByLc = new Map<string, string>();
  for (const e of events) {
    const lc = e.project_name.toLowerCase();
    if (e.block_height >= (maxHeightByLc.get(lc) ?? -1)) {
      maxHeightByLc.set(lc, e.block_height);
      canonicalByLc.set(lc, e.project_name);
    }
  }
  // The legacy exclusion only makes sense once the indexer has actually
  // crossed Fern. While the backfill is still below V11, EVERY project's
  // latest contract is pre-Fern, so this would flag them all legacy and
  // erase the entire timeline — even though the pre-Fern add/remove
  // history is real and worth showing. Engage the filter only after a
  // post-Fern contract has been indexed (steady state on the full chain).
  const reachedFern = v11Height !== null
    && [...maxHeightByLc.values()].some((h) => h >= v11Height);
  const isLegacy = (lc: string): boolean => reachedFern
    && (maxHeightByLc.get(lc) ?? 0) < v11Height;

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
      evIdx += 1;
      const lc = e.project_name.toLowerCase();
      if (isLegacy(lc)) continue;
      const name = canonicalByLc.get(lc) ?? e.project_name;
      todayEvents.push({ project: name, action: e.action });
      if (e.action === 'add') {
        active.add(lc);
        delisted.delete(lc);
      } else if (e.action === 'remove') {
        if (active.delete(lc)) delistedToday += 1;
        delisted.add(lc);
      }
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

const getHistory = swrCached(buildHistory, HISTORY_TTL_MS);

projectsRouter.get('/history', async (req: Request, res: Response) => {
  const yr = parseYearRange(req, res);
  if (!yr) return;
  const { isYear, year } = yr;

  const all = await getHistory();
  const points = isYear
    ? all.filter((p) => p.date.startsWith(`${year}-`))
    : all;

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'projects_history',
      id: isYear ? `year:${year}` : 'all',
      attributes: {
        range: isYear ? 'year' : 'all',
        year,
        points,
      },
    },
  }));
});

// Per-section query wrapper. Returns an empty array on any error
// and warns; the per-project page is read-only and can render its
// other sections without one of them. Most common cause: an absent
// table immediately after a fresh deploy where migrate.mjs hasn't run
// yet (e.g. 0009 lands but the explorer hasn't restarted).
async function runOrEmpty<T>(
  sql: string,
  params: Record<string, unknown>,
  context: string,
): Promise<T[]> {
  try {
    return await query<T>(sql, params);
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
  // Canonicalised to match the stored key — project_name is written
  // trimmed-lowercase everywhere (see lib/projectName + migration
  // 0035), so an old mixed-case URL still resolves to the one project.
  const name = normalizeProjectName(param(req, 'name'));
  // superblock_projects spells project names in the compact
  // superblock-manifest form (separators stripped: 'tngrid',
  // 'worldcommunitygrid'), while project_contracts and the page URL keep
  // them ('tn-grid'). normalizeProjectName only lowercases, so the two
  // never match for hyphen/underscore names and the RAC chart came up
  // empty. Bridge to the manifest form by stripping space/underscore/hyphen
  // for the superblock lookup only — the contract lookup stays on `name`.
  const sbName = name.replace(/[ _-]+/g, '');
  try {
    const snap = await getSnapshot();
    const status = [...snap.active, ...snap.delisted]
      .find((p) => p.name === name) ?? null;

    // Per-project history pulls from three tables we already index:
    //   • project_contracts: ADD / REMOVE events from chain.
    //   • superblock_projects: every superblock's RAC / total_credit.
    //   • polls (filtered by title) for community-driven listing
    //     proposals — best-effort string-match since Gridcoin doesn't
    //     tag polls with a structured "subject project" field.
    //
    // Each query is independently wrapped: one section's failure
    // (e.g. project_contracts table absent before migration 0009 has
    // been applied) shouldn't blank the whole page. The remaining
    // sections still render.
    const [contracts, samples, polls] = await Promise.all([
      runOrEmpty<ProjectContractRow>(`
        SELECT
          action, base_url, contract_version, tx_id, block_height,
          CAST(epoch(time) AS BIGINT) AS time
        FROM project_contracts
        WHERE project_name = $name
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
          arg_min(rac, superblock_height)         AS rac,
          arg_min(average_rac, superblock_height) AS average_rac,
          arg_min(total_credit, superblock_height) AS total_credit
        FROM superblock_projects
        WHERE lower(regexp_replace(project_name, '[ _-]', '', 'g')) = $sbName
        GROUP BY superblock_height // 256, superblock_height
        ORDER BY superblock_height ASC
      `, { sbName }, 'superblock_projects'),
      // Loose matching: a poll about "asteroids@home" usually puts
      // the project name in the title verbatim. Imperfect but cheap;
      // the table is small (a few thousand polls over chain history).
      runOrEmpty<PollMatchRow>(`
        SELECT poll_id, title, block_height, CAST(epoch(end_time) AS BIGINT) AS end_time
        FROM polls
        WHERE contains(lower(title), $needle)
        ORDER BY block_height ASC
        LIMIT 50
      `, { needle: name.toLowerCase() }, 'polls'),
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
