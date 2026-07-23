import { describe, expect, it } from "vitest";
import type { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Executor } from "../src/types.js";

// Compile-time proof that the Workers executor still satisfies our Executor
// seam. This is type-only (no runtime dependency on @cloudflare/codemode);
// `tsc --noEmit` over the test suite fails if the upstream shape ever drifts.
const _check: Executor = null as unknown as DynamicWorkerExecutor;
void _check;

describe("codemode compatibility", () => {
  it("DynamicWorkerExecutor is assignable to Executor (enforced by tsc)", () => {
    expect(true).toBe(true);
  });
});
