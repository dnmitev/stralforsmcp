/*
 * R8: verify's ok branch carries expiresAt (ms epoch of the token's `expires`) and nothing else new.
 */
import { describe, expect, it } from 'vitest';
import { createTokenStore } from './index.ts';
import { DAY, T, entry, fixture, iso } from '../../test/helpers/token-list.ts';

const store = (f = fixture(), now = T) => createTokenStore({ read: () => f.file.content, now: () => now, setTimer: () => 'h', clearTimer: () => undefined, log: { warn: () => undefined, info: () => undefined } });

describe('R8 expiresAt', () => {
  it('equals Date.parse(expires) and the ok branch has exactly ok, principal, expiresAt', () => {
    const f = fixture();
    const r = store(f).verify(f.raw.tA);
    expect(r).toEqual({ ok: true, principal: { userId: 'u1', name: 'User One', role: 'dev', envs: ['test', 'prod'] }, expiresAt: T + 30 * DAY });
    expect(Object.keys(r).sort()).toEqual(['expiresAt', 'ok', 'principal']);
  });

  it('is the per-token instant, not a constant', () => {
    const f = fixture();
    const r = store(f).verify(f.raw.tC);
    expect(r).toMatchObject({ ok: true, expiresAt: T + 1000 });
  });

  it('preserves sub-second precision of the ISO string', () => {
    const f = fixture();
    const list = JSON.parse(f.file.content);
    list.tokens[0].expires = iso(T + 1999);
    f.file.content = JSON.stringify(list);
    expect(store(f).verify(f.raw.tA)).toMatchObject({ expiresAt: T + 1999 });
  });

  it('every ok result expires after `at`; at or after expiry is "expired", not ok', () => {
    const f = fixture();
    const s = store(f);
    for (const at of [T - DAY, T, T + 999]) {
      const r = s.verify(f.raw.tC, at);
      expect(r.ok && r.expiresAt > at).toBe(true);
    }
    expect(s.verify(f.raw.tC, T + 1000)).toEqual({ ok: false, code: 'expired' });
  });

  it('failure results are unchanged (no expiresAt key)', () => {
    const f = fixture();
    expect(store(f).verify(f.raw.tB)).toEqual({ ok: false, code: 'revoked' });
    expect(entry(f.raw.tA, 'u1').expires).toBeTypeOf('string');
  });
});
