import {
  chmodSync,
  closeSync,
  existsSync,
  futimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { KVStorage, Logger } from "../types.js";

interface Entry {
  value: string;
  exp?: number; // epoch ms
}

const HEARTBEAT_MS = 15_000;
const STALE_LOCK_MS = 60_000;
const localLocks = new Map<string, string>();
// A pid is meaningful only in its own host/namespace. Container hostnames may
// be shared, so Linux uses the kernel boot id and the actual PID namespace.
const pidScope = (() => {
  if (process.platform !== "linux") return hostname();
  try {
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return undefined; // Without namespace evidence, rely on the heartbeat.
  }
})();

function stale(path: string): boolean {
  return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
}

// One listener per module, removed when the last store closes. Node's listen()
// drains requests before process.exit(), so the lock lasts through those writes.
const openStores = new Set<() => void>();
const closeStores = () => {
  for (const close of openStores) {
    try {
      close();
    } catch {
      // A dead-pid or expired-heartbeat lock can be reclaimed next startup.
    }
  }
};

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function lockFile(path: string): { assertHeld(): void; release(): void } {
  const lockPath = `${path}.lock`;
  const contents = JSON.stringify({
    pid: process.pid,
    pidScope,
    createdAt: Date.now(),
    id: randomUUID(),
  });
  const readLock = (): string | null => {
    try {
      return readFileSync(lockPath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  };
  const refuseLiveHolder = () => {
    const raw = readLock();
    if (raw === null) return false;
    try {
      if (stale(lockPath)) return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
    let holder: { pid: number; createdAt: number; pidScope?: string };
    try {
      holder = JSON.parse(raw) as typeof holder;
      if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0 ||
          holder.pid > 2147483647 || !Number.isFinite(holder.createdAt)) {
        throw new Error("Invalid lock holder");
      }
    } catch {
      throw new Error(`[connecta] state file ${path} has an unreadable lock at ${lockPath}. ` +
        `Refusing to start. Retry after its heartbeat has been stale for 60 seconds.`);
    }
    if (pidScope !== undefined && holder.pidScope === pidScope) {
      if (holder.pid === process.pid) {
        // A new container process may inherit the old holder's pid. Only our
        // own registry can distinguish that incarnation from a second opener.
        if (localLocks.get(path) !== raw) return true;
      } else {
        try {
          process.kill(holder.pid, 0);
        } catch (error) {
          if (hasCode(error, "ESRCH")) return true;
          // Permission errors do not establish that the holder is dead.
        }
      }
    }
    throw new Error(`[connecta] state file ${path} is held by pid ${holder.pid} ` +
      `(lock timestamp ${holder.createdAt}). Close that store before opening another.`);
  };
  const acquire = (): boolean => {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
    try {
      writeFileSync(fd, contents);
      const now = new Date();
      futimesSync(fd, now, now);
    } catch (error) {
      unlinkSync(lockPath);
      throw error;
    } finally {
      closeSync(fd);
    }
    return true;
  };
  if (!acquire()) {
    refuseLiveHolder();
    // Serialize stale-lock removal. Without this guard, two reclaimers could
    // both observe the dead pid and the slower one unlink the new live lock.
    // Recovery is synchronous. A guard older than the lease is from a crashed
    // or paused reclaimer, which must recheck its ownership before continuing.
    const reclaimPath = `${lockPath}.reclaim`;
    const recoveryError = () => new Error(
      `[connecta] state file ${path} has a lock recovery in progress at ${reclaimPath}. ` +
      `Retry after its 60-second lease expires.`,
    );
    try {
      const expired = statSync(reclaimPath);
      if (Date.now() - expired.mtimeMs > STALE_LOCK_MS) {
        const markers = readdirSync(reclaimPath);
        const current = statSync(reclaimPath);
        if (current.dev !== expired.dev || current.ino !== expired.ino ||
            current.birthtimeMs !== expired.birthtimeMs || !stale(reclaimPath)) {
          throw recoveryError();
        }
        // Delete only the expired owner's unique marker. A competing cleanup
        // cannot empty a replacement guard by deleting these old filenames.
        for (const marker of markers) rmSync(`${reclaimPath}/${marker}`, { force: true });
        rmdirSync(reclaimPath);
      }
    } catch (error) {
      if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) throw recoveryError();
      if (!hasCode(error, "ENOENT")) throw error;
    }
    try {
      mkdirSync(reclaimPath, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      throw recoveryError();
    }
    const guard = statSync(reclaimPath);
    const markerPath = `${reclaimPath}/${randomUUID()}`;
    const ownsGuard = () => {
      try {
        const current = statSync(reclaimPath);
        return current.dev === guard.dev && current.ino === guard.ino &&
          existsSync(markerPath);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      }
    };
    const assertGuard = () => {
      if (!ownsGuard() || stale(reclaimPath)) throw recoveryError();
    };
    try {
      writeFileSync(markerPath, "", { flag: "wx", mode: 0o600 });
      if (!ownsGuard()) throw recoveryError();
      const now = new Date();
      utimesSync(reclaimPath, now, now);
      const removeStale = refuseLiveHolder();
      assertGuard();
      if (removeStale) unlinkSync(lockPath);
      if (!acquire()) {
        refuseLiveHolder();
        throw new Error(`[connecta] state file ${path} lock changed during recovery. Retry opening it.`);
      }
    } finally {
      const owned = ownsGuard();
      rmSync(markerPath, { force: true });
      if (owned) rmdirSync(reclaimPath);
    }
  }
  const assertHeld = () => {
    if (readLock() !== contents) {
      throw new Error(`[connecta] state file ${path} lock was lost. Refusing to write a stale snapshot.`);
    }
  };
  localLocks.set(path, contents);
  const heartbeat = setInterval(() => {
    try {
      assertHeld();
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // A replaced lock belongs to its new holder. Failed refreshes let the
      // lease expire; subsequent writes still have to prove ownership.
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    assertHeld,
    release() {
      clearInterval(heartbeat);
      if (localLocks.get(path) === contents) localLocks.delete(path);
      if (readLock() === contents) unlinkSync(lockPath);
    },
  };
}

export interface FileStorageOptions {
  /** Destination for the corrupt-state-file recovery report. Default console. */
  logger?: Logger;
}

/**
 * JSON-file-backed KVStorage for Node. Loads once, persists on every write via
 * an exclusive temp-file + rename. Refuses a second holder of the same path.
 * Call close() when finished to release its lock; process exit also releases it.
 * Only reachable via the "@zackbart/connecta/node"
 * subpath so the main entry stays Workers-clean.
 */
export function fileStorage(
  path: string,
  opts: FileStorageOptions = {},
): KVStorage & { close(): void } {
  path = resolve(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = lockFile(path);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openStores.delete(close);
    if (!openStores.size) process.removeListener("exit", closeStores);
    lock.release();
  };
  const assertOpen = () => {
    if (closed) throw new Error(`[connecta] state file ${path} is closed.`);
  };
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
  try {
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
  } catch (error) {
    close();
    throw error;
  }
  if (!openStores.size) process.on("exit", closeStores);
  openStores.add(close);
  const persist = () => {
    // Physical expiry rides on an operation that was already going to write.
    // Reads only prune memory; they do not rewrite the state file.
    const now = Date.now();
    for (const [key, entry] of Object.entries(data)) {
      if (entry.exp && now > entry.exp) delete data[key];
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    // 0o600 on the tmp file; the atomic rename below preserves it, so the live
    // state file is never briefly world-readable.
    const fd = openSync(tmp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(data));
      } finally {
        closeSync(fd);
      }
      lock.assertHeld();
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
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
    close,
    async get(key) {
      // Reads use the loaded snapshot; only writes need filesystem ownership
      // checks to prevent a reclaimed holder from overwriting newer state.
      assertOpen();
      return fresh(key)?.value ?? null;
    },
    async set(key, value, opts) {
      assertOpen();
      lock.assertHeld();
      data[key] = {
        value,
        ...(opts?.ttlSeconds
          ? { exp: Date.now() + opts.ttlSeconds * 1000 }
          : {}),
      };
      persist();
    },
    async delete(key) {
      assertOpen();
      lock.assertHeld();
      delete data[key];
      persist();
    },
    async list(prefix) {
      assertOpen();
      return Object.keys(data)
        .filter((key) => Boolean(fresh(key)) && key.startsWith(prefix))
        .sort();
    },
  };
}
