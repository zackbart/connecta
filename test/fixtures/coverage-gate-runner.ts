import { BaseSequencer, startVitest, type TestSpecification } from "vitest/node";
import CoverageReporter from "./coverage-reporter.js";

const root = process.argv[2]!;
const mode = process.argv[3];
// Simulate a pool/collection failure that leaves a scheduled suite unexecuted.
class OmitSuite extends BaseSequencer {
  override async sort(specifications: TestSpecification[]) {
    return specifications.filter(({ moduleId }) => !moduleId.endsWith("/other.test.ts"));
  }
}
const vitest = await startVitest("test", mode === "file" ? ["active.test.ts"] : [], {
  root, config: false, run: true, maxWorkers: 1,
  reporters: ["default", new CoverageReporter()],
  ...(mode === "name" ? { testNamePattern: "real test" } : {}),
  ...(mode === "project" ? { project: ["node"] } : {}),
  ...(mode === "shard" ? { shard: "1/2" } : {}),
  ...(mode === "omit" ? { sequence: { sequencer: OmitSuite } } : {}),
  projects: [{ test: {
    name: "node", include: ["test/**/*.test.ts"], exclude: ["**/dist/**"],
  } }],
});
if (!vitest) throw new Error("Fixture runner did not start");
await vitest.close();
