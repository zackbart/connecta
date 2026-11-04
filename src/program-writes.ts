import { toolError } from "./tool-error.js";
// Budget and outcome accounting for writes dispatched by programs on writable endpoints.
// Await each dispatched write once; never conceal an unknown outcome.

import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { Effect } from "effect";
import { clipText, MAX_TOOL_ERROR_BYTES, type CallErrorDetails } from "./errors.js";
import type { InvocationOutcome } from "./invocation.js";
import { type ToolResult } from "./meta-tools.js";
import type { SentSecrets } from "./sent-secrets.js";
import { classifyWriteOutcome, type WriteState } from "./write-outcome.js";

/** Writes one program may send (`execute.maxWrites`), unless configured. */
export const DEFAULT_MAX_WRITES = CONFIG_DEFAULTS.execute.maxWrites;

type WriteDeadline = Pick<NonNullable<CallErrorDetails["details"]>, "operation" | "stage" | "elapsedMs" | "deadlineMs">;
/** An authorization verdict a write met after it left: the grant still needs recovery. */
type WriteHandoff = Pick<CallErrorDetails, "code" | "connector" | "recovery" | "nextAction" | "retry">;
/** Which write failed; its outcome stays unknown whatever its failure said. */
type UnknownWriteFacts = Pick<CallErrorDetails, "code" | "toolAnswered"> & { address?: string };
/**
 * What it said, longer than any report holds so the run's final credentials can match
 * whole before a cut. Request memory only; activity and logs never see it (INV-6, INV-7).
 */
type UnknownWrite = UnknownWriteFacts & { text: string; cut: boolean };
type WriteCompletion =
  | WriteState
  | {
      state: "unknown";
      failure: UnknownWrite;
      uncertainCall?: NonNullable<CallErrorDetails["uncertainCall"]>;
      deadline?: WriteDeadline;
      handoff?: WriteHandoff;
    };

/** Unknown writes one run retains and reports. */
const MAX_REPORTED_WRITES = 10;
/** UTF-16 code units per write, so its UTF-8 size can reach three times this. */
const RETAINED_UNITS = 4 * MAX_TOOL_ERROR_BYTES;
/** Serialized bytes of the whole report: two full messages, or more shorter ones. */
const MAX_REPORT_BYTES = 2 * MAX_TOOL_ERROR_BYTES;
/** Room kept for what joins the result after the report: counters and a quoted address. */
const RESULT_RESERVE = 256;

const CHECK_UNKNOWN_WRITE = "Read its target to see whether it applied before anything depends on it.";
const UNKNOWN_WRITE_ARGS = "Echoed arguments may be partial or absent; use your original arguments for further calls.";
const NO_PROGRAM_RERUN =
  "Do not rerun this program: writes it already sent would repeat. If a tool's words call for a further call, send only that operation, as a new call.";

