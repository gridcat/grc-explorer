import { ch } from './ch';

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
 * No FINAL: project_users is ~48% un-merged duplicate rows, so FINAL
 * is load-bearing for correctness AND a full merge-scan. We reproduce
 * it cheaply — dedup each (cpid, project_name) to its latest `_seq`,
 * then pick the name from the BOINC project where the user has the
 * most credit. `cpid IN (...)` is primary-key-pruned (cpid leads the
 * ORDER BY). Verified row-for-row identical to the FINAL form.
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
      const result = await ch.query({
        // Inner aliases are `nm`/`tc` (not `display_name`) and the
        // empty-name filter is a HAVING on the inner aggregate — a
        // WHERE/outer-alias collision here resolves to the outer
        // argMax aggregate and ClickHouse rejects it (error 184,
        // ILLEGAL_AGGREGATION).
        query: `
          SELECT cpid, argMax(nm, tc) AS display_name
          FROM (
            SELECT cpid, project_name,
                   argMax(name, _seq)         AS nm,
                   argMax(total_credit, _seq) AS tc
            FROM project_users
            WHERE cpid IN ({cpids: Array(String)})
            GROUP BY cpid, project_name
            HAVING nm != ''
          )
          GROUP BY cpid
        `,
        query_params: { cpids: chunk },
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ cpid: string; display_name: string }>();
      for (const r of rows) if (r.display_name) out.set(r.cpid, r.display_name);
    } catch {
      // Table absent (pre-migration 0015) or transient CH error —
      // degrade to no names; callers fall back to truncated hashes.
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
