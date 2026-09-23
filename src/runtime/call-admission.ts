// The Effect face of downstream call admission (src/call-admission.ts).
//
// ConnectorCallAdmissionController is a published class whose declaration —
// private member names included — ships, so its Effect program cannot hang
// off a new field or method. As with AdmissionController (see
// src/runtime/admission.ts), the class hands that program here from a static
// block: the one place outside its instance methods that may read its private
// bookkeeping, and one that emits nothing into the `.d.ts`.
//
// The two controllers stay separate on purpose (#453): request admission
// bounds executor work, this bounds calls to one downstream connector, and a
// shared queue between them was refused.

import { Effect, type Scope } from "effect";
import type {
  CallAdmissionError,
  CallAdmissionPermit,
  ConnectorCallAdmissionController,
} from "../call-admission.js";
import type { ConnectorCallAdmissionInput } from "../types.js";

export interface CallAdmissionRequest
  extends Readonly<ConnectorCallAdmissionInput> {
  /** Cancels a queued wait as a `cancelled` CallAdmissionError. */
  signal?: AbortSignal | undefined;
}

/**
 * Runs the synchronous admission checks when called — counters, partition
 * derivation, the budget, an immediate grant or refusal — and returns an
 * effect that at most waits for a queued slot. `now` is the clock the rolling
 * window and queue-wait accounting read for this caller.
 */
type CallAdmissionProgram = (
  controller: ConnectorCallAdmissionController,
  request: CallAdmissionRequest,
  now: () => number,
) => Effect.Effect<CallAdmissionPermit, CallAdmissionError>;

let program: CallAdmissionProgram | undefined;

// What the live Clock reads, looked up on every call rather than bound once,
// so a Date faked after a caller queued (vitest's setSystemTime) still counts.
const liveNow = (): number => Date.now();

/**
 * Install the controller's admission program. Called once, by
 * ConnectorCallAdmissionController's static block, when that module
 * evaluates — which any caller has already caused, since it needs a
 * controller to pass in.
 */
export function provideCallAdmissionProgram(admit: CallAdmissionProgram): void {
  program = admit;
}

function installed(): CallAdmissionProgram {
  if (!program) {
    throw new Error(
      "ConnectorCallAdmissionController's admission program was never installed.",
    );
  }
  return program;
}

/**
 * The Promise shell's entry: decide now, on `Date.now()` — the value the live
 * Clock reads — and return only the wait.
 *
 * Deciding eagerly is what keeps the limiter payload-free. The returned
 * effect closes over the partition key, never the request, so a queued call
 * does not retain its tool arguments for as long as it waits.
 */
export function startCallAdmission(
  controller: ConnectorCallAdmissionController,
  request: CallAdmissionRequest,
): Effect.Effect<CallAdmissionPermit, CallAdmissionError> {
  return installed()(controller, request, liveNow);
}

/**
 * Admit one downstream call, as `controller.acquire()` does, without a
 * Promise.
 *
 * Fails with the same CallAdmissionError objects and bumps the same counters.
 * The rolling window and queue-wait times read the fiber's Clock. Nothing
 * happens until the effect runs, and each run is a fresh admission.
 * Interrupting the fiber while it is queued withdraws it (counted as
 * cancelled); interrupting it after a slot was handed over releases that slot
 * rather than stranding it.
 */
export function admitCall(
  controller: ConnectorCallAdmissionController,
  request: CallAdmissionRequest,
): Effect.Effect<CallAdmissionPermit, CallAdmissionError> {
  const admit = installed();
  return Effect.clockWith((clock) =>
    admit(controller, request, () => clock.currentTimeMillisUnsafe()),
  );
}

/**
 * A permit owned by the enclosing Scope: released when the scope closes, on
 * success, failure, or interruption alike. The queued wait stays
 * interruptible, so a caller that left does not hold its place in line until
 * the queue timeout.
 */
export function acquireCallScoped(
  controller: ConnectorCallAdmissionController,
  request: CallAdmissionRequest,
): Effect.Effect<CallAdmissionPermit, CallAdmissionError, Scope.Scope> {
  return Effect.acquireRelease(
    admitCall(controller, request),
    (permit) => Effect.sync(() => permit.release()),
    { interruptible: true },
  );
}
