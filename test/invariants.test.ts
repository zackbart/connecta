import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryTitles, sourceTitles } from "./fixtures/test-titles.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const principles = readFileSync(new URL("../PRINCIPLES.md", import.meta.url), "utf8");
const ids = [...principles.matchAll(/^- \*\*(INV-\d+):/gm)].map((match) => match[1]!);
const titles = repositoryTitles(ROOT);

// These are gaps in parts of an invariant, not exemptions from citing a real
// test. Remove each entry when its target behavior has its own regression.
const TRANSITIONAL_GAPS = {
  "INV-2": "TODO Phase 2 (#706 item 1): replace config-exemption tests with per-pool trust tests.",
  "INV-6": "TODO Phase 2 (#706 item 4): remove raw downstream failure text from logs (#716); activity already has payload-free tests.",
};

describe("principles backed by tests", () => {
  it("gives each documented invariant a unique ID and an enforcing test title", () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(titles.some(({ file, kind, title, disabled }) => file !== "test/invariants.test.ts" &&
        kind === "test" && !disabled &&
        [...title.matchAll(/\bINV-\d+\b/g)].some(([citation]) => citation === id)), id).toBe(true);
    }
  });

  it("rejects unknown invariant citations in test and suite titles", () => {
    for (const { file, title } of titles) {
      for (const [id] of title.matchAll(/\bINV-\d+\b/g)) {
        expect(ids, `${file}: ${title}`).toContain(id);
      }
    }
    for (const [id, todo] of Object.entries(TRANSITIONAL_GAPS)) {
      expect(ids).toContain(id);
      expect(todo).toMatch(/TODO Phase \d+ \(#\d+ item \d+\)/);
    }
  });

  it("separates enforcing tests from comments, ordinary strings, and skipped tests", () => {
    const source = [
      'import { it, test, describe } from "vitest";',
      '// it("comment", () => {});',
      'const prose = "ordinary string";',
      'it.skip("skipped", () => {});',
      'test.todo("todo");',
      'it("real test", () => {});',
      'it.each([1, 2])("case %s", () => {});',
      'describe("suite", () => {});',
      'function unused() { it("not registered", () => {}); }',
      'it("outer", () => { it("inside test", () => {}); });',
      'describe("shadowing", () => { const it = () => {}; it("fake", () => {}); });',
      'describe.skip("skipped suite", () => { it("skipped child", () => {}); });',
    ].join("\n");
    expect(sourceTitles("fixture.test.ts", source).filter(({ disabled }) => !disabled)).toEqual([
      { file: "fixture.test.ts", title: "real test", kind: "test" },
      { file: "fixture.test.ts", title: "case %s", kind: "test" },
      { file: "fixture.test.ts", title: "suite", kind: "suite" },
      { file: "fixture.test.ts", title: "outer", kind: "test" },
      { file: "fixture.test.ts", title: "shadowing", kind: "suite" },
    ]);
  });

  it("requires a Vitest import and resolves its local alias", () => {
    expect(sourceTitles("fake.test.ts", 'const it = () => {}; it("fake", () => {});')).toEqual([]);
    expect(sourceTitles("alias.test.ts", 'import { it as check } from "vitest"; check("real", () => {});')).toEqual([
      { file: "alias.test.ts", title: "real", kind: "test" },
    ]);
  });

  it("recognizes browser registrations and excludes hooks and unsupported methods", () => {
    const source = [
      'import { test } from "@playwright/test";',
      'test.describe("browser suite", () => { test("browser case", () => {}); });',
      'test.beforeEach(() => { test("inside hook", () => {}); });',
      'test.fake("unsupported method", () => {});',
    ].join("\n");
    expect(sourceTitles("browser.spec.ts", source)).toEqual([
      { file: "browser.spec.ts", title: "browser suite", kind: "suite" },
      { file: "browser.spec.ts", title: "browser case", kind: "test" },
    ]);
  });

});
