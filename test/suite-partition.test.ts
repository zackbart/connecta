import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NODE_ONLY_SUITES, WORKERS_SUITES } from "../vitest.config.js";

type NodeOnlySuite = { file: string; reason: string };

function partitionProblems(
  actualFiles: readonly string[],
  workers: readonly string[],
  nodeOnly: readonly NodeOnlySuite[],
): string[] {
  const actual = new Set(actualFiles);
  const workerSet = new Set(workers);
  const nodeSet = new Set(nodeOnly.map(({ file }) => file));
  const problems: string[] = [];

  for (const file of actual) {
    const inWorkers = workerSet.has(file);
    const inNodeOnly = nodeSet.has(file);
    if (!inWorkers && !inNodeOnly) {
      problems.push(
        `${file} is in neither WORKERS_SUITES nor NODE_ONLY_SUITES`,
      );
    } else if (inWorkers && inNodeOnly) {
      problems.push(
        `${file} is in both WORKERS_SUITES and NODE_ONLY_SUITES`,
      );
    }
  }

  for (const file of new Set([...workerSet, ...nodeSet])) {
    if (!actual.has(file)) {
      problems.push(
        `${file} is listed in WORKERS_SUITES or NODE_ONLY_SUITES but does not exist`,
      );
    }
  }

  for (const { file, reason } of nodeOnly) {
    if (reason.trim() === "") {
      problems.push(`${file} has no NODE_ONLY_SUITES reason`);
    }
  }

  return problems.sort();
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const actualSuites = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => `test/${file}`)
  .sort();

describe("Vitest runtime partition", () => {
  it("classifies every suite into exactly one runtime list", () => {
    const problems = partitionProblems(
      actualSuites,
      WORKERS_SUITES,
      NODE_ONLY_SUITES,
    );
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("names the file and both lists in classification failures", () => {
    expect(
      partitionProblems(["test/unclassified.test.ts"], [], []),
    ).toEqual([
      "test/unclassified.test.ts is in neither WORKERS_SUITES nor NODE_ONLY_SUITES",
    ]);
    expect(
      partitionProblems(
        ["test/double.test.ts"],
        ["test/double.test.ts"],
        [{ file: "test/double.test.ts", reason: "example" }],
      ),
    ).toEqual([
      "test/double.test.ts is in both WORKERS_SUITES and NODE_ONLY_SUITES",
    ]);
  });
});
