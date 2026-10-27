/**
 * Failed-attempt limiter, one bucket per client.
 *
 * A wrong access code is not tied to any customer, so the sensible thing to limit is who is
 * guessing. One client hitting the limit never affects anyone else.
 */
export function createAttemptLimiter({ max = 8, windowMs = 60_000, maxKeys = 5000 } = {}) {
  const buckets = new Map();
  const prune = (key, now) => {
    const list = (buckets.get(key) || []).filter((t) => t > now - windowMs);
    if (list.length) buckets.set(key, list);
    else buckets.delete(key);
    return list;
  };
  return {
    /** True while this client may still try. */
    allowed(key, now = Date.now()) {
      return prune(key, now).length < max;
    },
    fail(key, now = Date.now()) {
      const list = prune(key, now);
      list.push(now);
      buckets.set(key, list);
      // A flood of distinct keys must not grow memory without bound: drop the oldest key.
      if (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
    },
    size: () => buckets.size,
  };
}
