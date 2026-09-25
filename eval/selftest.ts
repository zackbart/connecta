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
import { ACTIVE_TASKS } from "./tasks/index.js";
import type { ActiveTask, Check } from "./tasks/types.js";

function emptyTrace(toolUses: ToolUse[]): AgentTrace {
  return {
    transcript: [],
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

async function play(task: ActiveTask, mode: "reference" | "noop"): Promise<Check[]> {
  const world = new World(task.world);
  await world.start();
  for (const { service, fault } of task.faults ?? []) world.service(service).faults.push(fault);
  const deployment = await startNodeDeployment(world.connectorSpecs(), task.deployment);
  const session = await connectMcp(deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
  const toolUses: ToolUse[] = [];
  let turn = 1;
  try {
    if (mode === "reference") {
      await task.reference({
        world,
        call: async (tool, args) => {
          const result = await session.call(tool, args);
          toolUses.push({
            id: `ref-${toolUses.length + 1}`,
            turn,
            tool,
            input: args,
            isError: result.isError,
            resultText: result.text,
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
    return task.grade({ world, trace: emptyTrace(toolUses) });
  } finally {
    await session.close();
    await deployment.close();
    await world.stop();
  }
}

const required = (checks: Check[]) => checks.filter((item) => !item.advisory);
let failures = 0;
for (const task of ACTIVE_TASKS) {
  const reference = await play(task, "reference");
  const refFailed = required(reference).filter((item) => !item.pass);
  const noop = await play(task, "noop");
  const noopPassed = required(noop).every((item) => item.pass);
  const ok = refFailed.length === 0 && !noopPassed;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${task.id}`);
  for (const item of refFailed) {
    console.log(`       reference failed ${item.id}: ${item.description}${item.detail ? ` (${item.detail})` : ""}`);
  }
  for (const item of reference.filter((entry) => entry.advisory && !entry.pass)) {
    console.log(`       reference advisory miss ${item.id}${item.detail ? ` (${item.detail})` : ""}`);
  }
  if (noopPassed) console.log("       a no-op agent passed the grader");
}
if (failures) {
  console.error(`${failures} task(s) have a broken grader or reference.`);
  process.exitCode = 1;
}
