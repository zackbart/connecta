// Resumable writes: a program pauses host-side at its first unapproved write
// and resumes by replay through `resume_execution` (#565).
//
// Three pieces live here. `RunState` is one play of one run — the host side of
// the sandbox's host calls, numbering them, answering replayed ones from the
// journal, gating writes, and stopping the run when one needs a human.
// `ReplayState` is the journal a resumed play answers from. And the
// `resume_execution` handler claims a paused run and plays it again.
//
// The guarantees, and where each is kept:
//
// - A write needing approval is never sent by `execute_code`. The gate sits in
//   the shared invocation path after validation and before admission, and
//   answers `pause` for it (`gate`).
// - An approved write is sent at most once, across restarts and racing
//   resumes. Only the holder of the run's claim sends, and it marks each live
//   write `sending` in the header by compare-and-set before dispatch
//   (`writeAhead`). A second resume loses the claim; a takeover after a crash
//   finds the `sending` mark and reports the outcome unknown rather than
//   replaying past it.
// - A write whose outcome is unknown is never sent again: the run fails there
//   and a failed run is never replayed (`settleWrite`).
// - Replay reaches nothing downstream. Recorded calls are answered from the
//   journal before the invocation path, so they load no catalog, take no
//   permit, call no connector, and record no activity (`lookup`).
// - Replay never mixes reads across runs: a journal expires at a fixed time
//   from its first pause, and a program that stops matching its journal fails
//   typed (`execution_diverged`).

import type { McpServer } from "@modelcontextprotocol/server";
import { Deferred, Effect } from "effect";
import { z } from "zod";
import type { ActivityRequestContext } from "./activity.js";
import { advertisedSchema } from "./advertised-schema.js";
import type { ResolvedCatalogTool } from "./catalog-service.js";
import { echoedCallArgs, framingError } from "./errors.js";
import type { PinnedEnvironment, ProgramRunner } from "./execute.js";
import {
  InvocationFailure,
  type InvocationOutcome,
  type WriteGateDecision,
} from "./invocation.js";
import { jsonResult, type ToolResult } from "./meta-tools.js";
import { splitAddress, type RegistryView } from "./registry.js";
import { runEdge } from "./runtime/run.js";
import { underAnySignal } from "./timeout.js";
import type { KVStorage } from "./types.js";
import {
  canonicalJson,
  classifyWriteOutcome,
  formatToken,
  MAX_FINAL_CHARS,
  MAX_JOURNAL_BYTES,
  MAX_PENDING_ARGS_BYTES,
  parseToken,
  randomId,
  RunJournal,
  sha256Hex,
  utf8Bytes,
  type Approval,
  type JournalEntry,
  type JournalOp,
  type PendingCall,
  type RunHeader,
  type WriteState,
} from "./run-journal.js";

/** Deployment settings a resumable run carries. */
export interface ResumableSettings {
  /** Consequential calls one run may dispatch (`execute.maxWrites`). */
  maxWrites: number;
  /** How long a paused run lives after its first pause, in seconds. */
  ttlSeconds: number;
  /** The `/mcp/<pool>` this request came in on; `null` for `/mcp`. */
  pool: string | null;
}

export const DEFAULT_MAX_WRITES = 10;
export const DEFAULT_PAUSED_RUN_TTL_SECONDS = 1_800;

/** A typed stop, as the model receives it: the `error` of an error result. */
interface RunFailure {
  code:
    | "execution_diverged"
    | "write_outcome_unknown"
    | "execution_claim_lost"
    | "journal_too_large"
    | "pending_write_too_large"
    | "unavailable";
  message: string;
  retryable: boolean;
  [field: string]: unknown;
}

/** Why a play stopped before its program settled. */
export type RunStop =
  | { kind: "paused"; pending: PendingCall }
  | { kind: "failed"; failure: RunFailure };

/** What a replayed host call finds. */
type Lookup =
  | { kind: "hit"; entry: JournalEntry }
  | { kind: "live" }
  | { kind: "diverged"; reason: string };

/**
 * The journal a resumed play answers from.
 *
 * Calls sharing a key answer in the order they were first issued, so two
 * identical reads around a write replay as the two different answers they
 * got. Until the approved pending call is re-issued, every call must find a
 * record: the pause was decided only after every earlier-numbered call had
 * been decided and journaled, so a call with no record before that point is a
 * program that took another path.
 */
class ReplayState {
  private readonly queues = new Map<string, JournalEntry[]>();
  private readonly writes = new Set<JournalEntry>();
  private pendingReissued = false;

