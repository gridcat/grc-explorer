import { defineConfig } from 'vitest/config';

// Unit tests for the explorer backend. Pure functions only — no DB,
// no RPC, no Redis.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    setupFiles: ['tests/setEnv.ts'],
  },
});
