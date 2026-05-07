// ClickHouse migration runner. Walks `clickhouse/migrations/*.sql` in
// filename order, applies the ones not yet recorded in the `_migrations`
// table, and records each on success. Idempotent.
//
// Plain ESM JavaScript — uses Node 22+ built-in fetch — so it runs in
// both dev (`predev`) and prod (`prestart` / Dockerfile CMD) without
// ts-node, without a compile step, and without any npm dependency.
//
// Usage: node clickhouse/migrate.mjs
//   env: CLICKHOUSE_URL (default http://localhost:8123)
//        CLICKHOUSE_DATABASE (default grc_explorer_testnet)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const url = (process.env.CLICKHOUSE_URL ?? 'http://localhost:8123').replace(/\/$/, '');
const database = process.env.CLICKHOUSE_DATABASE ?? 'grc_explorer_testnet';
const migrationsDir = path.join(dirname, 'migrations');

// Wait up to ~60 s for ClickHouse to accept connections. Compose's
// `depends_on: condition: service_healthy` already gates this most of
// the time, but the retry loop is the belt to that suspenders — works
// when the runner is invoked outside compose (CI, local shell), and
// survives transient daemon hiccups during long backfill runs.
async function fetchWithRetry(input, init) {
  const maxAttempts = 30;
  const delayMs = 2000;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      const cause = err?.cause?.code ?? err?.cause?.message ?? '';
      console.warn(`fetch failed (attempt ${attempt}/${maxAttempts}): ${cause || err.message}; retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`ClickHouse unreachable at ${url} after ${maxAttempts} attempts: ${lastErr?.message}`);
}

async function runSql(sql, opts = {}) {
  const params = new URLSearchParams();
  if (opts.withDb !== false) params.set('database', database);
  const res = await fetchWithRetry(`${url}/?${params.toString()}`, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickHouse ${res.status}: ${body.trim()}\n--- offending SQL ---\n${sql}`);
  }
}

async function loadApplied() {
  const params = new URLSearchParams({
    database,
    query: 'SELECT name FROM _migrations FORMAT TabSeparated',
  });
  const res = await fetchWithRetry(`${url}/?${params.toString()}`);
  // Table doesn't exist before the first migration runs — treat as empty.
  if (!res.ok) return new Set();
  return new Set((await res.text()).split('\n').filter(Boolean));
}

// Naive split on `;` followed by newline. Our DDL has no inline `;`
// inside string literals or quoted identifiers, and ClickHouse `--`
// line comments are stripped first. If we ever embed stored procedures
// or DDL containing semicolons in literals, swap in a real splitter.
function splitStatements(sql) {
  const stripped = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return stripped
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  // Database may not exist yet on a freshly-mounted volume even if
  // CLICKHOUSE_DB was set — the env var only fires on first server
  // boot, not on volume re-attach.
  await runSql(`CREATE DATABASE IF NOT EXISTS ${database}`, { withDb: false });

  const applied = await loadApplied();
  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    console.log(`apply ${file}`);
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    for (const stmt of splitStatements(sql)) {
      await runSql(stmt);
    }
    // _migrations is created by 0001 itself; by the time this insert
    // fires for 0001, the CREATE TABLE has already succeeded.
    await runSql(`INSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
  }
  console.log('migrations complete');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
