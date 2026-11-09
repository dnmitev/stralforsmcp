import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const METRICS = ['lines', 'branches', 'functions', 'statements'] as const;
const pct = (n: number) => `${n.toFixed(1)}%`;

export function buildReport(coverage: unknown, junitXml: string): string {
  const total = (coverage as { total?: Record<string, { pct?: unknown }> } | null)?.total;
  const rows = METRICS.map((m) => {
    const p = total?.[m]?.pct;
    if (typeof p !== 'number') throw new Error(`malformed coverage summary: missing numeric total.${m}.pct`);
    return `| ${m[0]!.toUpperCase()}${m.slice(1)} coverage | ${pct(p)} |`;
  });

  const attrs = /<testsuites\b([^>]*)>/.exec(junitXml)?.[1];
  if (attrs === undefined) throw new Error('malformed junit: no <testsuites> root');
  const get = (k: string) => Number(new RegExp(`\\b${k}="(\\d+)"`).exec(attrs)?.[1] ?? 0);
  const [n, f, e, s] = [get('tests'), get('failures'), get('errors'), get('skipped')] as const;
  const passed = n - f - e - s;
  const runnable = n - s;

  return [
    '| Metric | Value |',
    '| --- | --- |',
    ...rows,
    `| Passed | ${passed} |`,
    `| Failed | ${f + e} |`,
    `| Skipped | ${s} |`,
    `| Pass rate | ${runnable > 0 ? pct((passed / runnable) * 100) : 'n/a'} |`,
    '| Mutation score | n/a (from Phase 1) |',
    '',
  ].join('\n');
}

type IO = { out(s: string): void; err(s: string): void };

export async function main(
  argv: string[],
  io: IO = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) },
): Promise<number> {
  const [covPath = '', junitPath = ''] = argv;
  let path = covPath;
  try {
    const coverage: unknown = JSON.parse(await readFile(covPath, 'utf8'));
    path = junitPath;
    const xml = await readFile(junitPath, 'utf8');
    path = covPath;
    const report = (() => {
      try {
        return buildReport(coverage, xml);
      } catch (e) {
        // blame the right file: junit errors mention junit
        path = /junit/.test((e as Error).message) ? junitPath : covPath;
        throw e;
      }
    })();
    io.out(report);
    return 0;
  } catch (e) {
    io.err(`ci-report: ${path}: ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}
