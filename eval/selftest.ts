/**
 * `npm run eval:selftest` — the harness checking itself, with no LLM.
 *
 * For every active task, a scripted MCP client plays the ideal route against a
 * fresh world and deployment, and the grader must pass it; an agent that does
 * nothing must fail it. A grader that passes a no-op or fails the reference is
 * a broken yardstick, and every later phase would be measured with it.
 */
import { World } from "./fakes/world.js";
import { startNodeDeployment } from "./deploy/node.js";
import { connectMcp } from "./support/mcp.js";
import type { AgentTrace, ToolUse } from "./agent/trace.js";
import { counterexamples } from "./tasks/counterexamples.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { startAuthHost } from "./agent/auth-host.js";
import { parseTrace, type StreamEvent } from "./agent/trace.js";
import { flags } from "./support/meta.js";
import type { ActiveTask, Check } from "./tasks/types.js";

function emptyTrace(toolUses: ToolUse[], finalAnswer = ""): AgentTrace {
  return {
    finalAnswer, transcript: [],
    toolUses,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: undefined,
    apiMs: 0,
    modelTurns: 0,
    permissionDenials: [],
    resultSubtypes: [],
    model: undefined,
    claudeCodeVersion: undefined,
    loadedTools: [],
    rateLimit: undefined,
  };
}

async function play(task: ActiveTask, mode: "reference" | "noop"): Promise<{ correct: Check[]; wrongDestination: Check[]; missingEvidence: Check[]; regressions: ReturnType<typeof counterexamples> }> {
  const world = new World(task.world);
  await world.start();
  for (const { service, fault } of task.faults ?? []) world.service(service).faults.push(fault);
  const deployment = await startNodeDeployment(world.connectorSpecs(), task.deployment, task.world?.oauth ? world.oauth : undefined);
  const hostEvents: StreamEvent[] = [];
  const host = task.host ? await startAuthHost(deployment, task.host.urlElicitation === "capable", e => hostEvents.push(e)) : undefined;
  const session = await connectMcp(host?.mcpUrl ?? deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  const toolUses: ToolUse[] = [];
  let turn = 1;
  let finalAnswer = "";
  try {
    if (!task.world?.oauth && !/^cta_[A-Za-z0-9_-]{43}$/.test(deployment.token)) {
      throw new Error("Node eval did not provision a managed machine token");
    }
    for (const headers of [{}, { Authorization: "Bearer eval-provisioning" }]) {
      const response = await fetch(deployment.mcpUrl, { headers });
      await response.body?.cancel();
      if (response.status !== 401) throw new Error("Node eval admitted an unprovisioned client");
    }
    if (mode === "reference") {
      await task.reference({
        world,
        answer: text => { finalAnswer = text; },
        call: async (tool, args) => {
          const result = await session.call(tool, args);
          toolUses.push({
            id: `ref-${toolUses.length + 1}`,
            turn,
            tool,
            input: args,
            isError: result.isError,
            resultText: result.text,
            resultBlocks: result.content,
          });
          return result;
        },
        nextTurn: async () => {
          const followUp = task.followUps?.[turn - 1];
          turn += 1;
          const proceed = await followUp?.before?.({
            world,
            deployment,
            trace: emptyTrace(toolUses),
            note: () => {},
          });
          return proceed !== false;
        },
      });
    }
    if (deployment.artifacts) world.artifacts = await deployment.artifacts.snapshot();
    world.programs = deployment.programs;
    const trace = emptyTrace(toolUses, finalAnswer);
    trace.urlElicitations = parseTrace(hostEvents, [], []).urlElicitations ?? [];
    const correct = task.grade({ world, trace });
    const regressions = mode === "reference" ? counterexamples(task, world, trace) : [];
    const missingEvidence = task.grade({ world, trace: { ...trace, finalAnswer: "Completed." } });
    // Keep the successful state and answer, but attribute every source call
    // to another destination. This isolates source enforcement from evidence.
    for (const call of world.ledger.calls) call.service = "wrong_destination";
    for (const p of world.programs) for (const c of p.calls) {
      if (typeof c.args[0] === "string") c.args[0] = c.args[0].replace(/^[^.]+/, "wrong_destination");
    }
    const wrongUses = toolUses.map(use => ({ ...use, input: {
      ...use.input,
      ...(typeof use.input.address === "string" ? { address: use.input.address.replace(/^[^.]+/, "wrong_destination") } : {}),
      ...(typeof use.input.connector === "string" ? { connector: "wrong_destination" } : {}),
      ...(typeof use.input.query === "string" ? { query: "wrong_destination" } : {}),
      ...(typeof use.input.code === "string" ? { code: use.input.code.replace(/tracker|ci|assets|oauth|mixpanel|supabase|revenuecat|artifacts|github/gi, "wrong_destination") } : {}),
    } }));
    const wrongDestination = task.grade({ world, trace: { ...trace, toolUses: wrongUses } });
    return { correct, missingEvidence, wrongDestination, regressions };
  } finally {
    await session.close();
    await host?.close();
    await deployment.close();
    await world.stop();
  }
}

const required = (checks: Check[]) => checks.filter((item) => !item.advisory);
let failures = 0;
const args = flags(process.argv.slice(2));
const include = new Set((args.get("include-skipped") ?? "").split(","));
for (const task of ACTIVE_TASKS) {
  if (task.skip && !include.has(task.skip.flag)) {
    console.log(`skip ${task.id}: ${task.skip.reason} Enable with --include-skipped ${task.skip.flag}.`);
    continue;
  }
  const played = await play(task, "reference");
  const reference = played.correct;
  const refFailed = required(reference).filter((item) => !item.pass);
  const noop = (await play(task, "noop")).correct;
  const noopPassed = required(noop).every((item) => item.pass);
  const destinationRejected = played.wrongDestination.some(c => c.id === "correct-destination" && !c.pass) &&
    played.wrongDestination.some(c => c.id === "answer-evidence" && c.pass);
  const evidenceRejected = played.missingEvidence.some(c => c.id === "answer-evidence" && !c.pass) &&
    played.missingEvidence.some(c => c.id === "correct-destination" && c.pass);
  const ok = refFailed.length === 0 && !noopPassed && destinationRejected && evidenceRejected && played.regressions.every(c => c.rejected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${task.id}`);
  for (const item of refFailed) {
    console.log(`       reference failed ${item.id}: ${item.description}${item.detail ? ` (${item.detail})` : ""}`);
  }
  for (const item of reference.filter((entry) => entry.advisory && !entry.pass)) {
    console.log(`       reference advisory miss ${item.id}${item.detail ? ` (${item.detail})` : ""}`);
  }
  for (const c of played.regressions) console.log(`       ${c.rejected ? "rejected" : "FAIL accepted"}: ${c.name}`);
  if (!destinationRejected) console.log("       wrong-destination answer did not fail the destination check independently");
  if (!evidenceRejected) console.log("       right-destination answer without facts did not fail evidence independently");
  if (noopPassed) console.log("       a no-op agent passed the grader");
}
if (failures) {
  console.error(`${failures} task(s) have a broken grader or reference.`);
  process.exitCode = 1;
}
