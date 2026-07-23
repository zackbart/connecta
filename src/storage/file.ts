import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { KVStorage } from "../types.js";

interface Entry {
  value: string;
  exp?: number; // epoch ms
}

/**
 * JSON-file-backed KVStorage for Node. Loads once, persists on every write via
 * a temp-file + rename (atomic-ish). Only reachable via the "@zackbart/connecta/node"
 * subpath so the main entry stays Workers-clean.
 */
export function fileStorage(path: string): KVStorage {
  let data: Record<string, Entry> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>;
    } catch {
      data = {};
    }
  }
  const persist = () => {
    const dir = dirname(path);
    if (dir) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  };
  const fresh = (key: string): Entry | null => {
    const e = data[key];
    if (!e) return null;
    if (e.exp && Date.now() > e.exp) {
      delete data[key];
      return null;
    }
    return e;
  };
  return {
    async get(key) {
      return fresh(key)?.value ?? null;
    },
    async set(key, value, opts) {
      data[key] = {
        value,
        exp: opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1000 : undefined,
      };
      persist();
    },
    async delete(key) {
      delete data[key];
      persist();
    },
  };
}
