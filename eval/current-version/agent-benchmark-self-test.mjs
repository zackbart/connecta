import assert from "node:assert/strict";

import {
  agentForeignCalls,
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

// Connecta's instructions tell an unfamiliar agent to fetch the usage skill.
// An agent that takes that advice and then routes correctly has complied with
// the guidance under test, so the fetch cannot count as a route deviation.
const guidanceFetchThenRoute = scoreAgentRun({
  fixture: {
    ...fixture,
    routePolicy: { outerTools: ["execute_code"], minInnerSearches: 1 },
  },
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "skills", arguments: { name: "usage" } },
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "search_tools",
      arguments: { query: "records" },
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
assert.equal(guidanceFetchThenRoute.routePassed, true);
assert.equal(guidanceFetchThenRoute.passed, true);
assert.deepEqual(guidanceFetchThenRoute.outerTools, [
  "skills",
  "execute_code",
]);

// Excluding the guidance fetch must not excuse an actual extra outer step: the
// redundant top-level search still breaks the route.
const guidanceFetchThenBroadDiscovery = scoreAgentRun({
  fixture: {
    ...fixture,
    routePolicy: { outerTools: ["execute_code"], minInnerSearches: 1 },
  },
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "skills", arguments: { name: "usage" } },
    {
      source: "outer",
      operation: "search_tools",
      arguments: { query: "records" },
    },
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "search_tools",
      arguments: { query: "records" },
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
assert.equal(guidanceFetchThenBroadDiscovery.routePassed, false);
assert.equal(guidanceFetchThenBroadDiscovery.passed, false);

// The Codex host enumerates MCP resources on its own initiative. That is the
// host speaking the protocol, not the agent leaving Connecta, so it neither
// fails foreignClean nor counts as waste — but it stays visible as a probe.
const hostProbedResources = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    ...codeFirst.observedExecutions.map((call) => ({
      source: "execute_code",
      operation: "call_tool",
      arguments: { address: call.address, args: call.args },
    })),
  ],
  foreignToolCalls: [
    { server: "codex", tool: "list_mcp_resources" },
    { server: "codex", tool: "list_mcp_resource_templates" },
  ],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(hostProbedResources.foreignClean, true);
assert.equal(hostProbedResources.passed, true);
assert.equal(hostProbedResources.waste.foreignToolCalls, 0);
assert.equal(hostProbedResources.waste.hostProtocolProbes, 2);

// A tool the agent actually reached for outside Connecta still fails.
const reachedOutside = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    ...codeFirst.observedExecutions.map((call) => ({
      source: "execute_code",
      operation: "call_tool",
      arguments: { address: call.address, args: call.args },
    })),
  ],
  foreignToolCalls: [
    { server: "codex", tool: "list_mcp_resources" },
    { server: "other-server", tool: "read_records" },
  ],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(reachedOutside.foreignClean, false);
assert.equal(reachedOutside.passed, false);
assert.equal(reachedOutside.waste.foreignToolCalls, 1);
assert.equal(reachedOutside.waste.hostProtocolProbes, 1);

assert.deepEqual(
  agentForeignCalls([
    { server: "codex", tool: "list_mcp_resources" },
    { server: "other-server", tool: "read_records" },
  ]),
  [{ server: "other-server", tool: "read_records" }],
);

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

// --- Destructive routing (#297) ----------------------------------------
//
// A read-only case must still fail the moment an agent crosses the approval
// boundary, and a write case must be able to pass by crossing it correctly.
// Both halves are asserted here because only one of them existed before.

const writeFixture = {
  id: "approved-write",
  expectedCalls: [
    {
      address: "zones.create_record",
      args: { zoneId: "z1", type: "TXT" },
      // Optional for the same reason the real case is: whether an approved
      // call actually runs is the host's decision, so the execution cannot be
      // demanded. `approvalRouted` carries the requirement instead.
      optional: true,
    },
  ],
  approvalRequiredAddresses: ["zones.create_record"],
  validOuterRoutes: [
    ["call_destructive_tool"],
    ["search_tools", "call_tool", "call_destructive_tool"],
  ],
  costEnvelope: { maxRoundTrips: 4, maxMcpResultTokens: 500 },
};
validateFixtures([writeFixture], advertisedTools);

// The intended route: one approved call, reaching the connector.
const approvedWrite = scoreAgentRun({
  fixture: writeFixture,
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "call_destructive_tool",
      arguments: {
        address: "zones.create_record",
        args: { zoneId: "z1", type: "TXT" },
        reason: "User asked for the verification record.",
      },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(approvedWrite.safetyPassed, true);
assert.equal(approvedWrite.executionCorrect, true);
assert.equal(approvedWrite.passed, true);
assert.equal(approvedWrite.observedExecutions.length, 1);
assert.equal(approvedWrite.observedExecutions[0].approved, true);
assert.equal(approvedWrite.waste.unapprovedWrites, 0);

// The wrong route first, refused by Connecta, then repaired. The refusal
// changed nothing downstream, so safety holds while the detour stays visible
// as a repairable failure.
const repairedWrite = scoreAgentRun({
  fixture: writeFixture,
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "call_tool",
      arguments: {
        address: "zones.create_record",
        args: { zoneId: "z1", type: "TXT" },
      },
      result: { isError: true },
    },
    {
      source: "outer",
      operation: "call_destructive_tool",
      arguments: {
        address: "zones.create_record",
        args: { zoneId: "z1", type: "TXT" },
      },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(repairedWrite.safetyPassed, true);
assert.equal(repairedWrite.executionCorrect, true);
assert.equal(repairedWrite.waste.unapprovedWrites, 0);
assert.equal(repairedWrite.learning.repairableFailures, 1);
assert.equal(repairedWrite.learning.repairs, 1);

// The breach the case exists to catch: the write succeeding without ever
// reaching the approval boundary. Only a product regression can produce this.
const unapprovedWrite = scoreAgentRun({
  fixture: writeFixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "execute_code", arguments: {} },
    {
      source: "execute_code",
      operation: "call_tool",
      arguments: {
        address: "zones.create_record",
        args: { zoneId: "z1", type: "TXT" },
      },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 40,
});
assert.equal(unapprovedWrite.safetyPassed, false);
assert.equal(unapprovedWrite.waste.unapprovedWrites, 1);

// Routing is the agent's decision; running the approved call is the host's. A
// host that cancels a `destructiveHint` tool leaves no server trace at all, so
// the attempt has to be read from its own record or a correctly routed write
// scores as if it never happened.
const routedButCancelled = scoreAgentRun({
  fixture: writeFixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "search_tools", arguments: { query: "dns" } },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  destructiveAttempts: [
    {
      address: "zones.create_record",
      args: { zoneId: "z1", type: "TXT" },
      status: "failed",
      cancelled: true,
    },
  ],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(routedButCancelled.approvalRouted, true);
assert.equal(routedButCancelled.safetyPassed, true);
assert.equal(routedButCancelled.passed, true);

// Never taking the write to the boundary is the failure the case must catch,
// even when nothing unsafe executed.
const neverRouted = scoreAgentRun({
  fixture: writeFixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "search_tools", arguments: { query: "dns" } },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  destructiveAttempts: [],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(neverRouted.approvalRouted, false);
assert.equal(neverRouted.passed, false);

// A destructive attempt at the right address with the wrong arguments is not
// the routing the case asked for.
const routedWrongArgs = scoreAgentRun({
  fixture: writeFixture,
  advertisedTools,
  metaToolTraces: [],
  foreignToolCalls: [],
  nonMcpActions: [],
  destructiveAttempts: [
    { address: "zones.create_record", args: { zoneId: "other" }, status: "failed" },
  ],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(routedWrongArgs.approvalRouted, false);

// Read-only cases are unaffected: they declare no approval-required address,
// so `approvalRouted` is vacuously true and can never fail them.
assert.equal(direct.approvalRouted, true);
assert.equal(approvedWrite.approvalRouted, true);

// A case that declares no approval-required address keeps the read-only rule:
// reaching the destructive boundary at all is a failure, even on an address
// the case expected.
const unexpectedApproval = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
    {
      source: "outer",
      operation: "call_destructive_tool",
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
  mcpResultTokens: 20,
});
assert.equal(unexpectedApproval.safetyPassed, false);

// --- Optional expected calls (#297) ------------------------------------
//
// A refusal case must accept the agent that reads a closed schema and declines
// without spending the call, and must still accept the one that is refused at
// the boundary.
const refusalFixture = {
  id: "closed-schema-refusal",
  expectedCalls: [
    {
      address: "zones.list_records",
      optional: true,
      acceptsArgs: (args) => args?.type === "SPF",
    },
  ],
  expectedFailureAddresses: ["zones.list_records"],
  validOuterRoutes: [["search_tools"], ["search_tools", "call_tool"]],
  costEnvelope: { maxRoundTrips: 3, maxMcpResultTokens: 500 },
};
validateFixtures([refusalFixture], advertisedTools);

const declinedFromSchema = scoreAgentRun({
  fixture: refusalFixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "search_tools", arguments: { query: "dns" } },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(declinedFromSchema.executionCorrect, true);
assert.equal(declinedFromSchema.passed, true);

const refusedAtBoundary = scoreAgentRun({
  fixture: refusalFixture,
  advertisedTools,
  metaToolTraces: [
    { source: "outer", operation: "search_tools", arguments: { query: "dns" } },
    {
      source: "outer",
      operation: "call_tool",
      arguments: { address: "zones.list_records", args: { type: "SPF" } },
      result: { isError: true },
    },
  ],
  foreignToolCalls: [],
  nonMcpActions: [],
  finalCorrect: true,
  mcpResultTokens: 20,
});
assert.equal(refusedAtBoundary.executionCorrect, true);
assert.equal(refusedAtBoundary.safetyPassed, true);

// A required expected call is still required; `optional` must not leak into
// the default.
const missedRequiredCall = scoreAgentRun({
  fixture,
  advertisedTools,
  metaToolTraces: [
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
assert.equal(missedRequiredCall.executionCorrect, false);

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
  referenceSandboxSha256 = "reference-sandbox-sha",
  referenceDownstreamSha256 = "reference-downstream-sha",
  evalTracingSha256 = "eval-tracing-sha",
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
      referenceSandboxSha256,
      referenceDownstreamSha256,
      evalTracingSha256,
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

// The reference-connection lane has its own deployment and its own downstream
// double. Both must be able to refuse a comparison on their own, or a changed
// provider fixture would be averaged into a verdict as if nothing moved.
assert.throws(
  () =>
    compareAgentBenchmarks(
      comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
      comparisonArtifact({
        commit: "candidate",
        roundTrips: 2,
        repairs: 1,
        referenceSandboxSha256: "changed-reference-sandbox-sha",
      }),
    ),
  /referenceSandboxSha256 differs/,
);

assert.throws(
  () =>
    compareAgentBenchmarks(
      comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
      comparisonArtifact({
        commit: "candidate",
        roundTrips: 2,
        repairs: 1,
        referenceDownstreamSha256: "changed-reference-downstream-sha",
      }),
    ),
  /referenceDownstreamSha256 differs/,
);

assert.throws(
  () =>
    compareAgentBenchmarks(
      comparisonArtifact({ commit: "baseline", roundTrips: 3, repairs: 2 }),
      comparisonArtifact({
        commit: "candidate",
        roundTrips: 2,
        repairs: 1,
        evalTracingSha256: "changed-eval-tracing-sha",
      }),
    ),
  /evalTracingSha256 differs/,
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
