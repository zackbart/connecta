import type { KVStorage } from "../types.js";

interface Entry {
  value: string;
  exp?: number; // epoch ms
}

/** In-memory KV store with expiry. The default for dev and Node. */
export function memoryStorage(): KVStorage {
  const map = new Map<string, Entry>();
  const fresh = (key: string): Entry | null => {
    const e = map.get(key);
    if (!e) return null;
    if (e.exp && Date.now() > e.exp) {
      map.delete(key);
      return null;
    }
    return e;
  };
  return {
    async get(key) {
      return fresh(key)?.value ?? null;
    },
    async set(key, value, opts) {
      map.set(key, {
        value,
        ...(opts?.ttlSeconds
          ? { exp: Date.now() + opts.ttlSeconds * 1000 }
          : {}),
      });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}
