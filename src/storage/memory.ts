import type { KVStorage } from "../types.js";

interface Entry {
  value: string;
  exp?: number; // epoch ms
}

/** In-memory KV store with expiry. The default for dev and Node. */
export function memoryStorage(): KVStorage {
  const map = new Map<string, Entry>();
  let sweep = map.keys();
  const fresh = (key: string): Entry | null => {
    const e = map.get(key);
    if (!e) return null;
    if (e.exp !== undefined && Date.now() >= e.exp) {
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
      // Rotate through at most 16 existing keys. Live entries cannot keep an
      // expired tail resident forever, and no request starts a background job.
      for (let i = 0; i < 16; i++) {
        const next = sweep.next();
        if (next.done) { sweep = map.keys(); break; }
        fresh(next.value);
      }
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
    async list(prefix) {
      return [...map.keys()]
        .filter((key) => {
          fresh(key);
          return key.startsWith(prefix) && map.has(key);
        })
        .sort();
    },
  };
}
