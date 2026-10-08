/** Regrade saved facts only. Never execute a saved program or contact a model. */
import type { ActiveTask, Check } from "../tasks/types.js";
import { World } from "../fakes/world.js";
import type { AgentTrace, ToolUse } from "./trace.js";
import type { TrialResult } from "./run.js";
import { restoreGradeInputs } from "./saved.js";

// Explicit allowlists for legacy files lacking world snapshots and guest-call
// observations. Unknown/new checks require a rerun rather than invented state.
const LEGACY_CHECKS: Record<string, string[]> = {
  "cross-connector-join": [
    "one-post",
    "no-stray-posts",
    "names-issue",
    "names-customer",
    "states-mrr",
    "no-unrequested-writes",
    "correct-destination",
  ],
  "stale-close-and-summarize": [
    "each-write-once",
    "no-other-tracker-writes",
    "one-post",
    "no-stray-posts",
    "summary-lists-closed",
    "summary-after-writes",
    "correct-destination",
  ],
  "auth-required-recovery": [
    "handed-off",
    "handed-off-once",
    "retried-read",
    "one-post",
    "no-stray-posts",
    "correct-total",
    "no-unrequested-writes",
    "correct-destination",
  ],
  "truncated-read-paging": [
    "one-post",
    "no-stray-posts",
    "found-real-failure",
    "not-the-flake",
    "log-read-once",
    "paged",
    "no-unrequested-writes",
    "correct-destination",
  ],
  "truncated-write-export": [
    "export-once",
    "one-post",
    "no-stray-posts",
    "found-deleter",
    "not-the-requester",
    "paged",
    "no-unrequested-writes",
    "correct-destination",
  ],
  "p5-trusted-program-write": ["program-write", "write-once", "correct-destination"],
  "p5-read-only-program-refusal": [],
  "p5-result-paging": ["one-fetch", "correct-destination"],
  "p5-direct-rich-output": ["image-delivered", "correct-destination"],
  "p5-program-image": ["image-delivered", "correct-destination"],
  "p5-auth-url-capable": ["host-mode", "zero-writes", "correct-destination"],
  "p5-auth-connect-incapable": ["host-mode", "agent-handoff", "zero-writes", "correct-destination"],
  "p5-fanout-over-budget": ["terminal-budget", "reads-only", "correct-destination"],
  "p5-mixpanel-bootstrap": ["bootstrap-order", "correct-destination"],
  "p5-revenuecat-text": ["resolved-project", "authoritative-access", "correct-destination"],
  "p5-supabase-project-ref": ["no-wrong-project", "correct-destination"],
  "p5-absent-github": ["no-lookalike-call", "states-absence", "structured-answer"],
  "p5-known-read-routing": ["direct-read", "one-read", "correct-destination"],
  "p5-connecta-read": ["reads-only", "correct-destination"],
};

function legacyTrace(trial: TrialResult): { trace: AgentTrace; complete: boolean } {
  const toolUses: ToolUse[] = [];
  let complete = true;
  for (const entry of trial.transcript) {
    if (entry.kind !== "tool_use") continue;
    const result = trial.transcript.find((e) => e.kind === "tool_result" && e.id === entry.id);
    if (
      typeof entry.input !== "object" ||
      entry.input === null ||
      result?.kind !== "tool_result" ||
      result.text.length !== result.chars
    )
      complete = false;
    const text = result?.kind === "tool_result" ? result.text : undefined;
    // Only standalone serialized MCP image blocks count. A PNG inside a
    // returned JSON object is data, not delivered rich output.
    const images = (text ?? "").split("\n").flatMap((line) => {
      try {
        const block = JSON.parse(line);
        return block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
          ? [block]
          : [];
      } catch {
        return [];
      }
    });
    toolUses.push({
      id: entry.id,
      turn: entry.turn,
      tool: entry.tool,
      input: typeof entry.input === "object" && entry.input !== null ? (entry.input as Record<string, unknown>) : {},
      isError: result?.kind === "tool_result" ? result.isError : undefined,
      resultText: text,
      resultBlocks: [...images, { type: "text", text: text ?? "" }],
    });
  }
  return {
    complete,
    trace: {
      finalAnswer: trial.finalAnswer ?? "",
      transcript: trial.transcript,
      toolUses,
      urlElicitations: trial.urlElicitations ?? [],
      tokens: trial.metrics.tokens,
      costUsd: trial.metrics.costUsd,
      apiMs: trial.metrics.apiMs,
      modelTurns: trial.metrics.modelTurns,
      permissionDenials: trial.approvals.permissionDenials,
      resultSubtypes: trial.transcript.flatMap((e) => (e.kind === "turn_end" ? [e.subtype] : [])),
      model: trial.model,
      claudeCodeVersion: undefined,
      loadedTools: [],
      rateLimit: undefined,
    },
  };
}

