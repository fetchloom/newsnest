import { now } from "./ids.ts";

/**
 * Fixed-window counters kept in memory: `allow(key, max, windowMs)` is false once `key` has been seen more than `max` times in
 * the window. Bounded at `maxKeys`; when full the oldest key is dropped, so a flood of made-up keys can't grow it without end.
 * Keys should already be normalised (see clientIp) by whoever builds them.
 */
export function windowLimiter(maxKeys = 10_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, max: number, windowMs: number): boolean => {
    const k = key.slice(0, 300);
    const t = now();
    const h = hits.get(k);
    if (!h || h.reset < t) {
      hits.delete(k);
      if (hits.size >= maxKeys) hits.delete(hits.keys().next().value!);
      hits.set(k, { n: 1, reset: t + windowMs });
      return true;
    }
    return ++h.n <= max;
  };
}
