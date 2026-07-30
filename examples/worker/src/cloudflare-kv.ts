import type { KVStorage } from "@zackbart/connecta";

/**
 * KVStorage backed by a Cloudflare Workers KV namespace binding.
 * Note: Workers KV enforces a 60s minimum TTL; shorter TTLs are dropped
 * (stored without expiry) rather than rejected.
 *
 * Workers KV is eventually consistent across locations. It is suitable for
 * this example's durable state, but cannot promise immediate global OAuth
 * disconnect, credential rotation, or access-token issuance/revocation; use a
 * strongly consistent adapter when that is required.
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
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await namespace.list({
          prefix,
          ...(cursor ? { cursor } : {}),
        });
        keys.push(...page.keys.map((key) => key.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return keys.sort();
    },
  };
}
