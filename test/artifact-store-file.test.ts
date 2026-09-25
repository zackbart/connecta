import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kvArtifactStore } from "../src/artifacts.js";
import { fileStorage } from "../src/storage/file.js";
import { artifactStoreContract, headRecord } from "./artifact-store-contract.js";

const opened: { close(): void }[] = [];
const directories: string[] = [];

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "connecta-artifacts-"));
  directories.push(directory);
  return join(directory, "state.json");
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("kvArtifactStore over the Node file store", () => {
  artifactStoreContract(() => {
    const storage = fileStorage(tempPath());
    opened.push(storage);
    return kvArtifactStore(storage);
  });

  it("keeps an artifact across a restart", async () => {
    const path = tempPath();
    const first = fileStorage(path);
    const store = kvArtifactStore(first);
    await store.swapHead("page", null, headRecord(1, "Survives"));
    await store.putBody("c".repeat(64), "body");
    first.close();
    const second = fileStorage(path);
    opened.push(second);
    const reopened = kvArtifactStore(second);
    expect((await reopened.head("page"))?.head.title).toBe("Survives");
    expect(await reopened.body("c".repeat(64))).toBe("body");
  });
});
