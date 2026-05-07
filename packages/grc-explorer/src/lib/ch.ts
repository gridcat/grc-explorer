import { createClient, ClickHouseClient } from '@clickhouse/client';
import { config } from '../config';

// Singleton ClickHouse client. Phase 2+ repositories import `ch` from
// here; the migration runner stays separate (uses native fetch) so it
// can run before npm deps are installed.
//
// Auth: dev runs the default user with empty password. Production
// should set CLICKHOUSE_USER / CLICKHOUSE_PASSWORD env vars and we'll
// thread them through here once the prod compose is updated.
export const ch: ClickHouseClient = createClient({
  url: config.CLICKHOUSE_URL,
  database: config.CLICKHOUSE_DATABASE,
  application: 'grc-explorer',
  // 60 s mirrors RPC_TIMEOUT_MS — pick the same ceiling so a slow CH
  // query and a slow daemon RPC time out at the same boundary.
  request_timeout: 60_000,
});
