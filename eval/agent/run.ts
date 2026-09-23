/**
 * One trial = a fresh world, a fresh deployment, one Claude Code conversation,
 * a grade over the fakes. A batch runs task × model × repeat through a small
 * pool and stops scheduling when the account's rate-limit window is nearly
 * spent, rather than burning through somebody's weekly quota.
 */
import type { CallRecord } from "../fakes/service.js";
import { World } from "../fakes/world.js";
import { startNodeDeployment } from "../deploy/node.js";
import { connectMcp, type ListedTool } from "../support/mcp.js";
import type { ActiveTask, Check } from "../tasks/types.js";
import { runClaude, toolId, type StreamEvent } from "./claude.js";
import {
  countBy,
  downstreamMetrics,
  parseTrace,
  type DownstreamMetrics,
  type Tokens,
  type TranscriptEntry,
} from "./trace.js";

interface ApprovalUse {
  turn: number;
  tool: string;
  target: string | undefined;
  reason: string | undefined;
  isError: boolean | undefined;
}

interface TrialMetrics {
  wallMs: number;
  apiMs: number;
  modelTurns: number;
  conversationTurns: number;
  tokens: Tokens;
  costUsd: number | undefined;
  metaTools: Record<string, number>;
  otherTools: Record<string, number>;
  toolErrors: number;
  /** Times the runner answered "yes" to an agent asking permission it already had. */
  confirmationNudges: number;
  downstream: DownstreamMetrics;
}

export interface TrialResult {
  task: string;
  model: string;
  repeat: number;
  status: "pass" | "fail" | "error";
  error?: string;
  checks: Check[];
  metrics: TrialMetrics;
  approvals: {
    allowed: string[];
    denied: string[];
    /** Tools the server does not annotate read-only: a real host would ask. */
    gated: string[];
    exercised: ApprovalUse[];
    permissionDenials: unknown[];
  };
  transcript: TranscriptEntry[];
  ledger: (Omit<CallRecord, "args"> & { args: string })[];
  claude: {
    model: string | undefined;
    version: string | undefined;
    exitCode: number | null;
    timedOut: boolean;
    resultSubtypes: string[];
    stderrTail: string;
    argv: string[];
    loadedTools: string[];
  };
  startedAt: string;
}

interface TrialOptions {
  timeoutMs: number;
  maxBudgetUsd?: number;
  effort?: string;
  mcpOutputTokens?: number;
  onEvent?(event: StreamEvent): void;
}

const MAX_NUDGES = 2;
const NUDGE = "Yes, go ahead.";
/** A final message that stops to ask permission for what it was told to do. */
const CONFIRMATION =
  /\b(confirm|proceed|go ahead|should i|shall i|want me to|would you like|ok(ay)? to|do you want)\b[^?]*\?\s*$/i;

async function surfaceOf(mcpUrl: string, token: string): Promise<ListedTool[]> {
  const session = await connectMcp(mcpUrl, { Authorization: `Bearer ${token}` });
  try {
    return await session.listTools();
  } finally {
    await session.close();
  }
}

