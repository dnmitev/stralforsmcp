import { defineConfig } from 'vitest/config';

// Second test tier: needs Docker and openssl. One fork, one container (see ADR 0019).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
