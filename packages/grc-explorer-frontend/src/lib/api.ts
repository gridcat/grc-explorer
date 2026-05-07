import axios, { AxiosInstance } from 'axios';

// Two URLs intentionally:
//   NEXT_PUBLIC_API_URL         — used in the browser
//   NEXT_PUBLIC_API_URL_SERVER  — used during SSR / getServerSideProps
//                                 (typically the internal Docker host)
const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:7002';
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
