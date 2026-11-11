/*
 * R3 verify + R4 loading/reload. API under test (src/auth/index.ts, re-exporting token-store.ts):
 *   hashToken, generateToken, TOKEN_RE, MAX_TOKEN_LIFETIME_MS, createTokenStore(o): { verify(raw, at?), reload(), close() }
 *   see requirements/phase-2.md R3, R4.
 */
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../stralfors/errors.ts';
import { MAX_TOKEN_LIFETIME_MS, TOKEN_RE, createTokenStore, generateToken, hashToken, type TokenList } from './index.ts';
import { DAY, T, entry, fixture, iso } from '../../test/helpers/token-list.ts';

const b64 = () => generateToken().slice(5);
const make = (f = fixture(), extra: Partial<Parameters<typeof createTokenStore>[0]> = {}) => {
  const timers: { fn: () => void; ms: number }[] = [];
  const clear = vi.fn();
  const warn = vi.fn();
  const onReload = vi.fn();
  const store = createTokenStore({
    read: () => f.file.content, now: () => T, setTimer: (fn, ms) => (timers.push({ fn, ms }), 'h'), clearTimer: clear,
    log: { warn, info: vi.fn() }, onReload, ...extra,
  });
  return { f, store, timers, clear, warn, onReload };
};
const loadErr = (list: unknown | string, f = fixture()) => {
  f.file.content = typeof list === 'string' ? list : JSON.stringify(list);
  try {
    make(f);
  } catch (e) {
    return e as Error;
  }
  return undefined;
};
const clone = (f = fixture()) => JSON.parse(JSON.stringify(f.list)) as TokenList & Record<string, any>;

