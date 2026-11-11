/* R21 token bucket. API under test (src/server/rate-limit.ts): createRateLimiter({ perMinute, burst, now? }) => { take(key), size() }. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limit.ts';

afterEach(() => vi.restoreAllMocks());

const make = (perMinute = 120, burst = 30) => {
  const c = { t: 0 };
  return { c, lim: createRateLimiter({ perMinute, burst, now: () => c.t }) };
};
const drain = (lim: ReturnType<typeof make>['lim'], key: string, n: number) => Array.from({ length: n }, () => lim.take(key));

describe('worked table (120/min, burst 30)', () => {
  it('burst, refusal with exact retryAfter, refill at 500 ms', () => {
    const { c, lim } = make();
    expect(drain(lim, 'u1', 30).every((r) => r.ok)).toBe(true);
    expect(lim.take('u1')).toEqual({ ok: false, retryAfterS: 1 });
    c.t = 499;
    expect(lim.take('u1')).toEqual({ ok: false, retryAfterS: 1 });
    c.t = 500;
    expect(lim.take('u1')).toEqual({ ok: true });
    expect(lim.take('u1')).toEqual({ ok: false, retryAfterS: 1 });
  });

  it('refill caps at burst', () => {
    const { c, lim } = make();
    lim.take('u1');
    c.t = 1_000_000;
    const r = drain(lim, 'u1', 31);
    expect(r.slice(0, 30).every((x) => x.ok)).toBe(true);
    expect(r[30]!.ok).toBe(false);
  });

  it('a bucket is full again after 15 000 ms', () => {
    const { c, lim } = make();
    drain(lim, 'u1', 30);
    c.t = 15_000;
    const r = drain(lim, 'u1', 31);
    expect(r.filter((x) => x.ok)).toHaveLength(30);
  });
});

describe('retryAfter arithmetic', () => {
  it.each([
    [1, 1, 0, 60],
    [1, 1, 59_999, 1],
    [1, 1, 60_000, 'ok'],
    [60, 1, 0, 1],
    [60, 1, 1000, 'ok'],
    [120, 30, 0, 1],
    [7, 3, 0, 9],
  ] as const)('perMinute %i burst %i at t=%i gives %s', (pm, b, t, s) => {
    const { c, lim } = make(pm, b);
    drain(lim, 'k', b);
    c.t = t;
    expect(lim.take('k')).toEqual(s === 'ok' ? { ok: true } : { ok: false, retryAfterS: s });
  });
});

describe('keys, cleanup, clock', () => {
  it('keys are isolated', () => {
    const { lim } = make();
    drain(lim, 'u1', 30);
    expect(lim.take('u2')).toEqual({ ok: true });
    expect(lim.take('u1').ok).toBe(false);
  });

  it('lazy cleanup drops only full-again buckets', () => {
    const { c, lim } = make();
    lim.take('u1');
    lim.take('u2');
    expect(lim.size()).toBe(2);
    c.t = 14_999;
    lim.take('u3');
    expect(lim.size()).toBe(3);
    c.t = 15_000;
    lim.take('u3');
    expect(lim.size()).toBe(1);
    expect(drain(lim, 'u1', 30).every((r) => r.ok)).toBe(true);
  });

  it('cleanup is lossless', () => {
    const { c, lim } = make();
    drain(lim, 'u1', 30);
    c.t = 15_000;
    expect(lim.take('u1')).toEqual({ ok: true });
  });

  it('a clock stepping back credits nothing and does not throw', () => {
    const { c, lim } = make(60, 1);
    c.t = 1000;
    expect(lim.take('u1').ok).toBe(true);
    c.t = 0;
    expect(lim.take('u1')).toEqual({ ok: false, retryAfterS: 1 });
  });

  it('a backwards step does not let the bucket be dropped as idle when the clock returns', () => {
    const { c, lim } = make(60, 1);
    c.t = 1000;
    expect(lim.take('u1').ok).toBe(true);
    c.t = 0;
    expect(lim.take('u1').ok).toBe(false);
    c.t = 1000;
    expect(lim.take('u1').ok).toBe(false);
  });

  it('defaults to Date.now', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    const lim = createRateLimiter({ perMinute: 60, burst: 1 });
    expect(lim.take('k').ok).toBe(true);
    expect(lim.take('k').ok).toBe(false);
  });
});
