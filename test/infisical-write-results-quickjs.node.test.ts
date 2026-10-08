// Node-only: runs Infisical identifier, explicit-read and sequential-program regressions in the real QuickJS child-process executor.
import { afterAll, afterEach, it, vi } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import {
  checkInfisicalResult,
  checkInfisicalSequence,
  infisicalResultCases,
} from "./fixtures/infisical-write-results.js";

vi.setConfig({ testTimeout: 20_000 });
const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
afterAll(async () => {
  await executor.close?.();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(infisicalResultCases)(
  "projects identifiers or explicitly reads values for $name in QuickJS returns and guest logs (INV-5)",
  async (testCase) => {
    await checkInfisicalResult(testCase, executor);
  },
);
it("preserves ordinary arguments and repeated write values in one QuickJS program (INV-5)", async () => {
  await checkInfisicalSequence(executor);
});
