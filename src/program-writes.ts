import { toolError } from "./tool-error.js";
// Budget and outcome accounting for writes dispatched by programs on writable endpoints.
// Await each dispatched write once; never conceal an unknown outcome.

import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { Effect } from "effect";
import type { CallErrorDetails } from "./errors.js";
import type { InvocationOutcome } from "./invocation.js";
import { type ToolResult } from "./meta-tools.js";
import { classifyWriteOutcome, type WriteState } from "./write-outcome.js";

/** Writes one program may send (`execute.maxWrites`), unless configured. */
export const DEFAULT_MAX_WRITES = CONFIG_DEFAULTS.execute.maxWrites;

type WriteDeadline = Pick<NonNullable<CallErrorDetails["details"]>, "operation" | "stage" | "elapsedMs" | "deadlineMs">;
/** An authorization verdict a write met after it left: the grant still needs recovery. */
type WriteHandoff = Pick<CallErrorDetails, "code" | "connector" | "recovery" | "nextAction" | "retry">;
type WriteCompletion =
  | WriteState
  | {
      state: "unknown";
      uncertainCall?: NonNullable<CallErrorDetails["uncertainCall"]>;
      deadline?: WriteDeadline;
      handoff?: WriteHandoff;
    };

/** What a dispatched write's outcome says about whether it landed. */
export function writeStateOf(outcome: InvocationOutcome<unknown>): WriteCompletion {
  const state = classifyWriteOutcome(
    outcome.ok
      ? { ok: true, dispatched: outcome.dispatched }
      : {
          ok: false,
          dispatched: outcome.dispatched,
          error: outcome.error,
          ...(outcome.answered !== undefined ? { answered: outcome.answered } : {}),
        },
  );
  if (state !== "unknown" || outcome.ok) return state;
  const { error } = outcome;
  const handoff: WriteHandoff | undefined =
    (error.code === "auth_required" || error.code === "downstream_oauth_required") &&
    error.nextAction &&
    "tool" in error.nextAction &&
    error.nextAction.tool === "authorize_connector"
      ? {
          code: error.code,
          ...(error.connector !== undefined ? { connector: error.connector } : {}),
          ...(error.recovery !== undefined ? { recovery: error.recovery } : {}),
          nextAction: error.nextAction,
          ...(error.retry !== undefined ? { retry: error.retry } : {}),
        }
      : undefined;
  if (!error.uncertainCall && !handoff) return state;
  return {
    state,
    ...(error.uncertainCall ? { uncertainCall: error.uncertainCall } : {}),
    ...(error.uncertainCall && error.details?.stage !== undefined
      ? {
          deadline: {
            ...(error.details.operation !== undefined ? { operation: error.details.operation } : {}),
            stage: error.details.stage,
            ...(error.details.elapsedMs !== undefined ? { elapsedMs: error.details.elapsedMs } : {}),
            ...(error.details.deadlineMs !== undefined ? { deadlineMs: error.details.deadlineMs } : {}),
          },
        }
      : {}),
    ...(handoff ? { handoff } : {}),
  };
}

type WriteCounts = { succeeded: number; failed: number; unknown: number };

/**
 * The writes one program sends. The play closes this when the
 * program settles — a write that reaches the gate after is not sent — and
 * drains what is on the wire before the run's scope aborts it, so the write
 * finishes and its activity says how it did. The result never hides a write
 * whose outcome is unknown, and a program that fails after writing reports
 * the counts.
 */
export class ProgramWrites {
  private closed = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly states: WriteState[] = [];
  private readonly uncertainCalls: NonNullable<CallErrorDetails["uncertainCall"]>[] = [];
  private uncertainCallsTruncated = false;
  private readonly deadlines: WriteDeadline[] = [];
  private handoff: WriteHandoff | undefined;

  /** Whether the program has settled: a write gated now is not sent. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Whether a dispatched write completed successfully in this run. */
  get hasSucceeded(): boolean {
    return this.states.includes("ok");
  }

