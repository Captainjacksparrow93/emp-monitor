// Tiny TTL cache for dashboard queries. Cleared whenever new data is flushed.
const store = new Map();

export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  store.set(key, { value, exp: Date.now() + ttlMs });
  if (store.size > 500) store.delete(store.keys().next().value);
  return value;
}

export function invalidateCache(prefix = '') {
  if (!prefix) return store.clear();
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
