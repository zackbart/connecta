/**
 * A scripted MCP client playing a task's reference (or nothing) against a
 * fresh world and the published-edge Node deployment, shared by
 * `eval:outcomes` and `eval:selftest`. No CLI or model runs.
 */
import { startNodeDeployment, type Deployment } from "../deploy/node.js";
import { World } from "../fakes/world.js";
import { connectMcp, type McpSession } from "../support/mcp.js";
import type { ActiveTask } from "../tasks/types.js";
import { startAuthHost } from "./auth-host.js";
import { assertSurface, type Surface } from "./surface.js";
import { parseTrace, type AgentTrace, type StreamEvent, type ToolUse, type TranscriptEntry } from "./trace.js";

/** A completed scripted conversation: one successful turn end per turn. */
function scriptedTrace(toolUses: ToolUse[], finalAnswer = "", transcript: TranscriptEntry[] = []): AgentTrace {
  const turns = Math.max(1, ...toolUses.map((u) => u.turn), ...transcript.map((e) => e.turn));
  const completions: TranscriptEntry[] = Array.from({ length: turns }, (_, i) => ({
    kind: "turn_end",
    turn: i + 1,
    subtype: "success",
    isError: false,
  }));
  return {
    finalAnswer,
    transcript: [...transcript, ...completions],
    toolUses,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: undefined,
    apiMs: 0,
    modelTurns: 0,
    permissionDenials: [],
    resultSubtypes: Array.from({ length: turns }, () => "success"),
    model: undefined,
    claudeCodeVersion: undefined,
    loadedTools: [],
    rateLimit: undefined,
  };
}

export interface Played {
  world: World;
  trace: AgentTrace;
  deployment: Deployment;
}

interface PlayOptions {
  mode: "reference" | "noop";
  surface?: Surface;
  /** Runs after the surface check and before the reference, on the same session. */
  before?(ctx: { session: McpSession; world: World; toolUses: ToolUse[] }): Promise<void>;
}

/** Play, then inspect the live world and trace before everything is torn down. */
export async function playReference<T>(
  task: ActiveTask,
  options: PlayOptions,
  inspect: (played: Played) => T | Promise<T>,
): Promise<T> {
  const surface = options.surface ?? "six";
  const world = new World(task.world);
  await world.start();
  for (const { service, fault } of task.faults ?? []) world.service(service).faults.push(fault);
  let deployment: Deployment | undefined;
  let host: Awaited<ReturnType<typeof startAuthHost>> | undefined;
  let session: McpSession | undefined;
  try {
    deployment = await startNodeDeployment(
      world.connectorSpecs(),
      task.deployment,
      task.world?.oauth ? world.oauth : undefined,
      surface,
    );
    const hostEvents: StreamEvent[] = [];
    host = task.host
      ? await startAuthHost(deployment, task.host.urlElicitation === "capable", (e) => hostEvents.push(e))
      : undefined;
    session = await connectMcp(host?.mcpUrl ?? deployment.mcpUrl, { Authorization: `Bearer ${deployment.token}` });
    if (!task.world?.oauth && !/^cta_[A-Za-z0-9_-]{43}$/.test(deployment.token)) {
      throw new Error("Node eval did not provision a managed machine token");
    }
    for (const headers of [{}, { Authorization: "Bearer eval-provisioning" }]) {
      const response = await fetch(deployment.mcpUrl, { headers });
      await response.body?.cancel();
      if (response.status !== 401) throw new Error("Node eval admitted an unprovisioned client");
    }
    assertSurface(
      (await session.listTools()).map((t) => t.name),
      surface,
    );
    const live = session;
    const toolUses: ToolUse[] = [];
    const transcript: TranscriptEntry[] = [];
    let turn = 1;
    let finalAnswer = "";
    await options.before?.({ session: live, world, toolUses });
    if (options.mode === "reference") {
      await task.reference({
        world,
        answer: (text) => {
          finalAnswer = text;
          transcript.push({ kind: "assistant", turn, text });
        },
        call: async (tool, args) => {
          const result = await live.call(tool, args);
          toolUses.push({
            id: `ref-${toolUses.length + 1}`,
            turn,
            tool,
            input: args,
            isError: result.isError,
            resultText: result.text,
            resultBlocks: result.content,
          });
          transcript.push({
            kind: "tool_result",
            turn,
            id: toolUses.at(-1)!.id,
            isError: result.isError,
            text: result.text,
            chars: result.text.length,
          });
          return result;
        },
        nextTurn: async () => {
          const followUp = task.followUps?.[turn - 1];
          turn += 1;
          const proceed = await followUp?.before?.({
            world,
            deployment: deployment!,
            trace: scriptedTrace(toolUses, finalAnswer, transcript),
            note: () => {},
          });
          return proceed !== false;
        },
      });
    }
    world.programs = deployment.programs;
    const trace = scriptedTrace(toolUses, finalAnswer, transcript);
    trace.urlElicitations = parseTrace(hostEvents, [], []).urlElicitations ?? [];
    return await inspect({ world, trace, deployment });
  } finally {
    await session?.close();
    await host?.close();
    await deployment?.close();
    await world.stop();
  }
}
