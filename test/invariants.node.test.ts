// Node-only: reads principles and spawns Vitest fixture runs to verify executed evidence.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { invariantProblems } from "./fixtures/test-titles.js";

// The coverage reporter in vitest.config.ts fails a complete Node run when an
// invariant or spec reference loses its last passing test. These cases prove
// the gate still fails.
describe("principles backed by tests", () => {
  it("requires a passing enforcing case, rather than a suite or the guard itself", () => {
    const title = "INV-9: evidence";
    for (const state of ["skipped", "pending", "failed"] as const) {
      expect(invariantProblems(["INV-9"], [{ file: "test/write.test.ts", kind: "test", title, state }])).toEqual([
        "INV-9 has no passing enforcing test",
      ]);
    }
    for (const citation of [
      { file: "test/write.test.ts", kind: "suite", title, state: "passed" },
      { file: "test/invariants.node.test.ts", kind: "test", title, state: "passed" },
    ] as const) {
      expect(invariantProblems(["INV-9"], [citation])).toEqual(["INV-9 has no passing enforcing test"]);
    }
    expect(
      invariantProblems(["INV-9"], [{ file: "test/write.test.ts", kind: "test", title, state: "passed" }]),
    ).toEqual([]);
  });

  it("fails the unfiltered coverage gate without passing evidence and skips explicit partial runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "connecta-coverage-collection-"));
    const active = join(root, "test/active.test.ts");
    const runGate = (mode = "full") =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./fixtures/coverage-gate-runner.ts", import.meta.url)), root, mode],
        { timeout: 30_000 },
      );
    try {
      mkdirSync(join(root, "test"), { recursive: true });
      mkdirSync(join(root, "spec"));
      writeFileSync(join(root, "PRINCIPLES.md"), "- **INV-9: One attempt per write.**\n");
      writeFileSync(
        join(root, "spec/coverage.json"),
        JSON.stringify({ features: [{ tests: [{ file: "test/active.test.ts", title: "INV-9: evidence" }] }] }),
      );
      writeFileSync(join(root, "test/other.test.ts"), 'import { it } from "vitest"; it("other test", () => {});');
      const missingEvidence = {
        stderr: expect.stringMatching(/INV-9 has no passing enforcing test[\s\S]*no passing test matches/),
      };
      writeFileSync(active, 'import { it } from "vitest"; it("real test", () => {});');
      await expect(runGate()).rejects.toMatchObject(missingEvidence);
      // A runtime skip is not evidence.
      writeFileSync(active, 'import { it } from "vitest"; it("INV-9: evidence", (ctx) => ctx.skip());');
      await expect(runGate()).rejects.toMatchObject(missingEvidence);
      await expect(runGate("project")).resolves.toMatchObject({
        stderr: "",
        stdout: expect.stringContaining("explicit partial run"),
      });
      writeFileSync(active, 'import { it } from "vitest"; it.only("INV-9: evidence", () => {});');
      await expect(runGate()).rejects.toMatchObject({
        stderr: expect.stringContaining("Unexpected .only modifier"),
      });
      writeFileSync(active, 'import { it } from "vitest"; it("INV-9: evidence", () => {});');
      await expect(runGate("omit")).rejects.toMatchObject({
        stderr: expect.stringContaining("test/other.test.ts: collected suite did not execute in an unfiltered run"),
      });
      await expect(runGate()).resolves.toMatchObject({
        stderr: "",
        stdout: expect.stringContaining("1 invariants and 1 spec references backed by passing tests"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
