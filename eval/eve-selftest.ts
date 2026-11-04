/** Opt-in Node 24+ controls through the real Eve server, without subscription auth. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopsBatch } from "./agent/infra.js";
import { eveHelperProblem, runEve } from "./agent/eve.js";
import { runBatch, type TrialResult } from "./agent/run.js";
import { parseTrace } from "./agent/trace.js";
import { META_TOOLS, type Surface } from "./agent/surface.js";
import type { Target } from "./deploy/targets.js";
import { World } from "./fakes/world.js";
import { startNodeDeployment } from "./deploy/node.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { gradeTask, passes } from "./tasks/grading.js";

const task = ACTIVE_TASKS.find((t) => t.id === "p5-known-read-routing")!;
const ANSWER = "CI run 4812 failed on commit 9f2c1ab.";

// A checkout without the helper's build gets instructions, not ENOENT.
const empty = await mkdtemp(join(tmpdir(), "connecta-eve-helper-"));
try {
  assert.match(eveHelperProblem(empty) ?? "", /pnpm install/);
  assert.equal(eveHelperProblem(), undefined);
} finally {
  await rm(empty, { recursive: true, force: true });
}

/** The read each arm makes, and the arm's wrong guess at a name. */
function read(surface: Surface, prefix: string) {
  if (surface === "code")
    return {
      name: `${prefix}execute_code`,
      input: { code: `async () => (await connecta.call("ci.get_run", { runId: 4812 })).data` },
    };
  if (surface === "native" || surface === "native-no-code")
    return { name: `${prefix}ci__get_run`, input: { runId: 4812 } };
  return { name: `${prefix}call_tool`, input: { address: "ci.get_run", args: { runId: 4812 } } };
}

/** Search, one mistaken deferred name, then the arm's read through the full batch path. */
async function armControl(surface: Surface, target: Target, connection?: string, description?: string | null) {
  const prefix = `${connection ?? "connecta"}__`;
  const call = read(surface, prefix);
  const model = "eve-arm-control";
  const { trials, stopped } = await runBatch([task], [model], 1, {
    runner: "eve",
    surface,
    target,
    grading: "outcome",
    concurrency: 1,
    timeoutMs: 120_000,
    eve: {
      ...(connection === undefined ? {} : { connection }),
      ...(description === undefined ? {} : { description }),
      testModelSource: `import { mockModel } from "eve/evals";
export default mockModel({ modelId: ${JSON.stringify(model)}, respond: ({ toolResults, messages }) => {
  if (toolResults.length === 0 && !messages.some((m) => m.text.includes(${JSON.stringify(description ?? "")}))) throw new Error("description absent from prompt");
  if (toolResults.length === 0) return { toolCalls: [{ name: "eve__search", input: { query: ${JSON.stringify(prefix)} } }] };
  if (toolResults.length === 1 && !messages.some((m) => m.role === "tool" && m.text.includes("could not"))) return { toolCalls: [{ name: "eve__tool", input: { name: "not_a_connecta_tool", input: {} } }] };
  if (!toolResults.some((r) => JSON.stringify(r.output ?? "").includes("9f2c1ab"))) return { toolCalls: [{ name: "eve__tool", input: ${JSON.stringify(call)} }] };
  return ${JSON.stringify(ANSWER)};
} });`,
    },
  });
  const label = `${surface} on ${target}`;
  assert.equal(stopped, undefined, label);
  const trial = trials[0] as TrialResult;
  assert.equal(trial.status, "pass", `${label}: ${JSON.stringify({ error: trial.error, checks: trial.checks })}`);
  assert.equal(trial.metrics.hostSearchCalls, 1, label);
  assert.ok((trial.metrics.firstTurnInputTokens ?? 0) > 0, label);
  assert.equal(trial.metrics.otherTools.eve__search, 1, label);
  // The mistaken name reaches the trace as one host-level tool error.
  assert.equal(trial.metrics.otherTools.eve__tool, 1, label);
  assert.equal(trial.metrics.toolErrors, 1, label);
  assert.ok(
    trial.ledger.some((c) => c.tool === "get_run" && c.kind === "read"),
    label,
  );
  // Native calls keep the address mapping graders and metrics read.
  if (surface === "native" || surface === "native-no-code") assert.equal(trial.metrics.metaTools.ci__get_run, 1, label);
  console.log(
    `ok   Eve ${label}${connection ? ` as connection ${connection}` : ""}: search, mistaken name, read, grade`,
  );
}

// Every arm main serves: the code arm exists only on Node.
for (const surface of ["six", "five", "code", "native", "native-no-code"] as const) await armControl(surface, "node");
await armControl("native", "worker");
// Helper changes are tested by naming the connection and choosing its description.
await armControl("native", "node", "gateway", "Issue and CI records");
await armControl("six", "node", "gateway", "Issue and CI records");

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
  // Refusal graders recognize the host's own rejection of a denied write.
  const refusal = trace.toolUses.find((t) => t.tool === "call_destructive_tool");
  assert.equal(refusal?.isError, true);
  assert.match(String(refusal?.resultText), /permission[^.]*denied/i);
  assert.equal(trace.resultSubtypes.join(), "success");
  assert.equal(trace.toolUses.find((t) => t.tool === "call_destructive_tool")?.isError, true);
  assert.equal(trace.permissionDenials.length, 1);
  assert.ok(world.ledger.calls.every((c) => c.kind === "read"));
  await deployment.close();
  deployment = await startNodeDeployment(world.connectorSpecs(), task.deployment, undefined, "native");
  const before = world.ledger.calls.length;
  const nativeRefusal = await runEve({
    model: "eve-native-write-control",
    surface: "native",
    mcpUrl: deployment.mcpUrl,
    token: deployment.token,
    allowedTools: ["skills", "execute_code", "authorize_connector"],
    deniedTools: ["ci__rerun_job"],
    timeoutMs: 120_000,
    firstPrompt: task.prompt,
    nextTurn: async () => undefined,
    testModelSource: `import { mockModel } from "eve/evals";
export default mockModel({ modelId: "eve-native-write-control", respond: ({ toolResults }) =>
  toolResults.length === 0 ? { toolCalls: [{ name: "eve__tool", input: { name: "connecta__ci__rerun_job", input: { runId: 4812 } } }] } : "Refused." });`,
  });
  const nativeTrace = parseTrace(nativeRefusal.events, nativeRefusal.turnStarts, [task.prompt]);
  assert.equal(nativeTrace.toolUses.find((t) => t.tool === "ci__rerun_job")?.isError, true);
  assert.equal(nativeTrace.permissionDenials.length, 1);
  assert.equal(world.ledger.calls.length, before, "A denied native write reached the fake");
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
    "ok   Eve mockModel read, denied six and native writes, and authentication batch-stop through real server and Node target",
  );
} finally {
  await deployment?.close();
  await world.stop();
}
