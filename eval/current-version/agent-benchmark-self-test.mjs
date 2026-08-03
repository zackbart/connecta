import assert from "node:assert/strict";

import {
  distribution,
  learningMetrics,
  scoreAgentRun,
  validateFixtures,
} from "./agent-benchmark-scoring.mjs";
import {
  compareAgentBenchmarks,
  renderAgentComparison,
} from "./agent-benchmark-compare.mjs";

const advertisedTools = [
  "skills",
  "search_tools",
  "call_tool",
  "call_destructive_tool",
  "authorize_connector",
  "get_result",
  "execute_code",
];
const fixture = {
  id: "two-reads",
  expectedCalls: [
    { address: "records.read", args: { id: 1 } },
    { address: "records.read", args: { id: 2 } },
  ],
  validOuterRoutes: [
    ["execute_code"],
    ["search_tools", "call_tool", "call_tool"],
  ],
  costEnvelope: { maxRoundTrips: 3, maxMcpResultTokens: 100 },
};

validateFixtures([fixture], advertisedTools);

const direct = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "search_tools",
      arguments: { query: "records" },
    },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: 1 } },
    },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: 2 } },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 80,
});
assert.equal(direct.passed, true, "the direct route is valid");

const codeFirst = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "search_tools",
      arguments: { query: "records" },
    },
    {
      source: "execute_code",
      operation: "batch_call",
      arguments: {
        calls: [
          { address: "records.read", args: { id: 1 } },
          { address: "records.read", args: { id: 2 } },
        ],
      },
      result: [
        { address: "records.read", ok: true, data: { id: 1 } },
        { address: "records.read", ok: true, data: { id: 2 } },
      ],
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(codeFirst.passed, true, "the code-first route is valid");
assert.deepEqual(codeFirst.removedToolCalls, []);

const separatelyDiscovered = scoreAgentRun({
  fixture: {
    ...fixture,
    routePolicy: {
      outerTools: ["execute_code"],
      minInnerSearches: 2,
      distinctInnerSearches: true,
    },
  },
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "search_tools",
      arguments: { query: "record one" },
    },
    {
      source: "execute_code",
      operation: "search_tools",
      arguments: { query: "record two" },
    },
    ...codeFirst.observedExecutions.map((call) => ({
      source: "execute_code",
      operation: "call_tool",
      arguments: { address: call.address, args: call.args },
    })),
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(separatelyDiscovered.routePassed, true);

const broadDiscovery = scoreAgentRun({
  fixture: {
    ...fixture,
    routePolicy: {
      outerTools: ["execute_code"],
      minInnerSearches: 2,
      distinctInnerSearches: true,
    },
  },
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "search_tools", arguments: { query: "records" } },
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "search_tools",
      arguments: { query: "record one two" },
    },
    ...separatelyDiscovered.observedExecutions.map((call) => ({
      source: "execute_code",
      operation: "call_tool",
      arguments: { address: call.address, args: call.args },
    })),
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(broadDiscovery.taskCorrect, true);
assert.equal(broadDiscovery.routePassed, false);
assert.equal(broadDiscovery.passed, false);

const partialBatchFailure = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "batch_call",
      arguments: {
        calls: [
          { address: "records.read", args: { id: 1 } },
          { address: "records.read", args: { id: 2 } },
        ],
      },
      result: [
        { address: "records.read", ok: true, data: { id: 1 } },
        {
          address: "records.read",
          ok: false,
          error: "connector unavailable",
        },
      ],
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(partialBatchFailure.observedExecutions[0].failed, false);
assert.equal(partialBatchFailure.observedExecutions[1].failed, true);
assert.equal(partialBatchFailure.executionCorrect, false);
assert.equal(partialBatchFailure.taskCorrect, false);
assert.equal(partialBatchFailure.passed, false);

const modeledBatchFailure = scoreAgentRun({
  fixture: {
    ...fixture,
    expectedFailureAddresses: ["records.read"],
  },
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "batch_call",
      arguments: {
        calls: [
          { address: "records.read", args: { id: 1 } },
          { address: "records.read", args: { id: 2 } },
        ],
      },
      result: [
        { address: "records.read", ok: true, data: { id: 1 } },
        {
          address: "records.read",
          ok: false,
          error: "authorization required",
        },
      ],
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(modeledBatchFailure.executionCorrect, true);
assert.equal(modeledBatchFailure.taskCorrect, true);
assert.equal(modeledBatchFailure.passed, true);

const unavailableRemoved = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "batch_call",
      arguments: {
        calls: [
          { address: "records.read", args: { id: 1 } },
          { address: "records.read", args: { id: 2 } },
        ],
      },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(unavailableRemoved.surfaceValid, false);
assert.deepEqual(unavailableRemoved.unavailableSurfaceCalls, ["batch_call"]);
assert.deepEqual(unavailableRemoved.removedToolCalls, ["batch_call"]);

const expectedAuthFailure = scoreAgentRun({
  fixture: {
    ...fixture,
    expectedCalls: [
      { address: "oauth.whoami", args: {} },
    ],
    expectedFailureAddresses: ["oauth.whoami"],
  },
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "oauth.whoami", args: {} },
      result: {
        isError: true,
        structuredContent: { ok: false },
      },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(expectedAuthFailure.failedMetaToolCalls, 1);
assert.equal(expectedAuthFailure.waste.unexpectedFailedMetaToolCalls, 0);
assert.equal(expectedAuthFailure.executionCorrect, true);
assert.equal(expectedAuthFailure.taskCorrect, true);

const failedOrdinaryRead = scoreAgentRun({
  fixture: {
    ...fixture,
    expectedCalls: [
      { address: "records.read", args: { id: 1 } },
    ],
  },
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: 1 } },
      result: {
        isError: true,
        structuredContent: { ok: false },
      },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(failedOrdinaryRead.executionCorrect, false);
assert.equal(failedOrdinaryRead.taskCorrect, false);
assert.equal(failedOrdinaryRead.passed, false);
assert.equal(failedOrdinaryRead.observedExecutions[0].failed, true);

const repairedReadOnlyArgs = scoreAgentRun({
  fixture: {
    ...fixture,
    expectedCalls: [
      {
        address: "records.read",
        args: { id: 1 },
        acceptsArgs: (args) => args?.id === 1,
      },
    ],
  },
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: "1" } },
      result: { isError: true },
    },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: 1 } },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(repairedReadOnlyArgs.executionCorrect, true);
assert.equal(repairedReadOnlyArgs.safetyPassed, true);
assert.equal(repairedReadOnlyArgs.taskCorrect, true);
assert.equal(repairedReadOnlyArgs.learning.repairableFailures, 1);
assert.equal(repairedReadOnlyArgs.learning.repairs, 1);

const unsafe = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "call_tool",
      arguments: { address: "records.delete", args: { id: 1 } },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(unsafe.safetyPassed, false);
assert.equal(unsafe.executionCorrect, false);

const wasteful = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "search_tools",
      arguments: { query: "records" },
    },
    {
      source: "outer",
      operation: "search_tools",
      arguments: { query: "records" },
    },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: 1 } },
    },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: 2 } },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [{ type: "command_execution" }],
  finalCorrect: true,
  mcpResultTokens: 101,
});
assert.equal(wasteful.taskCorrect, true);
assert.equal(wasteful.passed, false);
assert.equal(wasteful.duplicateMetaToolCalls, 1);
assert.equal(wasteful.waste.nonMcpHostActions, 1);
assert.equal(wasteful.roundTripEfficient, false);
assert.equal(wasteful.contextEfficient, false);

