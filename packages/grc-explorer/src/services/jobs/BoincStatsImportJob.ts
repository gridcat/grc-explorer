import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { ch } from '../../lib/ch';
import { log } from '../../lib/log';
import { nextSeq } from '../../lib/redis';
import { tsToUnix } from '../../lib/time';
import { loadNameDenylist } from '../../lib/boincDenylist';
import { normalizeProjectName } from '../../lib/projectName';

// Nightly import of BOINC project user-stats. For each whitelisted
// project, we fetch `<base_url>/stats/user.gz`, stream-decompress,
// parse the `<user>...</user>` blocks, and upsert into
// `project_users`. The `/cpids/resolve` route queries that CH table
// directly to resolve a typed-in username to its CPID.
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

// Soft-skip: when a project has been failing for this long without a
// successful import, drop it to a backoff retry schedule. Defaults are
// 3 days to enter soft-skip, then retry every 7 days. Both are env-
// tunable so an operator can tighten the loop while diagnosing a
// flaky source.
const SOFT_SKIP_AFTER_SECONDS = parseHours(process.env.BOINC_SOFTSKIP_AFTER_HOURS, 72) * 3600;
const SOFT_SKIP_RETRY_SECONDS = parseHours(process.env.BOINC_SOFTSKIP_RETRY_HOURS, 168) * 3600;

function parseHours(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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
  last_attempted_at: string | null;
  last_status: string;
}

export interface BoincImportOptions {
  /** Skip the per-project ~20h re-import cooldown. */
  force?: boolean;
  /** Restrict to projects whose name contains this substring (case-insensitive). */
  projectFilter?: string | null;
}

export class BoincStatsImportJob {
  private readonly force: boolean;

  private readonly projectFilter: string | null;

  // Per-process set of projects we've already announced as "soft-
  // skipped". Used to ensure the loud warning fires exactly once per
  // transition into soft-skip, instead of every tick. Cleared when the
  // project recovers (success after soft-skip).
  private readonly softSkipLogged = new Set<string>();

  constructor(opts: BoincImportOptions = {}) {
    this.force = Boolean(opts.force);
    this.projectFilter = opts.projectFilter
      ? normalizeProjectName(opts.projectFilter) || null
      : null;
  }

