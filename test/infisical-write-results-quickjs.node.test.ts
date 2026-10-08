// Node-only: runs Infisical write result regressions in the real QuickJS child-process executor.
import { afterAll, afterEach, describe, it, vi } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { checkInfisicalWriteResult, infisicalWriteCases } from "./fixtures/infisical-write-results.js";

vi.setConfig({ testTimeout: 20_000 });
const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
afterAll(async () => {
  await executor.close?.();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

for (const tool of ["create_secret", "update_secret"]) {
  for (const approval of [false, true]) {
    describe(`${tool} ${approval ? "pending approval" : "success"} QuickJS results`, () => {
      it.each(infisicalWriteCases)(
        "withholds unsafe metadata for $name in execute_code returns and guest logs (INV-5)",
        async (testCase) => {
          await checkInfisicalWriteResult(testCase, tool, approval, executor);
        },
      );
    });
  }
}
