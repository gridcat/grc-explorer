/**
 * Canonical BOINC project-name key.
 *
 * The same project surfaces through three independent ingest paths —
 * on-chain superblock contracts, on-chain whitelist contracts, and the
 * off-chain `<base_url>/stats/user.gz` exports — and each spells the
 * name with its own casing/whitespace: `Moowrap`/`moowrap`,
 * `MilkyWay@home`/`milkyway@home`, `NFS@Home`/`nfs@home`,
 * `Asteroids@home`/`asteroids@home`, `World_Community_Grid`. Stored
 * verbatim, one project fragments into several rows and the CPID /
 * project pages list it two or three times.
 *
 * We canonicalise to trimmed lowercase so a project is one identity at
 * every write path and in every equality predicate that reads it back.
 * Lowercase is also how BOINC's own base URLs and `user.gz` exports
 * spell projects, so it's the natural canonical form rather than an
 * arbitrary one.
 *
 * Pure function of the string: the matching CH migration
 * (0035_normalize_project_names.sql) applies the identical transform
 * (`lower(trimBoth(...))`) to existing rows, so stored data and new
 * writes converge with no reindex.
 */
export function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase();
}
