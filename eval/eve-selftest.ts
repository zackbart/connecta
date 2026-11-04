/** Opt-in Node 24+ control through the real Eve server, without subscription auth. */
import assert from "node:assert/strict";
import { stopsBatch } from "./agent/infra.js";
import { runEve } from "./agent/eve.js";
import { parseTrace } from "./agent/trace.js";
import { META_TOOLS } from "./agent/surface.js";
import { World } from "./fakes/world.js";
import { startNodeDeployment } from "./deploy/node.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { gradeTask, passes } from "./tasks/grading.js";

const task = ACTIVE_TASKS.find((t) => t.id === "p5-known-read-routing")!;
const world = new World(task.world);
await world.start();
let deployment: Awaited<ReturnType<typeof startNodeDeployment>> | undefined;
try {
  deployment = await startNodeDeployment(world.connectorSpecs(), task.deployment);
  const result = await runEve({
    model: "eve-read-control",
    mcpUrl: deployment.mcpUrl,
    token: deployment.token,
    allowedTools: META_TOOLS.filter((t) => t !== "call_destructive_tool"),
    deniedTools: ["call_destructive_tool"],
    timeoutMs: 120_000,
    firstPrompt: task.prompt,
    nextTurn: async () => undefined,
    testModelSource: `import { mockModel } from "eve/evals";
export default mockModel({ modelId: "eve-read-control", respond: ({ toolResults }) =>
  toolResults.length === 0 ? { toolCalls: [{ name: "eve__search", input: { query: "connecta__call_tool" } }] } :
  toolResults.length === 1 ? { toolCalls: [{ name: "eve__tool", input: { name: "connecta__call_tool", input: { address: "ci.get_run", args: { runId: 4812 } } } }] } :
  toolResults.length === 2 ? { toolCalls: [{ name: "eve__tool", input: { name: "connecta__call_destructive_tool", input: { address: "issues.close_issue", args: { id: 102 } } } }] } :
  "CI run 4812 failed on commit 9f2c1ab." });`,
  });
  assert.equal(result.exitCode, 0, JSON.stringify({ events: result.events, logs: result.stderrTail }));
  const trace = parseTrace(result.events, result.turnStarts, [task.prompt]);
  const checks = gradeTask(task, { world, trace }, "six", "outcome");
  assert.ok(passes(checks, "outcome"), JSON.stringify(checks));
  assert.equal(trace.toolUses.filter((t) => t.tool === "eve__search").length, 1);
  assert.equal(trace.toolUses.find((t) => t.tool === "call_tool")?.isError, false);
  assert.equal(trace.resultSubtypes.join(), "success");
  assert.equal(trace.toolUses.find((t) => t.tool === "call_destructive_tool")?.isError, true);
  assert.equal(trace.permissionDenials.length, 1);
  assert.ok(world.ledger.calls.every((c) => c.kind === "read"));
  const authFailure = await runEve({
    model: "eve-auth-control",
    mcpUrl: deployment.mcpUrl,
    token: "invalid-eval-token",
    allowedTools: [...META_TOOLS],
    deniedTools: [],
    timeoutMs: 120_000,
    firstPrompt: task.prompt,
    nextTurn: async () => undefined,
    testModelSource: `import { mockModel } from "eve/evals";
export default mockModel({ modelId: "eve-auth-control", respond: ({ toolResults }) => toolResults.length === 0 ? { toolCalls: [{ name: "eve__search", input: { query: "connecta__call_tool" } }] } : "Unavailable" });`,
  });
  assert.equal(authFailure.exitCode, 1);
  assert.ok(stopsBatch(String(authFailure.events.at(-1)?.result)));
  console.log(
    "ok   Eve mockModel read, denied write and authentication batch-stop through real server and Node target",
  );
} finally {
  await deployment?.close();
  await world.stop();
}
