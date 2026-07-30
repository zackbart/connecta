import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeAgentBenchmark } from "./performance-report-agent.mjs";

const legacy = JSON.parse(
  await readFile(
    new URL(
      "./results/current-agent-performance.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const normalizedLegacy = normalizeAgentBenchmark(legacy);
assert.equal(normalizedLegacy.reportSchema, "v1-legacy");
assert.equal(normalizedLegacy.summary.runs, legacy.cases.length);
assert.equal(normalizedLegacy.cases[0].repetitions, 1);
assert.equal(normalizedLegacy.cases[0].rates.safetyPassed, null);
assert.equal(
  normalizedLegacy.cases[0].costEnvelope.maxMcpResultTokens,
  legacy.cases[0].mcpResultTokenBudget,
);

const normalizedV2 = normalizeAgentBenchmark({
  schemaVersion: 2,
  summary: { runs: 3 },
  runs: [{ id: "sample" }],
  cases: [{ id: "sample" }],
});
assert.equal(normalizedV2.reportSchema, "v2");
assert.equal(normalizedV2.summary.runs, 3);
assert.equal(normalizedV2.runs.length, 1);

assert.throws(
  () => normalizeAgentBenchmark({ schemaVersion: 99 }),
  /Unsupported agent benchmark schema 99/,
);

process.stdout.write("performance report compatibility self-test passed\n");
