import type { KVStorage } from "../types.js";

/**
 * KVStorage backed by a Cloudflare Workers KV namespace binding.
 * Note: Workers KV enforces a 60s minimum TTL; shorter TTLs are dropped
 * (stored without expiry) rather than rejected.
 */
export function cloudflareKvStorage(namespace: KVNamespace): KVStorage {
  return {
    async get(key) {
      return namespace.get(key);
    },
    async set(key, value, opts) {
      const ttl = opts?.ttlSeconds;
      await namespace.put(
        key,
        value,
        ttl && ttl >= 60 ? { expirationTtl: ttl } : undefined,
      );
    },
    async delete(key) {
      await namespace.delete(key);
    },
  };
}
