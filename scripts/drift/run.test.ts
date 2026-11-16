import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { UpstreamError } from '../../src/stralfors/index.ts';
import type { RuleNode } from '../../src/stralfors/rules.ts';
import { outDirOk, runDrift, type Baseline } from './run.ts';

const CANARY = 'CANARY-vendor-text-9f3a';
const tree = (extra: string[] = []): RuleNode[] => [{ id: '1', parameter: 'Document.A', ruleCriterias: ['Required', `ValidationCriteria: ${CANARY}`, ...extra], expectedPattern: '^x$' }];
function fake(over: { version?: string; channels?: string[]; trees?: Record<string, RuleNode[]>; fail?: 'rules' } = {}) {
  const calls: string[] = [];
  const channels = over.channels ?? ['ChanA', `${CANARY}-chan`];
  return {
    calls,
    client: {
      apiInfo: async () => { calls.push('apiInfo'); return { version: over.version ?? '2.0', name: CANARY }; },
      channels: async () => { calls.push('channels'); return channels; },
      templates: async () => { calls.push('templates'); return [{ standardId: 1, type: { name: CANARY } }]; },
      rules: async (c: string) => { calls.push('rules'); if (over.fail === 'rules') throw new UpstreamError('boom'); return { channel: c, rules: over.trees?.[c] ?? tree() }; },
    } as never,
  };
}
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'drift-')); dirs.push(d); return d; };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('runDrift', () => {
  it('no drift: no findings, only the four read methods are called', async () => {
    const f = fake();
    const r = await runDrift({ client: f.client, env: 'test' });
    expect(r.findings).toEqual([]);
    expect(new Set(f.calls)).toEqual(new Set(['apiInfo', 'channels', 'templates', 'rules']));
    expect(r.report).toContain('findings: none');
    expect(r.report).toContain('version skipped');
  });
  it('each drift class is reported', async () => {
    const f = fake({ version: '3.0', trees: { ChanA: tree(['BrandNew: x']) } });
    const r = await runDrift({ client: f.client, env: 'test' }, { expectVersion: '2.0', expectChannels: ['ChanA', 'Gone'] });
    const checks = r.findings.map((x) => x.check);
    expect(checks).toEqual(expect.arrayContaining(['api-version', 'channel-new', 'channel-missing', 'unknown-criterion']));
  });
  it('a failing fetch becomes a finding with the error kind only', async () => {
    const r = await runDrift({ client: fake({ fail: 'rules' }).client, env: 'test' });
    expect(r.findings.some((x) => x.check === 'fetch-failed')).toBe(true);
    expect(r.report).toMatch(/fetch-failed rules: \w+/);
  });
  it('baseline: round trip is clean, changed prose / new template / new channel are drift', async () => {
    const first = await runDrift({ client: fake().client, env: 'test' });
    const same = await runDrift({ client: fake().client, env: 'test' }, { baseline: first.baseline });
    expect(same.findings).toEqual([]);
    const changed = await runDrift({ client: fake({ trees: { ChanA: [{ id: '1', parameter: 'Document.A', ruleCriterias: ['ValidationCriteria: other'] }] } }).client, env: 'test' }, { baseline: first.baseline });
    expect(changed.findings.map((x) => x.check)).toContain('criteria-changed');
    const older: Baseline = { ...first.baseline, templates: [], channels: ['ChanA'] };
    const grown = await runDrift({ client: fake().client, env: 'test' }, { baseline: older });
    expect(grown.findings.map((x) => x.check)).toEqual(expect.arrayContaining(['template-new', 'channel-new']));
  });
  it('standing unknown kinds are drift only when their count changes against the baseline', async () => {
    const withUnknown = (n: number) => fake({ trees: { ChanA: [{ id: '1', parameter: 'Document.A', ruleCriterias: Array.from({ length: n }, (_, i) => `Brand${i}: x`) }] } }).client;
    const first = await runDrift({ client: withUnknown(2), env: 'test' });
    expect(first.findings).toEqual([{ check: 'unknown-criterion', count: 2 }]);
    expect((await runDrift({ client: withUnknown(2), env: 'test' }, { baseline: first.baseline })).findings).toEqual([]);
    expect((await runDrift({ client: withUnknown(3), env: 'test' }, { baseline: first.baseline })).findings).toEqual([{ check: 'unknown-criterion', count: 1 }]);
  });
  it('report and baseline carry no vendor text, names or rule hashes in the report', async () => {
    const r = await runDrift({ client: fake().client, env: 'test' }, { expectChannels: [] });
    expect(r.report).not.toContain(CANARY);
    expect(JSON.stringify(r.baseline)).not.toContain('ValidationCriteria');
  });
});

describe('outDirOk', () => {
  const repo = resolve('/repo/x');
  it.each([[undefined, false], ['', false], ['relative/dir', false], ['/repo/x', false], ['/repo/x/reports', false], ['/repo/xy', true], ['/elsewhere/drift', true], ['/repo', true]])('%s -> %s', (p, ok) => expect(outDirOk(p, repo)).toBe(ok));
});

describe('main (spawned)', () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [resolve(import.meta.dirname, 'run.ts')], { env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' });
  it.each([['unset', {}], ['relative', { DRIFT_OUT: 'out' }], ['inside the repo', { DRIFT_OUT: resolve(import.meta.dirname, '../../reports/drift') }]])('refuses when DRIFT_OUT is %s, before any config or request', (_n, env) => {
    const r = run(env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DRIFT_OUT must be an absolute path');
  });
  it('a valid DRIFT_OUT without credentials fails on config and writes nothing', () => {
    const d = tmp();
    const r = run({ DRIFT_OUT: d });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('DRIFT_OUT must');
    expect(readdirSync(d)).toEqual([]);
  });
});