  close(): void {
    this.closed = true;
  }

  /** A write is being dispatched; the function returned records how it ended. */
  begin(): (completion: WriteCompletion) => void {
    let done: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.inFlight.add(settled);
    let recorded = false;
    return (completion) => {
      if (recorded) return;
      recorded = true;
      const state = typeof completion === "string" ? completion : completion.state;
      if (typeof completion !== "string") {
        if (completion.uncertainCall) {
          if (this.uncertainCalls.length < 10) this.uncertainCalls.push(completion.uncertainCall);
          else this.uncertainCallsTruncated = true;
        }
        if (completion.deadline && this.deadlines.length < 10) this.deadlines.push(completion.deadline);
        this.handoff ??= completion.handoff;
      }
      this.states.push(state);
      this.inFlight.delete(settled);
      done();
    };
  }

  /** Wait for dispatched writes, each bounded by its host-call deadline. */
  drain(): Effect.Effect<void> {
    return Effect.promise(async () => {
      while (this.inFlight.size > 0) await Promise.all(this.inFlight);
    });
  }

  finish(result: ToolResult): ToolResult {
    if (this.states.length === 0) return result;
    const writes: WriteCounts = {
      succeeded: this.states.filter((state) => state === "ok").length,
      failed: this.states.filter((state) => state === "failed").length,
      unknown: this.states.filter((state) => state === "unknown").length,
    };
    if (writes.unknown > 0) {
      // Caught or not, an authorization verdict a write met after it left is
      // the result, as a direct call reports it: its code and handoff, never
      // retryable, with the write's outcome unknown.
      const handoff = this.handoff;
      return toolError({
        code: handoff?.code ?? "write_outcome_unknown",
        message: handoff
          ? "A write this program sent failed authorization after it left, so whether it took effect is unknown, and that is the result rather than what the program returned. It will not be sent again. Check its target before doing anything that depends on it, and give nextAction to the operator to recover the connector. Argument echoes may be partial or absent; use the original arguments if reconciliation requires another call."
          : "A write this program sent has no known outcome, so that is the result rather than what the program returned. It will not be sent again. Check its target before doing anything that depends on it. Argument echoes may be partial or absent; use the original arguments if reconciliation requires another call.",
        retryable: false,
        ...(handoff ? { ...handoff, reconciliationRequired: true, writeOutcome: "unknown" } : {}),
        ...(this.deadlines.length > 0 ? { details: this.deadlines[0] } : {}),
        ...(this.deadlines.length > 1 ? { timeouts: this.deadlines } : {}),
        ...(this.uncertainCalls.length === 1
          ? { uncertainCall: this.uncertainCalls[0] }
          : this.uncertainCalls.length > 1
            ? { uncertainCalls: this.uncertainCalls }
            : {}),
        ...(this.uncertainCallsTruncated ? { uncertainCallsTruncated: true } : {}),
        writes,
      });
    }
    return result.isError ? withWrites(result, writes) : result;
  }
}

/**
 * An error result from a program that sent writes, carrying their counts: a
 * program that fails after writing is not a program that is safe to repeat.
 */
function withWrites(result: ToolResult, writes: WriteCounts): ToolResult {
  const structured = result.structuredContent;
  const error = structured?.error;
  const annotated = toolError({
    ...(error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {
          code: "executor_failed",
          message: result.content[0]?.text ?? "",
          retryable: false,
        }),
    writes,
    note: "This run attempted writes, counted in writes; those that succeeded are not undone. Check them before running the task again.",
  });
  if (structured && error !== null && typeof error === "object") {
    const { error: _replaced, ...rest } = structured;
    annotated.structuredContent = { ...rest, error: annotated.structuredContent?.error };
    annotated.content = [{ type: "text", text: JSON.stringify(annotated.structuredContent) }];
  }
  return annotated;
}
