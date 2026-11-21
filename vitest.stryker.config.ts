import { defineConfig } from 'vitest/config';

// Stryker runs the unit tests only (perTest coverage narrows it per mutant): no junit reporter, no coverage thresholds.
// Excluded: integration (Docker, slow) and tests of non-src artefacts (chart, extension bundle, release version). The
// integration files drive every tool from beforeAll, which Stryker counts as static coverage: with them 72% of mutants were
// static (each reruns the whole set), without them 15% (module-level constants only). Integration tests still run in
// `npm run test:integration`; the other excluded tests run in `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/integration/**', 'test/chart.test.ts', 'test/extension*.test.ts', 'test/release-version.test.ts'],
  },
});
