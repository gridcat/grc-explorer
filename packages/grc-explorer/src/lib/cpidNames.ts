import { query } from './db';

const CPID_RE = /^[0-9a-f]{32}$/;

// Internal IN(...) batch size. Callers like the superblock-detail
// enrichment can pass ~900 CPIDs; chunk so the IN list stays sane.
// Deliberately NOT the /cpids/names route's 500 cap — that's an
// untrusted-input guard, it has no place on internal enrichment.
const RESOLVE_CHUNK = 1000;

/**
 * Batch-resolve CPIDs to their canonical BOINC display name.
 *
 * Returns a Map keyed by the LOWERCASE cpid (project_users' canonical
 * form); only CPIDs with a non-empty published name are present.
 * Callers treat absence as "anonymous / unknown" and fall back to a
 * truncated hash. Use `cpidDisplayName()` to look up by a possibly
 * mixed-case chain CPID.
 *
 * (cpid, project_name) is the PRIMARY KEY (one row per pair via
 * upsert), so no dedup is needed — we just pick the name from the BOINC
 * project where the user has the most credit. `cpid = ANY(...)` is
 * primary-key-pruned (cpid leads the PK).
 */
export async function resolveCpidNames(
  cpids: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(
    cpids.map((c) => c.toLowerCase()).filter((c) => CPID_RE.test(c)),
  ));
  if (unique.length === 0) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += RESOLVE_CHUNK) {
    chunks.push(unique.slice(i, i + RESOLVE_CHUNK));
  }
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const rows = await query<{ cpid: string; display_name: string }>(
        `
          SELECT cpid, arg_max(name, total_credit) AS display_name
          FROM project_users
          WHERE cpid = ANY($cpids) AND name != ''
          GROUP BY cpid
        `,
        { cpids: chunk },
      );
      for (const r of rows) if (r.display_name) out.set(r.cpid, r.display_name);
    } catch {
      // Table absent (pre-migration) — degrade to no names; callers
      // fall back to truncated hashes.
    }
  }));
  return out;
}

/**
 * Look up a single CPID's display name from a `resolveCpidNames`
 * result, normalising the chain's mixed-case CPID to the lowercase
 * key project_users stores. Returns null when unresolved.
 */
export function cpidDisplayName(
  resolved: Map<string, string>,
  cpid: string | null | undefined,
): string | null {
  if (!cpid) return null;
  return resolved.get(cpid.toLowerCase()) ?? null;
}
