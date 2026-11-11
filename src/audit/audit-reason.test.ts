/*
 * R14: AuditReason is a closed union. The type-level legs are enforced by `npm run typecheck`
 * (an unused @ts-expect-error is a compile error); the runtime leg checks every member is emitted unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createAudit, type AuditInput, type AuditReason } from './index.ts';

const T = Date.parse('2030-01-01T00:00:00.000Z');
const lines: string[] = [];
const audit = createAudit({ destination: { write: (s) => void lines.push(s) }, now: () => T });
const base = { tool: 't', env: 'test', outcome: 'error', durationMs: 0 } as const satisfies AuditInput;

const MEMBERS = [
  'env', 'role', 'write', 'scope',
  'malformed', 'unknown', 'expired', 'revoked',
  'config', 'tls', 'auth', 'forbidden', 'agreement_not_found', 'route_not_found', 'bad_request', 'validation_failed', 'conflict',
  'rate_limited', 'upstream', 'timeout', 'too_large', 'schema', 'write_blocked', 'token_format', 'request_invalid',
  'write_guard', 'error',
] as const satisfies readonly AuditReason[];

describe('AuditReason closed union', () => {
  it('rejects arbitrary strings at the type level', () => {
    // @ts-expect-error free text is not an AuditReason
    audit.record({ ...base, reason: 'free text' });
    const wide: `${string}` = 'x';
    // @ts-expect-error a plain string is not an AuditReason
    audit.record({ ...base, reason: wide });
    // @ts-expect-error a template-literal string is not an AuditReason
    const r: AuditReason = `smcp_${wide}`;
    expect(r).toBeTypeOf('string');
  });

  it('has exactly the documented members (compile-time exhaustiveness)', () => {
    type Missing = Exclude<AuditReason, (typeof MEMBERS)[number]>;
    const exhaustive: [Missing] extends [never] ? true : false = true; // compile error when a member is not listed
    expect(exhaustive).toBe(true);
    expect(MEMBERS).toHaveLength(27);
    expect(new Set(MEMBERS).size).toBe(27);
  });

  it.each(MEMBERS)('member %s is emitted unchanged', (reason) => {
    lines.length = 0;
    expect(audit.record({ ...base, reason }).reason).toBe(reason);
    expect(JSON.parse(lines.join(''))).toMatchObject({ reason });
  });
});
