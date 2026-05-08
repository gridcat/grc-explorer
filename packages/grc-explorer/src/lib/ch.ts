import { createClient, ClickHouseClient } from '@clickhouse/client';
import { config } from '../config';
import { getRequestSignal } from './requestContext';

// Singleton ClickHouse client. Phase 2+ repositories import `ch` from
// here; the migration runner stays separate (uses native fetch) so it
// can run before npm deps are installed.
//
// Auth: dev runs the default user with empty password. Production
// should set CLICKHOUSE_USER / CLICKHOUSE_PASSWORD env vars and we'll
// thread them through here once the prod compose is updated.
//
// Audit P0 #6: cap open connections and shorten the request timeout
// so a tarpit attacker can't hold the connection pool. Pair with
// per-route `abort_signal: req.signal` (Express 5) so a client
// disconnect cancels the in-flight query rather than letting it run
// to the timeout.
const rawCh: ClickHouseClient = createClient({
  url: config.CLICKHOUSE_URL,
  database: config.CLICKHOUSE_DATABASE,
  application: 'grc-explorer',
  request_timeout: 15_000,
  max_open_connections: 50,
});

// Signal-aware proxy. When a request handler is on the stack the
// AsyncLocalStorage in `requestContext` carries the request's
// AbortSignal; we merge it into every CH call so a client disconnect
// cancels the in-flight query rather than letting it run to the
// 15s timeout. Background workers (indexer, scheduled jobs) run
// without a context — `getRequestSignal` returns undefined, the
// merged params are unchanged, behaviour matches the bare client.
//
// Typed via Pick so the wrapper inherits the underlying generic
// signatures (query<Format>, insert<Shape>, etc.) exactly — tests
// + callers keep their existing type ergonomics.
function withSignal<T extends { abort_signal?: AbortSignal | undefined }>(params: T): T {
  if (params.abort_signal !== undefined) return params;
  const signal = getRequestSignal();
  return signal ? { ...params, abort_signal: signal } : params;
}

type Ch = Pick<ClickHouseClient, 'query' | 'command' | 'insert'>;

export const ch: Ch = {
  query: ((params) => rawCh.query(withSignal(params))) as Ch['query'],
  command: (params) => rawCh.command(withSignal(params)),
  insert: ((params) => rawCh.insert(withSignal(params))) as Ch['insert'],
};
