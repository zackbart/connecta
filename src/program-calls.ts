import { Effect } from "effect";
import type { InvocationOutcome } from "./invocation.js";
import { withDeadlineEffect } from "./runtime/run.js";
import { RESULT_TTL_SECONDS } from "./storage/keys.js";
import { classifyWriteOutcome } from "./write-outcome.js";

export type CallOutcome = "success" | "failure" | "unknown" | "refused";

export interface LoggedCall {
  address: string;
  outcome: CallOutcome;
  durationMs: number;
  resultId?: string;
}

export type RetainRead = () => Effect.Effect<string | undefined, unknown>;

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
  resultId?: string;
}

export function callOutcome(outcome: InvocationOutcome<unknown>): CallOutcome {
  if (outcome.ok) return "success";
  if (!outcome.dispatched) return "refused";
  if (outcome.resolved?.definition.classification === "read") return "failure";
  const state = classifyWriteOutcome(outcome);
  return state === "ok" ? "success" : state === "unknown" ? "unknown" : "failure";
}

export class ProgramCalls {
  private readonly entries: Entry[] = [];
  private omitted = 0;

  begin(address: string): (outcome: CallOutcome, settled?: { address?: string; retain?: RetainRead }) => void {
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
      if (settled?.retain && outcome === "success") entry.retain = settled.retain;
    };
  }

  retainReads(answerBy: number, signal?: AbortSignal): Effect.Effect<void> {
    return Effect.suspend(() => {
      const pending = this.entries.filter((entry) => entry.retain).slice(0, MAX_RETAINED_READS);
      if (pending.length === 0) return Effect.void;
      const timeoutMs = Math.max(1, Math.min(RETAIN_BUDGET_MS, Math.floor((answerBy - Date.now()) / 4)));
      return withDeadlineEffect(
        () =>
          Effect.forEach(
            pending,
            (entry) =>
              entry.retain!().pipe(
                Effect.tap((id) =>
                  Effect.sync(() => {
                    if (id !== undefined) entry.resultId = id;
                  }),
                ),
                Effect.ignore,
              ),
            { concurrency: RETAIN_CONCURRENCY, discard: true },
          ),
        { timeoutMs, ...(signal ? { signal } : {}), timeoutError: new Error("Retaining completed reads timed out.") },
      ).pipe(Effect.ignore);
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
