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
import { runClaude } from "./claude.js";
import { gradeTask, classifyChecks, passes, type Grading } from "../tasks/grading.js";
import { taskForSurface } from "../tasks/surface.js";
import { assertSurface, type Surface } from "./surface.js";
import { startAuthHost } from "./auth-host.js";
import { infraError, stopsBatch } from "./infra.js";
import { saveGradeInputs, type SavedGradeInputs } from "./saved.js";
import { conversationCompletion } from "./completion.js";
import {
  countBy,
  downstreamMetrics,
  parseTrace,
  type AgentTrace,
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
  surface?: Surface;
  grading?: Grading;
  model: string;
  repeat: number;
  status: "pass" | "fail" | "error" | "skipped";
  skip?: { code: "runner-limitation"; reason: string };
  saved?: SavedGradeInputs;
  regrade?: { applied: string[]; unavailable: string[]; reason?: string };
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
  finalAnswer?: string;
  urlElicitations?: AgentTraceElicitations;
  ledger: (Omit<CallRecord, "args"> & { args: string })[];
  codex?: {
    requestedModel: string;
    servedModel: string | undefined;
    version: string | undefined;
    exitCode: number | null;
    timedOut: boolean;
    aborted: boolean;
    resultSubtypes: string[];
    stderrTail: string;
    argv: string[];
    loadedTools: string[];
    skillInventory?: AgentTrace["skillInventory"];
    pluginInventory?: AgentTrace["pluginInventory"];
  };
  /** Claude Code runner metadata; historical results remain readable. */
  claude?: Record<string, unknown>;
  startedAt: string;
}

interface TrialOptions {
  surface?: Surface;
  grading?: Grading;
  runner?: "codex" | "claude";
  maxBudgetUsd?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  effort?: string;
  onEvent?(event: StreamEvent): void;
}

type AgentTraceElicitations = NonNullable<ReturnType<typeof parseTrace>["urlElicitations"]>;

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

async function runTrial(task: ActiveTask, model: string, repeat: number, options: TrialOptions): Promise<TrialResult> {
  const surfaceArm = options.surface ?? "six";
  const grading = options.grading ?? "route";
  task = taskForSurface(task, surfaceArm);
  const startedAt = new Date().toISOString();
  const skip = task.runnerSkips?.[options.runner ?? "codex"];
  if (skip)
    return {
      task: task.id,
      surface: surfaceArm,
      grading,
      model,
      repeat,
      startedAt,
      status: "skipped",
      skip,
      checks: [],
      metrics: {
        wallMs: 0,
        apiMs: undefined,
        modelTurns: undefined,
        conversationTurns: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: undefined,
        metaTools: {},
        otherTools: {},
        toolErrors: 0,
        confirmationNudges: 0,
        downstream: downstreamMetrics([], []),
      },
      approvals: { allowed: [], denied: [], gated: [], exercised: [], permissionDenials: [] },
      transcript: [],
      ledger: [],
    };
  const world = new World(task.world);
  await world.start();
  for (const { service, fault } of task.faults ?? []) world.service(service).faults.push(fault);
  const deployment = await startNodeDeployment(
    world.connectorSpecs(),
    task.deployment,
    task.world?.oauth ? world.oauth : undefined,
    surfaceArm,
  );
  const hostEvents: StreamEvent[] = [];
  const host = task.host
    ? await startAuthHost(deployment, task.host.urlElicitation === "capable", (e) => hostEvents.push(e))
    : undefined;
  try {
    const surface = await surfaceOf(deployment.mcpUrl, deployment.token);
    assertSurface(
      surface.map((tool) => tool.name),
      surfaceArm,
    );
    const deny = task.approvals?.deny ?? [];
    const allow = (task.approvals?.allow ?? surface.map((tool) => tool.name)).filter((tool) => !deny.includes(tool));
    const gated = surface.filter((tool) => !tool.readOnly).map((tool) => tool.name);
    const prompts = [task.prompt];
    const notes: { beforeTurn: number; text: string }[] = [];
    let followUpsSent = 0;
    let nudges = 0;
    const runAgent = options.runner === "claude" ? runClaude : runCodex;
    const run = await runAgent({
      model,
      surface: surfaceArm,
      ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
      mcpUrl: host?.mcpUrl ?? deployment.mcpUrl,
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
          if (nudges < MAX_NUDGES && last?.kind === "assistant" && CONFIRMATION.test(last.text)) {
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
    world.programs = deployment.programs;
    const trace = parseTrace(run.events, run.turnStarts, prompts);
    trace.urlElicitations = parseTrace(hostEvents, [], []).urlElicitations ?? [];
    for (const note of notes) {
      const at = trace.transcript.findIndex((entry) => entry.kind === "user" && entry.turn === note.beforeTurn);
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
      metaTools: countBy(
        trace.toolUses.filter((use) => surfaceNames.has(use.tool)),
        (use) => use.tool,
      ),
      otherTools: countBy(
        trace.toolUses.filter((use) => !surfaceNames.has(use.tool)),
        (use) => use.tool,
      ),
      toolErrors: trace.toolUses.filter((use) => use.isError).length,
      confirmationNudges: nudges,
      downstream: downstreamMetrics(world.ledger.calls, world.ledger.requests),
    };
    const error = run.aborted
      ? "interrupted by operator"
      : run.timedOut
        ? `${options.runner ?? "codex"} trial timed out`
        : infraError(run.events, run.exitCode, trace.loadedTools);
    const completed = conversationCompletion(trace, run.turnStarts.length, run.timedOut, run.aborted).check;
    const unprompted: Check = {
      id: "no-confirmation-needed",
      description: "finished without stopping to ask permission it had been given",
      pass: nudges === 0,
      ...(nudges ? { detail: `${nudges} nudge(s)` } : {}),
      advisory: true,
    };
    const checks = error
      ? []
      : classifyChecks(task.id, [completed, ...gradeTask(task, { world, trace }, surfaceArm, grading), unprompted]);
    const passed = passes(checks, grading);
    return {
      task: task.id,
      surface: surfaceArm,
      grading,
      model,
      repeat,
      status: error ? "error" : passed ? "pass" : "fail",
      ...(error ? { error } : {}),
      checks,
      saved: saveGradeInputs(world, trace),
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
      finalAnswer: trace.finalAnswer ?? "",
      urlElicitations: trace.urlElicitations ?? [],
      ledger: world.ledger.calls.map((call) => ({ ...call, args: clipArgs(call.args) })),
      [options.runner === "claude" ? "claude" : "codex"]: {
        requestedModel: model,
        servedModel: run.model,
        version: trace.agentVersion ?? trace.claudeCodeVersion,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        aborted: run.aborted,
        resultSubtypes: trace.resultSubtypes,
        stderrTail: run.stderrTail,
        argv: run.argv,
        loadedTools: trace.loadedTools,
        ...(trace.skillInventory ? { skillInventory: trace.skillInventory } : {}),
        ...(trace.pluginInventory ? { pluginInventory: trace.pluginInventory } : {}),
      },
      startedAt,
    };
  } finally {
    await host?.close();
    await deployment.close();
    await world.stop();
  }
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
