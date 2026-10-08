import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import { makeRegistry } from "./helpers.js";
import { stashChargeContract } from "./stash-charge-contract.js";
import { compareAndSetContract } from "./storage-contract.js";

describe("memoryStorage compareAndSet", () => {
  compareAndSetContract(() => memoryStorage());
  stashChargeContract(async () => ({ storage: memoryStorage() }));
});

describe("namespaced storage compareAndSet", () => {
  compareAndSetContract(() => makeRegistry([], { storage: memoryStorage() }).scopedStorage("s"));

  it("claims under its own prefix without touching a sibling namespace", async () => {
    const root = memoryStorage();
    const registry = makeRegistry([], { storage: root });
    const alice = registry.scopedStorage("alice");
    const bob = registry.scopedStorage("bob");
    expect(await alice.compareAndSet("lock", null, "a")).toBe(true);
    expect(await bob.compareAndSet("lock", null, "b")).toBe(true);
    expect(await root.get("subject:alice:lock")).toBe("a");
    expect(await root.get("subject:bob:lock")).toBe("b");
    expect(await alice.compareAndSet("lock", "b", null)).toBe(false);
    expect(await alice.compareAndSet("lock", "a", null)).toBe(true);
    expect(await root.get("subject:alice:lock")).toBeNull();
    expect(await root.get("subject:bob:lock")).toBe("b");
  });
});
