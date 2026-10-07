import { writeFileSync } from "node:fs";
import { startVitest } from "vitest/node";
import CoverageReporter from "./coverage-reporter.js";
import { executedTitles } from "./test-titles.js";

const root = process.argv[2]!;
const output = process.argv[3]!;
const vitest = await startVitest("test", [], {
  root, config: false, include: ["active.test.ts"], name: "node", run: true,
  reporters: process.argv[4] === "gate" ? [new CoverageReporter(["active.test.ts"])] : [],
});
if (!vitest) throw new Error("Fixture runner did not start");
try {
  writeFileSync(output, JSON.stringify(executedTitles(root, vitest.state.getTestModules())));
} finally {
  await vitest.close();
}
