// Node-only: reads principles and spawns Vitest fixture runs to verify executed evidence.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { invariantProblems, referenceProblems, type TestTitle } from "./fixtures/test-titles.js";

const principles = readFileSync(new URL("../PRINCIPLES.md", import.meta.url), "utf8");
const ids = [...principles.matchAll(/^- \*\*(INV-\d+):/gm)].map((match) => match[1]!);

// These are gaps in parts of an invariant, not exemptions from citing a real
// test. Remove each entry when its target behavior has its own regression.
const TRANSITIONAL_GAPS = {
  "INV-2": "TODO Phase 2 (#706 item 1): replace config-exemption tests with per-pool trust tests.",
  "INV-6": "TODO Phase 2 (#706 item 4): remove raw downstream failure text from logs (#716); activity already has payload-free tests.",
};

describe("principles backed by tests", () => {
  it("gives each documented invariant a unique ID", () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [id, todo] of Object.entries(TRANSITIONAL_GAPS)) {
      expect(ids).toContain(id);
      expect(todo).toMatch(/TODO Phase \d+ \(#\d+ item \d+\)/);
    }
  });

  it("requires a passing enforcing case, rather than a suite or the guard itself", () => {
    const title = "INV-9: evidence";
    for (const state of ["skipped", "pending", "failed"] as const) {
      expect(invariantProblems(["INV-9"], [{ file: "test/write.test.ts", kind: "test", title, state }]))
        .toEqual(["INV-9 has no passing enforcing test"]);
    }
    for (const citation of [
      { file: "test/write.test.ts", kind: "suite", title, state: "passed" },
      { file: "test/invariants.node.test.ts", kind: "test", title, state: "passed" },
    ] as const) {
      expect(invariantProblems(["INV-9"], [citation])).toEqual(["INV-9 has no passing enforcing test"]);
    }
    expect(invariantProblems(["INV-9"], [{ file: "test/write.test.ts", kind: "test", title, state: "passed" }]))
      .toEqual([]);
  });

  it("rejects unknown citations even in skipped test and suite titles", () => {
    expect(invariantProblems([], [
      { file: "test/write.test.ts", kind: "test", title: "INV-99: skipped", state: "skipped" },
      { file: "test/write.test.ts", kind: "suite", title: "INV-98: suite", state: "passed" },
    ])).toEqual([
      "test/write.test.ts: INV-99: skipped: unknown invariant INV-99",
      "test/write.test.ts: INV-98: suite: unknown invariant INV-98",
    ]);
  });

  it("rejects fixture-only, skipped, conditional, and empty parameterized citations from a real runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "connecta-invariant-evidence-"));
    const output = join(root, "titles.json");
    try {
      writeFileSync(join(root, "active.test.ts"), [
        'import { it, describe } from "vitest";',
        '// it("INV-9: comment", () => {});',
        'const prose = "INV-9: ordinary string";',
        'it.skip("INV-9: skipped", () => {});',
        'it.todo("INV-9: todo");',
        'describe.skip("parent", () => { it("INV-9: skipped child", () => {}); });',
        'it("INV-9: runtime skip", (ctx) => { ctx.skip(); });',
        'if (false) { it("INV-9: false branch", () => {}); }',
        'it.each([])("INV-9: empty cases %s", () => {});',
        'function unused() { it("INV-9: unused helper", () => {}); }',
        'it("real test", () => {});',
        'it.each([1, 2])("real case %s", () => {});',
      ].join("\n"));
      // A valid registration in a file outside the runner's include list.
      writeFileSync(join(root, "fixture.test.ts"),
        'import { it } from "vitest"; it("INV-9: unexecuted fixture", () => {});');
      await promisify(execFile)(process.execPath, [
        "--import", "tsx", fileURLToPath(new URL("./fixtures/collect-executed-titles.ts", import.meta.url)), root, output,
      ], { timeout: 20_000 });
      const titles = JSON.parse(readFileSync(output, "utf8")) as TestTitle[];
      expect(titles.filter(({ kind, state }) => kind === "test" && state === "passed").map(({ title }) => title))
        .toEqual(["real test", "real case 1", "real case 2"]);
      expect(invariantProblems(["INV-9"], titles)).toEqual(["INV-9 has no passing enforcing test"]);
      expect(referenceProblems([{ file: "fixture.test.ts", title: "INV-9: unexecuted fixture" }], titles))
        .toEqual(["fixture.test.ts: INV-9: unexecuted fixture: no passing test matches the coverage reference"]);
      expect(referenceProblems([{ file: "active.test.ts", title: "INV-9: skipped" }], titles))
        .toEqual(["active.test.ts: INV-9: skipped: no passing test matches the coverage reference"]);
      expect(referenceProblems([{ file: "active.test.ts", title: "real case 1" }], titles)).toEqual([]);

      // Exercise the same end-of-run reporter installed in vitest.config.ts.
      writeFileSync(join(root, "PRINCIPLES.md"), "- **INV-9: One attempt per write.**\n");
      mkdirSync(join(root, "spec"));
      writeFileSync(join(root, "spec/coverage.json"), JSON.stringify({ features: [] }));
      const runGate = () => promisify(execFile)(process.execPath, [
        "--import", "tsx", fileURLToPath(new URL("./fixtures/collect-executed-titles.ts", import.meta.url)), root, output, "gate",
      ], { timeout: 20_000 });
      await expect(runGate()).rejects.toMatchObject({
        stderr: expect.stringContaining("INV-9 has no passing enforcing test"),
      });
      writeFileSync(join(root, "active.test.ts"),
        readFileSync(join(root, "active.test.ts"), "utf8") + '\nit("INV-9: passing evidence", () => {});');
      await expect(runGate()).resolves.toMatchObject({ stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails the unfiltered coverage gate despite excluded suites and accepts explicit filters", async () => {
    const root = mkdtempSync(join(tmpdir(), "connecta-coverage-collection-"));
    const active = join(root, "test/active.test.ts");
    const runGate = (mode = "full") => promisify(execFile)(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./fixtures/coverage-gate-runner.ts", import.meta.url)), root, mode,
    ], { timeout: 20_000 });
    try {
      mkdirSync(join(root, "test/dist"), { recursive: true });
      mkdirSync(join(root, "spec"));
      writeFileSync(join(root, "PRINCIPLES.md"), "- **INV-9: One attempt per write.**\n");
      writeFileSync(join(root, "spec/coverage.json"), JSON.stringify({ features: [
        { tests: [{ file: "test/active.test.ts", title: "INV-9: evidence" }] },
      ] }));
      writeFileSync(active, 'import { it } from "vitest"; it("real test", () => {});');
      writeFileSync(join(root, "test/other.test.ts"),
        'import { it } from "vitest"; it("other test", () => {});');
      const missingEvidence = {
        stderr: expect.stringContaining("INV-9 has no passing enforcing test"),
      };
      await expect(runGate()).rejects.toMatchObject(missingEvidence);
      writeFileSync(join(root, "test/dist/x.test.ts"),
        'import { it } from "vitest"; it("INV-9: evidence", () => {});');
      await expect(runGate()).rejects.toMatchObject(missingEvidence);
      await expect(runGate()).rejects.toMatchObject({
        stderr: expect.stringContaining("no passing test matches the coverage reference"),
      });
      for (const mode of ["file", "name", "project", "shard"]) {
        await expect(runGate(mode)).resolves.toMatchObject({
          stderr: "", stdout: expect.stringContaining("explicit partial run"),
        });
      }
      // Ordinary runtime skips do not count as an explicit focus filter.
      writeFileSync(active, 'import { it } from "vitest"; it("INV-9: evidence", (ctx) => ctx.skip());');
      await expect(runGate()).rejects.toMatchObject(missingEvidence);
      writeFileSync(active, 'import { it } from "vitest"; it.only("INV-9: evidence", () => {});');
      await expect(runGate()).rejects.toMatchObject({
        stderr: expect.stringContaining("Unexpected .only modifier"),
      });
      writeFileSync(active, 'import { it } from "vitest"; it("INV-9: evidence", () => {});');
      await expect(runGate("omit")).rejects.toMatchObject({
        stderr: expect.stringContaining("test/other.test.ts: collected suite did not execute in an unfiltered run"),
      });
      await expect(runGate()).resolves.toMatchObject({
        stderr: "", stdout: expect.stringContaining("1 invariants and 1 spec references backed by passing tests"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

});
