// Mutation-hardening for src/auth/token-store.ts: constant-time compare on the path, verification order, boundaries.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { createTokenStore, generateToken, hashToken } from './index.ts';
import { DAY, T, entry, fixture, iso } from '../../test/helpers/token-list.ts';

vi.mock('node:crypto', async (orig) => {
  const m = await orig<typeof import('node:crypto')>();
  return { ...m, timingSafeEqual: vi.fn(m.timingSafeEqual) };
});

const store = (f = fixture(), now = T) => createTokenStore({ read: () => f.file.content, now: () => now, setTimer: () => 0, clearTimer: () => undefined });

describe('constant-time compare', () => {
  it('is called once with two 32-byte buffers for a known digest', () => {
    const f = fixture();
    const s = store(f);
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    s.verify(f.raw.tA);
    expect(spy).toHaveBeenCalledOnce();
    const [a, b] = spy.mock.calls[0]!;
    expect([(a as Buffer).length, (b as Buffer).length]).toEqual([32, 32]);
  });

  it('a negative compare result is "unknown"', () => {
    const f = fixture();
    const s = store(f);
    vi.mocked(crypto.timingSafeEqual).mockReturnValueOnce(false);
    expect(s.verify(f.raw.tA)).toEqual({ ok: false, code: 'unknown' });
  });

  it('is not called for malformed or unknown input', () => {
    const s = store();
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    s.verify('nope');
    s.verify(generateToken());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('hash and order', () => {
  it('lookup key is the SHA-256 hex of the raw token', () => {
    const f = fixture();
    expect(f.list.tokens[0]!.hash).toBe(createHash('sha256').update(f.raw.tA).digest('hex'));
    expect(hashToken(f.raw.tA)).toBe(f.list.tokens[0]!.hash);
  });

  it('a token is not valid before its created time (reported as expired), valid from created on', () => {
    const f = fixture();
    const raw = generateToken();
    f.list.tokens.push(entry(raw, 'u1', { created: iso(T + DAY), expires: iso(T + 2 * DAY) }));
    f.file.content = JSON.stringify(f.list);
    const s = store(f);
    expect(s.verify(raw)).toEqual({ ok: false, code: 'expired' });
    expect(s.verify(raw, T + DAY - 1)).toEqual({ ok: false, code: 'expired' });
    expect(s.verify(raw, T + DAY).ok).toBe(true);
  });

  it('expires one ms before / at / after now', () => {
    const f = fixture();
    const s = store(f);
    expect(s.verify(f.raw.tC, T + 1000 - 1).ok).toBe(true);
    expect(s.verify(f.raw.tC, T + 1000).ok).toBe(false);
    expect(s.verify(f.raw.tC, T + 1000 + 1).ok).toBe(false);
  });

  it('verify codes carry no extra keys', () => {
    const f = fixture();
    expect(Object.keys(store(f).verify(f.raw.tB))).toEqual(['ok', 'code']);
    expect(Object.keys(store(f).verify(f.raw.tA))).toEqual(['ok', 'principal']);
    const r = store(f).verify(f.raw.tA);
    if (r.ok) expect(Object.keys(r.principal).sort()).toEqual(['envs', 'name', 'role', 'userId']);
  });

  it('reload swaps lists atomically: users and tokens come from the same file', () => {
    const f = fixture();
    const s = store(f);
    f.list.users[0]!.role = 'qa';
    f.file.content = JSON.stringify(f.list);
    s.reload();
    expect(s.verify(f.raw.tA)).toMatchObject({ principal: { role: 'qa' } });
  });
});

describe('optional callbacks and default timers', () => {
  const bad = (f = fixture()) => {
    const s = createTokenStore({ read: () => f.file.content, now: () => T, setTimer: () => 0, clearTimer: () => undefined });
    f.file.content = '{';
    return s;
  };

  it('a failing reload without onReload or log does not throw', () => {
    expect(() => bad().reload()).not.toThrow();
  });

  it('a failing reload with log but no onReload does not throw', () => {
    const f = fixture();
    const warn = vi.fn();
    const s = createTokenStore({ read: () => f.file.content, now: () => T, setTimer: () => 0, clearTimer: () => undefined, log: { warn, info: vi.fn() } });
    f.file.content = '{';
    expect(() => s.reload()).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('default timer is a 60 s interval that reloads; close clears that handle once', () => {
    const f = fixture();
    const handle = { unref: vi.fn() };
    let tick: (() => void) | undefined;
    const set = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => ((tick = fn), handle)) as never);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const reads = vi.fn(() => f.file.content);
    const s = createTokenStore({ read: reads, now: () => T });
    tick!();
    expect(reads).toHaveBeenCalledTimes(2);
    s.close();
    s.close();
    expect(clear).toHaveBeenCalledExactlyOnceWith(handle);
    set.mockRestore();
    clear.mockRestore();
  });
});

describe('schema strictness', () => {
  const parseWith = (mut: (l: { tokens: Array<Record<string, unknown>> }) => void) => {
    const f = fixture();
    const l = JSON.parse(f.file.content);
    mut(l);
    return () => createTokenStore({ read: () => JSON.stringify(l), now: () => T, setTimer: () => 0, clearTimer: () => undefined });
  };

  it.each(['a', 'a'.repeat(63) + 'g'])('hash %s is refused', (h) => {
    expect(parseWith((l) => void (l.tokens[0]!.hash = h))).toThrow('token list: tokens[0].hash is invalid');
  });

  it.each(['0', 'f'])('hash with a stray leading or trailing char is refused', (c) => {
    const h = hashToken('x');
    expect(parseWith((l) => void (l.tokens[0]!.hash = c + h))).toThrow('hash is invalid');
    expect(parseWith((l) => void (l.tokens[0]!.hash = h + c))).toThrow('hash is invalid');
  });

  it('dates with an explicit offset are accepted, naive dates are not', () => {
    expect(parseWith((l) => void (l.tokens[0]!.created = '2029-12-31T12:00:00+02:00'))).not.toThrow();
    expect(parseWith((l) => void (l.tokens[0]!.created = '2029-12-31T12:00:00'))).toThrow('created is invalid');
  });
});
