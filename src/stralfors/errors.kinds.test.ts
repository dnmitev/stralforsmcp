// XS: the kind union is defined once in errors.ts (runtime list) and the type derives from it; KIND_TEXT covers every kind.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { STRALFORS_ERROR_KINDS, type StralforsErrorKind } from './errors.ts';
import { KIND_TEXT } from '../server/tools.ts';

describe('StralforsErrorKind', () => {
  it('type is derived from the runtime list', () => {
    expectTypeOf<StralforsErrorKind>().toEqualTypeOf<(typeof STRALFORS_ERROR_KINDS)[number]>();
  });
  it('lists the 17 kinds, unique', () => {
    expect(new Set(STRALFORS_ERROR_KINDS).size).toBe(STRALFORS_ERROR_KINDS.length);
    expect([...STRALFORS_ERROR_KINDS].sort()).toEqual([
      'agreement_not_found', 'auth', 'bad_request', 'config', 'conflict', 'forbidden', 'rate_limited', 'request_invalid', 'route_not_found',
      'schema', 'timeout', 'tls', 'token_format', 'too_large', 'upstream', 'validation_failed', 'write_blocked',
    ]);
  });
  it('KIND_TEXT covers every kind', () => {
    for (const k of STRALFORS_ERROR_KINDS) expect(KIND_TEXT(k)).toBe(`tool failed: ${k}`);
  });
});
