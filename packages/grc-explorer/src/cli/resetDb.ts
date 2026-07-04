import { NO_MIGRATIONS } from 'kysely';
import { closeDb } from '../lib/db';
import { makeMigrator } from '../lib/migrate';

// Hard reset of the MariaDB schema — drops every table via the migrations'
// down() (NO_MIGRATIONS migrates all the way back down), then re-applies
// up() to a clean, empty schema. DB-only: it does NOT touch Redis, so pair
// it with `redis-cli FLUSHALL` (drops the indexer cursor + wallet
// projection) when you want a full recrawl from genesis.
//
// Same env shape as `npm run db:migrate` — needs DATABASE_URL; the dummy
// RPC vars in the npm script let the shared config singleton load without
// the wallet RPC the migrator never uses.
async function resetDb(): Promise<void> {
  const migrator = makeMigrator();

  // eslint-disable-next-line no-console
  console.log('dropping all tables (migrating down to NO_MIGRATIONS)…');
  const down = await migrator.migrateTo(NO_MIGRATIONS);
  if (down.error) {
    // eslint-disable-next-line no-console
    console.error('drop failed:', down.error);
    await closeDb();
    process.exit(1);
  }
  down.results?.forEach((r) => {
    // eslint-disable-next-line no-console
    console.log(`  reverted ${r.migrationName} (${r.status})`);
  });

  // eslint-disable-next-line no-console
  console.log('re-applying all migrations…');
  const up = await migrator.migrateToLatest();
  if (up.error) {
    // eslint-disable-next-line no-console
    console.error('migrate failed:', up.error);
    await closeDb();
    process.exit(1);
  }
  up.results?.forEach((r) => {
    // eslint-disable-next-line no-console
    console.log(`  applied ${r.migrationName} (${r.status})`);
  });

  // eslint-disable-next-line no-console
  console.log('done — empty schema is ready.');
  await closeDb();
}

resetDb();
