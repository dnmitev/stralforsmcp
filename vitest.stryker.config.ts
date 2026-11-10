import { defineConfig } from 'vitest/config';

// Stryker runs only the stralfors tests: no junit reporter, no coverage thresholds.
export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});