  constructor(
    entries: readonly JournalEntry[],
    private readonly pendingKey: string | undefined,
  ) {
    for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
      const queue = this.queues.get(entry.key) ?? [];
      queue.push(entry);
      this.queues.set(entry.key, queue);
      if (entry.write) this.writes.add(entry);
    }
    // A run with no pending call (none survives a completed pause) has
    // nothing to wait for.
    if (pendingKey === undefined) this.pendingReissued = true;
  }

  lookup(key: string): Lookup {
    const entry = this.queues.get(key)?.shift();
    if (entry) {
      this.writes.delete(entry);
      if (key === this.pendingKey) this.pendingReissued = true;
      return { kind: "hit", entry };
    }
    if (!this.pendingReissued && key === this.pendingKey) {
      this.pendingReissued = true;
      return { kind: "live" };
    }
    if (!this.pendingReissued) {
      return {
        kind: "diverged",
        reason: "it made a call its journal has no record of before repeating the approved write",
      };
    }
    return { kind: "live" };
  }

  /** Divergence (b) and (c), checked when the program settles. */
  unfinished(): string | undefined {
    if (!this.pendingReissued) {
      return "it finished without repeating the approved write";
    }
    if (this.writes.size > 0) {
      return "it finished without repeating a write it had already sent";
    }
    return undefined;
  }
}

/** The claim a resumed play holds on its journal's header. */
interface Claim {
  id: string;
  raw: string;
  header: RunHeader;
}

function failure(
  code: RunFailure["code"],
  message: string,
  extra: Record<string, unknown> = {},
): RunFailure {
  return { code, message, retryable: code === "unavailable", ...extra };
}

function guestFailure(code: string, message: string): InvocationFailure {
  return new InvocationFailure({ code, message, retryable: false });
}

const RERUN = {
  tool: "execute_code",
  purpose: "Run the task again from the start; nothing from this run will be replayed.",
} as const;

/**
 * A replay that stopped matching its journal. It stops where it noticed; what
 * it had already sent is counted in `writes`, and nothing is replayed again.
 */
function diverged(reason: string): RunFailure {
  return failure(
    "execution_diverged",
    `The resumed program diverged from its journal: ${reason}. The run stopped there and will not be replayed; any writes it sent are counted in writes.`,
    { nextAction: RERUN },
  );
}

function storageFailure(): RunFailure {
  return failure(
    "unavailable",
    "Paused-run storage failed, so nothing further was sent. Retry shortly.",
  );
}

/**
 * One play of one run: the host-side state behind a program's host calls.
 *
 * A fresh play (`execute_code`) starts with an empty journal and no header;
 * it writes both only if it pauses. A replay (`resume_execution`) starts from
 * a claimed header and its entries, answers recorded calls from them, and
 * sends live only what comes after.
 */
