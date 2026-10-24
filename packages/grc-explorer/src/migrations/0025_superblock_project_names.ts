import { Kysely, sql } from 'kysely';

// gridcoin-rpc before 5.1.1 camelCased the keys of a superblock's
// `projects` object, and BlockWriter lowercased the result, so
// superblock_projects holds 'tngrid' / 'worldcommunitygrid' where the
// daemon sent 'TN-Grid' / 'World_Community_Grid'. Newer gridcoin-rpc
// returns the keys verbatim, so new rows land as 'tn-grid' /
// 'world_community_grid', the same spelling as project_contracts.
//
// One-time fix of the old rows: take the correct names from
// project_contracts, apply the old transform, and rename every stored row
// that matches. Names whose old form is shared by two correct names are
// left alone.

/**
 * What lowercase(camelCase(name)) produced: separators dropped, all lowercase.
 */
export function legacySuperblockProjectName(name: string): string {
  return name.toLowerCase().replace(/[_.\- ]+/g, '');
}

/**
 * Old stored name → correct name, for every correct name the old
 * transform changed and did not collide on.
 */
export function superblockProjectRenames(names: readonly string[]): Map<string, string> {
  const byLegacy = new Map<string, Set<string>>();
  names.forEach((name) => {
    const legacy = legacySuperblockProjectName(name);
    byLegacy.set(legacy, (byLegacy.get(legacy) ?? new Set()).add(name));
  });
  const renames = new Map<string, string>();
  byLegacy.forEach((candidates, legacy) => {
    const [name] = [...candidates];
    if (candidates.size === 1 && name !== legacy) {
      renames.set(legacy, name);
    }
  });
  return renames;
}

async function projectContractNames(db: Kysely<unknown>): Promise<string[]> {
  const { rows } = await sql<{ project_name: string }>`
    SELECT DISTINCT project_name FROM project_contracts
  `.execute(db);
  return rows.map((r) => r.project_name);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const renames = superblockProjectRenames(await projectContractNames(db));
  for (const [legacy, name] of renames) {
    await sql`
      UPDATE superblock_projects SET project_name = ${name} WHERE project_name = ${legacy}
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const renames = superblockProjectRenames(await projectContractNames(db));
  for (const [legacy, name] of renames) {
    await sql`
      UPDATE superblock_projects SET project_name = ${legacy} WHERE project_name = ${name}
    `.execute(db);
  }
}