export function regradeTrial(task: ActiveTask, trial: TrialResult, runner: "claude" | "codex"): TrialResult {
  const skip = task.runnerSkips?.[runner];
  if (skip) return { ...trial, status: "skipped", skip, checks: [], regrade: { applied: [], unavailable: [] } };
  if (trial.status === "error")
    return {
      ...trial,
      regrade: {
        applied: [],
        unavailable: ["trial"],
        reason: "The CLI did not complete a model trial. Requires a live rerun.",
      },
    };
  if (trial.status === "skipped") return trial;
  let checks: Check[];
  let unavailable: string[] = [];
  let reason: string | undefined;
  if (trial.saved) {
    checks = task.grade(restoreGradeInputs(trial.saved));
  } else {
    const world = new World(task.world);
    let ledgerComplete = true;
    for (const call of trial.ledger) {
      try {
        world.ledger.calls.push({ ...call, args: JSON.parse(call.args) });
      } catch {
        ledgerComplete = false;
      }
    }
    // The fake post service has a deterministic contract: an ok ledger call
    // records the exact posted channel and text. No request is replayed.
    for (const call of world.ledger.calls) {
      if (call.service !== "chat" || call.tool !== "post_message" || call.outcome !== "ok") continue;
      const key = String(call.args.channel).replace(/^#/, "").toLowerCase();
      const channel = world.chat.channels.find((c) => c.name === key || c.id.toLowerCase() === key);
      if (channel && typeof call.args.text === "string")
        world.chat.messages.push({
          channel: channel.name,
          text: call.args.text,
          author: "agent",
          byAgent: true,
          ts: new Date(call.at).toISOString(),
        });
    }
    const { trace, complete } = legacyTrace(trial);
    const inputsComplete = trial.transcript
      .filter((e) => e.kind === "tool_use")
      .every((e) => e.kind === "tool_use" && typeof e.input === "object" && e.input !== null);
    const traceChecks = new Set([
      "handed-off",
      "handed-off-once",
      "paged",
      "no-rewrite",
      "program-write",
      "direct-read",
      "one-read",
    ]);
    const resultChecks = new Set(["image-delivered", "host-mode", "agent-handoff", "terminal-budget"]);
    const available = new Set([
      "answer-evidence",
      ...(ledgerComplete
        ? (LEGACY_CHECKS[task.id] ?? []).filter(
            (id) => (!traceChecks.has(id) || inputsComplete) && (!resultChecks.has(id) || complete),
          )
        : []),
    ]);
    const current = task.grade({ world, trace });
    checks = current.map((check) => {
      if (available.has(check.id)) return check;
      unavailable.push(check.id);
      const old = trial.checks.find((c) => c.id === check.id);
      return { ...(old ?? { ...check, pass: false }), retained: true };
    });
    if (task.id === "p5-absent-github" && complete && current.some((c) => c.id === "correct-destination" && c.pass)) {
      checks = checks.map((c) => (c.id === "correct-destination" ? current.find((x) => x.id === c.id)! : c));
      unavailable = unavailable.filter((id) => id !== "correct-destination");
    }
    reason =
      "Legacy file lacks world snapshots and guest-call observations; retained checks are original grades, not current regrades." +
      (!ledgerComplete || !complete
        ? " Clipped ledger arguments or transcript inputs/results also prevent safe regrading."
        : "");
  }
  const outer = trial.checks.filter((c) => ["conversation-completed", "no-confirmation-needed"].includes(c.id));
  checks = [...outer, ...checks];
  return {
    ...trial,
    checks,
    status: checks.every((c) => c.advisory || c.pass) ? "pass" : "fail",
    regrade: {
      applied: checks.filter((c) => !c.retained && !outer.includes(c)).map((c) => c.id),
      unavailable,
      ...(unavailable.length && reason ? { reason } : {}),
    },
  };
}
