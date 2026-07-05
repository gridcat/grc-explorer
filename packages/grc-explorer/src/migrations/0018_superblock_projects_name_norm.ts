import { Kysely, sql } from 'kysely';

// The project detail page (routes/projects.ts) matched a project's RAC
// history with:
//   WHERE lower(REGEXP_REPLACE(project_name, '[ _-]', '')) = $sbName
// The function wrapper on the column made idx_superblock_projects_name
// unusable, so this full-scanned all ~51k rows AND ran the regex per row
// — 0.09 s warm but ~6 s cold on the HDD prod slice, once per project
// page load.
//
// Add a VIRTUAL generated column carrying the normalized name (adds
// INPLACE — no table rebuild, unlike a STORED column which needs COPY),
// then a covering index (project_name_norm, superblock_height, rac,
// average_rac, total_credit). The query switches to `WHERE
// project_name_norm = $sbName` and becomes an index-only range read of
// just that one project's rows. Validated on the replica: full-scan+regex
// -> type=ref, Using index.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE superblock_projects
      ADD COLUMN IF NOT EXISTS project_name_norm VARCHAR(191)
        AS (lower(REGEXP_REPLACE(project_name, '[ _-]', ''))) VIRTUAL,
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
  await sql`
    ALTER TABLE superblock_projects
      ADD INDEX IF NOT EXISTS idx_sbp_name_norm
        (project_name_norm, superblock_height, rac, average_rac, total_credit),
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE superblock_projects DROP INDEX IF EXISTS idx_sbp_name_norm`.execute(db);
  await sql`ALTER TABLE superblock_projects DROP COLUMN IF EXISTS project_name_norm`.execute(db);
}
