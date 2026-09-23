// The Effect face of bounded admission (src/executor-admission.ts).
//
// AdmissionController is a published class, and its declaration — private
// member names included — is part of what ships, so its Effect program cannot
// hang off a new field or method. The class hands that program here from a
// static block instead: the one place outside its instance methods that may
// read its private bookkeeping, and one that emits nothing into the `.d.ts`.
// Promise callers keep `acquire()`, which runs the same program through
// runEdge; Effect callers come through this module and never see a Promise.

import { Effect, type Scope } from "effect";
import type {
  AdmissionController,
  AdmissionLease,
  ExecutorAdmissionError,
} from "../executor-admission.js";

type AdmissionProgram = (
  controller: AdmissionController,
  signal: AbortSignal | undefined,
) => Effect.Effect<AdmissionLease, ExecutorAdmissionError>;

let program: AdmissionProgram | undefined;

/**
 * Install the controller's admission program. Called once, by
 * AdmissionController's static block, when that module evaluates — which any
 * importer of this module's value exports has already caused, since they need
 * a controller to pass in.
 */
export function provideAdmissionProgram(admit: AdmissionProgram): void {
  program = admit;
}

export interface AdmitOptions {
  /** Cancels a queued wait as `executor_cancelled`, as `acquire()` does. */
  signal?: AbortSignal | undefined;
}

/**
 * Admit one unit of work, as `controller.acquire()` does, without a Promise.
 *
 * Fails with the same ExecutorAdmissionError objects, bumps the same counters,
 * and honours the same queue bound and timeout. Interrupting the fiber while
 * it is queued withdraws it (counted as cancelled); interrupting it after a
 * slot was handed over releases that slot rather than stranding it.
 */
export function admit(
  controller: AdmissionController,
  options: AdmitOptions = {},
): Effect.Effect<AdmissionLease, ExecutorAdmissionError> {
  if (!program) {
    throw new Error("AdmissionController's admission program was never installed.");
  }
  return program(controller, options.signal);
}

/**
 * A lease owned by the enclosing Scope: released when the scope closes, on
 * success, failure, or interruption alike. The wait itself stays
 * interruptible — a queued request whose caller left must not hold its place
 * in line until the queue timeout.
 */
export function acquireScoped(
  controller: AdmissionController,
  options: AdmitOptions = {},
): Effect.Effect<AdmissionLease, ExecutorAdmissionError, Scope.Scope> {
  return Effect.acquireRelease(
    admit(controller, options),
    (lease) => Effect.sync(() => lease.release()),
    { interruptible: true },
  );
}
