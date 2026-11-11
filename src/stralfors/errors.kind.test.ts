/*
 * R17: StralforsError.kind is a literal union at the source. The type legs are enforced by `npm run typecheck`
 * (a missing export or an unused @ts-expect-error is a compile error); the runtime legs pin the 17 kinds.
 */
import { describe, expect, it } from 'vitest';
import { StralforsError, type StralforsErrorKind } from './errors.ts';
import { KINDS, exportedKindClasses } from '../../test/helpers/kinds.ts';

const props = { violations: [], faults: [], issues: [], fields: [] };

describe('StralforsErrorKind', () => {
  it('every class instance has a kind assignable to the union (compile-time) and equal to its literal', () => {
    for (const [C, kind] of KINDS) {
      const k: StralforsErrorKind = new C('m', props).kind;
      expect(k).toBe(kind);
    }
  });

  it('the table covers every exported subclass exactly once and the kinds are distinct', () => {
    expect(KINDS).toHaveLength(17);
    expect(exportedKindClasses()).toHaveLength(17);
    expect(new Set(KINDS.map(([C]) => C)).size).toBe(17);
    expect(new Set(KINDS.map(([, k]) => k)).size).toBe(17);
    for (const C of exportedKindClasses()) expect(KINDS.some(([K]) => K === C)).toBe(true);
  });

  it('a Record over the union is exhaustive (drift on either side fails to compile)', () => {
    const all: Record<StralforsErrorKind, true> = {
      config: true, tls: true, auth: true, forbidden: true, agreement_not_found: true, route_not_found: true, bad_request: true,
      validation_failed: true, conflict: true, rate_limited: true, upstream: true, timeout: true, too_large: true, schema: true,
      write_blocked: true, token_format: true, request_invalid: true,
    };
    expect(Object.keys(all).sort()).toEqual(KINDS.map(([, k]) => k).sort());
  });

  it('toJSON keeps the kind', () => {
    for (const [C, kind] of KINDS) expect(new C('m', props).toJSON().kind).toBe(kind);
  });

  it('the base constructor rejects an unknown kind at the type level', () => {
    // @ts-expect-error 'typo' is not a StralforsErrorKind
    const e = new StralforsError('typo', 'm');
    expect(e).toBeInstanceOf(StralforsError);
  });
});