export class RunState {
  /** Completed when the play stops early: a pause, or a typed failure. */
  readonly stopped = Deferred.makeUnsafe<RunStop>();
  private stop: RunStop | undefined;
  private seq = 0;
  private readonly decisions: Array<Deferred.Deferred<void>> = [];
  private writesSpent = 0;
  /** Live calls this play completed that the journal does not hold yet. */
  private readonly unpersisted: JournalEntry[] = [];
  /** Live writes this play dispatched: seq → reserved entry slot. */
  private readonly liveWrites = new Map<number, number | undefined>();
  /** Writes a fresh play sent, for the header of a later pause. */
  private readonly freshWrites: RunHeader["writes"] = [];
  /** Calls a gate refused because the play had stopped. Not journaled. */
  private readonly unrecorded = new Set<number>();
  private readonly inFlight = new Map<number, Promise<unknown>>();
  private headerTurn: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly journal: RunJournal,
    readonly program: string,
    readonly environment: PinnedEnvironment,
    readonly source: "execute_code" | "resume_execution",
    private readonly settings: ResumableSettings,
    private claim: Claim | undefined,
    private readonly replay: ReplayState | undefined,
  ) {}

  /** A fresh run. Its journal exists only once it pauses. */
  static fresh(
    storage: KVStorage,
    program: string,
    environment: PinnedEnvironment,
    settings: ResumableSettings,
  ): RunState {
    return new RunState(
      new RunJournal(storage, randomId()),
      program,
      environment,
      "execute_code",
      settings,
      undefined,
      undefined,
    );
  }

  /** A claimed replay of a paused run. */
  static replaying(options: {
    journal: RunJournal;
    program: string;
    claim: Claim;
    entries: readonly JournalEntry[];
    settings: ResumableSettings;
  }): RunState {
    const { header } = options.claim;
    return new RunState(
      options.journal,
      options.program,
      { clockMs: header.clock, seed: header.seed },
      "resume_execution",
      options.settings,
      options.claim,
      new ReplayState(options.entries, header.pending?.key),
    );
  }

  // --- numbering and the gate sequencer ---------------------------------

  /**
   * Number a host call. Called synchronously when the program makes it, so
   * the numbering is the program's own issue order.
   */
  begin(): number {
    const seq = this.seq++;
    this.decisions[seq] = Deferred.makeUnsafe<void>();
    return seq;
  }

  /**
   * Record that call `seq` has made its gate decision: dispatched, refused,
   * answered from the journal, or ended. Idempotent.
   */
  decide(seq: number): void {
    const decision = this.decisions[seq];
    if (decision && !Deferred.isDoneUnsafe(decision)) {
      Deferred.doneUnsafe(decision, Effect.void);
    }
  }

  /**
   * Every lower-numbered call's decision. A write decides only after these,
   * so of two writes issued together the first always pauses first, however
   * their catalogs happen to resolve — which is what makes the pause point
   * reproducible on replay.
   */
  private decidedBefore(seq: number): Effect.Effect<void> {
    const waits = this.decisions.slice(0, seq).filter(
      (decision) => !Deferred.isDoneUnsafe(decision),
    );
    return waits.length === 0
      ? Effect.void
      : Effect.forEach(waits, (decision) => Deferred.await(decision), {
          discard: true,
        });
  }

  /** Track a call until it settles, so a stop can wait for what is on the wire. */
  track(seq: number, settled: Promise<unknown>): void {
    this.inFlight.set(seq, settled);
    void settled.then(
      () => this.inFlight.delete(seq),
      () => this.inFlight.delete(seq),
    );
  }

  /**
   * Wait for in-flight calls: every one after a stop, since each will be
   * journaled; only writes otherwise, since abandoning a read costs nothing
   * but abandoning a write turns its outcome unknown. Each is bounded by its
   * own host-call deadline.
   */
  drain(scope: "all" | "writes"): Effect.Effect<void> {
    return Effect.promise(async () => {
      for (;;) {
        const waiting = [...this.inFlight.entries()]
          .filter(([seq]) => scope === "all" || this.liveWrites.has(seq))
          .map(([, settled]) => settled);
        if (waiting.length === 0) return;
        await Promise.allSettled(waiting);
      }
    });
  }

  // --- stopping ----------------------------------------------------------

  /** The failure a call made after the play stopped receives, if it has. */
  halted(): InvocationFailure | undefined {
    const stop = this.stop;
    if (!stop) return undefined;
    return stop.kind === "paused"
      ? guestFailure(
          "execution_paused",
          `The run paused at ${stop.pending.address} to wait for approval, so no further call is made. This program's result will be discarded.`,
        )
      : guestFailure(stop.failure.code, stop.failure.message);
  }

  private stopWith(stop: RunStop): void {
    if (this.stop) return;
    this.stop = stop;
    Deferred.doneUnsafe(this.stopped, Effect.succeed(stop));
  }

  /** Divergence (a): stop, and hand the calling program the typed failure. */
  diverge(reason: string): InvocationFailure {
    this.stopWith({
      kind: "failed",
      failure: diverged(reason),
    });
    return this.halted() ?? guestFailure("execution_diverged", reason);
  }

  // --- replay ------------------------------------------------------------

  /** Answer a call from the journal, or say it goes live. */
  lookup(key: string): Lookup {
    if (!this.replay) return { kind: "live" };
    const found = this.replay.lookup(key);
    // Replayed writes spend the write budget again, as replayed calls spend
    // the host-call budget: per-play totals equal per-run totals.
    if (found.kind === "hit" && found.entry.write) this.writesSpent++;
    return found;
  }

  /** Journal a completed live call that was not a write. */
  record(
    seq: number,
    op: JournalOp,
    key: string,
    outcome: JournalEntry["outcome"],
  ): void {
    if (this.unrecorded.has(seq) || this.liveWrites.has(seq)) return;
    this.unpersisted.push({ seq, op, key, outcome });
  }

  // --- the write gate ----------------------------------------------------

  /** Whether an approval on file covers this write, and which one. */
  private approvalFor(
    address: string,
    args: unknown,
  ): { approval: Approval; index: number } | undefined {
    const approvals = this.claim?.header.approvals ?? [];
    const toolIndex = approvals.findIndex(
      (approval) => approval.address === address && approval.scope === "tool",
    );
    if (toolIndex >= 0) {
      return { approval: approvals[toolIndex] as Approval, index: toolIndex };
    }
    const canonical = canonicalJson(args);
    const callIndex = approvals.findIndex(
      (approval) =>
        approval.address === address &&
        approval.scope === "call" &&
        !approval.consumed &&
        approval.argsCanonical === canonical,
    );
    return callIndex >= 0
      ? { approval: approvals[callIndex] as Approval, index: callIndex }
      : undefined;
  }

  /**
   * Decide one consequential call. Runs inside the invocation path, after
   * the call resolved and validated and before admission.
   */
  gate(
    seq: number,
    key: string,
    target: ResolvedCatalogTool,
    args: unknown,
  ): Effect.Effect<WriteGateDecision> {
    const decided = Effect.sync(() => this.decide(seq));
    return Effect.gen({ self: this }, function* () {
      yield* this.decidedBefore(seq);
      {
        const halted = this.halted();
        if (halted) {
          this.unrecorded.add(seq);
          return { kind: "refuse", error: halted.details, activity: "none" } as const;
        }
        const address = `${target.connector.id}.${target.toolName}`;
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          // Neither approval route takes arguments that are not an object, so
          // there is nothing a pause could ask a human to repeat.
          return {
            kind: "refuse",
            error: framingError(
              "destructive_tool_requires_approval",
              `Tool "${address}" is not explicitly read-only, and its arguments are not an object, so it cannot pause for approval.`,
            ),
          } as const;
        }
        if (this.writesSpent >= this.settings.maxWrites) {
          return {
            kind: "refuse",
            error: {
              code: "budget_exceeded",
              message: `execute_code write budget exceeded (${this.settings.maxWrites} writes maximum, execute.maxWrites); ${address} was not sent`,
              retryable: false,
            },
          } as const;
        }
        const approved = this.approvalFor(address, args);
        if (approved) {
          const reserved = yield* this.writeAhead(address, approved.index);
          if (reserved.kind === "lost") {
            this.stopWith({ kind: "failed", failure: reserved.failure });
            this.unrecorded.add(seq);
            return {
              kind: "refuse",
              error: { code: reserved.failure.code, message: reserved.failure.message, retryable: false },
              activity: "none",
            } as const;
          }
          this.writesSpent++;
          this.liveWrites.set(seq, reserved.slot);
          return { kind: "dispatch" } as const;
        }
        // Not approved: this is where the run pauses. A write too large to
        // hold for a human stops the run instead, before anything is kept.
        let argsText: string;
        try {
          argsText = canonicalJson(args);
        } catch {
          argsText = "";
        }
        if (!argsText || utf8Bytes(argsText) > MAX_PENDING_ARGS_BYTES) {
          const tooLarge = failure(
            "pending_write_too_large",
            `The write to ${address} has arguments over ${MAX_PENDING_ARGS_BYTES} bytes, too large to hold for approval. Nothing was sent. Call it through call_destructive_tool instead.`,
            {
              nextAction: {
                tool: "call_destructive_tool",
                arguments: { address },
                purpose: "Ask the MCP host to approve this one call directly.",
              },
            },
          );
          this.stopWith({ kind: "failed", failure: tooLarge });
          this.unrecorded.add(seq);
          return {
            kind: "refuse",
            error: { code: tooLarge.code, message: tooLarge.message, retryable: false },
          } as const;
        }
        this.stopWith({ kind: "paused", pending: { address, args, key } });
        this.unrecorded.add(seq);
        return {
          kind: "refuse",
          error: (this.halted() as InvocationFailure).details,
          activity: "paused",
        } as const;
      }
    }).pipe(Effect.ensuring(decided));
  }

  /**
   * Before a claimed play sends a write: reserve its journal slot, mark it
   * `sending`, and spend a call-scoped approval, in one compare-and-set on
   * the header. If the claim moved, nothing is sent. A fresh play holds no
   * header, so there is nothing to mark — and no journal that could replay
   * past the write.
   */
  private writeAhead(
    address: string,
    approvalIndex: number,
  ): Effect.Effect<
    { kind: "reserved"; slot: number | undefined } | { kind: "lost"; failure: RunFailure }
  > {
    if (!this.claim) return Effect.succeed({ kind: "reserved", slot: undefined });
    let slot = -1;
    return this.mutateHeader((header) => {
      slot = header.entries;
      const approvals = header.approvals.map((approval, index) =>
        index === approvalIndex && approval.scope === "call"
          ? { ...approval, consumed: true as const }
          : approval,
      );
      return {
        ...header,
        approvals,
        entries: header.entries + 1,
        writes: [...header.writes, { entry: slot, address, state: "sending" }],
      };
    }).pipe(
      Effect.map((result) =>
        result === "ok"
          ? { kind: "reserved" as const, slot }
          : { kind: "lost" as const, failure: result },
      ),
    );
  }

  /**
   * After a live write answered, or failed to: journal it, and stop the run
   * if nobody can say whether it landed. Returns the failure the program
   * sees in place of the call's own when the run stops here.
   */
  settleWrite(
    seq: number,
    key: string,
    target: { address: string; args: unknown },
    outcome: InvocationOutcome<unknown>,
  ): Effect.Effect<InvocationFailure | undefined> {
    return Effect.gen({ self: this }, function* () {
      if (!this.liveWrites.has(seq)) return undefined;
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
      const entry: JournalEntry = {
        seq,
        op: "call",
        key,
        write: true,
        outcome: outcome.ok
          ? { ok: true, value: outcome.value }
          : { ok: false, error: outcome.error },
      };
      const slot = this.liveWrites.get(seq);
      const unknownFailure = state === "unknown"
        ? failure(
            "write_outcome_unknown",
            `The write to ${target.address} was sent, but no answer came back, so whether it happened is unknown. It will not be sent again. Check its target before doing anything that depends on it.`,
            {
              address: target.address,
              ...echoedCallArgs(target.args),
            },
          )
        : undefined;
      if (this.claim && slot !== undefined) {
        const written = yield* Effect.tryPromise(() =>
          this.journal.writeEntry(slot, entry, this.claim?.header.expiresAt ?? Date.now()),
        ).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
        const settled = yield* this.mutateHeader((header) => ({
          ...header,
          bytes: header.bytes + utf8Bytes(RunJournal.entryText(entry)),
          writes: header.writes.map((write) =>
            write.entry === slot
              ? { ...write, state: written ? state : "unknown" }
              : write,
          ),
        }));
        if (settled !== "ok") {
          this.stopWith({ kind: "failed", failure: settled });
          return guestFailure(settled.code, settled.message);
        }
        if (!written && !unknownFailure) {
          // The write's outcome is known here but could not be journaled, so
          // no later replay could answer it: stop rather than lose it.
          const lost = storageFailure();
          this.stopWith({ kind: "failed", failure: lost });
          return guestFailure(lost.code, lost.message);
        }
      } else {
        this.unpersisted.push(entry);
        this.freshWrites.push({
          entry: -1,
          address: target.address,
          state: state as WriteState,
        });
      }
      if (unknownFailure) {
        this.stopWith({ kind: "failed", failure: unknownFailure });
        return guestFailure(unknownFailure.code, unknownFailure.message);
      }
      return undefined;
    });
  }

  /** Whether `seq` was dispatched as a live write. */
  isLiveWrite(seq: number): boolean {
    return this.liveWrites.has(seq);
  }

  // --- the header ----------------------------------------------------------

  /**
   * Compare-and-set the claimed header, one change at a time. A write that
   * finds the header moved has lost the claim: someone else holds the run.
   */
  private mutateHeader(
    update: (header: RunHeader) => RunHeader,
  ): Effect.Effect<"ok" | RunFailure> {
    return Effect.promise(() => {
      const turn = this.headerTurn.then(async (): Promise<"ok" | RunFailure> => {
        const claim = this.claim;
        if (!claim) return failure("execution_claim_lost", "This run holds no claim.");
        const next = update(structuredClone(claim.header));
        next.version = claim.header.version + 1;
        let raw: string | undefined;
        try {
          raw = await this.journal.casHeader(claim.raw, next);
        } catch {
          return storageFailure();
        }
        if (raw === undefined) {
          return failure(
            "execution_claim_lost",
            "Another resume_execution took over this run, so this one stopped before sending anything further.",
          );
        }
        this.claim = { ...claim, raw, header: next };
        return "ok";
      });
      this.headerTurn = turn.catch(() => {});
      return turn;
    });
  }

  /**
   * A fresh play's writes, each pointing at its entry. They were journaled
   * in completion order with everything else, in the same order they were
   * settled, so the n-th write entry is the n-th write.
   */
  private freshWriteSlots(): RunHeader["writes"] {
    const slots: RunHeader["writes"] = [];
    this.unpersisted.forEach((entry, slot) => {
      const write = this.freshWrites[slots.length];
      if (entry.write && write) slots.push({ ...write, entry: slot });
    });
    return slots;
  }

  private writeCounts(): { succeeded: number; failed: number; unknown: number } {
    const writes = this.claim?.header.writes ?? this.freshWrites;
    return {
      succeeded: writes.filter((write) => write.state === "ok").length,
      failed: writes.filter((write) => write.state === "failed").length,
      unknown: writes.filter((write) => write.state === "unknown" || write.state === "sending").length,
    };
  }

  // --- how a play ends -----------------------------------------------------

  /**
   * The play stopped: persist the pause, or the failure, and say so. Called
   * after in-flight calls drained, so everything the program started is in
   * `unpersisted` or already journaled.
   */
  finishStopped(stop: RunStop): Effect.Effect<ToolResult> {
    return stop.kind === "paused"
      ? this.persistPause(stop.pending)
      : this.finishFailed(stop.failure);
  }

  /** The program settled on its own. */
  finishSettled(result: ToolResult): Effect.Effect<ToolResult> {
    return Effect.gen({ self: this }, function* () {
      const unfinished = this.replay?.unfinished();
      if (unfinished) return yield* this.finishFailed(diverged(unfinished));
      if (!this.claim) return result;
      const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
      const final = {
        isError: result.isError === true,
        text: text.length <= MAX_FINAL_CHARS
          ? text
          : JSON.stringify({
              completed: true,
              note: "The run completed and its result was returned once; it was too large to keep for a repeated resume_execution.",
            }),
      };
      yield* this.mutateHeader((header) => ({
        ...header,
        state: "completed",
        final,
      }));
      return result;
    });
  }

  /**
   * The executor itself failed — admission, cancellation, the watchdog — not
   * the program. A claimed run goes back to paused at the same pause, its
   * claim released and this attempt's approval withdrawn, so the same resume
   * can be tried again: every write it sent is journaled and replays.
   */
  finishExecutorFailure(result: ToolResult): Effect.Effect<ToolResult> {
    return Effect.gen({ self: this }, function* () {
      if (!this.claim) return result;
      if (this.writeCounts().unknown > 0) {
        return yield* this.finishFailed(
          failure(
            "write_outcome_unknown",
            "The run ended while a write was in flight, so whether it happened is unknown. It will not be sent again.",
            { writes: this.writeCounts() },
          ),
        );
      }
      const nonce = this.claim.header.nonce;
      yield* this.mutateHeader((header) => {
        const { claim: _released, ...rest } = header;
        return {
          ...rest,
          state: "paused",
          // Withdraw this attempt's approval of the current pause, unless it
          // was a call approval already spent: that write is journaled and
          // replays, and the retry must not be handed a fresh one.
          approvals: header.approvals.filter(
            (approval) =>
              approval.nonce !== nonce ||
              (approval.scope === "call" && approval.consumed === true),
          ),
        };
      });
      return result;
    });
  }

  private finishFailed(runFailure: RunFailure): Effect.Effect<ToolResult> {
    return Effect.gen({ self: this }, function* () {
      const withCounts: RunFailure = runFailure.code === "write_outcome_unknown" ||
          runFailure.code === "execution_diverged" ||
          this.writeCounts().succeeded + this.writeCounts().failed > 0
        ? { ...runFailure, writes: this.writeCounts() }
        : runFailure;
      const result = errorEnvelope(withCounts);
      if (this.claim) {
        const text = result.content[0]?.text ?? "";
        yield* this.mutateHeader((header) => {
          const { claim: _released, ...rest } = header;
          return {
            ...rest,
            state: "failed",
            final: { isError: true, text },
          };
        });
      }
      return result;
    });
  }

  /** Write the journal and the header, then hand back the pending result. */
  private persistPause(pending: PendingCall): Effect.Effect<ToolResult> {
    return Effect.gen({ self: this }, function* () {
      const nonce = randomId();
      const now = Date.now();
      const claim = this.claim;
      const expiresAt = claim?.header.expiresAt ??
        now + this.settings.ttlSeconds * 1_000;
      const newBytes = this.unpersisted.reduce(
        (sum, entry) => sum + utf8Bytes(RunJournal.entryText(entry)),
        0,
      );
      const bytes = (claim ? claim.header.bytes : utf8Bytes(this.program)) + newBytes;
      if (bytes > MAX_JOURNAL_BYTES) {
        return yield* this.finishFailed(
          failure(
            "journal_too_large",
            `This run recorded more than ${MAX_JOURNAL_BYTES} bytes of source and host calls, too much to hold while it waits for approval. Nothing was sent. Read less before the first write, or split the work.`,
            { nextAction: RERUN },
          ),
        );
      }
      const firstSlot = claim?.header.entries ?? 0;
      const written = yield* Effect.tryPromise(async () => {
        if (!claim) await this.journal.writeSource(this.program, expiresAt);
        for (let index = 0; index < this.unpersisted.length; index++) {
          const entry = this.unpersisted[index];
          if (entry) await this.journal.writeEntry(firstSlot + index, entry, expiresAt);
        }
      }).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
      if (!written) return yield* this.finishFailed(storageFailure());
      const entries = firstSlot + this.unpersisted.length;
      if (claim) {
        const moved = yield* this.mutateHeader((header) => {
          const { claim: _released, ...rest } = header;
          return {
            ...rest,
            state: "paused",
            nonce,
            pending,
            entries,
            bytes,
          };
        });
        if (moved !== "ok") return errorEnvelope(moved);
      } else {
        const header: RunHeader = {
          v: 1,
          state: "paused",
          version: 1,
          nonce,
          pool: this.settings.pool,
          createdAt: now,
          expiresAt,
          clock: this.environment.clockMs,
          seed: [...this.environment.seed],
          programHash: yield* Effect.promise(() => sha256Hex(this.program)),
          pending,
          approvals: [],
          writes: this.freshWriteSlots(),
          entries,
          bytes,
        };
        const stored = yield* Effect.tryPromise(() =>
          this.journal.casHeader(null, header),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (stored === undefined) return errorEnvelope(storageFailure());
      }
      this.unpersisted.length = 0;
      return pausedResult(
        formatToken({ runId: this.journal.runId, nonce, expiresAt }),
        pending,
        expiresAt,
      );
    });
  }
}

