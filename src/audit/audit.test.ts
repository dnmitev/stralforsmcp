/*
 * R6 audit. API under test (src/audit/index.ts): mask, createAudit({ destination, now }).record(input): AuditEvent, fromBlocked(e), AUDIT_KEYS.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/index.ts';
import { AUDIT_KEYS, createAudit, fromBlocked, mask, type AuditInput } from './index.ts';
import { startFakeApi, testClient } from '../../test/helpers/api.ts';
import { generatePki } from '../../test/helpers/mtls.ts';

const T = Date.parse('2030-01-01T00:00:00.000Z');
const p: Principal = { userId: 'u1', name: 'NAME-CANARY', role: 'qa', envs: ['test'] };
const sink = () => {
  const chunks: string[] = [];
  const audit = createAudit({ destination: { write: (s) => void chunks.push(s) }, now: () => T });
  return { audit, chunks, text: () => chunks.join(''), lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
};

describe('mask', () => {
  it.each([
    ['11111111-2222-4333-8444-555555555555', '1111…5555'],
    ['abcdefghijklmnop', 'abcd…mnop'],
    ['abcdefghijklmno', '…'],
    ['consign-01', '…'],
    ['abcd', '…'],
    ['', '…'],
  ])('mask(%j) = %j', (i, o) => expect(mask(i)).toBe(o));

  it('never contains the middle', () => {
    for (let len = 16; len <= 54; len++) {
      const s = randomBytes(40).toString('base64url').slice(0, len);
      const m = mask(s);
      expect(m).toHaveLength(9);
      expect(m.startsWith(s.slice(0, 4)) && m.endsWith(s.slice(-4))).toBe(true);
      expect(m).not.toContain(s.slice(4, -4));
    }
  });
});

describe('audit events', () => {
  it('allowed call: exactly the allowlist keys', () => {
    const { audit, lines, text } = sink();
    const ev = audit.record({ principal: p, tool: 'list_channels', env: 'test', outcome: 'allowed', durationMs: 12, traceId: '00-abc-def-00' });
    expect(lines()).toHaveLength(1);
    const { level, ...line } = lines()[0]!;
    expect(typeof level).toBe('number');
    expect(Object.keys(line).sort()).toEqual(['log.type', 'ts', 'userId', 'role', 'tool', 'env', 'outcome', 'durationMs', 'traceId'].sort());
    expect(line).toEqual({ 'log.type': 'audit', ts: new Date(T).toISOString(), userId: 'u1', role: 'qa', tool: 'list_channels', env: 'test', outcome: 'allowed', durationMs: 12, traceId: '00-abc-def-00' });
    expect(text()).not.toMatch(/NAME-CANARY|envs/);
    const { 'log.type': _lt, ...expected } = line;
    expect(ev).toEqual(expected);
  });

  it('AUDIT_KEYS is the documented allowlist', () => {
    expect([...AUDIT_KEYS]).toEqual(['ts', 'userId', 'role', 'tool', 'env', 'outcome', 'reason', 'durationMs', 'traceId']);
  });

  it('denied with reason, no traceId key', () => {
    const { audit, lines } = sink();
    audit.record({ principal: p, tool: 'send_invoice', env: 'test', outcome: 'denied', reason: 'write', durationMs: 0 });
    expect(lines()[0]).toMatchObject({ reason: 'write' });
    expect(lines()[0]).not.toHaveProperty('traceId');
  });

  it('unauthenticated attempt is anonymous', () => {
    const { audit, lines } = sink();
    audit.record({ tool: 'list_channels', env: 'test', outcome: 'denied', reason: 'expired', durationMs: 0 });
    expect(lines()[0]).toMatchObject({ userId: 'anonymous', role: 'anonymous', reason: 'expired' });
  });

  it('error outcome carries the kind only', () => {
    const { audit, lines } = sink();
    audit.record({ principal: p, tool: 'validate_invoice', env: 'test', outcome: 'error', reason: 'validation_failed', durationMs: 340 });
    expect(lines()[0]).toMatchObject({ outcome: 'error', reason: 'validation_failed', durationMs: 340 });
  });

  it('fromBlocked maps to blocked and drops the profile', () => {
    const { audit, lines } = sink();
    const path = '/rest/outputmanagement/apiomni/v2/invoices/true';
    expect(fromBlocked({ profile: 'a', method: 'POST', pathTemplate: path })).toEqual({ tool: `POST ${path}`, outcome: 'blocked', reason: 'write_guard', durationMs: 0 });
    audit.record({ ...fromBlocked({ profile: 'a', method: 'POST', pathTemplate: path }), principal: p, env: 'test' });
    expect(lines()[0]).toMatchObject({ outcome: 'blocked', reason: 'write_guard', tool: `POST ${path}`, durationMs: 0 });
    expect(lines()[0]).not.toHaveProperty('profile');
  });

  it('fromBlocked replaces identifiers in path segments, keeps known route words and drops the query', () => {
    const id = randomUUID();
    expect(fromBlocked({ profile: 'a', method: 'POST', pathTemplate: `/rest/agreements/${id}/x?actionId=*&test=*` }).tool).toBe('POST /rest/*/*/*');
    expect(fromBlocked({ profile: 'a', method: 'POST', pathTemplate: '/rest/outputmanagement?agreement-123=*' }).tool).toBe('POST /rest/outputmanagement');
    expect(fromBlocked({ profile: 'a', method: 'DELETE', pathTemplate: `/rest/outputmanagement/apiomni/v2/invoices/${id}` }).tool).toBe('DELETE /rest/outputmanagement/apiomni/v2/invoices/*');
    expect(fromBlocked({ profile: 'a', method: 'POST', pathTemplate: `/rest/${id}` }).tool).not.toContain(id);
  });

  it('extra properties are never copied', () => {
    const { audit, text, lines } = sink();
    audit.record({ principal: p, tool: 't', env: 'test', outcome: 'allowed', durationMs: 1, args: { actionId: 'ID-CANARY' }, body: 'BODY-CANARY', consignmentId: 'CONS-CANARY', headers: { authorization: 'TOK-CANARY' } } as AuditInput);
    expect(text()).not.toMatch(/CANARY/);
    expect(Object.keys(lines()[0]!).filter((k) => !['level', ...AUDIT_KEYS, 'log.type'].includes(k))).toEqual([]);
  });

  it('canary sweep over every outcome', () => {
    const { audit, text } = sink();
    const c = ['name', 'token', 'digest', 'agreement', 'consignment', 'payload'].map((x) => `CANARY-${x}-${randomUUID()}`);
    const principal = { ...p, name: c[0]! };
    for (const outcome of ['allowed', 'denied', 'blocked', 'error'] as const) {
      audit.record({ principal, tool: 'tool', env: 'test', outcome, reason: 'write', durationMs: 1, raw: c[1], digest: c[2], actionId: c[3], consignmentId: c[4], payload: c[5] } as AuditInput);
    }
    for (const x of c) expect(text()).not.toContain(x);
  });

  it('two events, two newline-terminated lines', () => {
    const { audit, text } = sink();
    for (let i = 0; i < 2; i++) audit.record({ tool: 't', env: 'prod', outcome: 'allowed', durationMs: i });
    expect(text().split('\n')).toHaveLength(3);
    expect(text().endsWith('\n')).toBe(true);
  });

  it('client wiring: prod write blocked reaches the audit sink, server sees nothing', async () => {
    const pki = generatePki();
    const srv = await startFakeApi({ pki });
    const { audit, lines } = sink();
    const { client } = testClient(pki, srv, { extra: { STRALFORS_ENV: 'prod' }, onBlocked: (e) => void audit.record({ ...fromBlocked(e), principal: { ...p, role: 'dev', envs: ['prod'] }, env: 'prod' }) });
    await expect(client.post('/rest/outputmanagement/apiomni/v2/invoices/true', {})).rejects.toMatchObject({ name: 'WriteBlockedError' });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ outcome: 'blocked', env: 'prod' });
    expect(srv.requests).toHaveLength(0);
    await client.close();
    await srv.close();
    pki.cleanup();
  });
});
