import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { ch } from '../../lib/ch';
import { log } from '../../lib/log';
import { enqueueMeiliBatch, MeiliEnvelope } from '../../lib/meili';
import { loadNameDenylist } from '../../lib/boincDenylist';

// Nightly import of BOINC project user-stats. For each whitelisted
// project, we fetch `<base_url>/stats/user.gz`, stream-decompress,
// parse the `<user>...</user>` blocks, and upsert into
// `project_users`. CPIDs that also exist in our `beacons` table
// (i.e. attested to Gridcoin) get enqueued onto Meili's `cpid_names`
// index so global search resolves usernames to CPIDs.
//
// The user.gz file is the standard BOINC export every project runs
// nightly (see boinc.berkeley.edu/trac/wiki/UserData). Format is a
// flat repeating XML shape with no nesting beyond `<user>`, no CDATA,
// and HTML-escaped text. A streaming chunk-and-regex parser is fine —
// pulling sax just for this would dwarf the parse cost itself.
//
// Memory: large projects (WCG, Einstein) publish ~700k users. We flush
// to ClickHouse every BATCH_SIZE users so we never hold more than one
// batch in memory at a time, regardless of project size.

const REIMPORT_MIN_AGE_SECONDS = 20 * 3600; // ~20h: skip projects we already pulled today.
const BODY_TIMEOUT_MS = 10 * 60_000;
const BATCH_SIZE = 5_000;
const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB sanity ceiling.

interface WhitelistedProject {
  name: string;
  baseUrl: string;
}

interface ParsedUser {
  cpid: string;
  user_id: number;
  name: string;
  country: string;
  total_credit: number;
  expavg_credit: number;
  create_time: number;
}

interface ImportStatus {
  project_name: string;
  last_success_at: string | null;
}

export interface BoincImportOptions {
  /** Skip the per-project ~20h re-import cooldown. */
  force?: boolean;
  /** Restrict to projects whose name contains this substring (case-insensitive). */
  projectFilter?: string | null;
}

export class BoincStatsImportJob {
  private seq = Date.now();

  private readonly force: boolean;

  private readonly projectFilter: string | null;

