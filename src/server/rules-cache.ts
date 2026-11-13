/** TTL cache of values fetched per (profile, channel, templateStandardId). Per pod. Callers must not mutate the result. */
export interface RulesCache {
  get<T>(profile: string, channel: string, templateStandardId: number, fetch: () => Promise<T>): Promise<T>;
}

export const MAX_ENTRIES = 256; // a caller-chosen templateStandardId is part of the key: bound the map regardless of TTL

export function createRulesCache(o: { ttlMs: number; now?: () => number; maxEntries?: number }): RulesCache {
  const max = o.maxEntries ?? MAX_ENTRIES;
  const now = o.now ?? Date.now;
  // ponytail: evicts the oldest-inserted settled entry when full, no LRU and no timers; in-flight entries are never evicted
  const map = new Map<string, { value: Promise<unknown>; expiresAt: number; settled: boolean }>();
  return {
    get<T>(profile: string, channel: string, templateStandardId: number, fetch: () => Promise<T>): Promise<T> {
      if (o.ttlMs === 0) return fetch();
      const key = JSON.stringify([profile, channel, templateStandardId]);
      const hit = map.get(key);
      if (hit && now() < hit.expiresAt) return hit.value as Promise<T>;
      if (!hit && map.size >= max) { // a replaced stale key keeps its slot
        const victim = [...map].find(([, e]) => e.settled)?.[0];
        if (victim === undefined) return fetch(); // every slot is an in-flight fetch: run this one uncached rather than break sharing
        map.delete(victim);
      }
      const value = fetch(); // in flight: concurrent misses share it
      const entry = { value, expiresAt: now() + o.ttlMs, settled: false };
      map.set(key, entry);
      value.then(() => void (entry.settled = true), () => void (map.get(key) === entry && map.delete(key))); // a failed fetch is not cached
      return value;
    },
  };
}
