// Request an in-process admin task from the LIVE explorer and tail it.
//
// Long-running maintenance (wipe / boinc:fetch / rebuild) is best run
// on the live explorer's own connections rather than as a competing
// standalone process. Use this while the explorer is UP — it enqueues
// the task on Redis and the in-app admin watcher runs it in-process.
// (If the explorer is DOWN, run the standalone scripts directly — they
// open the unlocked file themselves.)
//
// Usage:
//   npm run admin -- wipe [--from-height N] [--include-mempool] [--include-boinc]
//   npm run admin -- boinc-fetch [--force] [--project NAME]
//   npm run admin -- rebuild-wallets
//   npm run admin -- --help

import { config } from '../config';
import { closeRedis } from '../lib/redis';
import { sleep } from '../lib/async';
import {
  ADMIN_KINDS, AdminKind, getAdminStatus, requestAdminTask,
} from '../lib/adminTask';

// How long to wait for the watcher to CLAIM the task (proves a live
// indexer/ROLE=all process is polling). The task itself may then run for
// minutes — that's the second, longer wait.
const CLAIM_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 60 * 60_000;
const POLL_MS = 1500;

function printHelp(): void {
  console.log(`Usage: npm run admin -- <task> [options]   (network=${config.NETWORK})

Enqueues an admin task for the running explorer and tails it. Run the
explorer's container while this works; for an app-DOWN operation use the
standalone scripts (npm run wipe / boinc:fetch) instead.

Tasks:
  wipe [--from-height N] [--include-mempool] [--include-boinc]
                         Full wipe (empties chain tables; replay from
                         genesis) or partial rewind to N-1.
  boinc-fetch [--force] [--project NAME]
                         Run the BOINC user-stats import now.
  rebuild-wallets        Rebuild the address_state projection from
                         address_balance_history.
  rebuild-clusters       Full address-cluster rebuild (repairs stale
                         over-merges the incremental path can't undo).
  reindex-meili          Re-emit the fuzzy-search corpora (superblocks,
                         polls, beacons, messages) from MariaDB into the
                         Meili queue. Run after a physical DB restore.
  -h, --help             Show this message.`);
}

function buildOpts(kind: AdminKind, argv: string[]): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eat = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    if (kind === 'wipe' && (arg === '--from-height' || arg === '--from')) {
      opts.fromHeight = Number(eat());
    } else if (kind === 'wipe' && (arg.startsWith('--from-height=') || arg.startsWith('--from='))) {
      opts.fromHeight = Number(arg.split('=', 2)[1]);
    } else if (kind === 'wipe' && arg === '--include-mempool') {
      opts.includeMempool = true;
    } else if (kind === 'wipe' && arg === '--include-boinc') {
      opts.includeBoinc = true;
    } else if (kind === 'boinc-fetch' && arg === '--force') {
      opts.force = true;
    } else if (kind === 'boinc-fetch' && arg === '--project') {
      opts.project = eat();
    } else if (kind === 'boinc-fetch' && arg.startsWith('--project=')) {
      [, opts.project] = arg.split('=', 2);
    } else {
      throw new Error(`Unknown/invalid argument for ${kind}: ${arg} (try --help)`);
    }
  }
  if (kind === 'wipe' && opts.fromHeight !== undefined) {
    const n = opts.fromHeight as number;
    if (!Number.isInteger(n) || n < 0) throw new Error(`--from-height expects a non-negative integer, got "${n}"`);
  }
  return opts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    printHelp();
    return;
  }
  const kind = argv[0] as AdminKind;
  if (!ADMIN_KINDS.includes(kind)) throw new Error(`Unknown task "${argv[0]}" (expected one of: ${ADMIN_KINDS.join(', ')})`);
  const opts = buildOpts(kind, argv.slice(1));

  const id = await requestAdminTask(kind, opts);
  console.log(`→ queued ${kind} (${id}); waiting for the explorer to pick it up…`);

  // One poll loop with two deadlines: the watcher must CLAIM within
  // CLAIM_TIMEOUT (proves a live explorer is polling), then the task
  // itself runs to completion within the longer RUN_TIMEOUT.
  const start = Date.now();
  let claimed = false;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const s = await getAdminStatus();
    if (s?.id === id) {
      if (!claimed) { claimed = true; console.log(`→ ${kind} claimed; running…`); }
      if (s.state === 'done') { console.log(`✓ ${kind}: ${s.message}`); return; }
      if (s.state === 'error') throw new Error(`${kind} failed: ${s.message}`);
    }
    const waited = Date.now() - start;
    if (!claimed && waited >= CLAIM_TIMEOUT_MS) {
      throw new Error(
        'no admin watcher claimed the task within 30s — is the explorer (ROLE=all/indexer) running? '
        + 'For an app-down operation, stop the explorer and run the standalone script directly.',
      );
    }
    if (waited >= RUN_TIMEOUT_MS) throw new Error(`${kind} did not finish within ${RUN_TIMEOUT_MS / 60000} min — check explorer logs`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closeRedis);
