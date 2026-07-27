import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStorage } from "../src/storage/file.js";

function tempStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), "connecta-state-")), "state.json");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fileStorage", () => {
  it("round-trips values across instances", async () => {
    const path = tempStatePath();
    await fileStorage(path).set("k", "v");
    expect(await fileStorage(path).get("k")).toBe("v");
  });

  it("honors ttl", async () => {
    const path = tempStatePath();
    const store = fileStorage(path);
    await store.set("k", "v", { ttlSeconds: -1 });
    expect(await store.get("k")).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("k");
    expect(await fileStorage(path).get("k")).toBeNull();
  });

  it("quarantines a corrupt state file instead of overwriting it", async () => {
    const path = tempStatePath();
    writeFileSync(path, "{ not json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = fileStorage(path);
    expect(error).toHaveBeenCalledOnce();

    // The damaged bytes must survive: they are the only copy of the
    // deployment's downstream OAuth tokens and stored credentials.
    const dir = join(path, "..");
    const quarantined = readdirSync(dir).filter((f) =>
      f.includes(".corrupt-"),
    );
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dir, quarantined[0]), "utf8")).toBe("{ not json");

    // And the instance still works, from empty state.
    await store.set("k", "v");
    expect(await fileStorage(path).get("k")).toBe("v");
  });

  it("starts from empty state when no file exists yet", async () => {
    expect(await fileStorage(tempStatePath()).get("k")).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "writes the state file owner-only (0600)",
    async () => {
      const path = tempStatePath();
      await fileStorage(path).set("k", "v");
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

      fileStorage(path); // load repairs the mode
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

    fileStorage(path, {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error },
    });

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toContain("not valid JSON");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
