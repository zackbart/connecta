import assert from "node:assert/strict";

import {
  distribution,
  scoreAgentRun,
  validateFixtures,
} from "./agent-benchmark-scoring.mjs";

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

process.stdout.write("agent benchmark scoring self-test passed\n");
