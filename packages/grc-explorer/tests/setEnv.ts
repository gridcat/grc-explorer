// Set required env vars before any module under test reads `config`.
// Without these, config.ts throws at import time, which causes vitest
// to fail collection rather than running tests.
process.env.NODE_ENV = 'testing';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'mysql://test:test@localhost:3306/grc_explorer_test';
process.env.NETWORK = process.env.NETWORK ?? 'testnet';
process.env.GRC_RPC_HOST = process.env.GRC_RPC_HOST ?? 'localhost';
process.env.GRC_RPC_PORT = process.env.GRC_RPC_PORT ?? '47813';
process.env.PORT = process.env.PORT ?? '7002';
// Required by config.checkConfig. An in-memory DuckDB keeps pure-function
// unit tests from touching disk; tests that need a real DB open their own.
process.env.DUCKDB_PATH = process.env.DUCKDB_PATH ?? ':memory:';
