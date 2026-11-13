/** TTL cache of values fetched per (profile, channel, templateStandardId). Per pod. Callers must not mutate the result. */
export interface RulesCache {
  get<T>(profile: string, channel: string, templateStandardId: number, fetch: () => Promise<T>): Promise<T>;
}

export const MAX_ENTRIES = 256; // a caller-chosen templateStandardId is part of the key: bound the map regardless of TTL

/**
 * A pending fetch is never evicted or expired, so concurrent callers always share it; the TTL starts when it settles.
 * Only settled entries are evicted (oldest inserted first), so the map holds at most maxEntries settled entries plus the fetches in flight.
 */
export function createRulesCache(o: { ttlMs: number; now?: () => number; maxEntries?: number }): RulesCache {
  const now = o.now ?? Date.now;
  const max = o.maxEntries ?? MAX_ENTRIES;
  // ponytail: no LRU and no timers; oldest-inserted eviction is enough for a few dozen keys
  const map = new Map<string, { value: Promise<unknown>; expiresAt: number }>();
  return {
    get<T>(profile: string, channel: string, templateStandardId: number, fetch: () => Promise<T>): Promise<T> {
      if (o.ttlMs === 0) return fetch();
      const key = JSON.stringify([profile, channel, templateStandardId]);
      const hit = map.get(key);
      if (hit && now() < hit.expiresAt) return hit.value as Promise<T>;
      const entry = { value: undefined as unknown as Promise<unknown>, expiresAt: Infinity }; // Infinity while pending
      if (!hit) { // a stale key being replaced keeps its slot
        for (const [k, e] of map) {
          if (map.size < max) break;
          if (e.expiresAt !== Infinity) map.delete(k);
        }
      }
      const value = fetch();
      entry.value = value;
      map.set(key, entry);
      value.then(() => void (entry.expiresAt = now() + o.ttlMs), () => void map.delete(key)); // a failed fetch is not cached
      return value;
    },
  };
}
