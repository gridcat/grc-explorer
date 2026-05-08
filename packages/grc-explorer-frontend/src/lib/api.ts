import axios, { AxiosInstance } from 'axios';

// Two URLs intentionally:
//   NEXT_PUBLIC_API_URL         — used in the browser
//   NEXT_PUBLIC_API_URL_SERVER  — used during SSR / getServerSideProps
//                                 (typically the internal Docker host)
// Fall back to '/api' (same-origin via nginx) rather than the dev
// server, so a prod image built without the env present still resolves
// against the public ingress instead of leaking localhost into the
// client bundle. Dev is unaffected — `.env` always supplies the value
// explicitly when running `npm run dev`.
const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const SERVER_BASE = process.env.NEXT_PUBLIC_API_URL_SERVER ?? PUBLIC_BASE;

const isServer = typeof window === 'undefined';

export const api: AxiosInstance = axios.create({
  baseURL: isServer ? SERVER_BASE : PUBLIC_BASE,
  timeout: 15_000,
  headers: { Accept: 'application/vnd.api+json' },
});

export interface JsonApiEnvelope<T = unknown> {
  data: T;
  meta?: Record<string, unknown> & { network?: string };
  // The explorer's ad-hoc routes (block detail, tx detail, cpid view)
  // attach extra arrays at the top level — captured here as a passthrough.
  [key: string]: unknown;
}
