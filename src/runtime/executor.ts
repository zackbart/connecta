// Private execution dispatch. Public shells call their own program directly;
// only consumers select by method identity, so wrappers may call saved shells.
import { Effect } from "effect";
import type { Executor, ExecutorLease, ExecutorProvider, ExecuteResult } from "../types.js";

type ExecutionTarget = Executor | ExecutorLease;
type ExecuteProgram = (code: string, providers: ExecutorProvider[]) => Effect.Effect<ExecuteResult, unknown>;
const programs = new WeakMap<
  ExecutionTarget,
  { method: ExecutionTarget["execute"]; run: ExecuteProgram; logs?: () => unknown }
>();

export function provideExecutorProgram(target: ExecutionTarget, run: ExecuteProgram, logs?: () => unknown): void {
  programs.set(target, { method: target.execute, run, ...(logs ? { logs } : {}) });
}

/** Queued ownership crosses a Promise so workerd resumes in the waiting request. */
export function awaitExecutorLease(
  acquire: (signal: AbortSignal) => Promise<ExecutorLease>,
): Effect.Effect<ExecutorLease, unknown> {
  return Effect.suspend(() => {
    let pending: Promise<ExecutorLease> | undefined;
    return Effect.tryPromise({ try: (signal) => (pending = acquire(signal)), catch: (error) => error }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          pending
            ?.then(
              (lease) => lease.release(),
              () => {},
            )
            .catch(() => {});
        }),
      ),
    );
  });
}

export function executorProgram(
  target: ExecutionTarget,
  code: string,
  providers: ExecutorProvider[],
  observe?: {
    result: (outcome: ExecuteResult) => void;
    error: (error: unknown) => void;
    interrupted: (logs: unknown) => void;
  },
): Effect.Effect<ExecuteResult, unknown> {
  return Effect.suspend(() => {
    const native = programs.get(target);
    return native?.method === target.execute
      ? native.run(code, providers).pipe(
          Effect.tap((outcome) => Effect.sync(() => observe?.result(outcome))),
          Effect.tapError((error) => Effect.sync(() => observe?.error(error))),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (native.logs) observe?.interrupted(native.logs());
            }),
          ),
        )
      : Effect.tryPromise({
          // Observe a real Promise leaf even if its waiting fiber has lost a
          // terminal race. Its synchronous log prefix still belongs to the run.
          try: () =>
            target.execute(code, providers).then(
              (outcome) => {
                observe?.result(outcome);
                return outcome;
              },
              (error: unknown) => {
                observe?.error(error);
                throw error;
              },
            ),
          catch: (error) => error,
        });
  }).pipe(Effect.catchDefect((error) => Effect.fail(error)));
}
