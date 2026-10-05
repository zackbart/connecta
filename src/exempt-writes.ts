// The writes a program may send: config-exempt ones (#566), and nothing else.
//
// Every other write a program attempts is refused
// `destructive_tool_requires_approval` before it is validated or sent (E4),
// so the host's prompt on `call_destructive_tool` stays the only approval.
// An exempt write is still a write, though, and it gets what a write needs:
// its own budget, a dispatch the run waits for rather than aborts, and a
// result that never hides a write whose outcome is unknown.
//
// Web-API only, like everything reachable from the root entry.

import { Effect } from "effect";
import type { CallErrorDetails } from "./errors.js";
import type { InvocationOutcome } from "./invocation.js";
import { jsonResult, type ToolResult } from "./meta-tools.js";

/** Writes one program may send (`execute.maxWrites`), unless configured. */
export const DEFAULT_MAX_WRITES = 10;

/** How a dispatched write ended, as far as anyone can know. */
type WriteState = "ok" | "failed" | "unknown";

/**
 * Whether a write landed, as far as anyone can know.
 *
 * `unknown` is the outcome a result must never paper over: the call left
 * connecta and no answer came back, so sending it again could do it twice and
 * not sending it could leave it undone. That is a dispatched call that timed
 * out, was cancelled, found the service unavailable, or failed any way that
 * is not a verdict. A refusal code (`REFUSALS`) or a downstream tool's own
 * `isError` is an answer, so it is `failed`, except that an `isError` whose text
 * classifies as a timeout is a gateway reporting that it gave up, and stays
 * unknown. A call that was never dispatched is `failed`: nothing was sent.
 * `result_processing_failed` means the downstream call completed.
 */
export function classifyWriteOutcome(outcome: {
  ok: boolean;
  dispatched: boolean;
  answered?: boolean;
  error?: Pick<CallErrorDetails, "code">;
}): WriteState {
  if (outcome.ok) return "ok";
  if (!outcome.dispatched) return "failed";
  const code = outcome.error?.code;
  if (code === "result_processing_failed") return "ok";
  if (code === "timeout" || code === "cancelled" || code === "unavailable") {
    return "unknown";
  }
  if (code !== undefined && REFUSALS.has(code)) return "failed";
  return outcome.answered === true ? "failed" : "unknown";
}

/**
 * Codes that say the other side refused the call rather than acted on it:
 * the credential, the arguments, the resource, the rate, or a base version
 * someone else already moved past (`conflict`). Anything else a
 * connector reports after dispatch — `connector_call_failed` from a response
 * too large to read, a redirect it would not follow, a body it could not
 * parse, a 5xx — may come after the write landed, so only a downstream
 * tool's own `isError` answer makes it a known failure.
 */
const REFUSALS = new Set([
  "auth_required",
  "invalid_args",
  "not_found",
  "rate_limited",
  "input_required_unsupported",
  "conflict",
]);

/** What a dispatched write's outcome says about whether it landed. */
export function writeStateOf(outcome: InvocationOutcome<unknown>): WriteState {
  return classifyWriteOutcome(
    outcome.ok
      ? { ok: true, dispatched: outcome.dispatched }
      : {
          ok: false,
          dispatched: outcome.dispatched,
          error: outcome.error,
          ...(outcome.answered !== undefined ? { answered: outcome.answered } : {}),
        },
  );
}

type WriteCounts = { succeeded: number; failed: number; unknown: number };

/**
 * The exempt writes one program sends. The play closes this when the
 * program settles — a write that reaches the gate after is not sent — and
 * drains what is on the wire before the run's scope aborts it, so the write
 * finishes and its activity says how it did. The result never hides a write
 * whose outcome is unknown, and a program that fails after writing reports
 * the counts.
 */
export class ExemptWrites {
  private closed = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly states: WriteState[] = [];

  /** Whether the program has settled: a write gated now is not sent. */
  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  /** A write is being dispatched; the function returned records how it ended. */
  begin(): (state: WriteState) => void {
    let done: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.inFlight.add(settled);
    let recorded = false;
    return (state) => {
      if (recorded) return;
      recorded = true;
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
      return errorEnvelope({
        code: "write_outcome_unknown",
        message: "A write this program sent has no known outcome, so that is the result rather than what the program returned. It will not be sent again. Check its target before doing anything that depends on it.",
        retryable: false,
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
  const annotated = errorEnvelope({
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

function errorEnvelope(error: Record<string, unknown>): ToolResult {
  const result = jsonResult({ error });
  result.isError = true;
  return result;
}