describe('R3 verify', () => {
  it('valid token returns exactly the principal', () => {
    const { store, f } = make();
    expect(store.verify(f.raw.tA)).toMatchObject({ ok: true, principal: { userId: 'u1', name: 'User One', role: 'dev', envs: ['test', 'prod'] } });
  });

  it('principal is a fresh copy each call', () => {
    const { store, f } = make();
    const a = store.verify(f.raw.tA);
    const b = store.verify(f.raw.tA);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.principal).not.toBe(b.principal);
    a.principal.envs.push('x' as never);
    expect(store.verify(f.raw.tA)).toMatchObject({ principal: { envs: ['test', 'prod'] } });
  });

  it.each([
    ['empty', () => '', 'malformed'],
    ['Bearer prefix', (f: ReturnType<typeof fixture>) => `Bearer ${f.raw.tA}`, 'malformed'],
    ['no smcp_ prefix', (f: ReturnType<typeof fixture>) => f.raw.tA.slice(5), 'malformed'],
    ['42 chars', () => `smcp_${b64().slice(1)}`, 'malformed'],
    ['44 chars', () => `smcp_${b64()}A`, 'malformed'],
    ['plus sign', () => `smcp_${b64().slice(1)}+`, 'malformed'],
    ['never loaded', () => generateToken(), 'unknown'],
    ['revoked', (f: ReturnType<typeof fixture>) => f.raw.tB, 'revoked'],
  ])('%s -> %s code only', (_n, raw, code) => {
    const { store, f } = make();
    expect(store.verify(raw(f))).toEqual({ ok: false, code });
  });

  it('non-string input is malformed', () => {
    expect(make().store.verify(undefined as never)).toEqual({ ok: false, code: 'malformed' });
  });

  it('expiry instant', () => {
    const { store, f } = make();
    expect(store.verify(f.raw.tC, T + 999).ok).toBe(true);
    expect(store.verify(f.raw.tC, T + 1000)).toEqual({ ok: false, code: 'expired' });
  });

  it('at defaults to now()', () => {
    const f = fixture();
    expect(make(f, { now: () => T + 1000 }).store.verify(f.raw.tC)).toEqual({ ok: false, code: 'expired' });
  });

  it('revoked wins over expired', () => {
    const f = fixture();
    const raw = generateToken();
    f.list.tokens.push(entry(raw, 'u1', { revoked: true, expires: iso(T + 1000) }));
    f.file.content = JSON.stringify(f.list);
    expect(make(f).store.verify(raw, T + DAY)).toEqual({ ok: false, code: 'revoked' });
  });

  it('generateToken: shape and uniqueness', () => {
    const all = Array.from({ length: 1000 }, generateToken);
    expect(all.every((t) => TOKEN_RE.test(t) && t.length === 48)).toBe(true);
    expect(new Set(all).size).toBe(1000);
  });

  it('hashToken is SHA-256 lower-case hex', () => {
    const raw = `smcp_${'A'.repeat(43)}`;
    expect(hashToken(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(hashToken(raw)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no token material escapes', () => {
    const f = fixture();
    const { store, warn } = make(f);
    const canaries = [...Object.values(f.raw), ...Object.values(f.raw).map(hashToken)];
    const seen: string[] = [];
    for (const r of Object.values(f.raw)) seen.push(JSON.stringify(store.verify(r)));
    f.file.content = '{';
    try {
      store.reload();
    } catch (e) {
      seen.push(String((e as Error).stack));
    }
    seen.push(inspect(store, { depth: 5 }), JSON.stringify(store), JSON.stringify(warn.mock.calls));
    for (const c of canaries) for (const s of seen) expect(s).not.toContain(c);
  });
});

describe('R4 loading', () => {
  const dup = (l: any) => (l.tokens[1].hash = l.tokens[0].hash);
  it.each<[string, (l: any) => void, string]>([
    ['90 d + 1 ms', (l) => (l.tokens[0].expires = iso(Date.parse(l.tokens[0].created) + MAX_TOKEN_LIFETIME_MS + 1)), 'tokens[0].expires exceeds 90 days'],
    ['expires = created', (l) => (l.tokens[0].expires = l.tokens[0].created), 'tokens[0].expires is not after created'],
    ['duplicate hash', dup, 'tokens[1].hash is duplicate'],
    ['upper-case hash', (l) => (l.tokens[0].hash = l.tokens[0].hash.toUpperCase()), 'tokens[0].hash is invalid'],
    ['63-char hash', (l) => (l.tokens[0].hash = l.tokens[0].hash.slice(1)), 'tokens[0].hash is invalid'],
    ['bad role', (l) => (l.users[0].role = 'admin'), 'users[0].role is invalid'],
    ['bad env', (l) => (l.users[0].envs = ['test', 'staging']), 'users[0].envs[1] is invalid'],
    ['empty envs', (l) => (l.users[0].envs = []), 'users[0].envs is invalid'],
    ['duplicate envs', (l) => (l.users[0].envs = ['test', 'test']), 'users[0].envs is duplicate'],
    ['unknown user', (l) => (l.tokens[0].userId = 'nobody'), 'tokens[0].userId references unknown user'],
    ['duplicate user id', (l) => (l.users[1].id = l.users[0].id), 'users[1].id is duplicate'],
    ['bad date', (l) => (l.tokens[0].created = 'yesterday'), 'tokens[0].created is invalid'],
    ['extra key', (l) => (l.tokens[0].raw = 'x'), 'tokens[0] has unknown key'],
    ['missing tokens', (l) => delete l.tokens, 'tokens is required'],
  ])('rejected whole: %s', (_n, mutate, text) => {
    const l = clone();
    mutate(l);
    const e = loadErr(l);
    expect(e).toBeInstanceOf(ConfigError);
    expect(e!.message).toBe(`token list: ${text}`);
  });

  it('not JSON', () => {
    expect(loadErr('{')!.message).toBe('token list: (root) is invalid');
  });

  it('error text carries no value from the file', () => {
    const l = clone();
    l.users[0].name = 'NAME-CANARY';
    l.tokens[0].created = 'DATE-CANARY';
    const e = loadErr(l)!;
    expect(e.message).not.toMatch(/NAME-CANARY|DATE-CANARY/);
    expect(e.message).not.toContain(l.tokens[1]!.hash);
  });

  it('exactly 90 days is accepted', () => {
    const f = fixture();
    const raw = generateToken();
    const created = iso(T - DAY);
    f.list.tokens.push(entry(raw, 'u1', { created, expires: iso(Date.parse(created) + MAX_TOKEN_LIFETIME_MS) }));
    f.file.content = JSON.stringify(f.list);
    expect(make(f).store.verify(raw).ok).toBe(true);
  });

  it('empty lists are valid and deny everyone', () => {
    const f = fixture();
    f.file.content = JSON.stringify({ users: [], tokens: [] });
    expect(make(f).store.verify(generateToken())).toEqual({ ok: false, code: 'unknown' });
  });

  it('unreadable file at start-up refuses to start, no timer', () => {
    const setTimer = vi.fn();
    expect(() => createTokenStore({ read: () => { throw new Error('EACCES /secret/path'); }, now: () => T, setTimer })).toThrow(new ConfigError('token list: cannot read'));
    expect(setTimer).not.toHaveBeenCalled();
  });
});

describe('R4 reload', () => {
  it('schedules once with the interval', () => {
    const { timers } = make(undefined, { intervalMs: 60_000 });
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
  });

  it('default interval is 60 s', () => {
    expect(make().timers[0]!.ms).toBe(60_000);
  });

  it('default timer handle is unref-ed', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as never);
    const f = fixture();
    const store = createTokenStore({ read: () => f.file.content, now: () => T });
    expect(unref).toHaveBeenCalledOnce();
    store.close();
    spy.mockRestore();
  });

  it('revoke takes effect on the timer tick', () => {
    const { store, f, timers, onReload } = make();
    expect(store.verify(f.raw.tA).ok).toBe(true);
    f.list.tokens[0]!.revoked = true;
    f.file.content = JSON.stringify(f.list);
    timers[0]!.fn();
    expect(store.verify(f.raw.tA)).toEqual({ ok: false, code: 'revoked' });
    expect(onReload).toHaveBeenCalledWith({ ok: true, users: 2, tokens: 3 });
  });

  it('new token appears after reload()', () => {
    const { store, f } = make();
    const raw = generateToken();
    expect(store.verify(raw)).toMatchObject({ code: 'unknown' });
    f.list.tokens.push(entry(raw, 'u2'));
    f.file.content = JSON.stringify(f.list);
    store.reload();
    expect(store.verify(raw).ok).toBe(true);
  });

  it('invalid file keeps the last good list, logs once, no content', () => {
    const { store, f, warn, onReload } = make();
    f.file.content = '{"leak":"FRAGMENT-CANARY"';
    store.reload();
    expect(store.verify(f.raw.tA).ok).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith({ kind: 'config' }, 'reload.failed');
    expect(onReload).toHaveBeenLastCalledWith({ ok: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('FRAGMENT-CANARY');
  });

  it('unreadable file on reload keeps the last good list', () => {
    const f = fixture();
    let fail = false;
    const { store, warn } = make(f, { read: () => { if (fail) throw new Error('EIO'); return f.file.content; } });
    fail = true;
    store.reload();
    expect(store.verify(f.raw.tA).ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('same failure logged once; success resets the dedupe; different failure logs again', () => {
    const { store, f, warn } = make();
    f.file.content = '{';
    store.reload(); store.reload(); store.reload();
    expect(warn).toHaveBeenCalledTimes(1);
    f.file.content = JSON.stringify(f.list);
    store.reload();
    f.file.content = '{';
    store.reload();
    expect(warn).toHaveBeenCalledTimes(2);
    const l = clone(f);
    l.tokens[1]!.hash = l.tokens[0]!.hash;
    f.file.content = JSON.stringify(l);
    store.reload();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('close clears the timer once', () => {
    const { store, clear } = make();
    store.close();
    store.close();
    expect(clear).toHaveBeenCalledExactlyOnceWith('h');
  });
});
