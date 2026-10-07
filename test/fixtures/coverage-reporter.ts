import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Reporter, TestModule, TestProject, TestSpecification, Vitest } from "vitest/node";
import { executedTitles, invariantProblems, referenceProblems } from "./test-titles.js";

// Check the complete Node run (which includes every portable suite too).
// Focused file/name runs and Workers-only runs keep their normal inner loop.
export default class CoverageReporter implements Reporter {
  private vitest: Vitest | undefined;
  private partial = false;
  private collected = new Set<string>();
  private scheduled = new Set<string>();
  private allowOnly = new Map<TestProject, boolean>();

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  async onTestRunStart(specifications: ReadonlyArray<TestSpecification>) {
    const vitest = this.vitest!;
    const config = vitest.config;
    // Vitest 4 retains start()'s CLI file filters here, but omits this field
    // from its declarations. Static config.filters does not narrow start()'s
    // collection. A collection mismatch is never a filter signal.
    const filters = (vitest as Vitest & { filenamePattern?: string[] }).filenamePattern;
    this.partial = !!(filters?.length || config.testNamePattern ||
      config.project.length || config.shard || config.changed || config.related?.length || config.tagsFilter?.length);
    this.scheduled = new Set(specifications.filter(({ project }) => project.name === "node")
      .map(({ moduleId }) => moduleId));
    this.collected = new Set();
    if (this.partial) return;
    this.collected = new Set((await vitest.globTestSpecifications())
      .filter(({ project }) => project.name === "node").map(({ moduleId }) => moduleId));
    // Vitest rewrites .only to run/skip before reporting the collected tree.
    // Reject it in full runs instead of inferring focus from ordinary skips.
    for (const project of vitest.projects) {
      if (project.name === "node") {
        this.allowOnly.set(project, project.config.allowOnly);
        project.config.allowOnly = false;
      }
    }
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    for (const [project, allowOnly] of this.allowOnly) project.config.allowOnly = allowOnly;
    this.allowOnly.clear();
    if (this.partial) {
      this.vitest!.logger.log("Test-backed coverage: explicit partial run; invariant and spec checks skipped.");
      return;
    }
    const root = this.vitest!.config.root;
    const principles = readFileSync(`${root}/PRINCIPLES.md`, "utf8");
    const ids = [...principles.matchAll(/^- \*\*(INV-\d+):/gm)].map((match) => match[1]!);
    const coverage = JSON.parse(readFileSync(`${root}/spec/coverage.json`, "utf8")) as {
      features: Array<{ tests?: Array<{ file: string; title: string }> }>;
    };
    const nodeModules = modules.filter(({ project }) => project.name === "node");
    const executed = new Set(nodeModules.map(({ moduleId }) => moduleId));
    const collectionProblems = [];
    if (!this.collected.size) collectionProblems.push("Unfiltered Node run collected no suites");
    for (const file of this.collected) {
      const name = relative(root, file).split(sep).join("/");
      if (!this.scheduled.has(file)) collectionProblems.push(`${name}: collected suite was not scheduled in an unfiltered run`);
      if (!executed.has(file)) collectionProblems.push(`${name}: collected suite did not execute in an unfiltered run`);
    }
    for (const file of this.scheduled) {
      if (!this.collected.has(file)) collectionProblems.push(`${relative(root, file)}: scheduled suite was absent from Vitest collection`);
    }
    for (const file of executed) {
      if (!this.collected.has(file)) collectionProblems.push(`${relative(root, file)}: executed suite was absent from Vitest collection`);
    }
    for (const module of nodeModules) {
      if (["pending", "queued"].includes(module.state())) {
        collectionProblems.push(`${relative(root, module.moduleId)}: suite did not finish in an unfiltered run`);
      }
    }
    const titles = executedTitles(root, nodeModules);
    const references = coverage.features.flatMap(({ tests }) => tests ?? []);
    const problems = [
      ...collectionProblems,
      ...invariantProblems(ids, titles),
      ...referenceProblems(references, titles),
    ];
    if (problems.length) throw new Error(`Test-backed coverage failed:\n${problems.join("\n")}`);
    this.vitest!.logger.log(`Test-backed coverage: ${ids.length} invariants and ${references.length} spec references backed by passing tests.`);
  }
}
