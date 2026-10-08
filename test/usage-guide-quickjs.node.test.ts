// Node-only: runs extracted usage examples in real QuickJS child processes.
import { afterAll, it } from "vitest";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { checkUsageExamples } from "./usage-examples.js";

const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
afterAll(async () => { await executor.close?.(); });
it("INV-3 INV-7: usage examples execute and assert their outputs on QuickJS", async () => {
  await checkUsageExamples(executor);
}, 20_000);
