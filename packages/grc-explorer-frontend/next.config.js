/** @type {import('next').NextConfig} */

// Content-Security-Policy.
//
// Goal: a meaningful XSS/clickjacking floor. CSP is the seatbelt for
// any future Markdown / poll-description / message-contract renderer
// regression — even if React's escaping ever leaks something through,
// a strict CSP keeps an attacker from running the payload.
//
// Inline-script and inline-style: `unsafe-inline` is allowed because
// (a) Next.js injects `__NEXT_DATA__`, hydration markers, and route
// preloads as inline scripts, and (b) Emotion server-renders critical
// CSS as `<style>` tags. Migrating to per-request nonces is a real
// refactor (Document.getInitialProps + Emotion + Plausible all need
// the nonce threaded through); we pick that fight later.
//
// Plausible: `daj.pw` hosts the analytics script and ingests events.
// Reference memory: `reference_plausible_script` documents the
// shared family-wide loader at `daj.pw/js/plausible.js`.
//
// Dev needs `unsafe-eval` for HMR; production drops it.
const PROD = process.env.NODE_ENV === 'production';

// API origin for connect-src. The browser EventSource + axios calls
// target NEXT_PUBLIC_API_URL — if it's an absolute origin (dev compose
// uses `http://localhost:7002`) the CSP must allow that explicitly,
// otherwise the SSE connection is refused. In prod the value is `/api`
// (same-origin via nginx) and 'self' suffices.
function apiOrigin() {
  const v = process.env.NEXT_PUBLIC_API_URL;
  if (!v) return null;
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}
const apiConnect = apiOrigin();

const cspDirectives = {
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    "'unsafe-inline'",
    'https://daj.pw',
    ...(PROD ? [] : ["'unsafe-eval'"]),
  ],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': [
    "'self'",
    'https://daj.pw',
    ...(apiConnect ? [apiConnect] : []),
  ],
  'frame-ancestors': ["'self'"],
  'form-action': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'upgrade-insecure-requests': [],
};

const cspValue = Object.entries(cspDirectives)
  .map(([k, v]) => (v.length === 0 ? k : `${k} ${v.join(' ')}`))
  .join('; ');

module.exports = {
  // React strict mode double-invokes every render and every effect in
  // development (no effect on production). For this dashboard — 9
  // panels, each with its own SSE subscription + 30s polling — the
  // double-invocation roughly doubles dev mount cost without catching
  // anything we aren't already careful about. Keep off; flip to true
  // when intentionally hunting effect-cleanup bugs.
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: '/((?!_next/).*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: cspValue },
        ],
      },
    ];
  },
};
