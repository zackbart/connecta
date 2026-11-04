// What a failing program's finished calls produced. Host memory only, for the
// length of the run: a run that succeeds discards it unread, and one that fails
// moves it to the result stash and reports addresses (R9). It never reaches
// activity, logs or status (INV-6).

import type { ResolvedCatalogTool } from "./catalog-service.js";
import type { ProgramResultDependency } from "./meta-tools.js";
import { isWriteLike } from "./tool-safety.js";

/** Serialized output one run may hold for recovery. */
const COMPLETED_OUTPUT_BYTES = 1024 * 1024;
/** Calls one envelope lists; an error envelope has no size guard of its own. */
const MAX_LISTED_CALLS = 32;

interface CompletedCall {
  address: string;
  write: boolean;
  dependency: ProgramResultDependency;
  format: "json" | "text";
  /** The output as JSON, until evicted or replaced by its own stash entry. */
  output?: string;
  bytes: number;
  /** The call's own result stash entry, when its output was too large to inline. */
  resultId?: string;
}

/** The result id of a call's own stash entry, in any of the program call shapes. */
function ownResultId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const shape = value as { format?: unknown; resultId?: unknown; handle?: unknown; value?: unknown; native?: unknown };
  if (shape.format === "paged") return typeof shape.resultId === "string" ? shape.resultId : undefined;
  return ownResultId(shape.handle ?? shape.value ?? (shape.native as { value?: unknown } | undefined)?.value);
}

export class CompletedCalls {
  private readonly calls: CompletedCall[] = [];
  private held = 0;
  private closed = false;

  /**
   * A dispatch answered. Call this as soon as it does, before presentation can
   * fail. `bytes` is the size the invocation measured, or undefined when the
   * output cannot be serialized, so an oversized output is never stringified.
   */
  record(
    resolved: ResolvedCatalogTool,
    value: unknown,
    format: "json" | "text",
    bytes: number | undefined,
  ): CompletedCall | undefined {
    if (this.closed) return undefined;
    const call: CompletedCall = {
      address: `${resolved.connector.id}.${resolved.toolName}`,
      write: isWriteLike(resolved.definition),
      dependency: {
        connector: resolved.connector.id,
        tool: resolved.definition.name,
        classification: resolved.definition.classification === "read" ? "read" : "write",
      },
      format,
      bytes: 0,
    };
    this.calls.push(call);
    if (bytes !== undefined && bytes <= COMPLETED_OUTPUT_BYTES && this.makeRoom(bytes, call.write)) {
      try {
        const output = JSON.stringify(value);
        if (output !== undefined) {
          call.output = output;
          call.bytes = bytes;
          this.held += bytes;
        }
      } catch {
        // An output that cannot serialize is reported as dropped.
      }
    }
    return call;
  }

  /** The call finished presenting: an output with its own stash entry needs no copy here. */
  presented(call: CompletedCall | undefined, value: unknown): void {
    const resultId = ownResultId(value);
    if (!call || !resultId || this.closed) return;
    call.resultId = resultId;
    this.evict(call);
  }

  /** Drop older reads, then for a write older writes. A read never displaces a write. */
  private makeRoom(bytes: number, write: boolean): boolean {
    while (this.held + bytes > COMPLETED_OUTPUT_BYTES) {
      const victim =
        this.calls.find((call) => call.output !== undefined && !call.write) ??
        (write ? this.calls.find((call) => call.output !== undefined) : undefined);
      if (!victim) return false;
      this.evict(victim);
    }
    return true;
  }

  private evict(call: CompletedCall): void {
    this.held -= call.bytes;
    call.bytes = 0;
    delete call.output;
  }

  /** The run is over: hold nothing more, and hand back what a failure may keep. */
  close():
    | { dependencies: ProgramResultDependency[]; stashed: unknown; report: (resultId?: string) => object }
    | undefined {
    this.closed = true;
    const calls = this.calls.splice(0);
    this.held = 0;
    if (calls.length === 0) return undefined;
    const kept = calls.filter((call) => call.output !== undefined);
    return {
      dependencies: calls.map((call) => call.dependency),
      stashed:
        kept.length === 0
          ? undefined
          : {
              calls: kept.map((call) => ({
                address: call.address,
                ...(call.write ? { write: true } : {}),
                format: call.format,
                data: JSON.parse(call.output!),
              })),
            },
      report: (resultId) => completedReport(calls, resultId),
    };
  }
}

/** The `error.completed` field: addresses, never outputs. */
function completedReport(calls: CompletedCall[], resultId: string | undefined): object {
  const stashFailed = resultId === undefined && calls.some((call) => call.output !== undefined);
  const dropped = (call: CompletedCall) => !call.resultId && (call.output === undefined || resultId === undefined);
  // Every write first, then the newest reads, in call order.
  const reads = calls.filter((call) => !call.write);
  const writes = calls.length - reads.length;
  const listed = new Set(
    writes >= MAX_LISTED_CALLS
      ? calls.filter((call) => call.write).slice(-MAX_LISTED_CALLS)
      : [...calls.filter((call) => call.write), ...reads.slice(writes - MAX_LISTED_CALLS)],
  );
  const notes = ["These calls finished before the run failed and are not undone."];
  if (resultId) notes.push("Page their outputs with connecta.result(resultId); the text is JSON with a calls array.");
  if (calls.some((call) => call.resultId)) notes.push("A call's own resultId pages its output.");
  if (stashFailed) notes.push("Result storage could not keep their outputs, so only addresses survive.");
  else if (calls.some((call) => !call.resultId && call.output === undefined))
    notes.push("An output marked dropped did not fit the 1 MiB one run retains.");
  notes.push("Never repeat a write to recover its output.");
  return {
    ...(resultId ? { resultId } : {}),
    calls: calls
      .filter((call) => listed.has(call))
      .map((call) => ({
        address: call.address,
        ...(call.write ? { write: true } : {}),
        ...(call.resultId ? { resultId: call.resultId } : {}),
        ...(dropped(call) ? { dropped: true } : {}),
      })),
    ...(listed.size < calls.length ? { callsOmitted: calls.length - listed.size } : {}),
    note: notes.join(" "),
  };
}