/** The `execute_code` / `resume_execution` result for a paused run. */
function pausedResult(
  token: string,
  pending: PendingCall,
  expiresAt: number,
): ToolResult {
  return jsonResult({
    paused: {
      address: pending.address,
      args: pending.args,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      nextAction: {
        tool: "resume_execution",
        arguments: {
          token,
          address: pending.address,
          args: pending.args,
          approval: "call",
        },
      },
      hint: 'Not sent. To run it, call resume_execution repeating this address and args exactly; approval "tool" also covers later calls to this tool for the rest of the run. Every read before this point is replayed from the journal, not repeated.',
    },
  });
}

function errorEnvelope(error: Record<string, unknown>): ToolResult {
  const result = jsonResult({ error });
  result.isError = true;
  return result;
}

// --- resume_execution ------------------------------------------------------

export interface ResumeArgs {
  token: string;
  address: string;
  args: Record<string, unknown>;
  approval?: "call" | "tool";
}

/** What `resume_execution` needs from the deployment and the request. */
export interface ResumeContext {
  storage: KVStorage;
  settings: ResumableSettings | undefined;
  /** Plays a claimed run: the same runner `execute_code` uses. */
  run: (runState: RunState) => Effect.Effect<ToolResult>;
  /** Claim lease: long enough for one play to finish or be abandoned. */
  claimMs: number;
  activity?: ActivityRequestContext | undefined;
}

