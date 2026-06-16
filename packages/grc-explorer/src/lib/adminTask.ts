import { redis } from './redis';

// In-process admin-task bus. DuckDB is single-writer: while the explorer
// holds the database file open, a *separate* process (a standalone
// `npm run wipe` / `boinc:fetch` / rebuild script) can't open it — it
// hits "Conflicting lock". So instead of running those out-of-process,
// the operator enqueues a request here and the LIVE explorer (which
// already owns the write connection) executes it in-process via the
// admin watcher. The CLI requester (`scripts/adminRequest.ts`) sets the
// request and tails the status; the watcher (`services/admin/
// adminWatcher.ts`) claims and runs it.
//
// Keys are auto-prefixed by lib/redis's keyPrefix, so both the requester
// and the in-app watcher resolve the same namespaced key.

export const ADMIN_KINDS = ['wipe', 'boinc-fetch', 'rebuild-wallets'] as const;
export type AdminKind = (typeof ADMIN_KINDS)[number];

export interface AdminRequest {
  id: string;
  kind: AdminKind;
  opts: Record<string, unknown>;
  requestedAt: number;
}

export type AdminState = 'running' | 'done' | 'error';

export interface AdminStatus {
  id: string;
  kind: AdminKind;
  state: AdminState;
  message: string;
  startedAt: number;
  endedAt?: number;
}

const REQ_KEY = 'admin:req';
const STATUS_KEY = 'admin:status';

let seq = 0;
function newId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

// Requester side — enqueue a task. Rejects if one is already queued
// (REQ_KEY present) or currently running, so two operators can't stack
// destructive ops. Returns the new task id to tail.
export async function requestAdminTask(
  kind: AdminKind,
  opts: Record<string, unknown>,
): Promise<string> {
  const current = await getAdminStatus();
  if (current?.state === 'running') {
    throw new Error(`an admin task is already running: ${current.kind} (${current.id})`);
  }
  const id = newId();
  const req: AdminRequest = {
    id, kind, opts, requestedAt: Date.now(),
  };
  // NX: don't stomp a request that's queued but not yet claimed.
  const ok = await redis.set(REQ_KEY, JSON.stringify(req), 'NX');
  if (ok !== 'OK') throw new Error('an admin task request is already queued — wait for it to finish');
  return id;
}

// Watcher side — atomically claim the queued request (GETDEL). Returns
// null when nothing is queued. Single watcher (one ROLE=all/indexer
// process), so no multi-claimer race.
export async function claimAdminTask(): Promise<AdminRequest | null> {
  const raw = await redis.getdel(REQ_KEY);
  if (!raw) return null;
  try {
    const req = JSON.parse(raw) as AdminRequest;
    // Validate the untrusted Redis payload here so the dispatcher can
    // trust req.kind is a real AdminKind (no defensive default branch).
    if (!ADMIN_KINDS.includes(req.kind)) return null;
    return req;
  } catch {
    return null;
  }
}

export async function setAdminStatus(status: AdminStatus): Promise<void> {
  await redis.set(STATUS_KEY, JSON.stringify(status));
}

export async function getAdminStatus(): Promise<AdminStatus | null> {
  const raw = await redis.get(STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminStatus;
  } catch {
    return null;
  }
}