  async tick(): Promise<void> {
    try {
      let projects = await this.loadWhitelist();
      if (this.projectFilter) {
        const needle = this.projectFilter;
        projects = projects.filter((p) => p.name.includes(needle));
      }
      if (projects.length === 0) {
        // Indexer hasn't crossed any project ADD events yet, or the
        // --project filter matched nothing. Both are normal cases.
        return;
      }
      const statuses = await this.loadStatuses();
      const denyCpids = await loadNameDenylist();

      const nowSec = Math.floor(Date.now() / 1000);
      for (const project of projects) {
        const status = statuses.get(project.name);
        const lastSuccessSec = tsToUnix(status?.last_success_at) ?? 0;
        const lastAttemptSec = tsToUnix(status?.last_attempted_at) ?? 0;
        const secondsSinceSuccess = nowSec - lastSuccessSec;
        const secondsSinceAttempt = nowSec - lastAttemptSec;
        const inSoftSkip = status?.last_status === 'error'
          && secondsSinceSuccess > SOFT_SKIP_AFTER_SECONDS;

        if (!this.force) {
          // Cooldown gates on last_ATTEMPTED_at (not last_success_at):
          // last_attempted_at is persisted by recordStatus on EVERY
          // attempt (success or failure), so this is restart-proof —
          // a never-succeeded or failing project is contacted at most
          // once per ~20h no matter how many times the process hot-
          // reloads. Gating on last_success_at meant a project that
          // never succeeded had no cooldown at all and was re-fetched
          // on every boot, hammering BOINC servers (ban risk).
          // Soft-skipped projects keep the slower weekly retry.
          if (inSoftSkip) {
            if (secondsSinceAttempt < SOFT_SKIP_RETRY_SECONDS) continue;
          } else if (secondsSinceAttempt < REIMPORT_MIN_AGE_SECONDS) {
            continue;
          }
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          const userCount = await this.importProject(project, denyCpids);
          // eslint-disable-next-line no-await-in-loop
          await this.recordStatus(project.name, 'ok', userCount, '');
          if (this.softSkipLogged.delete(project.name)) {
            log.info(`BoincStatsImportJob: ${project.name} recovered from soft-skip`);
          }
          log.info(`BoincStatsImportJob: imported ${userCount} users from ${project.name}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-await-in-loop
          await this.recordStatus(project.name, 'error', 0, msg);
          if (inSoftSkip) {
            // Retry attempt during soft-skip failed again — already
            // announced, stay quiet at warn level so logs don't churn.
            log.debug(`BoincStatsImportJob: ${project.name} soft-skip retry still failing: ${msg}`);
          } else if (
            status?.last_status === 'error'
            && secondsSinceSuccess > SOFT_SKIP_AFTER_SECONDS
            && !this.softSkipLogged.has(project.name)
          ) {
            // This failure pushed us across the threshold. Loud one-
            // time announcement, then back off to the retry cadence.
            this.softSkipLogged.add(project.name);
            const days = Math.round(secondsSinceSuccess / 86400);
            const retryDays = Math.round(SOFT_SKIP_RETRY_SECONDS / 86400);
            log.warn(
              `BoincStatsImportJob: ${project.name} moved to soft-skip after `
              + `${days}d without a successful import (last error: ${msg}); `
              + `will retry every ${retryDays}d`,
            );
          } else {
            log.warn(`BoincStatsImportJob: ${project.name} import failed: ${msg}`);
          }
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
      // Strip any trailing `@` and `/` runs. Many on-chain BOINC URLs
      // are stored with a trailing `@` (wallet's legacy separator) —
      // without this, the user.gz URL ends up `<base>/@/stats/user.gz`
      // and 404s on every healthy project.
      .map((r) => ({
        name: normalizeProjectName(r.project_name),
        baseUrl: r.latest_url.replace(/[/@]+$/, ''),
      }));
  }

  private async loadStatuses(): Promise<Map<string, ImportStatus>> {
    const result = await ch.query({
      query: `
        SELECT
          project_name,
          toString(last_success_at)   AS last_success_at,
          toString(last_attempted_at) AS last_attempted_at,
          last_status
        FROM project_user_imports FINAL
      `,
      format: 'JSONEachRow',
    });
    const rows = await result.json<ImportStatus>();
    return new Map(rows.map((r) => [r.project_name, r]));
  }

  private async importProject(
    project: WhitelistedProject,
    denyCpids: Set<string>,
  ): Promise<number> {
    const url = `${project.baseUrl}/stats/user.gz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'gridcoin-explorer/1 (+https://explorer.gridcoin.club)',
          // undici defaults to Accept-Encoding: gzip, deflate and will
          // auto-decompress when the response carries Content-Encoding.
          // Some BOINC projects (mis)configure their servers to set
          // `Content-Encoding: gzip` on `.gz` static assets, so undici
          // strips one gzip layer before we ever see the bytes — our
          // createGunzip() then chokes on raw XML with "incorrect
          // header check". `identity` opts out of HTTP-level encoding
          // and leaves the .gz body untouched.
          'Accept-Encoding': 'identity',
        },
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
    // `pipe()` does not propagate errors from source to destination —
    // an upstream socket abort would leave gunzip waiting forever and
    // our `for await` hangs until BODY_TIMEOUT_MS. Forward errors
    // explicitly so they surface as a thrown error instead.
    upstream.on('error', (err) => gunzip.destroy(err));
    upstream.pipe(gunzip);

    let buffer = '';
    let decompressedBytes = 0;
    let batch: ParsedUser[] = [];
    let totalUsers = 0;

    const flushDb = async () => {
      if (batch.length === 0) return;
      // One _seq per batch — rows in the batch have distinct
      // (cpid, project_name) sort keys so no in-batch collisions are
      // possible against ReplacingMergeTree(_seq). Each subsequent
      // batch picks a higher _seq so re-imports always win the merge.
      const seq = (await nextSeq()).toString();
      const rows = batch.map((u) => ({
        cpid: u.cpid,
        project_name: normalizeProjectName(project.name),
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
        _seq: seq,
      }));
      await ch.insert({ table: 'project_users', format: 'JSONEachRow', values: rows });
      batch = [];
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
          if (batch.length >= BATCH_SIZE) {
            await flushDb();
          }
        }
      }
      await flushDb();
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
    // ClickHouse's JSONEachRow can't parse ISO-8601 with a trailing 'Z'
    // into DateTime64; it expects 'YYYY-MM-DD HH:MM:SS.fff'.
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
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
        project_name: normalizeProjectName(projectName),
        last_attempted_at: now,
        last_success_at: lastSuccess ?? prevSuccess ?? '1970-01-01 00:00:00.000',
        user_count: userCount,
        last_status: status,
        last_error: error,
        _seq: (await nextSeq()).toString(),
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
