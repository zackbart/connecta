import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Reporter, TestModule, TestSpecification, Vitest } from "vitest/node";
import { executedTitles, invariantProblems, referenceProblems } from "./test-titles.js";

// Check the complete Node run (which includes every portable suite too).
// Focused file/name runs and Workers-only runs keep their normal inner loop.
export default class CoverageReporter implements Reporter {
  private vitest: Vitest | undefined;
  private complete = false;

  constructor(private readonly files: readonly string[]) {}

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>) {
    const vitest = this.vitest!;
    const files = new Set(specifications.filter(({ project }) => project.name === "node")
      .map(({ moduleId }) => relative(vitest.config.root, moduleId).split(sep).join("/")));
    this.complete = !vitest.config.testNamePattern &&
      this.files.length === files.size && this.files.every((file) => files.has(file));
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    if (!this.complete) return;
    const root = this.vitest!.config.root;
    const principles = readFileSync(`${root}/PRINCIPLES.md`, "utf8");
    const ids = [...principles.matchAll(/^- \*\*(INV-\d+):/gm)].map((match) => match[1]!);
    const coverage = JSON.parse(readFileSync(`${root}/spec/coverage.json`, "utf8")) as {
      features: Array<{ tests?: Array<{ file: string; title: string }> }>;
    };
    const titles = executedTitles(root, modules.filter(({ project }) => project.name === "node"));
    const references = coverage.features.flatMap(({ tests }) => tests ?? []);
    const problems = [
      ...invariantProblems(ids, titles),
      ...referenceProblems(references, titles),
    ];
    if (problems.length) throw new Error(`Test-backed coverage failed:\n${problems.join("\n")}`);
    this.vitest!.logger.log(`Test-backed coverage: ${ids.length} invariants and ${references.length} spec references backed by passing tests.`);
  }
}
