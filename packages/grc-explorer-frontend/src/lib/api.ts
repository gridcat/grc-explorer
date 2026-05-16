import axios, { AxiosInstance, AxiosResponse } from 'axios';

// Two URLs intentionally:
//   NEXT_PUBLIC_API_URL         — used in the browser
//   NEXT_PUBLIC_API_URL_SERVER  — used during SSR / getServerSideProps
//                                 (typically the internal Docker host)
// Fall back to '/api' (same-origin via nginx) rather than the dev
// server, so a prod image built without the env present still resolves
// against the public ingress instead of leaking localhost into the
// client bundle. Dev is unaffected — `.env` always supplies the value
// explicitly when running `npm run dev`.
export const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const SERVER_BASE = process.env.NEXT_PUBLIC_API_URL_SERVER ?? PUBLIC_BASE;

const isServer = typeof window === 'undefined';

export const api: AxiosInstance = axios.create({
  baseURL: isServer ? SERVER_BASE : PUBLIC_BASE,
  timeout: 15_000,
  headers: { Accept: 'application/vnd.api+json' },
});

/**
 * Unwrap a JSON:API single-resource envelope to its `attributes`.
 * Returns null when the response is empty or missing the wrapping
 * shape — saves the `r.data?.data?.attributes ?? null` ladder from
 * recurring in every page. Pass the `T` type from the caller; we
 * trust the route contract rather than re-validating per call.
 */
export function getAttributes<T>(r: AxiosResponse | null | undefined): T | null {
  const attrs = (r?.data as { data?: { attributes?: unknown } } | undefined)?.data?.attributes;
  return (attrs ?? null) as T | null;
}

/**
 * Unwrap a JSON:API list envelope to an array of `attributes`. Empty
 * array when the data array is missing or non-array — list endpoints
 * always return an array on success, so empty-fallback matches the
 * "no rows" semantics every caller already handles.
 */
export function getDataList<T>(r: AxiosResponse | null | undefined): T[] {
  const data = (r?.data as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return data.map((d) => (d as { attributes?: T }).attributes).filter((a): a is T => a !== undefined);
}

export interface JsonApiEnvelope<T = unknown> {
  data: T;
  meta?: Record<string, unknown> & { network?: string };
  // The explorer's ad-hoc routes (block detail, tx detail, cpid view)
  // attach extra arrays at the top level — captured here as a passthrough.
  [key: string]: unknown;
}

/**
 * True only when the API explicitly said the resource isn't
 * addressable: a real 404, or a 400 (malformed id/height/hash — that
 * thing can't exist either). axios throws on every non-2xx, so this is
 * how SSR tells "genuinely absent" apart from "backend hiccuped".
 */
export function isAbsentError(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    const s = err.response?.status;
    return s === 404 || s === 400;
  }
  return false;
}

/**
 * getServerSideProps catch helper. A bare `catch { notFound: true }`
 * turns a transient backend timeout / 5xx into a PERMANENT-looking 404
 * — wrong for users and actively harmful for crawlers (signals the
 * page is gone). Genuine absence → 404; everything else (timeout,
 * network, 5xx, rate-limit) → rethrow so Next renders its error page
 * (HTTP 500, retryable).
 */
export function notFoundOrRethrow(err: unknown): { notFound: true } {
  if (isAbsentError(err)) return { notFound: true };
  throw err;
}
