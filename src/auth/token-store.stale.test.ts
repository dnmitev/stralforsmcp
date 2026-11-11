/*
 * R23 staleness. API under test (src/auth/token-store.ts): TokenStoreOptions.staleAfterMs / onStale, TokenStore.staleMs().
 */
import { describe, expect, it, vi } from 'vitest';
import { createTokenStore } from './index.ts';
import { T, fixture } from '../../test/helpers/token-list.ts';

const MIN = 60_000;
const make = (o: { staleAfterMs?: number | undefined; read?: () => string; onStale?: () => void } = {}) => {
  const f = fixture();
  const clock = { t: T };
  const timers: { fn: () => void; ms: number }[] = [];
  const onStale = vi.fn(o.onStale);
  const onReload = vi.fn();
  const good = JSON.stringify(f.list);
  const store = createTokenStore({
    read: o.read ?? (() => f.file.content), now: () => clock.t, setTimer: (fn, ms) => (timers.push({ fn, ms }), 'h'), clearTimer: vi.fn(),
    log: { warn: vi.fn(), info: vi.fn() }, onReload, ...('staleAfterMs' in o ? { staleAfterMs: o.staleAfterMs } : { staleAfterMs: 900_000 }), onStale,
  });
  const at = (ms: number) => void (clock.t = T + ms);
  return { f, store, onStale, onReload, at, good, clock };
};

describe('staleMs', () => {
  it('is 0 for a fresh store, also after time passes without a reload', () => {
    const { store, at } = make();
    expect(store.staleMs()).toBe(0);
    at(50_000);
    expect(store.staleMs()).toBe(0);
  });

  it('counts from the last good load while reloads fail, below the bound nothing fires', () => {
    const { store, f, at, onStale } = make();
    f.file.content = '{';
    for (let m = 1; m <= 14; m++) {
      at(m * MIN);
      store.reload();
      expect(store.staleMs()).toBe(m * MIN);
    }
    expect(onStale).not.toHaveBeenCalled();
  });

  it('a successful reload resets it to 0 (last good time moves)', () => {
    const { store, f, at, good } = make();
    f.file.content = '{';
    at(MIN);
    store.reload();
    f.file.content = good;
    at(2 * MIN);
    store.reload();
    expect(store.staleMs()).toBe(0);
    f.file.content = '{';
    at(3 * MIN);
    store.reload();
    expect(store.staleMs()).toBe(MIN);
  });
});

describe('onStale', () => {
  it('fires once at the inclusive bound, not before, and last-good keeps serving', () => {
    const { store, f, at, onStale } = make();
    f.file.content = '{';
    at(899_999);
    store.reload();
    expect(onStale).not.toHaveBeenCalled();
    at(900_000);
    store.reload();
    expect(onStale).toHaveBeenCalledTimes(1);
    for (const ms of [960_000, 1_020_000]) {
      at(ms);
      store.reload();
    }
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(store.staleMs()).toBe(1_020_000);
    expect(store.verify(f.raw.tA, T)).toMatchObject({ ok: true });
  });

  it('a success re-arms: the next streak fires again', () => {
    const { store, f, at, onStale, onReload, good } = make();
    f.file.content = '{';
    at(900_000);
    store.reload();
    expect(onStale).toHaveBeenCalledTimes(1);
    f.file.content = good;
    at(960_000);
    store.reload();
    expect(onReload).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
    expect(store.staleMs()).toBe(0);
    f.file.content = '{';
    at(960_000 + 900_000);
    store.reload();
    expect(onStale).toHaveBeenCalledTimes(2);
  });

  it('without staleAfterMs the hook never fires but staleMs still counts', () => {
    const { store, f, at, onStale } = make({ staleAfterMs: undefined });
    f.file.content = '{';
    for (let i = 1; i <= 10; i++) {
      at(i * 12 * MIN);
      store.reload();
    }
    expect(onStale).not.toHaveBeenCalled();
    expect(store.staleMs()).toBe(120 * MIN);
  });

  it('an unreadable file counts the same as an invalid one', () => {
    let broken = false;
    const f = fixture();
    const { store, at, onStale } = make({ read: () => { if (broken) throw new Error('EIO'); return f.text(); } });
    broken = true;
    at(900_000);
    store.reload();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('a throwing hook is contained: reload does not throw, onReload still gets ok:false, the next success re-arms', () => {
    const { store, f, at, onStale, onReload, good } = make({ onStale: () => { throw new Error('hook'); } });
    f.file.content = '{';
    at(900_000);
    expect(() => store.reload()).not.toThrow();
    expect(onReload).toHaveBeenLastCalledWith({ ok: false });
    f.file.content = good;
    at(960_000);
    store.reload();
    f.file.content = '{';
    at(960_000 + 900_000);
    expect(() => store.reload()).not.toThrow();
    expect(onStale).toHaveBeenCalledTimes(2);
  });

  it('a custom bound is honoured', () => {
    const { store, f, at, onStale } = make({ staleAfterMs: 120_000 });
    f.file.content = '{';
    at(MIN);
    store.reload();
    expect(onStale).not.toHaveBeenCalled();
    at(2 * MIN);
    store.reload();
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});
