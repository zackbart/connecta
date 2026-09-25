import { describe, expect, it } from "vitest";
import { kvArtifactStore, type ArtifactBlobStore } from "../src/artifacts.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { KVStorage } from "../src/types.js";
import { artifactStoreContract, headRecord } from "./artifact-store-contract.js";

describe("kvArtifactStore over memoryStorage", () => {
  artifactStoreContract(() => kvArtifactStore(memoryStorage()));
});

describe("kvArtifactStore with a separate blob store", () => {
  const blobs = new Map<string, string>();
  const blobStore: ArtifactBlobStore = {
    async put(key, body) {
      blobs.set(key, body);
    },
    async get(key) {
      return blobs.get(key) ?? null;
    },
  };
  artifactStoreContract(() => {
    blobs.clear();
    return kvArtifactStore(memoryStorage(), { blobs: blobStore });
  });

  it("keeps bodies out of the key-value store", async () => {
    const kv = memoryStorage();
    const store = kvArtifactStore(kv, { blobs: blobStore });
    await store.putBody("f".repeat(64), "body");
    expect(blobs.get("f".repeat(64))).toBe("body");
    expect(await kv.list?.("")).toEqual([]);
  });
});

describe("kvArtifactStore construction", () => {
  it("refuses storage without compareAndSet, naming the stores that have it", () => {
    const { compareAndSet: _omitted, ...eventual } = memoryStorage();
    expect(() => kvArtifactStore(eventual as KVStorage)).toThrow(
      /compareAndSet and list[\s\S]*Workers KV[\s\S]*d1Storage[\s\S]*fileStorage[\s\S]*memoryStorage/,
    );
  });

  it("refuses storage without list", () => {
    const { list: _omitted, ...unlisted } = memoryStorage();
    expect(() => kvArtifactStore(unlisted as KVStorage)).toThrow(/compareAndSet and list/);
  });

  it("keeps every record under its prefix", async () => {
    const kv = memoryStorage();
    await kv.set("unrelated", "x");
    const store = kvArtifactStore(kv, { prefix: "pages/" });
    await store.swapHead("page", null, headRecord(1));
    await store.putBody("a".repeat(64), "body");
    await store.putVersion("page", "view", 1, headRecord(1).view);
    expect((await kv.list?.("")) ?? []).toEqual([
      `pages/blob:${"a".repeat(64)}`,
      "pages/head:page",
      "pages/ver:page:view:0000000001",
      "unrelated",
    ]);
  });
});
