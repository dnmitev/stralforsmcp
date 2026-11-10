// Mutation-hardening for src/audit/audit.ts: mask boundaries, ts from the injected clock, optional-key handling, key order independence.
import { describe, expect, it } from 'vitest';
import { createAudit, mask } from './index.ts';

describe('mask boundaries', () => {
  it('15 vs 16 vs 17 chars', () => {
    expect(mask('a'.repeat(15))).toBe('…');
    expect(mask('abcd' + 'x'.repeat(8) + 'wxyz')).toBe('abcd…wxyz');
    expect(mask('abcd' + 'x'.repeat(9) + 'wxyz')).toBe('abcd…wxyz');
  });
  it('first and last four are distinct slices', () => {
    expect(mask('1234abcdefgh5678')).toBe('1234…5678');
  });
});

describe('record', () => {
  const make = (now: () => number) => {
    const out: string[] = [];
    return { audit: createAudit({ destination: { write: (s) => void out.push(s) }, now }), out };
  };
  it('ts follows the injected clock on every call', () => {
    let t = 0;
    const { audit, out } = make(() => t);
    audit.record({ tool: 'a', env: 'test', outcome: 'allowed', durationMs: 0 });
    t = 86_400_000;
    audit.record({ tool: 'a', env: 'test', outcome: 'allowed', durationMs: 0 });
    expect(out.map((l) => JSON.parse(l).ts)).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-02T00:00:00.000Z']);
  });
  it('no time, pid, hostname, msg or name in the line', () => {
    const { audit, out } = make(() => 0);
    audit.record({ tool: 'a', env: 'test', outcome: 'allowed', durationMs: 0 });
    const keys = Object.keys(JSON.parse(out[0]!));
    for (const k of ['time', 'pid', 'hostname', 'msg', 'name']) expect(keys).not.toContain(k);
  });
  it('durationMs 0 is written, absent reason and traceId are omitted (not null)', () => {
    const { audit, out } = make(() => 0);
    const ev = audit.record({ tool: 'a', env: 'prod', outcome: 'error', durationMs: 0 });
    const line = JSON.parse(out[0]!);
    expect(line.durationMs).toBe(0);
    expect('reason' in line || 'traceId' in line).toBe(false);
    expect('reason' in ev || 'traceId' in ev).toBe(false);
  });
  it('log.type is audit on every outcome', () => {
    const { audit, out } = make(() => 0);
    for (const outcome of ['allowed', 'denied', 'blocked', 'error'] as const) audit.record({ tool: 'a', env: 'test', outcome, durationMs: 0 });
    expect(out.map((l) => JSON.parse(l)['log.type'])).toEqual(['audit', 'audit', 'audit', 'audit']);
  });
  it('principal.name and envs are never written even with identical-looking values', () => {
    const { audit, out } = make(() => 0);
    audit.record({ principal: { userId: 'u', name: 'u', role: 'dev', envs: ['test'] }, tool: 'a', env: 'test', outcome: 'allowed', durationMs: 0 });
    expect(Object.keys(JSON.parse(out[0]!)).sort()).toEqual(['durationMs', 'env', 'level', 'log.type', 'outcome', 'role', 'tool', 'ts', 'userId']);
  });
});