assert.deepEqual(
  learningMetrics([
    {
      source: "outer",
      operation: "search_tools",
      arguments: { query: "issues" },
    },
    {
      source: "outer",
      operation: "skills",
      arguments: { name: "connector:records" },
    },
    {
      source: "outer",
      operation: "describe_tools",
      arguments: { addresses: ["records.read"] },
    },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: "wrong" } },
      result: {
        isError: true,
        structuredContent: { ok: false },
      },
    },
    {
      source: "outer",
      operation: "describe_tools",
      arguments: { addresses: ["records.read"] },
    },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: { id: 1 } },
    },
  ]),
  {
    discoveryCalls: 1,
    guideListCalls: 0,
    guideFetches: 1,
    connectorGuideFetches: 1,
    schemaExpansions: 2,
    executionCalls: 2,
    repairableFailures: 1,
    repairs: 1,
    repeatedLearningCalls: 1,
  },
);

assert.equal(
  learningMetrics([
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "records.read", args: {} },
      result: { isError: true },
    },
  ]).repairs,
  0,
  "a terminal failure is not reported as a repair",
);

assert.deepEqual(distribution([10, 20, 30], (value) => value), {
  min: 10,
  p50: 20,
  p95: 30,
  max: 30,
  mean: 20,
  stddev: Math.sqrt(200 / 3),
});

assert.throws(
  () =>
    validateFixtures(
      [{
        ...fixture,
        validOuterRoutes: [["batch_call"]],
      }],
      advertisedTools,
    ),
  /documented route batch_call uses unavailable tool/,
);

assert.throws(
  () =>
    validateFixtures(
      [{
        ...fixture,
        validOuterRoutes: [
          ["execute_code"],
          ["batch_call"],
        ],
      }],
      advertisedTools,
    ),
  /documented route batch_call uses unavailable tool/,
);

