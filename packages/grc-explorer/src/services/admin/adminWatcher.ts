import {
  AdminRequest, claimAdminTask, setAdminStatus,
} from '../../lib/adminTask';
import { sleep } from '../../lib/async';
import { clearWipeLock, setWipeLock } from '../../lib/redis';
import { log } from '../../lib/log';
import { rebuildAddressState } from '../../scripts/rebuildAddressState';
import { reindexMeili } from '../../scripts/reindexMeili';
import { runWipe } from '../../scripts/wipeExplorer';
import { AddressClusterJob } from '../jobs/AddressClusterJob';
import { BoincStatsImportJob } from '../jobs/BoincStatsImportJob';

// In-process executor for admin tasks (see lib/adminTask). The explorer
// holds the DuckDB write connection, so these run HERE rather than in a
// separate `npm run …` process that would deadlock on the file lock.
// Polled by a single-flight schedule() in index.ts; one task at a time.

// Let the in-flight backfill batch land before a wipe touches the DB.
// The wipe and the indexer share one DuckDB writer connection (so they
// can't corrupt each other), but pausing avoids re-writing rows mid-wipe.
const WIPE_GRACE_MS = 2500;

async function dispatch(req: AdminRequest): Promise<string> {
  switch (req.kind) {
    case 'wipe': {
      const o = req.opts as { fromHeight?: number | null; includeMempool?: boolean; includeBoinc?: boolean };
      // Re-validate here, not just in the CLI requester: the request
      // arrives over the Redis bus, and fromHeight flows into SQL
      // builders — don't trust the transport.
      const fromHeight = o.fromHeight == null ? null : Number(o.fromHeight);
      if (fromHeight !== null && (!Number.isInteger(fromHeight) || fromHeight < 0)) {
        throw new Error(`wipe: invalid fromHeight ${String(o.fromHeight)}`);
      }
      await runWipe({
        fromHeight,
        includeMempool: Boolean(o.includeMempool),
        includeBoinc: Boolean(o.includeBoinc),
      });
      return fromHeight != null ? `wiped from height ${fromHeight}` : 'full wipe complete';
    }
    case 'boinc-fetch': {
      const o = req.opts as { force?: boolean; project?: string | null };
      await new BoincStatsImportJob({ force: Boolean(o.force), projectFilter: o.project ?? null }).tick();
      return 'boinc user-stats import complete';
    }
    case 'rebuild-wallets': {
      const n = await rebuildAddressState();
      return `rebuilt address_state projection (${n} addresses)`;
    }
    case 'rebuild-clusters': {
      const n = await new AddressClusterJob().fullRebuild();
      return `rebuilt address clusters (${n} clustered addresses)`;
    }
    case 'reindex-meili': {
      const n = await reindexMeili();
      return `queued ${n} Meili envelope(s) for reindex`;
    }
    default: {
      // claimAdminTask already rejected unknown kinds; this is a
      // compile-time exhaustiveness guard, not a runtime path.
      const unreachable: never = req.kind;
      throw new Error(`unknown admin task kind: ${String(unreachable)}`);
    }
  }
}

export async function adminWatcherTick(): Promise<void> {
  const req = await claimAdminTask();
  if (!req) return;

  log.info(`adminWatcher: claimed ${req.kind} (${req.id})`);
  await setAdminStatus({
    id: req.id, kind: req.kind, state: 'running', message: `${req.kind} running`, startedAt: Date.now(),
  });

  // Only a wipe needs the indexer paused (it deletes en masse and we
  // don't want the backfiller re-inserting underneath it). boinc-fetch /
  // rebuild-wallets are ordinary writes that share the writer connection
  // safely, and must NOT set the lock — the backfiller honors it and
  // would also make a self-triggered job abort.
  const needsLock = req.kind === 'wipe';
  if (needsLock) {
    await setWipeLock(600);
    await sleep(WIPE_GRACE_MS);
  }

  try {
    const message = await dispatch(req);
    await setAdminStatus({
      id: req.id, kind: req.kind, state: 'done', message, startedAt: req.requestedAt, endedAt: Date.now(),
    });
    log.info(`adminWatcher: ${req.kind} done — ${message}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setAdminStatus({
      id: req.id, kind: req.kind, state: 'error', message, startedAt: req.requestedAt, endedAt: Date.now(),
    });
    log.error(`adminWatcher: ${req.kind} failed`, err);
  } finally {
    if (needsLock) await clearWipeLock();
  }
}
