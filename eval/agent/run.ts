/**
 * One trial = a fresh world, a fresh deployment, one Codex conversation,
 * a grade over the fakes. A batch runs task × model × repeat through a small
 * pool and stops scheduling after an authentication or rate-limit failure.
 */
import type { CallRecord } from "../fakes/service.js";
import { World } from "../fakes/world.js";
import { startNodeDeployment } from "../deploy/node.js";
import { connectMcp, type ListedTool } from "../support/mcp.js";
import type { ActiveTask, Check } from "../tasks/types.js";
import { runCodex } from "./codex.js";
import {
  countBy,
  downstreamMetrics,
  parseTrace,
  toolId,
  type StreamEvent,
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
  apiMs: number | undefined;
  modelTurns: number | undefined;
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
  codex?: {
    requestedModel: string;
    servedModel: string | undefined;
    version: string | undefined;
    exitCode: number | null;
    timedOut: boolean;
    resultSubtypes: string[];
    stderrTail: string;
    argv: string[];
    loadedTools: string[];
  };
  /** Historical results only. New runs never invoke Claude Code. */
  claude?: Record<string, unknown>;
  startedAt: string;
}

interface TrialOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  effort?: string;
  onEvent?(event: StreamEvent): void;
}

const MAX_NUDGES = 2;
const NUDGE = "Yes, go ahead.";
/**
 * A final message that stops to ask permission for what it was told to do:
 * a question at the end, or a "Shall I…" that closes on "let me know…"
 * without a question mark.
 */
const CONFIRMATION =
  /\b(confirm|proceed|go ahead|should i|shall i|want me to|would you like|ok(ay)? to|do you want)\b[^?]*\?\s*$|\b(should i|shall i)\b[\s\S]*\blet me know\b[^\n]*$/i;

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

export function infraError(events: StreamEvent[], exitCode: number | null, loadedTools: string[]): string | undefined {
  const results = events.filter((event) => event.type === "result");
  const failed = results.find(event => event.subtype !== "success");
  const failureText = String(failed?.result ?? "");
  const info = failed?.codex_error_info;
  const code = typeof info === "string" ? info :
    info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  if (["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"].includes(code ?? "")) {
    return `rate or usage limit (${code}): ${failureText.slice(0, 300)}`;
  }
  if (code === "unauthorized") return `authentication failure: ${failureText.slice(0, 300)}`;
  if (["serverOverloaded", "internalServerError", "httpConnectionFailed",
    "responseStreamConnectionFailed", "responseStreamDisconnected",
    "responseTooManyFailedAttempts"].includes(code ?? "")) {
    return `backend failure (${code}): ${failureText.slice(0, 300)}`;
  }
  if (failed && /rate[ -]?limit|too many requests|\b429\b/i.test(failureText)) return `rate limited: ${failureText.slice(0, 300)}`;
  if (failed && /authentication|unauthorized|invalid api key|please run \/login|\b401\b/i.test(failureText)) {
    return `authentication failure: ${failureText.slice(0, 300)}`;
  }
  if (failed) return `Codex turn failed: ${String(failed.result ?? failed.subtype).slice(0, 300)}`;
  if (results.length && !loadedTools.includes(toolId("execute_code"))) {
    return "the connecta MCP server was not connected when the session started";
  }
  const apiError = results.find((event) => event.api_error_status != null);
  if (apiError) return `API error ${String(apiError.api_error_status)}: ${String(apiError.result ?? "").slice(0, 300)}`;
  if (results.length === 0) return `Codex produced no result (exit ${String(exitCode)})`;
  return undefined;
}

export function stopsBatch(error: string | undefined): boolean {
  return /rate or usage limit|rate limited|authentication failure|backend failure/i.test(error ?? "");
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
    const run = await runCodex({
      model,
      mcpUrl: deployment.mcpUrl,
      token: deployment.token,
      allowedTools: allow,
      deniedTools: deny,
      timeoutMs: task.limits?.timeoutMs ?? options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
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
    const error = run.aborted ? "interrupted by operator" : run.timedOut ? "Codex trial timed out" :
      infraError(run.events, run.exitCode, trace.loadedTools);
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
    // Graders are synchronous over the world; artifact state lives in the
    // deployment's store, so it is read into the world first.
    if (deployment.artifacts) world.artifacts = await deployment.artifacts.snapshot();
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
      codex: {
        requestedModel: model,
        servedModel: run.model,
        version: trace.agentVersion,
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
  onTrial?(trial: TrialResult, done: number, total: number): void | Promise<void>;
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
  const worker = async () => {
    while (queue.length && !stopped && !options.signal?.aborted) {
      const next = queue.shift()!;
      const trial = await runTrial(next.task, next.model, next.repeat, options);
      trials.push(trial);
      await options.onTrial?.(trial, trials.length, total);
      if (trial.status === "error" && stopsBatch(trial.error)) {
        stopped ??= trial.error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  if (options.signal?.aborted) stopped ??= "interrupted by operator";
  return { trials, ...(stopped ? { stopped } : {}) };
}
