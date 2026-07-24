import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
});
