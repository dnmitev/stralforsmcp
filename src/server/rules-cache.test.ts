import { describe, expect, it, vi } from 'vitest';
import { createRulesCache } from './rules-cache.ts';

const setup = (ttlMs = 3_600_000) => {
  let t = 1000;
  let calls = 0;
  const cache = createRulesCache({ ttlMs, now: () => t });
  const fetcher = (v = 'r') => () => (calls++, Promise.resolve(v));
  return { cache, fetcher, calls: () => calls, advance: (ms: number) => void (t += ms) };
};

describe('size bound', () => {
  it('evicts the oldest entry when full and never exceeds the bound', async () => {
    const cache = createRulesCache({ ttlMs: 3_600_000, maxEntries: 2 });
    let calls = 0;
    const f = (v: string) => () => (calls++, Promise.resolve(v));
    await cache.get('p', 'a', 0, f('a'));
    await cache.get('p', 'b', 0, f('b'));
    await cache.get('p', 'c', 0, f('c')); // evicts a
    expect(calls).toBe(3);
    await cache.get('p', 'b', 0, f('b2'));
    await cache.get('p', 'c', 0, f('c2'));
    expect(calls).toBe(3); // b and c still cached
    await cache.get('p', 'a', 0, f('a2')); // refetch: a was evicted
    expect(calls).toBe(4);
  });
  it('re-requesting a stale key does not evict another entry', async () => {
    let t = 0;
    const cache = createRulesCache({ ttlMs: 10, now: () => t, maxEntries: 2 });
    let calls = 0;
    const f = () => (calls++, Promise.resolve('v'));
    await cache.get('p', 'a', 0, f);
    await cache.get('p', 'b', 0, f);
    t = 10;
    await cache.get('p', 'a', 0, f); // a expired, replaced in place
    t = 11;
    await cache.get('p', 'b', 0, f);
    expect(calls).toBe(4);
  });
  it('defaults to 256 entries', async () => {
    const { MAX_ENTRIES } = await import('./rules-cache.ts');
    expect(MAX_ENTRIES).toBe(256);
    const cache = createRulesCache({ ttlMs: 3_600_000 });
    let calls = 0;
    for (let i = 0; i < 257; i++) await cache.get('p', `c${i}`, 0, () => (calls++, Promise.resolve(i)));
    await cache.get('p', 'c0', 0, () => (calls++, Promise.resolve(0))); // evicted
    await cache.get('p', 'c256', 0, () => (calls++, Promise.resolve(0))); // kept
    expect(calls).toBe(258);
  });
});

describe('rules cache', () => {
  it('reads twice with one fetch', async () => {
    const s = setup();
    expect(await s.cache.get('p', 'c', 0, s.fetcher('a'))).toBe('a');
    expect(await s.cache.get('p', 'c', 0, s.fetcher('b'))).toBe('a');
    expect(s.calls()).toBe(1);
  });
  it.each([['profile', 'q', 'c', 0], ['channel', 'p', 'd', 0], ['template', 'p', 'c', 2]] as const)('a different %s fetches again', async (_n, p, c, t) => {
    const s = setup();
    await s.cache.get('p', 'c', 0, s.fetcher());
    await s.cache.get(p, c, t, s.fetcher());
    expect(s.calls()).toBe(2);
  });
  it('keys cannot collide through separators', async () => {
    const s = setup();
    await s.cache.get('a', 'b|c', 0, s.fetcher());
    await s.cache.get('a|b', 'c', 0, s.fetcher());
    expect(s.calls()).toBe(2);
  });
  it('refetches exactly when the TTL has elapsed', async () => {
    const s = setup(1000);
    await s.cache.get('p', 'c', 0, s.fetcher());
    s.advance(999);
    await s.cache.get('p', 'c', 0, s.fetcher());
    expect(s.calls()).toBe(1);
    s.advance(1);
    await s.cache.get('p', 'c', 0, s.fetcher());
    expect(s.calls()).toBe(2);
  });
  it('does not cache a failed fetch', async () => {
    const s = setup();
    await expect(s.cache.get('p', 'c', 0, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await s.cache.get('p', 'c', 0, s.fetcher('ok'))).toBe('ok');
    expect(await s.cache.get('p', 'c', 0, s.fetcher('later'))).toBe('ok');
  });
  it('a stale failure does not evict a newer entry', async () => {
    const s = setup(1000);
    let fail!: (e: Error) => void;
    const slow = s.cache.get('p', 'c', 0, () => new Promise<string>((_r, rej) => (fail = rej)));
    s.advance(1000);
    const fresh = await s.cache.get('p', 'c', 0, s.fetcher('new'));
    fail(new Error('late'));
    await expect(slow).rejects.toThrow('late');
    await Promise.resolve();
    expect(fresh).toBe('new');
    expect(await s.cache.get('p', 'c', 0, s.fetcher('other'))).toBe('new');
  });
  it('concurrent misses share one fetch', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.cache.get('p', 'c', 0, s.fetcher('x')), s.cache.get('p', 'c', 0, s.fetcher('y'))]);
    expect([a, b, s.calls()]).toEqual(['x', 'x', 1]);
  });
  it('ttl 0 fetches every time', async () => {
    const s = setup(0);
    await s.cache.get('p', 'c', 0, s.fetcher());
    await s.cache.get('p', 'c', 0, s.fetcher());
    expect(s.calls()).toBe(2);
  });
  it('defaults to the wall clock', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_000); // controlled clock: no real-time dependence
    try {
      const cache = createRulesCache({ ttlMs: 60_000 });
      let n = 0;
      await cache.get('p', 'c', 0, async () => ++n);
      spy.mockReturnValue(60_999);
      await cache.get('p', 'c', 0, async () => ++n);
      expect(n).toBe(1);
      spy.mockReturnValue(61_000);
      await cache.get('p', 'c', 0, async () => ++n);
      expect(n).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