function clipArgs(args: unknown): string {
  const text = JSON.stringify(args);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function infraError(events: StreamEvent[], exitCode: number | null, loadedTools: string[]): string | undefined {
  const results = events.filter((event) => event.type === "result");
  if (results.length && !loadedTools.includes(toolId("execute_code"))) {
    return "the connecta MCP server was not connected when the session started";
  }
  const apiError = results.find((event) => event.api_error_status != null);
  if (apiError) return `API error ${String(apiError.api_error_status)}: ${String(apiError.result ?? "").slice(0, 300)}`;
  const rejected = events.find(
    (event) =>
      event.type === "rate_limit_event" &&
      (event.rate_limit_info as { status?: string } | undefined)?.status === "rejected",
  );
  if (rejected) return "rate limited (status: rejected)";
  if (results.length === 0) return `claude produced no result (exit ${String(exitCode)})`;
  const authFailure = results.find((event) =>
    /invalid api key|please run \/login|authentication_error|oauth token/i.test(String(event.result ?? "")),
  );
  if (authFailure) return `authentication failure: ${String(authFailure.result).slice(0, 200)}`;
  return undefined;
}

async function runTrial(
  task: ActiveTask,
  model: string,
  repeat: number,
  options: TrialOptions,
): Promise<TrialResult> {
  const startedAt = new Date().toISOString();
  const world = new World(task.world);
  await world.start();
  for (const { service, fault } of task.faults ?? []) world.service(service).faults.push(fault);
  const deployment = await startNodeDeployment(world.connectorSpecs(), task.deployment);
  try {
    const surface = await surfaceOf(deployment.mcpUrl, deployment.token);
    const deny = task.approvals?.deny ?? [];
    const allow = (task.approvals?.allow ?? surface.map((tool) => tool.name)).filter(
      (tool) => !deny.includes(tool),
    );
    const gated = surface.filter((tool) => !tool.readOnly).map((tool) => tool.name);
    const prompts = [task.prompt];
    const notes: { beforeTurn: number; text: string }[] = [];
    let followUpsSent = 0;
    let nudges = 0;
    const run = await runClaude({
      model,
      mcpUrl: deployment.mcpUrl,
      token: deployment.token,
      allowedTools: allow.map(toolId),
      disallowedTools: deny.map(toolId),
      timeoutMs: task.limits?.timeoutMs ?? options.timeoutMs,
      ...(task.limits?.maxBudgetUsd ?? options.maxBudgetUsd
        ? { maxBudgetUsd: task.limits?.maxBudgetUsd ?? options.maxBudgetUsd }
        : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.mcpOutputTokens ? { mcpOutputTokens: options.mcpOutputTokens } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      firstPrompt: task.prompt,
      nextTurn: async (turnIndex, events) => {
        const followUp = task.followUps?.[followUpsSent];
        if (!followUp) {
          // Every scripted turn is spent. An agent that stops to ask "shall I
          // post it?" after being told to post gets the answer a human would
          // give, so the trial measures the task rather than the model's
          // habit of asking. Each nudge is counted and reported.
          const last = parseTrace(events, [], [])
            .transcript.filter((entry) => entry.kind !== "turn_end")
            .at(-1);
          if (
            nudges < MAX_NUDGES &&
            last?.kind === "assistant" &&
            CONFIRMATION.test(last.text)
          ) {
            nudges += 1;
            prompts.push(NUDGE);
            return NUDGE;
          }
          return undefined;
        }
        followUpsSent += 1;
        const proceed = await followUp.before?.({
          world,
          deployment,
          trace: parseTrace(events, [], []),
          note: (text) => notes.push({ beforeTurn: turnIndex + 1, text }),
        });
        if (proceed === false) return undefined;
        prompts.push(followUp.prompt);
        return followUp.prompt;
      },
    });
    const trace = parseTrace(run.events, run.turnStarts, prompts);
    for (const note of notes) {
      const at = trace.transcript.findIndex(
        (entry) => entry.kind === "user" && entry.turn === note.beforeTurn,
      );
      const entry: TranscriptEntry = { kind: "operator", turn: note.beforeTurn - 1, text: note.text };
      if (at >= 0) trace.transcript.splice(at, 0, entry);
      else trace.transcript.push(entry);
    }
    const surfaceNames = new Set(surface.map((tool) => tool.name));
    const metrics: TrialMetrics = {
      wallMs: run.wallMs,
      apiMs: trace.apiMs,
      modelTurns: trace.modelTurns,
      conversationTurns: run.turnStarts.length,
      tokens: trace.tokens,
      costUsd: trace.costUsd,
      metaTools: countBy(trace.toolUses.filter((use) => surfaceNames.has(use.tool)), (use) => use.tool),
      otherTools: countBy(trace.toolUses.filter((use) => !surfaceNames.has(use.tool)), (use) => use.tool),
      toolErrors: trace.toolUses.filter((use) => use.isError).length,
      confirmationNudges: nudges,
      downstream: downstreamMetrics(world.ledger.calls, world.ledger.requests),
    };
    const error = infraError(run.events, run.exitCode, trace.loadedTools);
    const completed = check(
      "conversation-completed",
      "every turn ended normally within the time limit",
      !run.timedOut && trace.resultSubtypes.length > 0 && trace.resultSubtypes.every((subtype) => subtype === "success"),
      run.timedOut ? "timed out" : trace.resultSubtypes.join(", "),
    );
    const unprompted: Check = {
      id: "no-confirmation-needed",
      description: "finished without stopping to ask permission it had been given",
      pass: nudges === 0,
      ...(nudges ? { detail: `${nudges} nudge(s)` } : {}),
      advisory: true,
    };
    const checks = error ? [] : [completed, ...task.grade({ world, trace }), unprompted];
    const passed = checks.every((item) => item.advisory || item.pass);
    return {
      task: task.id,
      model,
      repeat,
      status: error ? "error" : passed ? "pass" : "fail",
      ...(error ? { error } : {}),
      checks,
      metrics,
      approvals: {
        allowed: allow,
        denied: deny,
        gated,
        exercised: trace.toolUses
          .filter((use) => gated.includes(use.tool))
          .map((use) => ({
            turn: use.turn,
            tool: use.tool,
            target:
              typeof use.input.address === "string"
                ? use.input.address
                : typeof use.input.connector === "string"
                  ? use.input.connector
                  : undefined,
            reason: typeof use.input.reason === "string" ? use.input.reason : undefined,
            isError: use.isError,
          })),
        permissionDenials: trace.permissionDenials,
      },
      transcript: trace.transcript,
      ledger: world.ledger.calls.map((call) => ({ ...call, args: clipArgs(call.args) })),
      claude: {
        model: trace.model,
        version: trace.claudeCodeVersion,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        resultSubtypes: trace.resultSubtypes,
        stderrTail: run.stderrTail,
        argv: run.argv,
        loadedTools: trace.loadedTools,
      },
      startedAt,
    };
  } finally {
    await deployment.close();
    await world.stop();
  }
}

function check(id: string, description: string, pass: boolean, detail?: string): Check {
  return { id, description, pass, ...(detail ? { detail } : {}) };
}

export interface BatchOptions extends TrialOptions {
  concurrency: number;
  /** Stop scheduling once any reported rate-limit window reaches this. */
  maxUtilization: number;
  onTrial?(trial: TrialResult, done: number, total: number): void;
}

export async function runBatch(
  tasks: ActiveTask[],
  models: string[],
  repeats: number,
  options: BatchOptions,
): Promise<{ trials: TrialResult[]; stopped?: string }> {
  const queue: { task: ActiveTask; model: string; repeat: number }[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const task of tasks) for (const model of models) queue.push({ task, model, repeat });
  }
  const total = queue.length;
  const trials: TrialResult[] = [];
  let stopped: string | undefined;
  const onEvent = (event: StreamEvent) => {
    options.onEvent?.(event);
    if (event.type !== "rate_limit_event") return;
    const info = event.rate_limit_info as {
      status?: string;
      unifiedWindows?: Record<string, { utilization?: number }>;
    };
    const utilization = Math.max(
      0,
      ...Object.values(info.unifiedWindows ?? {}).map((window) => window.utilization ?? 0),
    );
    if (info.status === "rejected") stopped ??= "rate limit rejected a request";
    else if (utilization >= options.maxUtilization) {
      stopped ??= `rate-limit utilization reached ${Math.round(utilization * 100)}% (limit ${Math.round(options.maxUtilization * 100)}%)`;
    }
  };
  const worker = async () => {
    while (queue.length && !stopped) {
      const next = queue.shift()!;
      const trial = await runTrial(next.task, next.model, next.repeat, { ...options, onEvent });
      trials.push(trial);
      options.onTrial?.(trial, trials.length, total);
      if (trial.status === "error" && /rate limited|authentication failure/.test(trial.error ?? "")) {
        stopped ??= trial.error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return { trials, ...(stopped ? { stopped } : {}) };
}
