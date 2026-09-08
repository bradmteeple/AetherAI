import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Integration tests drive a real local Showdown server and must not run in parallel.
    fileParallelism: false,
  },
});
