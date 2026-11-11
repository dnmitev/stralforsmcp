/* Round 1 kill tests: schema strictness, offsets, reload without a callback. */
import { describe, expect, it } from 'vitest';
import { entry, iso, T } from '../../test/helpers/token-list.ts';
import { createTokenStore, generateToken } from './index.ts';

const log = () => ({ warns: 0, warn() { this.warns++; }, info: () => undefined });
const users = [{ id: 'u1', name: 'N', role: 'dev', envs: ['test'] }];
const mk = (tokens: object[], extra: object = {}) => createTokenStore({
  read: () => JSON.stringify({ users, tokens }), now: () => T, setTimer: () => 'h', clearTimer: () => undefined, ...extra,
});

describe('token store kill', () => {
  it('hash must be exactly 64 hex chars, anchored both sides', () => {
    const e = entry(generateToken(), 'u1');
    expect(() => mk([{ ...e, hash: `${e.hash}0` }])).toThrow();
    expect(() => mk([{ ...e, hash: `x${e.hash}` }])).toThrow();
    expect(() => mk([{ ...e, hash: `${e.hash}\n` }])).toThrow();
  });
  it('dates with a UTC offset are accepted', () => {
    const e = entry(generateToken(), 'u1', { expires: `${iso(T + 86_400_000).slice(0, 19)}+02:00` });
    expect(() => mk([e])).not.toThrow();
  });
  it('a successful reload without onReload applies the new list and does not warn', () => {
    const raw = generateToken();
    let list: object[] = [];
    let tick = () => undefined as void;
    const l = log();
    const store = createTokenStore({
      read: () => JSON.stringify({ users, tokens: list }), now: () => T, log: l,
      setTimer: (fn) => { tick = fn; return 'h'; }, clearTimer: () => undefined,
    });
    list = [entry(raw, 'u1')];
    tick();
    expect(l.warns).toBe(0);
    expect(store.verify(raw).ok).toBe(true);
  });
});
