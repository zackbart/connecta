import { afterAll, expect, it } from "vitest";
import type { Executor } from "../src/types.js";
import { checkUsageExamples } from "./usage-examples.js";

// Only workerd has a real Loader. Absence in that project must fail, never skip.
let executor: Executor | undefined;
let inWorkerd = false;
try {
  const module = "cloudflare:test";
  const { env } = await import(/* @vite-ignore */ module);
  inWorkerd = true;
  const { workerExecutor } = await import("../src/worker.js");
  executor = workerExecutor({ loader: env.LOADER });
} catch (error) {
  if (inWorkerd) throw error;
}
afterAll(async () => { await executor?.close?.(); });
it("has a real Worker Loader in the workers project", () => {
  expect(inWorkerd ? executor !== undefined : true).toBe(true);
});
it.skipIf(!executor)("INV-3 INV-7: usage examples execute and assert their outputs on Workers", async () => {
  await checkUsageExamples(executor!);
}, 20_000);