function resumeError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  retryable = false,
): ToolResult {
  return errorEnvelope({ code, message, retryable, ...extra });
}

function resumeAction(
  header: RunHeader,
  runId: string,
): Record<string, unknown> | undefined {
  const pending = header.pending;
  if (header.state !== "paused" || !pending) return undefined;
  return {
    tool: "resume_execution",
    arguments: {
      token: formatToken({ runId, nonce: header.nonce, expiresAt: header.expiresAt }),
      address: pending.address,
      args: pending.args,
      approval: "call",
    },
  };
}

/**
 * The `resume_execution` handler: check the token and the exact repetition,
 * claim the run, and play it again.
 *
 * Everything that can refuse — an unknown or expired token, a stale one, a
 * mismatch — refuses before the claim, so a refusal spends nothing and
 * changes nothing. The claim is one compare-and-set from `paused` to
 * `running`; of two resumes racing for it, exactly one wins.
 */
export function resumeExecution(
  args: ResumeArgs,
  ctx: ResumeContext,
): Effect.Effect<ToolResult> {
  return Effect.gen(function* () {
    const { settings, storage } = ctx;
    if (!settings || !storage.compareAndSet) {
      return resumeError(
        "resumable_writes_unavailable",
        "This deployment does not pause programs at writes, so there is nothing to resume. Send a write through call_destructive_tool.",
      );
    }
    const token = parseToken(args.token);
    const notFound = resumeError(
      "execution_not_found",
      "No paused run matches this token. Run the task again with execute_code.",
      { nextAction: RERUN },
    );
    if (!token) return notFound;
    const journal = new RunJournal(storage, token.runId);
    const read = yield* Effect.tryPromise(() => journal.readHeader()).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (read === null) {
      return resumeError(
        "unavailable",
        "Paused-run storage could not be read. Retry shortly.",
        {},
        true,
      );
    }
    const now = Date.now();
    const expired = resumeError(
      "execution_expired",
      "This paused run expired. Its reads are stale, so it will not be replayed: run the task again with execute_code.",
      { nextAction: RERUN },
    );
    if (!read) return now >= token.expiresAt ? expired : notFound;
    const { header } = read;
    if (header.pool !== settings.pool) return notFound;
    if (now >= header.expiresAt) return expired;
    if (token.nonce !== header.nonce) {
      const next = resumeAction(header, token.runId);
      return resumeError(
        "execution_token_stale",
        "This token names an earlier pause of the run, which has moved on.",
        next ? { nextAction: next } : {},
      );
    }
    const pending = header.pending;
    if (
      !pending ||
      args.address !== pending.address ||
      canonicalJson(args.args) !== canonicalJson(pending.args)
    ) {
      return resumeError(
        "approval_mismatch",
        "resume_execution must repeat the paused write's address and args exactly. Nothing was approved or sent.",
        pending ? { nextAction: resumeAction(header, token.runId) } : {},
      );
    }
    if (header.state === "completed" || header.state === "failed") {
      // The same resume, repeated after the run ended: the same answer.
      const final = header.final;
      if (!final) return notFound;
      let parsed: unknown;
      try {
        parsed = JSON.parse(final.text);
      } catch {
        parsed = undefined;
      }
      const repeated = jsonResult(parsed, final.text);
      if (final.isError) repeated.isError = true;
      return repeated;
    }
    const scope = args.approval ?? "call";
    const claimId = randomId();
    const until = now + ctx.claimMs;
    // One approval per pause. A retry after an executor failure finds the
    // pause's spent call approval still on file and adds none: approving the
    // same call twice must not leave a second, unspent approval behind for an
    // identical later call to use.
    const alreadyApproved = header.approvals.some(
      (approval) => approval.nonce === header.nonce,
    );
    let claimed: RunHeader;
    const approvedNow = !alreadyApproved;
    if (header.state === "running") {
      if ((header.claim?.until ?? 0) > now) {
        return resumeError(
          "execution_in_progress",
          "Another resume_execution is playing this run right now. Retry after it finishes to see its result.",
          {},
          true,
        );
      }
      // The previous claimant stopped without finishing, and its lease ran
      // out. Whatever it marked `sending` may or may not have landed.
      const inFlight = header.writes.some((write) => write.state === "sending");
      claimed = {
        ...header,
        version: header.version + 1,
        claim: { id: claimId, until },
        ...(inFlight
          ? {
              state: "failed" as const,
              writes: header.writes.map((write) =>
                write.state === "sending" ? { ...write, state: "unknown" as const } : write,
              ),
            }
          : {}),
      };
    } else {
      claimed = {
        ...header,
        state: "running",
        version: header.version + 1,
        claim: { id: claimId, until },
      };
    }
    if (!alreadyApproved) {
      claimed.approvals = [...header.approvals, approvalOf(pending, scope, header.nonce)];
    }
    const raw = yield* Effect.tryPromise(() => journal.casHeader(read.raw, claimed)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (raw === undefined) {
      return resumeError(
        "execution_in_progress",
        "Another resume_execution claimed this run first. Retry after it finishes to see its result.",
        {},
        true,
      );
    }
    if (approvedNow) recordApproval(ctx.activity, pending.address, scope);
    if (claimed.state === "failed") {
      // A takeover that found a write in flight: report, never replay.
      const counts = {
        succeeded: claimed.writes.filter((write) => write.state === "ok").length,
        failed: claimed.writes.filter((write) => write.state === "failed").length,
        unknown: claimed.writes.filter((write) => write.state === "unknown").length,
      };
      const result = errorEnvelope({
        code: "write_outcome_unknown",
        message: "An earlier resume of this run stopped while a write was in flight, so whether it happened is unknown. It will not be sent again, and the run will not be replayed.",
        retryable: false,
        writes: counts,
      });
      const { claim: _released, ...rest } = claimed;
      yield* Effect.tryPromise(() =>
        journal.casHeader(raw, {
          ...rest,
          version: claimed.version + 1,
          final: { isError: true, text: result.content[0]?.text ?? "" },
        }),
      ).pipe(Effect.ignore);
      return result;
    }
    const loaded = yield* Effect.tryPromise(async () => ({
      program: await journal.readSource(claimed.programHash),
      entries: await journal.readEntries(claimed.entries),
    })).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const claim: Claim = { id: claimId, raw, header: claimed };
    if (!loaded?.program || !loaded.entries) {
      // Unreadable is unrecoverable: a partial journal cannot be replayed.
      const { claim: _released, ...rest } = claimed;
      yield* Effect.tryPromise(() =>
        journal.casHeader(raw, { ...rest, state: "failed", version: claimed.version + 1 }),
      ).pipe(Effect.ignore);
      return notFound;
    }
    return yield* ctx.run(
      RunState.replaying({
        journal,
        program: loaded.program,
        claim,
        entries: loaded.entries,
        settings,
      }),
    );
  });
}

function approvalOf(
  pending: PendingCall,
  scope: "call" | "tool",
  nonce: string,
): Approval {
  return scope === "tool"
    ? { address: pending.address, scope, nonce }
    : {
        address: pending.address,
        scope,
        argsCanonical: canonicalJson(pending.args),
        nonce,
      };
}

/** One payload-free `approved` event: the address and the scope, nothing else. */
function recordApproval(
  activity: ActivityRequestContext | undefined,
  address: string,
  approval: "call" | "tool",
): void {
  const parts = splitAddress(address);
  if (!activity || !parts) return;
  activity.recordTool?.(activity, {
    connectorId: parts.connectorId,
    toolName: parts.toolName,
    address,
    source: "resume_execution",
    outcome: "approved",
    durationMs: 0,
    attempts: 0,
    approval,
  });
}

const RESUME_DESC =
  'Approve and run the write a paused execute_code program stopped at. Repeat the paused result\'s token, address, and args exactly. The program replays from its journal — earlier reads are answered from it, not repeated — sends the write once, and continues to its result or its next pause. approval "tool" also approves later calls to that tool in this run. A mismatch approves and sends nothing. reason is for the human reviewer and is not sent downstream.';

// Built once at module scope, like the other meta-tool inputs.
const RESUME_INPUT = advertisedSchema(
  z.strictObject({
    token: z.string().max(512),
    address: z.string(),
    args: z.record(z.string(), z.unknown()),
    approval: z.enum(["call", "tool"]).optional(),
    // Dropped in the handler exactly as call_destructive_tool drops it.
    reason: z.string().max(500).optional(),
  }),
);

/** Register `resume_execution`, the approval point for a paused program. */
export function registerResumeTool(
  server: McpServer,
  registry: RegistryView,
  ctx: {
    runner: ProgramRunner;
    settings: ResumableSettings | undefined;
    activity?: ActivityRequestContext | undefined;
    requestSignal?: AbortSignal | undefined;
  },
): void {
  server.registerTool(
    "resume_execution",
    {
      description: RESUME_DESC,
      inputSchema: RESUME_INPUT,
      // The one program tool that sends writes, so the host's permission
      // prompt shows it — with the exact write in its arguments.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    (args, extra) => {
      const { reason: _hostContext, ...resume } = args as ResumeArgs & {
        reason?: string;
      };
      return underAnySignal([extra.mcpReq.signal, ctx.requestSignal], (signal) =>
        runEdge(resumeExecution(resume, {
          storage: registry.resultsStorage(),
          settings: ctx.settings,
          run: (runState) => ctx.runner.replay(runState, signal),
          claimMs: ctx.runner.claimMs,
          activity: ctx.activity,
        })));
    },
  );
}
