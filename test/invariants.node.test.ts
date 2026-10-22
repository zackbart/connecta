// Node-only: reads principles and spawns Vitest fixture runs to verify executed evidence.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The coverage reporter in vitest.config.ts fails a complete Node run when an
// invariant or spec reference loses its last passing test. These cases prove
// the gate still fails.
describe("principles backed by tests", () => {
  it("fails the unfiltered coverage gate without passing evidence or an executed suite", async () => {
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
