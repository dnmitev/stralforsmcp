import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const METRICS = ['lines', 'branches', 'functions', 'statements'] as const;
const pct = (n: number) => `${n.toFixed(1)}%`;

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

/** Mutation score in percent from a mutation-testing-elements report; undefined when nothing countable. */
export function mutationScore(report: unknown): number | undefined {
  const files = (report as { files?: Record<string, { mutants?: { status?: unknown }[] }> } | null)?.files;
  if (typeof files !== 'object' || files === null) return undefined;
  let detected = 0;
  let undetected = 0;
  for (const f of Object.values(files)) {
    for (const m of f?.mutants ?? []) {
      if (DETECTED.has(m.status as string)) detected++;
      else if (UNDETECTED.has(m.status as string)) undetected++;
    }
  }
  const total = detected + undetected;
  return total > 0 ? (detected / total) * 100 : undefined;
}

export function buildReport(coverage: unknown, junitXml: string, mutation?: unknown): string {
  const score = mutationScore(mutation);
  const total = (coverage as { total?: Record<string, { pct?: unknown }> } | null)?.total;
  const rows = METRICS.map((m) => {
    const p = total?.[m]?.pct;
    if (typeof p !== 'number') throw new Error(`malformed coverage summary: missing numeric total.${m}.pct`);
    return `| ${m[0]!.toUpperCase()}${m.slice(1)} coverage | ${pct(p)} |`;
  });

  const attrs = /<testsuites\b([^>]*)>/.exec(junitXml)?.[1];
  if (attrs === undefined) throw new Error('malformed junit: no <testsuites> root');
  const get = (k: string) => Number(new RegExp(`\\b${k}="(\\d+)"`).exec(attrs)?.[1] ?? 0);
  // Vitest puts skipped on each <testsuite>, not on the <testsuites> root
  const s = [...junitXml.matchAll(/<testsuite\b[^>]*?\bskipped="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0);
  const [n, f, e] = [get('tests'), get('failures'), get('errors')] as const;
  const passed = n - f - e - s;
  if (passed < 0) throw new Error(`malformed junit: inconsistent report (tests=${n} failures=${f} errors=${e} skipped=${s})`);
  const runnable = n - s;

  return [
    '| Metric | Value |',
    '| --- | --- |',
    ...rows,
    `| Passed | ${passed} |`,
    `| Failed | ${f + e} |`,
    `| Skipped | ${s} |`,
    `| Pass rate | ${runnable > 0 ? pct((passed / runnable) * 100) : 'n/a'} |`,
    `| Mutation score | ${score === undefined ? 'n/a' : pct(score)} |`,
    '',
  ].join('\n');
}

type IO = { out(s: string): void; err(s: string): void };

export async function main(
  argv: string[],
  io: IO = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) },
): Promise<number> {
  const [covPath = '', junitPath = '', mutationPath] = argv;
  let path = covPath;
  try {
    const coverage: unknown = JSON.parse(await readFile(covPath, 'utf8'));
    path = junitPath;
    const xml = await readFile(junitPath, 'utf8');
    path = covPath;
    // A missing or malformed mutation report must not fail the report: the row shows n/a.
    const mutation: unknown = mutationPath
      ? await readFile(mutationPath, 'utf8').then((t) => JSON.parse(t) as unknown).catch(() => undefined)
      : undefined;
    const report = (() => {
      try {
        return buildReport(coverage, xml, mutation);
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
