/** @type {import('next').NextConfig} */
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
        ],
      },
    ];
  },
};
