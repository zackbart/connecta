import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import { cloudflareKvStorage } from "../examples/worker/src/cloudflare-kv.js";
import { makeRegistry } from "./helpers.js";
import { compareAndSetContract, requireCas } from "./storage-contract.js";

describe("memoryStorage compareAndSet", () => {
  compareAndSetContract(() => requireCas(memoryStorage()));
});

describe("namespaced storage compareAndSet", () => {
  compareAndSetContract(() =>
    requireCas(makeRegistry([], { storage: memoryStorage() }).scopedStorage("s")),
  );

  it("claims under its own prefix without touching a sibling namespace", async () => {
    const root = memoryStorage();
    const registry = makeRegistry([], { storage: root });
    const alice = requireCas(registry.scopedStorage("alice"));
    const bob = requireCas(registry.scopedStorage("bob"));
    expect(await alice.compareAndSet("lock", null, "a")).toBe(true);
    expect(await bob.compareAndSet("lock", null, "b")).toBe(true);
    expect(await root.get("subject:alice:lock")).toBe("a");
    expect(await root.get("subject:bob:lock")).toBe("b");
    expect(await alice.compareAndSet("lock", "b", null)).toBe(false);
    expect(await alice.compareAndSet("lock", "a", null)).toBe(true);
    expect(await root.get("subject:alice:lock")).toBeNull();
    expect(await root.get("subject:bob:lock")).toBe("b");
  });

  it("declares no compareAndSet over storage that lacks one", () => {
    const { compareAndSet: _omitted, ...plain } = memoryStorage();
    const registry = makeRegistry([], { storage: plain });
    expect("compareAndSet" in registry.scopedStorage("s")).toBe(false);
    expect("compareAndSet" in registry.resultsStorage()).toBe(false);
  });
});

describe("Worker example Cloudflare KV adapter", () => {
  // Workers KV is eventually consistent, so a read-then-write "CAS" would
  // hand two concurrent resumes the same claim. It must stay absent.
  it("declares no compareAndSet", () => {
    const storage = cloudflareKvStorage({} as KVNamespace);
    expect("compareAndSet" in storage).toBe(false);
  });
});
