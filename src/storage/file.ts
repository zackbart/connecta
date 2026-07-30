import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { KVStorage, Logger } from "../types.js";

interface Entry {
  value: string;
  exp?: number; // epoch ms
}

export interface FileStorageOptions {
  /** Destination for the corrupt-state-file recovery report. Default console. */
  logger?: Logger;
}

/**
 * JSON-file-backed KVStorage for Node. Loads once, persists on every write via
 * a temp-file + rename (atomic-ish). Only reachable via the "@zackbart/connecta/node"
 * subpath so the main entry stays Workers-clean.
 */
export function fileStorage(
  path: string,
  opts: FileStorageOptions = {},
): KVStorage {
  const logger: Logger = opts.logger ?? console;
  // The state file holds downstream OAuth access/refresh tokens in cleartext,
  // so keep it owner-only. Repair is best-effort: chmod is a no-op or throws on
  // non-POSIX filesystems, and a loose mode must never keep the store from
  // starting.
  const tighten = () => {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Non-POSIX filesystem or a race on the file — leave the mode as-is.
    }
  };
  let data: Record<string, Entry> = {};
  if (existsSync(path)) {
    tighten();
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>;
    } catch (error) {
      // Never let a damaged state file be silently replaced by an empty one:
      // the next set() would persist {} over irreplaceable downstream OAuth
      // tokens and credential-vault entries. Quarantine the bytes so they
      // survive for manual recovery, and refuse to start if even that fails —
      // losing the file loudly beats losing it quietly.
      const quarantine = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, quarantine);
      } catch (renameError) {
        throw new Error(
          `[connecta] state file ${path} is not valid JSON and could not be ` +
            `moved aside (${String(renameError)}). Refusing to start rather ` +
            `than overwrite it. Move or repair the file, then restart.`,
        );
      }
      logger.error(
        `[connecta] state file ${path} is not valid JSON ` +
          `(${error instanceof Error ? error.message : String(error)}) — ` +
          `moved to ${quarantine}, starting from empty state. Downstream ` +
          `OAuth connectors must be re-authorized and stored credentials ` +
          `re-entered.`,
      );
      data = {};
    }
  }
  const persist = () => {
    // Physical expiry rides on an operation that was already going to write.
    // A read must not flush this instance's load-once snapshot: another live
    // instance may have written newer unrelated values since we loaded it.
    const now = Date.now();
    for (const [key, entry] of Object.entries(data)) {
      if (entry.exp && now > entry.exp) delete data[key];
    }
    const dir = dirname(path);
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    // 0o600 on the tmp file; the atomic rename below preserves it, so the live
    // state file is never briefly world-readable.
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, path);
    tighten();
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
        ...(opts?.ttlSeconds
          ? { exp: Date.now() + opts.ttlSeconds * 1000 }
          : {}),
      };
      persist();
    },
    async delete(key) {
      delete data[key];
      persist();
    },
    async list(prefix) {
      return Object.keys(data)
        .filter((key) => Boolean(fresh(key)) && key.startsWith(prefix))
        .sort();
    },
  };
}
