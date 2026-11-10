// Interface contract (implemented in scripts/tokenomics.ts): see task brief.
// Synthetic fixtures only, written to a tmpdir.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PRICES,
  aggregate,
  collect,
  main,
  render,
  type Prices,
  type Rec,
} from './tokenomics.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenomics-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type U = { i?: number; o?: number; cw?: number; cr?: number; cw1h?: number };
const line = (id: string, ts: string, u: U = {}, model = 'm') =>
  JSON.stringify({
    timestamp: ts,
    message: {
      id,
      model,
      usage: {
        input_tokens: u.i ?? 0,
        output_tokens: u.o ?? 0,
        cache_creation_input_tokens: u.cw ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
        ...(u.cw1h === undefined ? {} : { cache_creation: { ephemeral_1h_input_tokens: u.cw1h } }),
      },
    },
  });
const T = '2026-01-10T12:00:00Z';
const wide = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-02-01T00:00:00Z') };

const main_ = (session: string, lines: string[]) =>
  writeFileSync(join(dir, `${session}.jsonl`), lines.join('\n') + '\n');
const sub = (session: string, id: string, lines: string[], meta?: unknown) => {
  const d = join(dir, session, 'subagents');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `agent-${id}.jsonl`), lines.join('\n') + '\n');
  if (meta !== undefined) writeFileSync(join(d, `agent-${id}.meta.json`), JSON.stringify(meta));
};
const roleOf = (recs: Rec[]) => recs.map((r) => r.role);

