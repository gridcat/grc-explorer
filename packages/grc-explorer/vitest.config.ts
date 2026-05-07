import { defineConfig } from 'vitest/config';

// Unit tests for the explorer backend. Pure functions only — no DB,
// no RPC, no Redis. The integration suite (vitest.integration.config.ts)
// owns anything that touches a live service.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    setupFiles: ['tests/setEnv.ts'],
  },
});
