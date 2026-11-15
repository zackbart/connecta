import { Effect } from "effect";
import type { InvocationOutcome } from "./invocation.js";
import type { HeldResults } from "./result-seal.js";
import { withDeadlineEffect } from "./runtime/run.js";
import { RESULT_TTL_SECONDS } from "./storage/keys.js";
import { isWriteLike } from "./tool-safety.js";
import { classifyWriteOutcome } from "./write-outcome.js";

export type CallOutcome = "success" | "failure" | "unknown" | "refused";

export interface LoggedCall {
  address: string;
  outcome: CallOutcome;
  durationMs: number;
  resultId?: string;
}

export type RetainRead = (held: HeldResults) => Effect.Effect<string | undefined, unknown>;

const MAX_LOGGED_CALLS = 100;
const MAX_RETAINED_READS = 20;
const RETAIN_BUDGET_MS = 1_000;
const RETAIN_CONCURRENCY = 4;

export const RETAINED_READS_NOTE = `Reads this run completed are retained for ${RESULT_TTL_SECONDS / 60} minutes: in a new program, read each calls[].resultId with connecta.result(resultId, { all: true }) instead of repeating that read.`;

interface Entry {
  address: string;
  readonly started: number;
  outcome?: CallOutcome;
  durationMs?: number;
  retain?: RetainRead;
  reuse?: string;
  resultId?: string;
}

export function callOutcome(outcome: InvocationOutcome<unknown>): CallOutcome {
  if (outcome.ok) return "success";
  if (!outcome.dispatched) return "refused";
  const writeLike = outcome.resolved === undefined || isWriteLike(outcome.resolved.definition);
  if (!writeLike && outcome.error.writeOutcome !== "unknown") return "failure";
  const state = classifyWriteOutcome(outcome);
  return state === "ok" ? "success" : state === "unknown" ? "unknown" : "failure";
}

export class ProgramCalls {
  private readonly entries: Entry[] = [];
  private omitted = 0;

  begin(
    address: string,
  ): (outcome: CallOutcome, settled?: { address?: string; retain?: RetainRead; reuse?: string }) => void {
    const started = Date.now();
    if (this.entries.length >= MAX_LOGGED_CALLS) {
      this.omitted++;
      return () => {};
    }
    const entry: Entry = { address, started };
    this.entries.push(entry);
    return (outcome, settled) => {
      if (entry.outcome) return;
      entry.outcome = outcome;
      entry.durationMs = Date.now() - started;
      if (settled?.address !== undefined) entry.address = settled.address;
      if (outcome !== "success") return;
      if (settled?.reuse !== undefined) entry.reuse = settled.reuse;
      else if (settled?.retain) entry.retain = settled.retain;
    };
  }

  retainReads(options: {
    answerBy: number;
    signal?: AbortSignal | undefined;
    ready: Effect.Effect<void>;
    stash: (retain: RetainRead) => Effect.Effect<string | undefined, unknown>;
    seal: (deadlineAt: number) => Effect.Effect<ReadonlySet<string>>;
  }): Effect.Effect<void> {
    return Effect.suspend(() => {
      const kept = this.entries
        .filter((entry) => entry.reuse !== undefined || entry.retain)
        .slice(0, MAX_RETAINED_READS);
      for (const entry of kept) if (entry.reuse !== undefined) entry.resultId = entry.reuse;
      const pending = kept.filter((entry) => entry.reuse === undefined);
      if (pending.length === 0) return Effect.void;
      const budgetMs = Math.max(2, Math.min(RETAIN_BUDGET_MS, Math.floor((options.answerBy - Date.now()) / 4)));
      const deadlineAt = Date.now() + budgetMs;
      const stashed = new Map<Entry, string>();
      const stashAll = Effect.andThen(
        options.ready,
        Effect.forEach(
          pending,
          (entry) =>
            options.stash(entry.retain!).pipe(
              Effect.tap((id) =>
                Effect.sync(() => {
                  if (id !== undefined) stashed.set(entry, id);
                }),
              ),
              Effect.ignore,
            ),
          { concurrency: RETAIN_CONCURRENCY, discard: true },
        ),
      );
      return withDeadlineEffect(() => stashAll, {
        timeoutMs: Math.max(1, Math.floor(budgetMs / 2)),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutError: new Error("Retaining completed reads timed out."),
      }).pipe(
        Effect.ignore,
        Effect.andThen(Effect.suspend(() => options.seal(deadlineAt))),
        Effect.tap((published) =>
          Effect.sync(() => {
            for (const [entry, id] of stashed) if (published.has(id)) entry.resultId = id;
          }),
        ),
        Effect.asVoid,
      );
    });
  }

  get retained(): boolean {
    return this.entries.some((entry) => entry.resultId !== undefined);
  }

  report(): { calls?: LoggedCall[]; callsOmitted?: number } {
    if (this.entries.length === 0) return {};
    const now = Date.now();
    return {
      calls: this.entries.map((entry) => ({
        address: entry.address,
        outcome: entry.outcome ?? "unknown",
        durationMs: entry.durationMs ?? now - entry.started,
        ...(entry.resultId !== undefined ? { resultId: entry.resultId } : {}),
      })),
      ...(this.omitted > 0 ? { callsOmitted: this.omitted } : {}),
    };
  }
}
