import {
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
  let data: Record<string, Entry> = {};
  if (existsSync(path)) {
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
