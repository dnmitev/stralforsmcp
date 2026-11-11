/*
 * R33 audit correlation (pure part). API under test (src/audit/audit.ts): createAudit({ destination, now, otelTraceId? }); AUDIT_KEYS has one more key, 'trace_id'.
 * `traceId` stays the vendor's request id; `trace_id` is this server's OTel trace id. The audit module imports no OTel package.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUDIT_KEYS, createAudit, type AuditInput } from './index.ts';
import { T } from '../../test/helpers/token-list.ts';

const mk = (otelTraceId?: () => string | undefined) => {
  const chunks: string[] = [];
  const audit = createAudit({ destination: { write: (s) => void chunks.push(s) }, now: () => T, ...(otelTraceId ? { otelTraceId } : {}) });
  return { audit, lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
};
const base: AuditInput = { tool: 't', env: 'test', outcome: 'allowed', durationMs: 1 };
const TRACE = 'a'.repeat(32);

describe('audit trace_id', () => {
  it('AUDIT_KEYS grows by exactly trace_id, in this order', () => {
    expect([...AUDIT_KEYS]).toEqual(['ts', 'userId', 'role', 'tool', 'env', 'outcome', 'reason', 'durationMs', 'traceId', 'trace_id']);
  });

  it('trace_id is written only when the injected source returns a string', () => {
    const { audit, lines } = mk(() => TRACE);
    const ev = audit.record(base);
    expect(lines()[0]!.trace_id).toBe(TRACE);
    expect(ev.trace_id).toBe(TRACE);
    expect('span_id' in lines()[0]!).toBe(false);
  });

  it.each([[undefined], [null], ['']])('source returning %j: no trace_id key at all', (v) => {
    const { audit, lines } = mk(() => v as string | undefined);
    audit.record(base);
    // '' is a string but not an id: never written; null/undefined never written
    expect('trace_id' in lines()[0]!).toBe(false);
  });

  it('no source: byte-identical shape to 02-03 (no trace_id key)', () => {
    const { audit, lines } = mk();
    audit.record(base);
    expect('trace_id' in lines()[0]!).toBe(false);
  });

  it('the source is consulted per record', () => {
    let n = 0;
    const { audit, lines } = mk(() => (n++ % 2 === 0 ? TRACE : undefined));
    audit.record(base);
    audit.record(base);
    audit.record(base);
    expect(lines().map((l) => l.trace_id)).toEqual([TRACE, undefined, TRACE]);
  });

  it('both ids side by side: vendor traceId untouched, trace_id the OTel one, exactly the documented keys', () => {
    const vendor = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00`;
    const { audit, lines } = mk(() => TRACE);
    audit.record({ ...base, outcome: 'error', reason: 'error', traceId: vendor });
    const l = lines()[0]!;
    expect(l.traceId).toBe(vendor);
    expect(l.trace_id).toBe(TRACE);
    expect(Object.keys(l).filter((k) => k !== 'level').sort()).toEqual(['durationMs', 'env', 'log.type', 'outcome', 'reason', 'role', 'trace_id', 'traceId', 'ts', 'tool', 'userId'].sort());
  });

  it('callers cannot pass trace_id through the input (extra keys are never copied)', () => {
    const { audit, lines } = mk();
    audit.record({ ...base, trace_id: 'x'.repeat(32) } as AuditInput);
    expect('trace_id' in lines()[0]!).toBe(false);
  });

  it('the module imports no OTel package', () => {
    expect(readFileSync(new URL('./audit.ts', import.meta.url), 'utf8')).not.toContain('@opentelemetry');
  });
});
