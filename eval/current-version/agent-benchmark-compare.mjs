import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function rate(count, total) {
  return total === 0 ? 0 : count / total;
}

function average(total, count) {
  return count === 0 ? 0 : total / count;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function caseIds(result) {
  return result.cases.map((fixture) => fixture.id).sort();
}

function assertComparable(baseline, candidate) {
  const errors = [];
  if (baseline.schemaVersion !== 3 || candidate.schemaVersion !== 3) {
    errors.push("both artifacts must use cold-agent schema version 3");
  }
  for (const field of [
    "model",
    "tokenizer",
    "harnessSha256",
    "scoringSha256",
    "sandboxSha256",
    // The reference-connection lane has its own deployment, its own downstream
    // double, and shared instrumentation. A change to any of them changes what
    // was measured just as surely as a change to the fixture sandbox does.
    "referenceSandboxSha256",
    "referenceDownstreamSha256",
    "evalTracingSha256",
  ]) {
    if (baseline.source?.[field] !== candidate.source?.[field]) {
      errors.push(
        `${field} differs (${String(baseline.source?.[field])} vs ${String(candidate.source?.[field])})`,
      );
    }
  }
  if (JSON.stringify(caseIds(baseline)) !== JSON.stringify(caseIds(candidate))) {
    errors.push("case inventories differ");
  }
  if (
    JSON.stringify(baseline.benchmark?.advertisedTools) !==
    JSON.stringify(candidate.benchmark?.advertisedTools)
  ) {
    errors.push("advertised tool inventories differ");
  }
  for (const [label, result] of [["baseline", baseline], ["candidate", candidate]]) {
    const short = result.cases.filter((fixture) => fixture.repetitions < 2);
    if (short.length > 0) {
      errors.push(
        `${label} cases need at least two fresh sessions: ${short.map((fixture) => fixture.id).join(", ")}`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Incomparable cold-agent artifacts:\n- ${errors.join("\n- ")}`);
  }
  reportProductFingerprints(baseline, candidate);
}

/**
 * Reported, never required. A candidate is supposed to measure different
 * product code, so differing fingerprints are the expected case — but two
 * artifacts taken from the same working tree carry the same `commit` and the
 * same `productDirty` flag, and only this hash tells you whether the candidate
 * actually measured a changed `src/`.
 */
function reportProductFingerprints(baseline, candidate) {
  const before = baseline.source?.productSha256;
  const after = candidate.source?.productSha256;
  if (before === undefined || after === undefined) {
    process.stderr.write(
      "Product fingerprint unrecorded on at least one artifact; provenance is commit-level only.\n",
    );
    return;
  }
  process.stderr.write(
    before === after
      ? `Product fingerprint identical on both sides (${before}); the candidate measured no src/ change.\n`
      : `Product fingerprint differs (baseline ${before} vs candidate ${after}); expected for a candidate.\n`,
  );
}

function totals(result) {
  const runs = result.summary.runs;
  return {
    runs,
    taskCorrectRate: rate(result.summary.correct, runs),
    safetyRate: rate(result.summary.safetyPassed, runs),
    contextBudgetRate: rate(result.summary.contextEfficient, runs),
    // A run the host answered from some other server — invented or real — is
    // not evidence about Connecta. Surfaced so a contaminated lane announces
    // itself instead of reading as a product regression.
    hostRoutingCleanRate: rate(result.summary.foreignClean ?? 0, runs),
    averageRoundTrips: average(
      result.runs.reduce((sum, run) => sum + run.connectaRoundTrips, 0),
      runs,
    ),
    averageMcpResultTokens: average(
      result.summary.totalMcpResultTokens,
      runs,
    ),
    averageWholeAgentTokens: average(
      result.summary.totalInputTokens + result.summary.totalOutputTokens,
      runs,
    ),
    learning: Object.fromEntries(
      Object.entries(result.summary.learning).map(([metric, total]) => [
        metric,
        average(total, runs),
      ]),
    ),
  };
}

function delta(baseline, candidate) {
  return round(candidate - baseline);
}

export function compareAgentBenchmarks(baseline, candidate) {
  assertComparable(baseline, candidate);
  const baselineTotals = totals(baseline);
  const candidateTotals = totals(candidate);
  const checks = {
    correctnessNotRegressed:
      candidateTotals.taskCorrectRate >= baselineTotals.taskCorrectRate,
    readOnlySafetyPreserved:
      candidateTotals.safetyRate === 1 &&
      candidateTotals.safetyRate >= baselineTotals.safetyRate,
    contextBudgetNotRegressed:
      candidateTotals.contextBudgetRate >= baselineTotals.contextBudgetRate,
    repairOrRoundTripReduction:
      candidateTotals.learning.repairs < baselineTotals.learning.repairs ||
      candidateTotals.averageRoundTrips < baselineTotals.averageRoundTrips,
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseline: {
      commit: baseline.source.commit,
      productDirty: baseline.source.productDirty,
      productSha256: baseline.source.productSha256,
      ...baselineTotals,
    },
    candidate: {
      commit: candidate.source.commit,
      productDirty: candidate.source.productDirty,
      productSha256: candidate.source.productSha256,
      ...candidateTotals,
    },
    deltas: {
      taskCorrectRate: delta(
        baselineTotals.taskCorrectRate,
        candidateTotals.taskCorrectRate,
      ),
      safetyRate: delta(
        baselineTotals.safetyRate,
        candidateTotals.safetyRate,
      ),
      contextBudgetRate: delta(
        baselineTotals.contextBudgetRate,
        candidateTotals.contextBudgetRate,
      ),
      hostRoutingCleanRate: delta(
        baselineTotals.hostRoutingCleanRate,
        candidateTotals.hostRoutingCleanRate,
      ),
      averageRoundTrips: delta(
        baselineTotals.averageRoundTrips,
        candidateTotals.averageRoundTrips,
      ),
      averageMcpResultTokens: delta(
        baselineTotals.averageMcpResultTokens,
        candidateTotals.averageMcpResultTokens,
      ),
      averageWholeAgentTokens: delta(
        baselineTotals.averageWholeAgentTokens,
        candidateTotals.averageWholeAgentTokens,
      ),
      learning: Object.fromEntries(
        Object.keys(baselineTotals.learning).map((metric) => [
          metric,
          delta(
            baselineTotals.learning[metric],
            candidateTotals.learning[metric],
          ),
        ]),
      ),
    },
    checks,
    qualifies: Object.values(checks).every(Boolean),
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value, digits = 2) {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function renderAgentComparison(comparison) {
  const { baseline, candidate, deltas, checks } = comparison;
  const rows = [
    ["Correctness", percent(baseline.taskCorrectRate), percent(candidate.taskCorrectRate), signed(deltas.taskCorrectRate * 100, 1) + " pp"],
    ["Read-only safety", percent(baseline.safetyRate), percent(candidate.safetyRate), signed(deltas.safetyRate * 100, 1) + " pp"],
    ["Context-budget pass", percent(baseline.contextBudgetRate), percent(candidate.contextBudgetRate), signed(deltas.contextBudgetRate * 100, 1) + " pp"],
    ["Host routing clean (no foreign calls)", percent(baseline.hostRoutingCleanRate), percent(candidate.hostRoutingCleanRate), signed(deltas.hostRoutingCleanRate * 100, 1) + " pp"],
    ["Connecta round trips / run", baseline.averageRoundTrips.toFixed(2), candidate.averageRoundTrips.toFixed(2), signed(deltas.averageRoundTrips)],
    ["MCP result tokens / run", baseline.averageMcpResultTokens.toFixed(1), candidate.averageMcpResultTokens.toFixed(1), signed(deltas.averageMcpResultTokens, 1)],
    ["Whole-agent tokens / run", baseline.averageWholeAgentTokens.toFixed(1), candidate.averageWholeAgentTokens.toFixed(1), signed(deltas.averageWholeAgentTokens, 1)],
    ["Repairs / run", baseline.learning.repairs.toFixed(2), candidate.learning.repairs.toFixed(2), signed(deltas.learning.repairs)],
  ];
  const productState = (artifact) =>
    artifact.productDirty ? "product changes present" : "clean product tree";
  const productFingerprint = (artifact) =>
    artifact.productSha256
      ? `src ${artifact.productSha256.slice(0, 12)}`
      : "src unrecorded";
  return `# Cold-agent comparison

Baseline: \`${baseline.commit}\` (${baseline.runs} runs; ${productState(baseline)}; ${productFingerprint(baseline)})

Candidate: \`${candidate.commit}\` (${candidate.runs} runs; ${productState(candidate)}; ${productFingerprint(candidate)})

## Result

${comparison.qualifies ? "**QUALIFIES**" : "**DOES NOT QUALIFY**"}

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
${rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}

## Acceptance checks

${Object.entries(checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"}: ${name}`).join("\n")}

Negative cost deltas are improvements. Qualification requires repeated comparable sessions, no correctness or context-budget regression, complete read-only safety, and fewer repairs or Connecta round trips.

Host routing below 100% means some run was answered from a server other than Connecta. Those runs measure the host, not the product: read the correctness and context-budget rows as contaminated before reading them as a regression.
`;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    return value;
  };
  const baselinePath = option("--baseline");
  const candidatePath = option("--candidate");
  if (!baselinePath || !candidatePath) {
    throw new Error("--baseline and --candidate are required.");
  }
  const outputPath = resolve(
    option("--output", "results/current-agent-comparison.json"),
  );
  const reportPath = resolve(
    option("--report", "results/current-agent-comparison.md"),
  );
  const [baseline, candidate] = await Promise.all(
    [baselinePath, candidatePath].map(async (path) =>
      JSON.parse(await readFile(resolve(path), "utf8")),
    ),
  );
  const comparison = compareAgentBenchmarks(baseline, candidate);
  await Promise.all([
    writeFile(outputPath, `${JSON.stringify(comparison, null, 2)}\n`),
    writeFile(reportPath, renderAgentComparison(comparison)),
  ]);
  process.stdout.write(
    `${JSON.stringify({ event: "agent_comparison_complete", outputPath, reportPath, qualifies: comparison.qualifies })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
