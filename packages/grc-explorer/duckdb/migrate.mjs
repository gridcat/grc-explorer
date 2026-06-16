// DuckDB migration runner. Walks `duckdb/migrations/*.sql` in filename
// order, applies the ones not yet recorded in the `_migrations` table,
// and records each on success. Idempotent.
//
// Plain ESM JavaScript, but unlike the old ClickHouse runner it imports
// `@duckdb/node-api` (a native dep), so it must run AFTER `npm install`
// — wired into `db:migrate` / `prestart`. The explorer process opens the
// same file afterwards; migrations run in a separate, earlier invocation
// (prestart exits before start), so there's never a concurrent writer.
//
// Usage: node duckdb/migrate.mjs
//   env: DUCKDB_PATH (required) — on-disk database file

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DUCKDB_PATH;
if (!dbPath) {
  console.error('DUCKDB_PATH must be set as an environment variable');
  process.exit(1);
}
const migrationsDir = path.join(dirname, 'migrations');

// Naive split on `;` followed by newline. Our DDL has no inline `;`
// inside string literals or quoted identifiers, and `--` line comments
// are stripped first. If we ever embed semicolons in literals, swap in
// a real splitter.
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
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();

  await conn.run(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name VARCHAR PRIMARY KEY,
       applied_at TIMESTAMP DEFAULT now()
     )`,
  );

  const appliedReader = await conn.runAndReadAll('SELECT name FROM _migrations');
  const applied = new Set(appliedReader.getRowObjectsJson().map((r) => r.name));

  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    console.log(`apply ${file}`);
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    // Each file is one transaction: a failure mid-file rolls back cleanly
    // and the migration stays unrecorded, so the next run retries it whole.
    await conn.run('BEGIN TRANSACTION');
    try {
      for (const stmt of splitStatements(sql)) {
        await conn.run(stmt);
      }
      await conn.run('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await conn.run('COMMIT');
    } catch (err) {
      await conn.run('ROLLBACK');
      throw err;
    }
  }
  console.log('migrations complete');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
