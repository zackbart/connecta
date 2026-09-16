import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { required } from "./helpers.js";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStorage } from "../src/storage/file.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
}));

const stores: ReturnType<typeof fileStorage>[] = [];
const paths: string[] = [];

function openStore(...args: Parameters<typeof fileStorage>) {
  const store = fileStorage(...args);
  stores.push(store);
  return store;
}

function tempStatePath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "connecta-state-")), "state.json");
  paths.push(path);
  return path;
}

function writeLock(path: string, pid: number, ageMs = 0) {
  const store = openStore(path);
  const holder = JSON.parse(readFileSync(`${path}.lock`, "utf8"));
  store.close();
  writeFileSync(`${path}.lock`, JSON.stringify({ ...holder, pid }));
  const modified = new Date(Date.now() - ageMs);
  utimesSync(`${path}.lock`, modified, modified);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  for (const path of paths.splice(0)) rmSync(join(path, ".."), { recursive: true, force: true });
});

describe("fileStorage", () => {
  it("refuses a second writer before it can load a stale snapshot", async () => {
    const path = tempStatePath();
    const store = openStore(path);
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
    await store.set("token", "current");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ token: { value: "current" } });
  });

  it("immediately reclaims a fresh lock from a dead local pid", () => {
    const path = tempStatePath();
    writeLock(path, 123456);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    openStore(path);
    expect(kill).toHaveBeenCalledWith(123456, 0);
    expect(JSON.parse(readFileSync(`${path}.lock`, "utf8")).pid).toBe(process.pid);
    expect(existsSync(`${path}.lock.reclaim`)).toBe(false);
  });

  it("reclaims an earlier incarnation with the current pid", () => {
    const path = tempStatePath();
    writeLock(path, process.pid, 60_001);
    const previous = readFileSync(`${path}.lock`, "utf8");
    openStore(path);
    expect(readFileSync(`${path}.lock`, "utf8")).not.toBe(previous);
  });

  it("uses the registry to reclaim a fresh same-pid lock from an earlier incarnation", () => {
    const path = tempStatePath();
    writeLock(path, process.pid);
    openStore(path);
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
  });

  it("refuses a fresh lock with a live foreign pid", () => {
    const path = tempStatePath();
    writeLock(path, 123456);
    vi.spyOn(process, "kill").mockReturnValue(true);
    expect(() => openStore(path)).toThrow("held by pid 123456");
  });

  it("reclaims a stale heartbeat even if the pid is still alive", () => {
    const path = tempStatePath();
    writeLock(path, 123456, 60_001);
    vi.spyOn(process, "kill").mockReturnValue(true);
    openStore(path);
    expect(JSON.parse(readFileSync(`${path}.lock`, "utf8")).pid).toBe(process.pid);
  });

  it("keeps the heartbeat fresh without keeping the process alive", () => {
    vi.useFakeTimers();
    const path = tempStatePath();
    const interval = vi.spyOn(globalThis, "setInterval");
    const store = openStore(path);
    const start = Date.now();
    for (let tick = 1; tick <= 8; tick++) {
      vi.advanceTimersByTime(15_000);
      expect(statSync(`${path}.lock`).mtimeMs).toBeCloseTo(start + tick * 15_000, 0);
    }
    expect(interval.mock.results[0]?.value.hasRef()).toBe(false);
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
    store.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a stale reclaim guard but refuses a fresh one", () => {
    const path = tempStatePath();
    writeLock(path, process.pid, 60_001);
    fs.mkdirSync(`${path}.lock.reclaim`);
    expect(() => openStore(path)).toThrow("lock recovery in progress");
    const expired = new Date(Date.now() - 60_001);
    utimesSync(`${path}.lock.reclaim`, expired, expired);
    openStore(path);
    expect(existsSync(`${path}.lock.reclaim`)).toBe(false);
  });

  it("does not clear a replacement reclaim guard using an earlier stale observation", () => {
    const path = tempStatePath();
    writeLock(path, process.pid, 60_001);
    const guard = `${path}.lock.reclaim`;
    fs.mkdirSync(guard);
    writeFileSync(`${guard}/old-owner`, "");
    const expired = new Date(Date.now() - 60_001);
    utimesSync(guard, expired, expired);
    const read = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
      const result = read(...args);
      if (args[0] === guard) {
        fs.unlinkSync(`${guard}/old-owner`);
        fs.rmdirSync(guard);
        fs.mkdirSync(guard);
        writeFileSync(`${guard}/new-owner`, "");
      }
      return result;
    });
    expect(() => openStore(path)).toThrow("lock recovery in progress");
    expect(existsSync(`${guard}/new-owner`)).toBe(true);
  });

  it("does not treat the same pid in another namespace as a previous incarnation", () => {
    const path = tempStatePath();
    writeLock(path, process.pid);
    const holder = JSON.parse(readFileSync(`${path}.lock`, "utf8"));
    writeFileSync(`${path}.lock`, JSON.stringify({ ...holder, pidScope: "another-container" }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not in this namespace"), { code: "ESRCH" });
    });
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
    expect(kill).not.toHaveBeenCalled();
  });

  it("fences a paused holder after heartbeat expiry and stops touching the replacement", async () => {
    vi.useFakeTimers();
    const path = tempStatePath();
    const store = openStore(path);
    await store.set("k", "old");
    // Advance wall time without running interval callbacks, like a SIGSTOP.
    vi.setSystemTime(Date.now() + 60_001);
    const replacement = openStore(path);
    await replacement.set("k", "new");
    await expect(store.set("k", "stale")).rejects.toThrow("lock was lost");
    await expect(store.delete("k")).rejects.toThrow("lock was lost");
    const touch = vi.spyOn(fs, "utimesSync");
    vi.advanceTimersByTime(15_000);
    expect(touch).toHaveBeenCalledTimes(1);
    store.close();
    expect(await replacement.get("k")).toBe("new");
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
  });

  it("serves reads without reading the lock file", async () => {
    const path = tempStatePath();
    const store = openStore(path);
    await store.set("k", "v");
    const read = vi.spyOn(fs, "readFileSync");
    expect(await store.get("k")).toBe("v");
    expect(await store.list?.("")).toEqual(["k"]);
    expect(read).not.toHaveBeenCalled();
  });

  it("fails closed on an incomplete lock or uncertain pid liveness", () => {
    const path = tempStatePath();
    writeFileSync(`${path}.lock`, "");
    expect(() => openStore(path)).toThrow("lock");
    fs.unlinkSync(`${path}.lock`);
    writeLock(path, 123456);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    expect(() => openStore(path)).toThrow("held by pid 123456");
  });

  it("releases the lock on close and refuses writes from the closed snapshot", async () => {
    const path = tempStatePath();
    const store = openStore(path);
    await store.set("k", "v");
    store.close();
    expect(existsSync(`${path}.lock`)).toBe(false);
    const next = openStore(path);
    store.close();
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
    await expect(store.set("k", "stale")).rejects.toThrow("closed");
    await expect(store.delete("k")).rejects.toThrow("closed");
    expect(await next.get("k")).toBe("v");
  });

  it("uses a fresh exclusive temp file for each write and leaves older temps alone", async () => {
    const path = tempStatePath();
    writeFileSync(`${path}.tmp`, "older writer");
    const rename = vi.spyOn(fs, "renameSync");
    const store = openStore(path);
    await store.set("k", "v");
    await store.set("k", "new");
    const temps = rename.mock.calls.filter((call) => call[1] === path).map((call) => String(call[0]));
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
    expect(temps.every((temp) => temp.startsWith(`${path}.${process.pid}.`) && temp.endsWith(".tmp"))).toBe(true);
    expect(readFileSync(`${path}.tmp`, "utf8")).toBe("older writer");
  });

  it("serializes competing stale-lock reclaimers", () => {
    const path = tempStatePath();
    writeLock(path, 123456);
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 123456) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((...args) => {
      const result = mkdir(...args);
      if (args[0] === `${path}.lock.reclaim`) {
        expect(() => openStore(path)).toThrow("lock recovery in progress");
      }
      return result;
    });
    openStore(path);
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
  });

  it("does not remove a new holder when the stale lock disappears during recovery", () => {
    const path = tempStatePath();
    writeLock(path, 123456);
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 123456) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });
    const read = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === `${path}.lock` && ++reads === 2) {
        fs.unlinkSync(`${path}.lock`);
        // Another opener wins after the read found no lock, before recovery
        // tries to acquire it. A reclaimer must not unlink this live holder.
        openStore(path);
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return read(...args);
    });
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
    expect(() => openStore(path)).toThrow(`held by pid ${process.pid}`);
  });

  it("releases its lock if loading fails", () => {
    const path = tempStatePath();
    writeFileSync(path, "{ not json");
    const error = new Error("logger failed");
    expect(() => openStore(path, {
      logger: { debug() {}, info() {}, warn() {}, error() { throw error; } },
    })).toThrow(error);
    expect(existsSync(`${path}.lock`)).toBe(false);
    openStore(path);
  });

  it("refuses a lost lock and never removes its replacement on close", async () => {
    const path = tempStatePath();
    const store = openStore(path);
    await store.set("k", "v");
    const replacement = JSON.stringify({ pid: process.pid, createdAt: 1, id: "replacement" });
    writeFileSync(`${path}.lock`, replacement);
    await expect(store.set("k", "stale")).rejects.toThrow("lock was lost");
    store.close();
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(replacement);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ k: { value: "v" } });
  });

  it("cleans up a temp file when rename fails", async () => {
    const path = tempStatePath();
    const store = openStore(path);
    await store.set("k", "v");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); });
    await expect(store.set("k", "next")).rejects.toThrow("rename failed");
    expect(readdirSync(join(path, ".."))).toEqual(["state.json", "state.json.lock"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ k: { value: "v" } });
  });

  it("refuses a separate process and releases locks on process exit", () => {
    const path = tempStatePath();
    const store = openStore(path);
    const script = `
      import { fileStorage } from ${JSON.stringify(new URL("../src/storage/file.ts", import.meta.url).href)};
      const store = fileStorage(process.argv[1]);
      await store.set("child", "value");
      process.exit(0);
    `;
    const run = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { encoding: "utf8" });
    const conflict = run();
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain(`held by pid ${process.pid}`);
    store.close();
    const success = run();
    expect(success.status, success.stderr).toBe(0);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ child: { value: "value" } });
  });

  it("round-trips values across instances", async () => {
    const path = tempStatePath();
    const store = openStore(path);
    await store.set("k", "v");
    store.close();
    expect(await openStore(path).get("k")).toBe("v");
  });

  it("honors ttl", async () => {
    const path = tempStatePath();
    const store = openStore(path);
    await store.set("k", "v", { ttlSeconds: -1 });
    expect(await store.get("k")).toBeNull();
    // A later mutation physically prunes expired entries. Reads do not write.
    await store.set("live", "value");
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("k");
    store.close();
    expect(await openStore(path).get("k")).toBeNull();
  });

  it("an expired read does not write the snapshot", async () => {
    const path = tempStatePath();
    writeFileSync(
      path,
      JSON.stringify({
        expired: { value: "gone", exp: Date.now() - 1 },
        live: { value: "old" },
      }),
    );

    const reader = openStore(path);
    const before = readFileSync(path, "utf8");

    expect(await reader.get("expired")).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("quarantines a corrupt state file instead of overwriting it", async () => {
    const path = tempStatePath();
    writeFileSync(path, "{ not json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = openStore(path);
    expect(error).toHaveBeenCalledOnce();

    // The damaged bytes must survive: they are the only copy of the
    // deployment's downstream OAuth tokens and stored credentials.
    const dir = join(path, "..");
    const quarantined = readdirSync(dir).filter((f) =>
      f.includes(".corrupt-"),
    );
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dir, required(quarantined[0])), "utf8")).toBe("{ not json");

    // And the instance still works, from empty state.
    await store.set("k", "v");
    store.close();
    expect(await openStore(path).get("k")).toBe("v");
  });

  it("starts from empty state when no file exists yet", async () => {
    expect(await openStore(tempStatePath()).get("k")).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "writes the state file owner-only (0600)",
    async () => {
      const path = tempStatePath();
      await openStore(path).set("k", "v");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "repairs a loose-permissioned state file on load",
    async () => {
      const path = tempStatePath();
      writeFileSync(path, JSON.stringify({}));
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o777).toBe(0o644);

      openStore(path); // load repairs the mode
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("routes the corruption report through an injected logger", async () => {
    const path = tempStatePath();
    writeFileSync(path, "{ not json");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = vi.fn();

    openStore(path, {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error },
    });

    expect(error).toHaveBeenCalledOnce();
    expect(required(error.mock.calls[0])[0]).toContain("not valid JSON");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
