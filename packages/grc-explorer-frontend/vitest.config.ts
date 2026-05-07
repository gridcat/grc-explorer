import { defineConfig } from 'vitest/config';

// Unit tests for the explorer frontend. Pure logic only — formatters,
// sort comparators, dedup helpers. The render-tree tests would need a
// jsdom environment + RTL; that's a separate scope, deliberately out
// of this first round.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