describe('collect', () => {
  it('counts a repeated message.id once, within and across files', () => {
    main_('s1', [line('a', T, { i: 1 }), line('a', T, { i: 1 }), line('b', T, { i: 2 })]);
    sub('s1', 'x', [line('b', T, { i: 2 }), line('c', T, { i: 4 })], { agentType: 'foo', description: '' });
    const recs = collect([dir], wide);
    expect(recs.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('window: since inclusive, until exclusive', () => {
    main_('s1', [
      line('before', '2025-12-31T23:59:59Z'),
      line('at-since', '2026-01-01T00:00:00Z'),
      line('inside', T),
      line('at-until', '2026-02-01T00:00:00Z'),
    ]);
    expect(collect([dir], wide).map((r) => r.id).sort()).toEqual(['at-since', 'inside']);
  });

  it('ignores non-usage lines and skips malformed JSON', () => {
    main_('s1', [
      '{not json',
      JSON.stringify({ timestamp: T, type: 'user', message: { id: 'u', content: 'hi' } }),
      '',
      line('ok', T, { i: 3 }),
    ]);
    const recs = collect([dir], wide);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ id: 'ok', input: 3, model: 'm' });
  });

  it('treats missing usage sub-fields as 0', () => {
    main_('s1', [
      JSON.stringify({ timestamp: T, message: { id: 'p', model: 'm', usage: { output_tokens: 5 } } }),
    ]);
    expect(collect([dir], wide)[0]).toMatchObject({ input: 0, output: 5, cacheWrite: 0, cacheRead: 0 });
  });

  it('cacheWrite1h from cache_creation.ephemeral_1h_input_tokens, 0 if absent', () => {
    main_('s1', [line('a', T, { cw: 10, cw1h: 4 }), line('b', T, { cw: 5 })]);
    const by = Object.fromEntries(collect([dir], wide).map((r) => [r.id, r]));
    expect(by.a).toMatchObject({ cacheWrite: 10, cacheWrite1h: 4 });
    expect(by.b).toMatchObject({ cacheWrite: 5, cacheWrite1h: 0 });
  });

  it('maps the four usage fields', () => {
    main_('s1', [line('a', T, { i: 1, o: 2, cw: 3, cr: 4 }, 'model-x')]);
    expect(collect([dir], wide)[0]).toMatchObject({
      id: 'a', model: 'model-x', input: 1, output: 2, cacheWrite: 3, cacheRead: 4, ts: T,
    });
  });

  it('main transcript has role "main"', () => {
    main_('s1', [line('a', T)]);
    expect(roleOf(collect([dir], wide))).toEqual(['main']);
  });

  it('subagent agentType other than general-purpose is the role', () => {
    sub('s1', 'x', [line('a', T)], { agentType: 'Explore', description: 'Developer: nope' });
    expect(roleOf(collect([dir], wide))).toEqual(['Explore']);
  });

  it('general-purpose + "Prefix: text" description -> trimmed lower-cased prefix', () => {
    sub('s1', 'x', [line('a', T)], { agentType: 'general-purpose', description: '  Developer : leak hooks' });
    expect(roleOf(collect([dir], wide))).toEqual(['developer']);
  });

  it('general-purpose without colon description stays general-purpose', () => {
    sub('s1', 'x', [line('a', T)], { agentType: 'general-purpose', description: 'just words' });
    expect(roleOf(collect([dir], wide))).toEqual(['general-purpose']);
  });

  it('missing meta file -> general-purpose', () => {
    sub('s1', 'x', [line('a', T)]);
    expect(roleOf(collect([dir], wide))).toEqual(['general-purpose']);
  });

  it('reads several dirs', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'tokenomics-'));
    try {
      main_('s1', [line('a', T)]);
      writeFileSync(join(d2, 's2.jsonl'), line('b', T) + '\n');
      expect(collect([dir, d2], wide).map((r) => r.id).sort()).toEqual(['a', 'b']);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

const rec = (o: Partial<Rec> & { id: string }): Rec => ({
  input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0,
  model: 'm', role: 'main', file: 'f1', ts: T, ...o,
});
const prices: Prices = { m: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } };

describe('aggregate', () => {
  it('one row per role, sorted by role name, tokens summed', () => {
    const rows = aggregate(
      [
        rec({ id: '1', role: 'main', input: 10 }),
        rec({ id: '2', role: 'developer', input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }),
        rec({ id: '3', role: 'developer', input: 1 }),
      ],
      prices,
    );
    expect(rows.map((r) => r.role)).toEqual(['developer', 'main']);
    expect(rows[0]).toMatchObject({ input: 2, output: 2, cacheWrite: 3, cacheRead: 4 });
  });

  it('runs = distinct contributing files per role', () => {
    const rows = aggregate(
      [
        rec({ id: '1', role: 'dev', file: 'a' }),
        rec({ id: '2', role: 'dev', file: 'a' }),
        rec({ id: '3', role: 'dev', file: 'b' }),
        rec({ id: '4', role: 'main', file: 'c' }),
      ],
      prices,
    );
    expect(rows.find((r) => r.role === 'dev')?.runs).toBe(2);
    expect(rows.find((r) => r.role === 'main')?.runs).toBe(1);
  });

  it('usd = sum tokens/1e6 x per-model rate', () => {
    const p: Prices = {
      m: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
      n: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
    };
    const [row] = aggregate(
      [
        rec({ id: '1', model: 'm', input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 }),
        rec({ id: '2', model: 'n', input: 500_000 }),
      ],
      p,
    );
    expect(row.usd).toBeCloseTo(10 + 5, 9);
  });

  it('1h cache writes priced at 2x input; remainder at cacheWrite rate', () => {
    const [row] = aggregate(
      [rec({ id: '1', cacheWrite: 1_000_000, cacheWrite1h: 400_000 })],
      prices,
    );
    // 600k x 3 + 400k x 2 x 1 = 2.6
    expect(row.usd).toBeCloseTo(2.6, 9);
    expect(row.cacheWrite).toBe(1_000_000);
  });

  it('unknown model -> usd null, tokens still counted', () => {
    const [row] = aggregate(
      [rec({ id: '1', input: 1_000_000 }), rec({ id: '2', model: 'mystery', input: 7 })],
      prices,
    );
    expect(row.usd).toBeNull();
    expect(row.input).toBe(1_000_007);
  });

  it('empty input -> no rows', () => {
    expect(aggregate([], prices)).toEqual([]);
  });
});

const row = (role: string, n: number, usd: number | null) => ({
  role, runs: n, input: n * 1000, output: n * 10, cacheWrite: n, cacheRead: n * 100000, usd,
});

describe('render', () => {
  it('heading, header row, one row per role, plain integers, $ 2 decimals', () => {
    const out = render('P1', [row('developer', 2, 1.005), row('main', 1, 0.5)]);
    expect(out).toContain('## Phase P1');
    expect(out).toContain('| Role | Runs | Input | Output | Cache write | Cache read | Est. USD |');
    expect(out).toContain('| developer | 2 | 2000 | 20 | 2 | 200000 |');
    expect(out).toContain('| main | 1 | 1000 | 10 | 1 | 100000 | $0.50 |');
    expect(out).not.toMatch(/\d,\d{3}/);
  });

  it('n/a for null usd', () => {
    const out = render('P', [row('x', 1, null)]);
    expect(out).toMatch(/\| x \| 1 \| 1000 \| 10 \| 1 \| 100000 \| n\/a \|/);
  });

  it('Total row sums all columns', () => {
    const out = render('P', [row('a', 1, 1.25), row('b', 2, 2.5)]);
    expect(out).toContain('| **Total** | 3 | 3000 | 30 | 3 | 300000 | $3.75 |');
  });

  it('Total USD is n/a if any row is n/a', () => {
    const out = render('P', [row('a', 1, 1), row('b', 1, null)]);
    expect(out).toMatch(/\| \*\*Total\*\* \| 2 \| 2000 \| 20 \| 2 \| 200000 \| n\/a \|/);
  });
});

describe('PRICES', () => {
  it('is non-empty with four numeric keys per entry', () => {
    const entries = Object.entries(PRICES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, p] of entries)
      for (const k of ['input', 'output', 'cacheWrite', 'cacheRead'] as const)
        expect(typeof p[k]).toBe('number');
  });
});

describe('main', () => {
  const run = (argv: string[], p: Prices = prices) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, p);
    return { code, out: out.join(''), err };
  };

  it('prints the rendered table and returns 0', () => {
    main_('s1', [line('a', T, { i: 1_000_000 })]);
    const r = run(['--phase', 'P0', '--since', '2026-01-01T00:00:00Z', '--until', '2026-02-01T00:00:00Z', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('## Phase P0');
    expect(r.out).toContain('| main | 1 | 1000000 | 0 | 0 | 0 | $1.00 |');
    expect(r.err).toEqual([]);
  });

  it('until defaults to now', () => {
    main_('s1', [line('a', T, { i: 1 })]);
    const r = run(['--phase', 'P0', '--since', '2026-01-01T00:00:00Z', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('| main | 1 | 1 |');
  });

  it('respects explicit --until', () => {
    main_('s1', [line('a', T, { i: 1 })]);
    const r = run(['--phase', 'P0', '--since', '2026-01-01T00:00:00Z', '--until', '2026-01-05T00:00:00Z', dir]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('| main |');
  });

  it.each([
    ['missing --phase', ['--since', '2026-01-01T00:00:00Z', 'DIR'], '--phase'],
    ['missing --since', ['--phase', 'P', 'DIR'], '--since'],
    ['bad --since', ['--phase', 'P', '--since', 'garbage', 'DIR'], '--since'],
    ['bad --until', ['--phase', 'P', '--since', '2026-01-01T00:00:00Z', '--until', 'nope', 'DIR'], '--until'],
    ['no dirs', ['--phase', 'P', '--since', '2026-01-01T00:00:00Z'], ''],
  ])('returns 1 with one err line: %s', (_n, argv, needle) => {
    const r = run(argv.map((a) => (a === 'DIR' ? dir : a)));
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain(needle);
    expect(r.out).toBe('');
  });

  it('returns 1 naming a nonexistent dir', () => {
    const ghost = join(dir, 'does-not-exist');
    const r = run(['--phase', 'P', '--since', '2026-01-01T00:00:00Z', ghost]);
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain(ghost);
  });
});
