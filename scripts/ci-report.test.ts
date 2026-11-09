// Interface contract (implemented in scripts/ci-report.ts):
//   buildReport(coverage: unknown, junitXml: string): string
//     - coverage = Istanbul json-summary { total: { lines|branches|functions|statements: { pct } } }
//     - each % rendered with 1 decimal (93.3%)
//     - JUnit totals from root <testsuites tests failures errors skipped>;
//       failed = F+E; passed = N-F-E-S; pass % = passed/(N-S) 1 decimal; zero runnable -> n/a
//     - mutation row contains "n/a (from Phase 1)"
//     - throws Error whose message contains 'coverage' on malformed coverage shape
//   main(argv: string[], io?: { out(s): void; err(s): void }): Promise<number>
//     - argv = [coveragePath, junitPath]; 0 + markdown to io.out on success;
//       non-zero + one-line error containing the offending path to io.err on missing/unparsable file
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport, main } from './ci-report.ts';

const cov = (l: number, b: number, f: number, s: number) => ({
  total: {
    lines: { pct: l },
    branches: { pct: b },
    functions: { pct: f },
    statements: { pct: s },
  },
});
const junit = (t: number, f: number, e: number, s: number) =>
  `<?xml version="1.0"?><testsuites name="vitest tests" tests="${t}" failures="${f}" errors="${e}" skipped="${s}" time="0.1"><testsuite name="a" tests="${t}" failures="0" errors="0" skipped="0"></testsuite></testsuites>`;

describe('buildReport', () => {
  it('renders coverage percentages with 1 decimal', () => {
    const r = buildReport(cov(93.333, 90, 100, 87.25), junit(10, 0, 0, 0));
    expect(r).toContain('93.3%');
    expect(r).toContain('90.0%');
    expect(r).toContain('100.0%');
    expect(r).toContain('87.3%');
  });

  it('reports all-passing totals', () => {
    const r = buildReport(cov(100, 100, 100, 100), junit(10, 0, 0, 0));
    expect(r).toContain('100.0%');
    expect(r).toMatch(/10/);
  });

  it('counts failures and errors as failed', () => {
    // N=10 F=2 E=1 S=0 -> failed 3, passed 7, 7/10 = 70.0%
    const r = buildReport(cov(100, 100, 100, 100), junit(10, 2, 1, 0));
    expect(r).toContain('70.0%');
    expect(r).toMatch(/failed\D*3/i);
    expect(r).toMatch(/passed\D*7/i);
  });

  it('excludes skipped from the pass rate', () => {
    // N=10 F=1 E=0 S=2 -> passed 7, runnable 8, 7/8 = 87.5%
    const r = buildReport(cov(100, 100, 100, 100), junit(10, 1, 0, 2));
    expect(r).toContain('87.5%');
    expect(r).toMatch(/skipped\D*2/i);
    expect(r).toMatch(/passed\D*7/i);
  });

  it('shows n/a pass rate when zero tests are runnable', () => {
    expect(buildReport(cov(100, 100, 100, 100), junit(0, 0, 0, 0))).toContain('n/a');
    expect(buildReport(cov(100, 100, 100, 100), junit(3, 0, 0, 3))).toContain('n/a');
  });

  it('has a mutation row marked n/a (from Phase 1)', () => {
    const r = buildReport(cov(100, 100, 100, 100), junit(1, 0, 0, 0));
    expect(r).toContain('n/a (from Phase 1)');
    expect(r.toLowerCase()).toContain('mutation');
  });

  it('reads totals from the root testsuites, not nested suites', () => {
    const xml = `<testsuites tests="4" failures="1" errors="0" skipped="0"><testsuite tests="99" failures="50" errors="0" skipped="0"/></testsuites>`;
    expect(buildReport(cov(100, 100, 100, 100), xml)).toContain('75.0%');
  });

  it.each([
    ['null', null],
    ['no total', {}],
    ['missing metric', { total: { lines: { pct: 1 } } }],
    ['non-numeric pct', cov(1, 1, 1, 1) && { total: { ...cov(1, 1, 1, 1).total, lines: { pct: 'x' } } }],
  ])('throws mentioning coverage on malformed shape: %s', (_n, bad) => {
    expect(() => buildReport(bad, junit(1, 0, 0, 0))).toThrow(/coverage/i);
  });
});

describe('main', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ci-report-'));
    out = [];
    err = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 0 and writes markdown on success', async () => {
    const c = join(dir, 'cov.json');
    const j = join(dir, 'junit.xml');
    await writeFile(c, JSON.stringify(cov(93.333, 90, 100, 87.25)));
    await writeFile(j, junit(10, 0, 0, 0));
    expect(await main([c, j], io)).toBe(0);
    expect(out.join('')).toContain('93.3%');
    expect(err).toEqual([]);
  });

  it('returns non-zero naming a missing coverage file', async () => {
    const j = join(dir, 'junit.xml');
    await writeFile(j, junit(1, 0, 0, 0));
    const missing = join(dir, 'nope.json');
    expect(await main([missing, j], io)).not.toBe(0);
    expect(err.join('')).toContain(missing);
  });

  it('returns non-zero naming a missing junit file', async () => {
    const c = join(dir, 'cov.json');
    await writeFile(c, JSON.stringify(cov(1, 1, 1, 1)));
    const missing = join(dir, 'nope.xml');
    expect(await main([c, missing], io)).not.toBe(0);
    expect(err.join('')).toContain(missing);
  });

  it('returns non-zero naming an unparsable coverage file', async () => {
    const c = join(dir, 'bad.json');
    const j = join(dir, 'junit.xml');
    await writeFile(c, '{not json');
    await writeFile(j, junit(1, 0, 0, 0));
    expect(await main([c, j], io)).not.toBe(0);
    expect(err.join('')).toContain(c);
  });

  it('returns non-zero naming a coverage file with malformed shape', async () => {
    const c = join(dir, 'shape.json');
    const j = join(dir, 'junit.xml');
    await writeFile(c, '{}');
    await writeFile(j, junit(1, 0, 0, 0));
    expect(await main([c, j], io)).not.toBe(0);
    expect(err.join('')).toContain(c);
  });
});
