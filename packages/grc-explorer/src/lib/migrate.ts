import path from 'path';
import { promises as fs } from 'fs';
import { Migrator, FileMigrationProvider } from 'kysely';
import { migratorDb } from './db';
import { log } from './log';

// Single Migrator factory, shared by the boot-time runner and both CLIs
// (cli/migrate, cli/resetDb). The migrationFolder relative path resolves
// the same from dist/lib/ and dist/cli/ (both one level under dist).
export function makeMigrator(): Migrator {
  return new Migrator({
    db: migratorDb(),
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, '..', 'migrations'),
    }),
  });
}

// Boot-time migration runner. Safe to call from the app entrypoint: Kysely
// serialises concurrent runners via kysely_migration_lock, and it does NOT
// destroy the pool — the long-running app keeps using it. Mirrors the
// family pattern (grc-stamp / grcbazaar src/lib/migrate.ts).
export async function migrateToLatest(): Promise<void> {
  const { error, results } = await makeMigrator().migrateToLatest();

  results?.forEach((r) => {
    if (r.status === 'Success') {
      log.info(`[migrate] applied ${r.migrationName}`);
    } else if (r.status === 'Error') {
      log.error(`[migrate] failed ${r.migrationName}`);
    }
  });

  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}
