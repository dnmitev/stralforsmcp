import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };
export type Prices = Record<string, Price>;
export type Rec = {
  id: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  role: string;
  file: string;
  ts: string;
};
export type Row = {
  role: string;
  runs: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  usd: number | null;
};

// source = Anthropic API pricing as of 2026-11; 1-hour cache writes are billed at 2x input (handled in aggregate).
export const PRICES: Prices = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

const ls = (d: string) => {
  try {
    return readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
};

function roleOf(jsonl: string): string {
  const metaPath = jsonl.replace(/\.jsonl$/, '.meta.json');
  try {
    const m = JSON.parse(readFileSync(metaPath, 'utf8')) as { agentType?: string; description?: string };
    if (m.agentType && m.agentType !== 'general-purpose') return m.agentType;
    const d = m.description ?? '';
    const i = d.indexOf(':');
    const prefix = i > 0 ? d.slice(0, i).trim().toLowerCase() : '';
    return prefix || 'general-purpose';
  } catch {
    return 'general-purpose';
  }
}

export function collect(dirs: string[], win: { since: Date; until: Date }): Rec[] {
  const files: { path: string; role: string | null }[] = [];
  for (const dir of dirs)
    for (const e of ls(dir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ path: join(dir, e.name), role: 'main' });
      else if (e.isDirectory())
        for (const s of ls(join(dir, e.name, 'subagents')))
          if (s.isFile() && /^agent-.*\.jsonl$/.test(s.name))
            files.push({ path: join(dir, e.name, 'subagents', s.name), role: null });
    }

  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const f of files) {
    const role = f.role ?? roleOf(f.path);
    // ponytail: reads whole transcripts into memory; stream if files exceed ~100 MB
    for (const l of readFileSync(f.path, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let j: any;
      try {
        j = JSON.parse(l);
      } catch {
        continue;
      }
      const m = j?.message;
      const u = m?.usage;
      if (!u || typeof m.id !== 'string' || seen.has(m.id)) continue;
      const t = new Date(j.timestamp);
      if (!(t >= win.since && t < win.until)) continue;
      seen.add(m.id);
      out.push({
        id: m.id,
        model: m.model,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        role,
        file: f.path,
        ts: j.timestamp,
      });
    }
  }
  return out;
}

export function aggregate(recs: Rec[], prices: Prices): Row[] {
  const by = new Map<string, Row & { files: Set<string> }>();
  for (const r of recs) {
    let a = by.get(r.role);
    if (!a)
      by.set(r.role, (a = { role: r.role, runs: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0, files: new Set() }));
    a.input += r.input;
    a.output += r.output;
    a.cacheWrite += r.cacheWrite;
    a.cacheRead += r.cacheRead;
    a.files.add(r.file);
    const p = prices[r.model];
    if (!p) a.usd = null;
    else if (a.usd !== null)
      a.usd +=
        (r.input * p.input +
          r.output * p.output +
          (r.cacheWrite - r.cacheWrite1h) * p.cacheWrite +
          r.cacheWrite1h * 2 * p.input +
          r.cacheRead * p.cacheRead) /
        1e6;
  }
  return [...by.values()]
    .sort((x, y) => (x.role < y.role ? -1 : x.role > y.role ? 1 : 0))
    .map(({ files, ...r }) => ({ ...r, runs: files.size }));
}

const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(2)}`);
const line = (c: (string | number)[]) => `| ${c.join(' | ')} |`;

export function render(phase: string, rows: Row[]): string {
  const sum = (k: 'runs' | 'input' | 'output' | 'cacheWrite' | 'cacheRead') => rows.reduce((s, r) => s + r[k], 0);
  const total = rows.some((r) => r.usd === null) ? null : rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  return [
    `## Phase ${phase}`,
    '',
    '| Role | Runs | Input | Output | Cache write | Cache read | Est. USD |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => line([r.role, r.runs, r.input, r.output, r.cacheWrite, r.cacheRead, usd(r.usd)])),
    line(['**Total**', sum('runs'), sum('input'), sum('output'), sum('cacheWrite'), sum('cacheRead'), usd(total)]),
    '',
  ].join('\n');
}

type IO = { out(s: string): void; err(s: string): void };

export function main(
  argv: string[],
  io: IO = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) },
  prices: Prices = PRICES,
): number {
  const fail = (msg: string) => {
    io.err(`tokenomics: ${msg}\n`);
    return 1;
  };
  let v;
  try {
    v = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { phase: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' } },
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  const { phase, since, until } = v.values;
  if (!phase) return fail('missing --phase');
  if (!since) return fail('missing --since');
  const s = new Date(since);
  if (Number.isNaN(s.getTime())) return fail(`bad --since: ${since}`);
  const u = until === undefined ? new Date() : new Date(until);
  if (Number.isNaN(u.getTime())) return fail(`bad --until: ${until}`);
  if (v.positionals.length === 0) return fail('usage: tokenomics --phase P --since ISO [--until ISO] DIR...');
  for (const d of v.positionals) {
    try {
      if (!statSync(d).isDirectory()) throw new Error();
    } catch {
      return fail(`not a directory: ${d}`);
    }
  }
  io.out(render(phase, aggregate(collect(v.positionals, { since: s, until: u }), prices)));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
