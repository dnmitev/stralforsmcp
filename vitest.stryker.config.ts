import { defineConfig } from 'vitest/config';

// Stryker runs every src/ and test/ test file (perTest coverage narrows it per mutant): no junit reporter, no coverage thresholds.
export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});