assert.throws(
  () =>
    validateFixtures(
      [fixture],
      [...advertisedTools, "batch_call"],
    ),
  /seven-tool surface mismatch.*removed tools advertised: batch_call/,
);

function comparisonArtifact({
  commit,
  roundTrips,
  repairs,
  correct = 14,
  safety = 14,
  contextEfficient = 14,
  foreignClean = 14,
  repetitions = 2,
  model = "pinned-eval-model",
  harnessSha256 = "harness-sha",
  productSha256 = "product-sha",
}) {
  const caseIds = [
    "exact-address-control",
    "generic-api-read",
    "guide-heavy-query",
    "schema-heavy-dependent-read",
    "unavailable-catalog",
    "auth-handoff",
    "large-result-reduction",
  ];
  const runs = caseIds.flatMap((id) =>
    Array.from({ length: repetitions }, () => ({
      id,
      connectaRoundTrips: roundTrips,
    })),
  );
  return {
    schemaVersion: 3,
    source: {
      commit,
      model,
      tokenizer: "o200k_base",
      harnessSha256,
      productSha256,
    },
    // Per-run detail lives only at the top level; `cases[]` carries aggregates.
    cases: caseIds.map((id) => ({ id, repetitions })),
    runs,
    summary: {
      runs: runs.length,
      correct,
      safetyPassed: safety,
      contextEfficient,
      foreignClean,
      totalMcpResultTokens: runs.length * 100,
      totalInputTokens: runs.length * 1_000,
      totalOutputTokens: runs.length * 100,
      learning: {
        discoveryCalls: runs.length,
        guideListCalls: 0,
        guideFetches: 2,
        connectorGuideFetches: 2,
        schemaExpansions: 4,
        executionCalls: 10,
        repairableFailures: repairs,
        repairs,
        repeatedLearningCalls: 0,
      },
    },
  };
}

const comparison = compareAgentBenchmarks(
  comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
  comparisonArtifact({ commit: "candidate", roundTrips: 2, repairs: 1 }),
);
assert.equal(comparison.qualifies, true);
assert.equal(comparison.deltas.averageRoundTrips, -1);
assert.match(renderAgentComparison(comparison), /\*\*QUALIFIES\*\*/);
assert.match(renderAgentComparison(comparison), /src product-sha/);

// A run the host answered elsewhere drags correctness down; the report has to
// say so on its own row rather than letting it read as a product regression.
const contaminated = compareAgentBenchmarks(
  comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
  comparisonArtifact({
    commit: "candidate",
    roundTrips: 2,
    repairs: 1,
    correct: 10,
    foreignClean: 10,
  }),
);
assert.equal(contaminated.qualifies, false);
assert.equal(contaminated.deltas.hostRoutingCleanRate < 0, true);
assert.match(
  renderAgentComparison(contaminated),
  /Host routing clean \(no foreign calls\)/,
);

assert.throws(
  () =>
    compareAgentBenchmarks(
      comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
      comparisonArtifact({
        commit: "candidate",
        roundTrips: 2,
        repairs: 1,
        model: "different-model",
      }),
    ),
  /model differs/,
);

// Scoring and sandbox fingerprints were already compared; the harness one was
// not covered, and an artifact that simply omits it would have compared
// undefined against undefined and passed.
assert.throws(
  () =>
    compareAgentBenchmarks(
      comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
      comparisonArtifact({
        commit: "candidate",
        roundTrips: 2,
        repairs: 1,
        harnessSha256: "changed-harness-sha",
      }),
    ),
  /harnessSha256 differs/,
);

// Product fingerprints are reported, never required: a candidate is supposed
// to measure changed src/.
const differentProduct = compareAgentBenchmarks(
  comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
  comparisonArtifact({
    commit: "candidate",
    roundTrips: 2,
    repairs: 1,
    productSha256: "changed-product-sha",
  }),
);
assert.equal(differentProduct.qualifies, true);
assert.equal(differentProduct.candidate.productSha256, "changed-product-sha");

assert.throws(
  () =>
    compareAgentBenchmarks(
      comparisonArtifact({
        commit: "baseline",
        roundTrips: 3,
        repairs: 2,
        repetitions: 1,
        correct: 7,
        safety: 7,
        contextEfficient: 7,
        foreignClean: 7,
      }),
      comparisonArtifact({
        commit: "candidate",
        roundTrips: 2,
        repairs: 1,
        repetitions: 1,
        correct: 7,
        safety: 7,
        contextEfficient: 7,
        foreignClean: 7,
      }),
    ),
  /at least two fresh sessions/,
);

process.stdout.write("agent benchmark scoring self-test passed\n");
