/**
 * Slice an array into fixed-size chunks. Used by callers that batch
 * external work (CH `IN (...)` clauses bounded by Poco's ~8KB query-
 * param limit, Redis pipelines bounded by client memory, etc.) — chunk
 * sizes are picked per call site since the bound differs by backend.
 */
export function* chunked<T>(arr: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) {
    yield arr.slice(i, i + size);
  }
}
