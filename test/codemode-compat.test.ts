import { describe, expect, it } from "vitest";
import type { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Executor } from "../src/types.js";
import { createConnecta } from "../src/index.js";

// The provider/result seam remains structurally compatible. This does not
// grant construction-time acceptance: upstream has no lifecycle brand.
const _check: Executor = null as unknown as DynamicWorkerExecutor;
void _check;

describe("codemode compatibility", () => {
  it("upstream's Promise provider/result shape remains assignable (enforced by tsc)", () => {
    expect(true).toBe(true);
  });
});

const inWorkerd = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
describe.skipIf(!inWorkerd)("executor construction in workerd", () => {
  it("rejects a real minified upstream bundle and its subclass before loading a Worker", async () => {
    const { DynamicWorkerExecutor } = await import("virtual:connecta-minified-upstream");
    expect(DynamicWorkerExecutor.name).not.toBe("DynamicWorkerExecutor");
    const loader = { load() { throw new Error("Construction must not load a Worker."); } } as unknown as WorkerLoader;
    class MinifiedSubclass extends DynamicWorkerExecutor {}
    for (const executor of [new DynamicWorkerExecutor({ loader }), new MinifiedSubclass({ loader })]) {
      expect(() => createConnecta({ connectors: [], executor, logger: "silent" }))
        .toThrow("ConnectaConfig.executor must declare its lifecycle");
    }
  });

  it("accepts real adapters from separate module copies with the same non-enumerable brand", async () => {
    const original = await import("../src/worker.js");
    const duplicate = await import("virtual:connecta-duplicate-worker");
    expect(original.workerExecutor).not.toBe(duplicate.workerExecutor);
    const loader = { load() { throw new Error("Construction must not load a Worker."); } } as unknown as WorkerLoader;
    for (const makeExecutor of [original.workerExecutor, duplicate.workerExecutor]) {
      const executor = makeExecutor({ loader });
      expect(Object.getOwnPropertyDescriptor(executor, Symbol.for("connecta.executor")))
        .toMatchObject({ enumerable: false, value: { version: 1, lifecycle: "leased" } });
      const app = createConnecta({ connectors: [], executor, logger: "silent" });
      await app.close();
    }
  });
});
