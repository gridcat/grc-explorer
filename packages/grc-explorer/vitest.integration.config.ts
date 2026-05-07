import { defineConfig } from 'vitest/config';

// Integration tests — real MySQL, real Prisma, real RPC stub. Lives in
// CI's `grc-explorer-integration` job which boots a `cimg/mysql:8.0`
// sidecar.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    setupFiles: ['tests/setEnv.ts'],
    // Integration tests share the DB — run them serially so a teardown
    // in one suite doesn't yank rows out from under another.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
  },
});
