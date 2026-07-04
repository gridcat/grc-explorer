import { closeDb } from '../lib/db';
import { makeMigrator } from '../lib/migrate';

// CLI migration runner — `npm run db:migrate` (or the prod prestart step).
// Same logic as the boot-time variant but tears the pool down + exits, so
// it never lingers as a writer alongside the app process.
async function migrateToLatest(): Promise<void> {
  const { error, results } = await makeMigrator().migrateToLatest();

  results?.forEach((r) => {
    if (r.status === 'Success') {
      // eslint-disable-next-line no-console
      console.log(`migrated ${r.migrationName}`);
    } else if (r.status === 'Error') {
      // eslint-disable-next-line no-console
      console.error(`failed ${r.migrationName}`);
    }
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('migration failed:', error);
    await closeDb();
    process.exit(1);
  }

  await closeDb();
}

migrateToLatest();
