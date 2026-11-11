/* R21 kill tests: arithmetic order, boundaries, no timers, no state outside take(). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limit.ts';

afterEach(() => void vi.useRealTimers());

describe('rate limiter kill', () => {
  it('no timers are created', () => {
    vi.useFakeTimers();
    const lim = createRateLimiter({ perMinute: 120, burst: 30 });
    for (let i = 0; i < 100; i++) lim.take(`k${i % 7}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('size() does not create or evict entries and starts at 0', () => {
    const lim = createRateLimiter({ perMinute: 120, burst: 30, now: () => 0 });
    expect(lim.size()).toBe(0);
    lim.take('a');
    expect(lim.size()).toBe(1);
    expect(lim.size()).toBe(1);
  });

  it('partial refill accumulates across takes (0.5 token + 0.5 token = one)', () => {
    let t = 0;
    const lim = createRateLimiter({ perMinute: 60, burst: 1, now: () => t });
    expect(lim.take('k').ok).toBe(true);
    t = 500;
    expect(lim.take('k')).toEqual({ ok: false, retryAfterS: 1 });
    t = 750;
    expect(lim.take('k').ok).toBe(false);
    t = 1000;
    expect(lim.take('k').ok).toBe(true);
  });

  it('a refused take does not consume or reset the refill clock', () => {
    let t = 0;
    const lim = createRateLimiter({ perMinute: 60, burst: 1, now: () => t });
    lim.take('k');
    for (t = 250; t < 1000; t += 250) expect(lim.take('k').ok).toBe(false);
    t = 1000;
    expect(lim.take('k').ok).toBe(true);
  });

  it('retryAfter shrinks as tokens refill and is never below 1', () => {
    let t = 0;
    const lim = createRateLimiter({ perMinute: 1, burst: 1, now: () => t });
    lim.take('k');
    const seen: number[] = [];
    for (t of [0, 30_000, 59_100, 59_999]) {
      const r = lim.take('k');
      seen.push(r.ok ? -1 : r.retryAfterS);
    }
    expect(seen).toEqual([60, 30, 1, 1]);
  });

  it('burst larger than perMinute works (burst 5, 1 per minute)', () => {
    const lim = createRateLimiter({ perMinute: 1, burst: 5, now: () => 0 });
    expect(Array.from({ length: 5 }, () => lim.take('k').ok)).toEqual([true, true, true, true, true]);
    expect(lim.take('k')).toEqual({ ok: false, retryAfterS: 60 });
  });

  it('the eviction bound scales with burst/perMinute (fullMs = burst*60000/perMinute)', () => {
    let t = 0;
    const lim = createRateLimiter({ perMinute: 60, burst: 10, now: () => t });
    lim.take('a');
    t = 9_999;
    lim.take('b');
    expect(lim.size()).toBe(2);
    t = 10_000;
    lim.take('b');
    expect(lim.size()).toBe(1);
  });

  it('the result of a refusal has only ok and retryAfterS', () => {
    const lim = createRateLimiter({ perMinute: 60, burst: 1, now: () => 0 });
    lim.take('k');
    expect(Object.keys(lim.take('k')).sort()).toEqual(['ok', 'retryAfterS']);
    const fresh = createRateLimiter({ perMinute: 60, burst: 1, now: () => 0 });
    expect(Object.keys(fresh.take('k'))).toEqual(['ok']);
  });
});