const encoder = new TextEncoder();
const serializedBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** `text` clipped so its JSON string fits `room` bytes, or nothing when not even the marker does. */
function fitted(text: string, room: number): string | undefined {
  let budget = room;
  let clipped = clipText(text, budget);
  for (let size = serializedBytes(clipped); size > room; size = serializedBytes(clipped)) {
    if (budget <= 0) return undefined;
    budget = Math.floor((budget * room) / size) - 1;
    clipped = clipText(text, Math.max(0, budget));
  }
  return clipped;
}

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
  const text = outcome.failureText ?? error.message;
  const handoff: WriteHandoff | undefined =
    (error.code === "auth_required" || error.code === "downstream_oauth_required") &&
    error.nextAction &&
    error.connector !== undefined
      ? {
          code: error.code,
          connector: error.connector,
          ...(error.recovery !== undefined ? { recovery: error.recovery } : {}),
          // This terminal result carries no handoff fields, so it never holds a link:
          // the agent fetches one, whatever the call's own error was given.
          nextAction: {
            tool: "authorize_connector",
            arguments: { connector: error.connector },
            operatorHandoff: "Give the URL and instructions it returns to the operator.",
          },
          ...(error.retry !== undefined ? { retry: error.retry } : {}),
        }
      : undefined;
  return {
    state,
    failure: {
      ...(outcome.resolved ? { address: `${outcome.resolved.connector.id}.${outcome.resolved.toolName}` } : {}),
      code: error.code,
      ...(error.toolAnswered ? { toolAnswered: true as const } : {}),
      text: text.slice(0, RETAINED_UNITS),
      cut: text.length > RETAINED_UNITS,
    },
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
  private readonly unknownWrites: UnknownWrite[] = [];
  private unknownWritesTruncated = false;
  private readonly uncertainCalls: NonNullable<CallErrorDetails["uncertainCall"]>[] = [];
  private uncertainCallsTruncated = false;
  private readonly deadlines: WriteDeadline[] = [];
  private handoff: WriteHandoff | undefined;

  /** Whether the program has settled: a write gated now is not sent. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Whether a dispatched write may or may not have taken effect. */
  get hasUnknown(): boolean {
    return this.states.includes("unknown");
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
        if (this.unknownWrites.length < MAX_REPORTED_WRITES) this.unknownWrites.push(completion.failure);
        else this.unknownWritesTruncated = true;
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

  /** Whether this run dispatched any write, whatever became of it. */
  get sent(): boolean {
    return this.states.length > 0 || this.inFlight.size > 0;
  }

  /** Wait for dispatched writes, each bounded by its host-call deadline. */
  drain(): Effect.Effect<void> {
    return Effect.promise(async () => {
      while (this.inFlight.size > 0) await Promise.all(this.inFlight);
    });
  }

  /**
   * What each unknown write said, checked against the run's final credentials and only
   * then cut, so a credential a later call registered matches whole. A retained text
   * was itself cut, so it also loses any unfinished tail. `room` bounds the serialized report.
   */
  private report(
    secrets: SentSecrets,
    room: number,
  ): { entries: (UnknownWriteFacts & { message?: string })[]; truncated: boolean } {
    const entries: (UnknownWriteFacts & { message?: string })[] = [];
    let truncated = this.unknownWritesTruncated;
    let left = room;
    for (const { text, cut, ...facts } of this.unknownWrites) {
      left -= serializedBytes(facts) + 12;
      if (left < 0) return { entries, truncated: true };
      const message = fitted(
        cut ? secrets.redactOpenTail(text) : secrets.text(text),
        Math.min(left, MAX_TOOL_ERROR_BYTES),
      );
      if (message === undefined) truncated = true;
      else left -= serializedBytes(message);
      entries.push({ ...facts, ...(message === undefined ? {} : { message }) });
    }
    return { entries, truncated };
  }

  finish(result: ToolResult, secrets: SentSecrets, maxResultChars: number): ToolResult {
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
      const facts = {
        code: handoff?.code ?? "write_outcome_unknown",
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
      };
      const advice = handoff
        ? `A write this program sent failed authorization after it left, so its outcome is unknown and the program's return was discarded. It will not be resent. ${CHECK_UNKNOWN_WRITE} Then give what nextAction returns to the operator to recover the connector. ${NO_PROGRAM_RERUN} ${UNKNOWN_WRITE_ARGS}`
        : `A write this program sent has an unknown outcome, and the program's return was discarded. It will not be resent. ${CHECK_UNKNOWN_WRITE} ${NO_PROGRAM_RERUN} ${UNKNOWN_WRITE_ARGS}`;
      const { entries, truncated } = this.report(
        secrets,
        Math.min(
          MAX_REPORT_BYTES,
          maxResultChars - RESULT_RESERVE - serializedBytes({ error: { ...facts, message: advice } }),
        ),
      );
      // The first tool's own words lead, once: they may be the only way forward. An
      // authorization verdict keeps its lead, since recovery starts with the connector.
      const quoted = handoff ? undefined : entries.find((entry) => entry.toolAnswered && entry.message !== undefined);
      const words = quoted?.message;
      if (quoted) delete quoted.message;
      return toolError({
        message: quoted
          ? `${quoted.address ?? "A tool"} answered: ${words}\n\nGive the user any approval link or request id above. ${advice}`
          : advice,
        ...(entries.length > 0 ? { unknownWrites: entries } : {}),
        ...(truncated ? { unknownWritesTruncated: true } : {}),
        ...facts,
      });
    }
    return result.isError ? withWrites(result, writes) : result;
  }
}

/**
 * An error result from a program that sent writes, carrying their counts: a
 * program that fails after writing is not a program that is safe to repeat.
 * Whatever ended the run, once a write has landed the program is not retryable
 * and no wait window invites it (INV-9). A failed write is proven not applied,
 * so failed writes alone leave the failure's own verdict standing.
 */
function withWrites(result: ToolResult, writes: WriteCounts): ToolResult {
  const structured = result.structuredContent;
  const error = structured?.error;
  const { retryAfterMs, ...failure } =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {
          retryAfterMs: undefined,
          code: "executor_failed",
          message: result.content[0]?.text ?? "",
          retryable: false,
        };
  const landed = writes.succeeded > 0;
  const annotated = toolError({
    ...failure,
    ...(landed ? { retryable: false } : retryAfterMs !== undefined ? { retryAfterMs } : {}),
    writes,
    note: landed
      ? "This run completed writes, counted in writes, and they are not undone. Running this program again would repeat them: check them, then send only what is left."
      : "This run attempted writes, counted in writes, and none applied. Check them before running the task again.",
  });
  if (structured && error !== null && typeof error === "object") {
    const { error: _replaced, ...rest } = structured;
    annotated.structuredContent = { ...rest, error: annotated.structuredContent?.error };
    annotated.content = [{ type: "text", text: JSON.stringify(annotated.structuredContent) }];
  }
  return annotated;
}
