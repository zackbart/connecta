// What a failing program's finished calls produced. Host memory only, for the
// length of the run: a run that succeeds discards it unread, and one that fails
// moves it to the result stash and reports addresses (R9). It never reaches
// activity, logs or status (INV-6).
//
// Only `seal` makes an id publishable, once the run's secret set is final. A
// call's own stash entry was written under the secrets known when it answered,
// so the report never reads it, only what sealing produced from it (INV-5).

import { Effect } from "effect";
import { utf8Length } from "./bytes.js";
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
  /** What `output` costs: its UTF-8 size, which is also what the stash receives. */
  bytes: number;
  /** The call's own stash entry when its output was too large to inline. Not publishable: see `seal`. */
  entry?: OwnEntry;
}

/** A stash entry written while the call answered, under the secrets known then. */
export interface OwnEntry {
  id: string;
  format: "json" | "text";
}

/** A call's own stash entry, in any of the program call shapes. */
function ownEntry(value: unknown): OwnEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const shape = value as {
    format?: unknown;
    valueFormat?: unknown;
    resultId?: unknown;
    handle?: unknown;
    value?: unknown;
    native?: unknown;
  };
  if (shape.format === "paged")
    return typeof shape.resultId === "string"
      ? { id: shape.resultId, format: shape.valueFormat === "text" ? "text" : "json" }
      : undefined;
  return ownEntry(shape.handle ?? shape.value ?? (shape.native as { value?: unknown } | undefined)?.value);
}

/** One step's failure costs only that step: what it would have named is reported dropped. */
const orUndefined = <E>(step: Effect.Effect<string | undefined, E>): Effect.Effect<string | undefined> =>
  step.pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.catchDefect(() => Effect.succeed(undefined)),
  );

/** The storage work sealing needs. Both run under the run's complete secret set. */
export interface SealOperations {
  /** Stash the retained outputs; the id, or undefined if storage could not keep them. */
  stash(outputs: unknown): Effect.Effect<string | undefined, unknown>;
  /** The id of an entry whose bytes pass the secret set, or undefined if that cannot finish. */
  reseal(entry: OwnEntry): Effect.Effect<string | undefined, unknown>;
}

interface CompletedRun {
  dependencies: ProgramResultDependency[];
  storageStalled: boolean;
  /** Pass every output the report can name through the final secret set. Interruptible between steps. */
  seal(operations: SealOperations): Effect.Effect<void>;
  /** Names only what `seal` finished; everything else is marked dropped. */
  report(): object;
}

export class CompletedCalls {
  private readonly calls: CompletedCall[] = [];
  private held = 0;
  private closed = false;
  private stalled = false;

  /** A result could not be presented in this run; the stash may not answer now either. */
  storageStalled(): void {
    this.stalled = true;
  }

  /**
   * A dispatch answered. Call this as soon as it does, before presentation can
   * fail. `bytes` is the size the invocation measured, or undefined when the
   * output cannot be serialized. It bounds the output's JSON from below, so one
   * already over the limit is never stringified; a held output is charged its
   * JSON, where a control character costs six bytes and a multibyte one its UTF-8.
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
    if (bytes !== undefined && bytes <= COMPLETED_OUTPUT_BYTES) {
      try {
        const output = JSON.stringify(value);
        const charge = output === undefined ? Infinity : utf8Length(output);
        if (charge <= COMPLETED_OUTPUT_BYTES && this.makeRoom(charge, call.write)) {
          call.output = output;
          call.bytes = charge;
          this.held += charge;
        }
      } catch {
        // An output that cannot serialize is reported as dropped.
      }
    }
    return call;
  }

  /** The call finished presenting: an output with its own stash entry needs no copy here. */
  presented(call: CompletedCall | undefined, value: unknown): void {
    const entry = ownEntry(value);
    if (!call || !entry || this.closed) return;
    call.entry = entry;
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
  close(): CompletedRun | undefined {
    this.closed = true;
    const calls = this.calls.splice(0);
    this.held = 0;
    if (calls.length === 0) return undefined;
    const listed = listedCalls(calls);
    const sealed = new Map<CompletedCall, string>();
    let resultId: string | undefined;
    return {
      dependencies: calls.map((call) => call.dependency),
      storageStalled: this.stalled,
      seal: (operations) =>
        Effect.gen(function* () {
          const kept = calls.filter((call) => call.output !== undefined);
          if (kept.length > 0)
            resultId = yield* operations
              .stash({
                calls: kept.map((call) => ({
                  address: call.address,
                  ...(call.write ? { write: true } : {}),
                  format: call.format,
                  data: JSON.parse(call.output!),
                })),
              })
              .pipe(orUndefined);
          // One at a time, and only what the envelope can name, so this reads no more than it publishes.
          for (const call of [...listed].sort((a, b) => Number(b.write) - Number(a.write))) {
            if (!call.entry) continue;
            const id = yield* operations.reseal(call.entry).pipe(orUndefined);
            if (id) sealed.set(call, id);
          }
        }),
      report: () => completedReport(calls, listed, sealed, resultId),
    };
  }
}

/** Every write first, then the newest reads, in call order. */
function listedCalls(calls: CompletedCall[]): Set<CompletedCall> {
  const reads = calls.filter((call) => !call.write);
  const writes = calls.length - reads.length;
  return new Set(
    writes >= MAX_LISTED_CALLS
      ? calls.filter((call) => call.write).slice(-MAX_LISTED_CALLS)
      : [...calls.filter((call) => call.write), ...reads.slice(writes - MAX_LISTED_CALLS)],
  );
}

/** The `error.completed` field: addresses, never outputs. */
function completedReport(
  calls: CompletedCall[],
  listed: Set<CompletedCall>,
  sealed: ReadonlyMap<CompletedCall, string>,
  resultId: string | undefined,
): object {
  const lost = (call: CompletedCall) => (call.entry ? !sealed.has(call) : call.output !== undefined && !resultId);
  const dropped = (call: CompletedCall) => !sealed.has(call) && (call.output === undefined || !resultId);
  const notes = ["These calls finished before the run failed and are not undone."];
  if (resultId) notes.push("Page their outputs with connecta.result(resultId); the text is JSON with a calls array.");
  if (sealed.size > 0) notes.push("A call's own resultId pages its output.");
  if (calls.some(lost))
    notes.push("Result storage could not keep every output, so only addresses survive for those marked dropped.");
  if (calls.some((call) => !call.entry && call.output === undefined))
    notes.push("An output marked dropped did not fit the 1 MiB one run retains.");
  notes.push("Never repeat a write to recover its output.");
  return {
    ...(resultId ? { resultId } : {}),
    calls: calls
      .filter((call) => listed.has(call))
      .map((call) => ({
        address: call.address,
        ...(call.write ? { write: true } : {}),
        ...(sealed.has(call) ? { resultId: sealed.get(call) } : {}),
        ...(dropped(call) ? { dropped: true } : {}),
      })),
    ...(listed.size < calls.length ? { callsOmitted: calls.length - listed.size } : {}),
    note: notes.join(" "),
  };
}