  constructor(opts: BoincImportOptions = {}) {
    this.force = Boolean(opts.force);
    this.projectFilter = opts.projectFilter
      ? opts.projectFilter.trim().toLowerCase() || null
      : null;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  async tick(): Promise<void> {
    try {
      let projects = await this.loadWhitelist();
      if (this.projectFilter) {
        const needle = this.projectFilter;
        projects = projects.filter((p) => p.name.toLowerCase().includes(needle));
      }
      if (projects.length === 0) {
        // Indexer hasn't crossed any project ADD events yet, or the
        // --project filter matched nothing. Both are normal cases.
        return;
      }
      const statuses = await this.loadStatuses();
      const denyCpids = await loadNameDenylist();
      const beaconCpids = await this.loadBeaconCpids();

      const nowSec = Math.floor(Date.now() / 1000);
      for (const project of projects) {
        const status = statuses.get(project.name);
        const lastSec = status?.last_success_at
          ? Math.floor(new Date(status.last_success_at).getTime() / 1000)
          : 0;
        if (!this.force && nowSec - lastSec < REIMPORT_MIN_AGE_SECONDS) continue;

        try {
          // eslint-disable-next-line no-await-in-loop
          const userCount = await this.importProject(project, denyCpids, beaconCpids);
          // eslint-disable-next-line no-await-in-loop
          await this.recordStatus(project.name, 'ok', userCount, '');
          log.info(`BoincStatsImportJob: imported ${userCount} users from ${project.name}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-await-in-loop
          await this.recordStatus(project.name, 'error', 0, msg);
          log.warn(`BoincStatsImportJob: ${project.name} import failed: ${msg}`);
        }
      }
    } catch (err) {
      log.warn('BoincStatsImportJob.tick failed', err);
    }
  }

  private async loadWhitelist(): Promise<WhitelistedProject[]> {
    // Active projects only: take the latest action per project_name
    // and keep `add`. Mirrors the projection in routes/projects.ts.
    const result = await ch.query({
      query: `
        SELECT project_name, latest_action, latest_url FROM (
          SELECT
            project_name,
            argMax(action, block_height)   AS latest_action,
            argMax(base_url, block_height) AS latest_url
          FROM project_contracts FINAL
          GROUP BY project_name
        )
        WHERE latest_action = 'add'
      `,
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ project_name: string; latest_action: string; latest_url: string }>();
    return rows
      .filter((r) => r.latest_url && /^https?:\/\//.test(r.latest_url))
      .map((r) => ({ name: r.project_name, baseUrl: r.latest_url.replace(/\/+$/, '') }));
  }

  private async loadStatuses(): Promise<Map<string, ImportStatus>> {
    const result = await ch.query({
      query: `
        SELECT project_name, toString(last_success_at) AS last_success_at
        FROM project_user_imports FINAL
      `,
      format: 'JSONEachRow',
    });
    const rows = await result.json<ImportStatus>();
    return new Map(rows.map((r) => [r.project_name, r]));
  }

  private async loadBeaconCpids(): Promise<Set<string>> {
    // Every CPID we've ever indexed a beacon for — the universe of
    // CPIDs that could plausibly need a display name surfaced. Limits
    // Meili enqueues to ~50k rows instead of millions.
    const result = await ch.query({
      query: 'SELECT DISTINCT cpid FROM beacons FINAL',
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ cpid: string }>();
    const set = new Set<string>();
    for (const r of rows) if (r.cpid) set.add(r.cpid);
    return set;
  }

  private async importProject(
    project: WhitelistedProject,
    denyCpids: Set<string>,
    beaconCpids: Set<string>,
  ): Promise<number> {
    const url = `${project.baseUrl}/stats/user.gz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'gridcoin-explorer/1 (+https://explorer.gridcoin.club)' },
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new Error(`HTTP ${res.status} from ${url}`);
    }

    const gunzip = createGunzip();
    const upstream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    upstream.pipe(gunzip);

    let buffer = '';
    let decompressedBytes = 0;
    let batch: ParsedUser[] = [];
    let meiliBatch: MeiliEnvelope[] = [];
    let totalUsers = 0;
    const seq0 = this.nextSeq();

    const flushDb = async () => {
      if (batch.length === 0) return;
      const rows = batch.map((u, i) => ({
        cpid: u.cpid,
        project_name: project.name,
        user_id: u.user_id,
        // Empty / explicitly anonymised names persist as empty; the
        // frontend renders that as "Anonymous". Storing the empty
        // string (not NULL) keeps the column small and lets queries
        // use `name != ''` without nullability gymnastics.
        name: denyCpids.has(u.cpid) ? '' : u.name,
        country: u.country,
        total_credit: u.total_credit,
        expavg_credit: u.expavg_credit,
        create_time: u.create_time,
        _seq: seq0 + i,
      }));
      await ch.insert({ table: 'project_users', format: 'JSONEachRow', values: rows });
      batch = [];
    };

    const flushMeili = async () => {
      if (meiliBatch.length === 0) return;
      await enqueueMeiliBatch(meiliBatch);
      meiliBatch = [];
    };

    try {
      for await (const chunk of gunzip as AsyncIterable<Buffer>) {
        decompressedBytes += chunk.length;
        if (decompressedBytes > MAX_DECOMPRESSED_BYTES) {
          throw new Error(`exceeded MAX_DECOMPRESSED_BYTES (${MAX_DECOMPRESSED_BYTES})`);
        }
        buffer += chunk.toString('utf8');
        let end: number;
        // Pull out every complete <user>...</user> block in the
        // buffer. The remainder stays for the next chunk.
        // eslint-disable-next-line no-cond-assign
        while ((end = buffer.indexOf('</user>')) !== -1) {
          const start = buffer.indexOf('<user>', 0);
          if (start === -1 || start > end) {
            // No opening tag before the close — skip past the close
            // to avoid an infinite loop on malformed input.
            buffer = buffer.slice(end + '</user>'.length);
            // eslint-disable-next-line no-continue
            continue;
          }
          const block = buffer.slice(start + '<user>'.length, end);
          buffer = buffer.slice(end + '</user>'.length);
          const user = parseUserBlock(block);
          if (!user) continue;
          totalUsers += 1;
          batch.push(user);
          // Only on-chain CPIDs reach Meili. Anonymous / empty names
          // are skipped because there's nothing to search by.
          if (user.name && !denyCpids.has(user.cpid) && beaconCpids.has(user.cpid)) {
            meiliBatch.push({
              index: 'cpid_names',
              action: 'upsert',
              doc: {
                id: `${user.cpid}:${project.name}`,
                cpid: user.cpid,
                project_name: project.name,
                name: user.name,
                total_credit: user.total_credit,
              },
            });
          }
          if (batch.length >= BATCH_SIZE) {
            await flushDb();
          }
          if (meiliBatch.length >= 500) {
            await flushMeili();
          }
        }
      }
      await flushDb();
      await flushMeili();
    } finally {
      clearTimeout(timer);
      // Drain any remaining body so the connection can be reused.
      upstream.destroy();
    }
    return totalUsers;
  }

  private async recordStatus(
    projectName: string,
    status: 'ok' | 'error',
    userCount: number,
    error: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const lastSuccess = status === 'ok' ? now : null;
    // We update last_success_at only on success — preserves the
    // previous value when the row is upserted. Fetch the prior value
    // first since ReplacingMergeTree overwrites the whole row.
    let prevSuccess: string | null = null;
    if (lastSuccess === null) {
      const r = await ch.query({
        query: `
          SELECT toString(last_success_at) AS last_success_at
          FROM project_user_imports FINAL
          WHERE project_name = {n: String} LIMIT 1
        `,
        query_params: { n: projectName },
        format: 'JSONEachRow',
      });
      const rows = await r.json<{ last_success_at: string }>();
      prevSuccess = rows[0]?.last_success_at ?? null;
    }
    await ch.insert({
      table: 'project_user_imports',
      format: 'JSONEachRow',
      values: [{
        project_name: projectName,
        last_attempted_at: now,
        last_success_at: lastSuccess ?? prevSuccess ?? '1970-01-01 00:00:00.000',
        user_count: userCount,
        last_status: status,
        last_error: error,
        _seq: this.nextSeq(),
      }],
    });
  }
}

// Strip the seven HTML entities BOINC ever emits in user names.
// CDATA is not used in user.gz exports.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function pickTag(block: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = block.indexOf(open);
  if (i === -1) return null;
  const j = block.indexOf(close, i + open.length);
  if (j === -1) return null;
  return block.slice(i + open.length, j);
}

function parseUserBlock(block: string): ParsedUser | null {
  const cpidRaw = pickTag(block, 'cpid');
  if (!cpidRaw) return null;
  const cpid = cpidRaw.trim().toLowerCase();
  // Gridcoin CPIDs are 32-char hex MD5. Anything else is a project
  // bug or a legacy "anonymous" CPID — skip.
  if (!/^[0-9a-f]{32}$/.test(cpid)) return null;

  const idStr = pickTag(block, 'id') ?? '0';
  const id = Number(idStr);
  const name = decodeEntities((pickTag(block, 'name') ?? '').trim());
  const country = (pickTag(block, 'country') ?? '').trim();
  const totalCredit = Number(pickTag(block, 'total_credit') ?? '0');
  const expavgCredit = Number(pickTag(block, 'expavg_credit') ?? '0');
  const createTime = Number(pickTag(block, 'create_time') ?? '0');

  return {
    cpid,
    user_id: Number.isFinite(id) && id >= 0 ? id : 0,
    name,
    country,
    total_credit: Number.isFinite(totalCredit) ? totalCredit : 0,
    expavg_credit: Number.isFinite(expavgCredit) ? expavgCredit : 0,
    create_time: Number.isFinite(createTime) && createTime > 0 && createTime < 4_102_444_800
      ? createTime
      : 0,
  };
}
