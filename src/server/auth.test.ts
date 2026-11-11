/*
 * R9 authenticate / toAuthInfo. API under test (src/server/auth.ts): authenticate(header, store, at?), toAuthInfo(principal, expiresAtMs), UNAUTHORIZED_BODY, WWW_AUTHENTICATE.
 */
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, type TokenStore } from '../auth/index.ts';
import { UNAUTHORIZED_BODY, WWW_AUTHENTICATE, authenticate, toAuthInfo } from './auth.ts';
import { world } from '../../test/helpers/server.ts';
import { DAY, T } from '../../test/helpers/token-list.ts';

describe('R9 constants', () => {
  it('are the exact fixed bytes', () => {
    expect(UNAUTHORIZED_BODY).toBe('{"error":"invalid_token"}');
    expect(WWW_AUTHENTICATE).toBe('Bearer error="invalid_token"');
  });
});

describe('authenticate', () => {
  it('valid header gives an AuthInfo without token material', () => {
    const w = world();
    const r = authenticate(`Bearer ${w.tA}`, w.store, T);
    expect(r).toEqual({
      ok: true,
      authInfo: { token: '', clientId: 'u1', scopes: [], expiresAt: Math.floor((T + 30 * DAY) / 1000), extra: { principal: { userId: 'u1', name: 'User One', role: 'dev', envs: ['test', 'prod'] } } },
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain(w.tA);
    expect(json).not.toContain(hashToken(w.tA));
    if (r.ok) expect('resource' in r.authInfo).toBe(false);
  });

  it('at defaults to the store clock', () => {
    const w = world();
    expect(authenticate(`Bearer ${w.tA}`, w.store).ok).toBe(true);
  });

  const cases = (w: ReturnType<typeof world>): [string, string | undefined, string][] => [
    ['absent', undefined, 'malformed'],
    ['empty', '', 'malformed'],
    ['Basic scheme', `Basic ${w.tA}`, 'malformed'],
    ['no scheme', w.tA, 'malformed'],
    ['scheme only', 'Bearer', 'malformed'],
    ['two spaces', `Bearer  ${w.tA}`, 'malformed'],
    ['extra part', `Bearer ${w.tA} x`, 'malformed'],
    ['trailing space', `Bearer ${w.tA} `, 'malformed'],
    ['tab separator', `Bearer\t${w.tA}`, 'malformed'],
    ['42 chars', `Bearer smcp_${generateToken().slice(5, 47)}`, 'malformed'],
    ['unknown', `Bearer ${generateToken()}`, 'unknown'],
    ['revoked', `Bearer ${w.tRevoked}`, 'revoked'],
    ['expired', `Bearer ${w.tExpired}`, 'expired'],
    ['not yet valid', `Bearer ${w.tFuture}`, 'expired'],
  ];
  it.each(cases(world()).map((c) => c[0]))('failure %s maps to exactly one code', (name) => {
    const w = world();
    const c = cases(w).find((x) => x[0] === name)!;
    expect(authenticate(c[1], w.store, T)).toEqual({ ok: false, code: c[2] });
  });

  it('scheme is case-insensitive', () => {
    const w = world();
    expect(authenticate(`bearer ${w.tA}`, w.store, T).ok).toBe(true);
    expect(authenticate(`BEARER ${w.tA}`, w.store, T).ok).toBe(true);
  });

  it('never throws: a throwing store yields unknown', () => {
    const w = world();
    const bad = { ...w.store, verify: () => { throw new Error('boom'); } } as TokenStore;
    expect(authenticate(`Bearer ${w.tA}`, bad, T)).toEqual({ ok: false, code: 'unknown' });
  });

  it('a malformed header calls verify with the empty string (A13)', () => {
    const w = world();
    const seen: string[] = [];
    const spy = { ...w.store, verify: (raw: string, at?: number) => (seen.push(raw), w.store.verify(raw, at)) } as TokenStore;
    authenticate('Basic abc', spy, T);
    authenticate(undefined, spy, T);
    expect(seen).toEqual(['', '']);
  });
});

describe('toAuthInfo', () => {
  const p = { userId: 'u9', name: 'N', role: 'qa', envs: ['test'] } as const;
  it('shape and seconds unit', () => {
    expect(toAuthInfo({ ...p, envs: ['test'] }, 1_893_456_001_999)).toEqual({ token: '', clientId: 'u9', scopes: [], expiresAt: 1_893_456_001, extra: { principal: p } });
  });
  it('floors, never rounds', () => {
    expect(toAuthInfo({ ...p, envs: ['test'] }, 1999).expiresAt).toBe(1);
    expect(toAuthInfo({ ...p, envs: ['test'] }, 2000).expiresAt).toBe(2);
    expect(toAuthInfo({ ...p, envs: ['test'] }, 1000).expiresAt).toBe(1);
  });
});
