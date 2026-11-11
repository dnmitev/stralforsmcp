export interface RateLimiterOptions { perMinute: number; burst: number; now?: () => number }
export type TakeResult = { ok: true } | { ok: false; retryAfterS: number };
export interface RateLimiter {
  take(key: string): TakeResult;
  /** number of live buckets; test seam for the memory bound */
  size(): number;
}

export function createRateLimiter(o: RateLimiterOptions): RateLimiter {
  const now = o.now ?? Date.now;
  const fullMs = (o.burst * 60000) / o.perMinute;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key) {
      const t = now();
      // ponytail: full scan per take (n = users in the token list); use a periodic sweep past a few thousand users
      for (const [k, v] of buckets) if (t - v.at >= fullMs) buckets.delete(k);
      const b = buckets.get(key) ?? { tokens: o.burst, at: t };
      b.tokens = Math.min(o.burst, b.tokens + (Math.max(0, t - b.at) * o.perMinute) / 60000);
      b.at = t;
      buckets.set(key, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterS: Math.ceil(((1 - b.tokens) * 60) / o.perMinute) };
    },
    size: () => buckets.size,
  };
}
