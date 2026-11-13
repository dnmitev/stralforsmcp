/** TTL cache of values fetched per (profile, channel, templateStandardId). Per pod. Callers must not mutate the result. */
export interface RulesCache {
  get<T>(profile: string, channel: string, templateStandardId: number, fetch: () => Promise<T>): Promise<T>;
}

export function createRulesCache(o: { ttlMs: number; now?: () => number }): RulesCache {
  const now = o.now ?? Date.now;
  // ponytail: no sweep, bounded by profiles x channels x templates; add an LRU if that stops holding
  const map = new Map<string, { value: Promise<unknown>; expiresAt: number }>();
  return {
    get<T>(profile: string, channel: string, templateStandardId: number, fetch: () => Promise<T>): Promise<T> {
      if (o.ttlMs === 0) return fetch();
      const key = JSON.stringify([profile, channel, templateStandardId]);
      const hit = map.get(key);
      if (hit && now() < hit.expiresAt) return hit.value as Promise<T>;
      const value = fetch(); // in flight: concurrent misses share it
      const entry = { value, expiresAt: now() + o.ttlMs };
      map.set(key, entry);
      value.catch(() => { if (map.get(key) === entry) map.delete(key); }); // a failed fetch is not cached
      return value;
    },
  };
}
