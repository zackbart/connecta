import { relative, sep } from "node:path";
import type { TestModule, TestSuite, TestState } from "vitest/node";

export interface TestTitle {
  file: string;
  title: string;
  kind: "test" | "suite";
  state: TestState;
}

// Evidence comes from the runner after execution, never from source text.
// Unconfigured fixtures and non-registering calls are absent; skip/todo and
// runtime ctx.skip() remain visible but cannot certify behavior.
export function executedTitles(root: string, modules: ReadonlyArray<TestModule>): TestTitle[] {
  const titles: TestTitle[] = [];
  function visit(parent: TestModule | TestSuite, file: string) {
    for (const child of parent.children) {
      titles.push({
        file, title: child.name, kind: child.type,
        state: child.type === "test" ? child.result().state : child.state(),
      });
      if (child.type === "suite") visit(child, file);
    }
  }
  for (const module of modules) {
    visit(module, relative(root, module.moduleId).split(sep).join("/"));
  }
  return titles;
}

export function invariantProblems(ids: readonly string[], titles: readonly TestTitle[]): string[] {
  const problems: string[] = [];
  for (const id of ids) {
    if (!titles.some(({ file, kind, title, state }) => file !== "test/invariants.node.test.ts" &&
      kind === "test" && state === "passed" &&
      [...title.matchAll(/\bINV-\d+\b/g)].some(([citation]) => citation === id))) {
      problems.push(`${id} has no passing enforcing test`);
    }
  }
  for (const { file, title } of titles) {
    for (const [id] of title.matchAll(/\bINV-\d+\b/g)) {
      if (!ids.includes(id)) problems.push(`${file}: ${title}: unknown invariant ${id}`);
    }
  }
  return problems;
}

export function referenceProblems(
  references: readonly { file: string; title: string }[],
  titles: readonly TestTitle[],
): string[] {
  return references.filter((reference) => !titles.some(({ file, title, kind, state }) =>
    kind === "test" && state === "passed" && file === reference.file && title === reference.title))
    .map(({ file, title }) => `${file}: ${title}: no passing test matches the coverage reference`);
}
