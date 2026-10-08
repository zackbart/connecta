import type { KVStorage } from "../types.js";
import { validateStorageKey } from "./keys.js";

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
  const write = (key: string, value: string, opts?: Parameters<KVStorage["set"]>[2]) => {
    const { ttlSeconds, expiresAtMs } = opts ?? {};
    if (expiresAtMs !== undefined && (!Number.isSafeInteger(expiresAtMs) || ttlSeconds !== undefined)) {
      throw new RangeError("expiresAtMs must be a safe integer epoch timestamp without ttlSeconds");
    }
    if (ttlSeconds !== undefined && !Number.isFinite(ttlSeconds)) {
      throw new RangeError("ttlSeconds must produce a finite expiration timestamp");
    }
    const exp = expiresAtMs ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined);
    if (exp !== undefined && !Number.isFinite(exp)) {
      throw new RangeError("ttlSeconds must produce a finite expiration timestamp");
    }
    // Rotate through at most 16 existing keys. Live entries cannot keep an
    // expired tail resident forever, and no request starts a background job.
    for (let i = 0; i < 16; i++) {
      const next = sweep.next();
      if (next.done) {
        sweep = map.keys();
        break;
      }
      fresh(next.value);
    }
    map.set(key, {
      value,
      ...(exp !== undefined ? { exp } : {}),
    });
  };
  return {
    capabilities: { absoluteExpiry: true },
    describe: () => ({ kind: "memory" }),
    async get(key) {
      validateStorageKey(key);
      return fresh(key)?.value ?? null;
    },
    async set(key, value, opts) {
      validateStorageKey(key);
      write(key, value, opts);
    },
    async delete(key) {
      validateStorageKey(key);
      map.delete(key);
    },
    async list(prefix) {
      validateStorageKey(prefix);
      return [...map.keys()]
        .filter((key) => {
          fresh(key);
          return key.startsWith(prefix) && map.has(key);
        })
        .sort();
    },
    // Atomic because nothing between the read and the write yields: the body
    // runs to completion before any other call on this map can start.
    async compareAndSet(key, expected, next, opts) {
      validateStorageKey(key);
      if ((fresh(key)?.value ?? null) !== expected) return false;
      if (next === null) map.delete(key);
      else write(key, next, opts);
      return true;
    },
  };
}
