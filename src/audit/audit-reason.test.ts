/*
 * R14: AuditReason is a closed union. The type-level legs are enforced by `npm run typecheck`
 * (an unused @ts-expect-error is a compile error); the runtime leg checks every member is emitted unchanged.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAudit, type AuditInput, type AuditReason } from './index.ts';

const T = Date.parse('2030-01-01T00:00:00.000Z');
const lines: string[] = [];
const audit = createAudit({ destination: { write: (s) => void lines.push(s) }, now: () => T });
const base = { tool: 't', env: 'test', outcome: 'error', durationMs: 0 } as const satisfies AuditInput;

const MEMBERS = [
  'env', 'role', 'write', 'validate', 'scope',
  'malformed', 'unknown', 'expired', 'revoked',
  'config', 'tls', 'auth', 'forbidden', 'agreement_not_found', 'route_not_found', 'bad_request', 'validation_failed', 'conflict',
  'rate_limited', 'upstream', 'timeout', 'too_large', 'schema', 'write_blocked', 'token_format', 'request_invalid',
  'write_guard', 'error', 'bad_input',
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
    expect(MEMBERS).toHaveLength(29);
    expect(new Set(MEMBERS).size).toBe(29);
  });

  it('is derived from the client error kinds, not copied (R17)', () => {
    const src = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8');
    expect(src).not.toContain("'agreement_not_found'");
    expect(src).toMatch(/import type \{[^}]*StralforsErrorKind[^}]*\} from '\.\.\/stralfors\/errors\.ts'/);
  });

  it('the union is exactly the documented record (no member on either side without the other)', () => {
    const all: Record<AuditReason, true> = {
      env: true, role: true, write: true, validate: true, scope: true, malformed: true, unknown: true, expired: true, revoked: true,
      config: true, tls: true, auth: true, forbidden: true, agreement_not_found: true, route_not_found: true, bad_request: true,
      validation_failed: true, conflict: true, rate_limited: true, upstream: true, timeout: true, too_large: true, schema: true,
      write_blocked: true, token_format: true, request_invalid: true, write_guard: true, error: true, bad_input: true,
    };
    expect(Object.keys(all).sort()).toEqual([...MEMBERS].sort());
  });

  it.each(MEMBERS)('member %s is emitted unchanged', (reason) => {
    lines.length = 0;
    expect(audit.record({ ...base, reason }).reason).toBe(reason);
    expect(JSON.parse(lines.join(''))).toMatchObject({ reason });
  });
});
