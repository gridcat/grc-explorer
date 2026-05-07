// Set required env vars before any module under test reads `config`.
// Without these, config.ts throws at import time, which causes vitest
// to fail collection rather than running tests.
process.env.NODE_ENV = 'testing';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'mysql://test:test@localhost:3306/grc_explorer_test';
process.env.NETWORK = process.env.NETWORK ?? 'testnet';
process.env.GRC_RPC_HOST = process.env.GRC_RPC_HOST ?? 'localhost';
process.env.GRC_RPC_PORT = process.env.GRC_RPC_PORT ?? '47813';
process.env.PORT = process.env.PORT ?? '7002';
// Required by config.checkConfig since the CH migration. Pure-function
// unit tests don't actually open a connection — these defaults just
// satisfy the import-time validation.
process.env.CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
process.env.CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? 'grc_explorer_test';
