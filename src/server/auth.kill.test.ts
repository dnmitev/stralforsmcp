/* R9 kill tests: boundaries of header parsing and expiry unit. */
import { describe, expect, it } from 'vitest';
import { iso, T, entry } from '../../test/helpers/token-list.ts';
import { createTokenStore, generateToken } from '../auth/index.ts';
import { authenticate } from './auth.ts';

const one = (expires: string) => {
  const raw = generateToken();
  const store = createTokenStore({
    read: () => JSON.stringify({ users: [{ id: 'u1', name: 'N', role: 'dev', envs: ['test'] }], tokens: [entry(raw, 'u1', { expires })] }),
    now: () => T, setTimer: () => 'h', clearTimer: () => undefined, log: { warn: () => undefined, info: () => undefined },
  });
  return { raw, store };
};

describe('authenticate kill', () => {
  it('expires T+1999 ms floors to seconds, expires T+1000 is exactly one', () => {
    const a = one(iso(T + 1999));
    const r = authenticate(`Bearer ${a.raw}`, a.store, T);
    expect(r.ok && r.authInfo.expiresAt).toBe(Math.floor((T + 1999) / 1000));
    expect(r.ok && r.authInfo.expiresAt).not.toBe(Math.round((T + 1999) / 1000));
  });
  it('expiresAt is seconds, so the SDK sees it as not yet expired', () => {
    const a = one(iso(T + 5000));
    const r = authenticate(`Bearer ${a.raw}`, a.store, T);
    expect(r.ok && r.authInfo.expiresAt).toBeLessThan(T); // ms would be larger than T
  });
  it('header anchors: no leading or trailing junk, newline is not a terminator', () => {
    const a = one(iso(T + 5000));
    for (const h of [` Bearer ${a.raw}`, `xBearer ${a.raw}`, `Bearer ${a.raw}\n`, `Bearer ${a.raw}\nx`, `Bearers ${a.raw}`]) {
      expect(authenticate(h, a.store, T)).toEqual({ ok: false, code: 'malformed' });
    }
  });
});
