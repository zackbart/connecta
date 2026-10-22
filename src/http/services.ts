// HTTP request facts and fixed write reservations (B.2/B.4 prototype).
import { Context, Effect } from "effect";
import type { ProviderRequest } from "../provider-call.js";
import { dispatchProviderRequest, providerRequest } from "../provider-call.js";
import type { ConnectorContext } from "../types.js";
import { callClassification } from "../call-classification.js";
import { fromSignal } from "../runtime/run.js";
import { callFromContext, openCall as openCoreCall, Signal } from "../runtime/call.js";
import { RequestRefused, ResendRefused, type HttpFailure, type OperationRef } from "./errors.js";
import type { WriteRequest } from "./write-request.js";
export { writeRequestKey, type WriteRequest } from "./write-request.js";
export {
  Caller,
  Credentials,
  Secrets,
  RequestSecrets,
  Budget,
  Recovery,
  Signal,
  Classification,
  Ledger,
  openRequest,
  operationView,
  deriveView,
  viewCaller,
  callView,
  chargeView,
} from "../runtime/call.js";
export type CallServices = import("../runtime/call.js").CallServices | Dispatches | WriteCapacity;
/**
 * How one resource request of this call ended, recorded as it happened. The
 * kit's own record of reservations and answers: the one-dispatch guard, the
 * 401 handoff, and a blocked resend read it. The write's verdict is read from
 * the core ledger entry (`request`), never from here.
 */
export interface Dispatch {
  /** It counts as the call's write: every request of a write call except one sent with `{ effect: "read" }`. */
  readonly write: boolean;
  /** Which construction-declared logical write it is; the implicit default is `write`. */
  readonly step?: string;
  readonly item?: string;
  readonly operation?: OperationRef;
  /**
   * `lost` when `fetch` rejected: no rejection proves a request unsent, since
   * one fetch can hide several attempts (#902 round 8).
   */
  state: "reserved" | "preparing" | "pending" | "lost" | "answered";
  status?: number;
  headers?: Headers;
  /** The failure this request's own answer settled into, so the mapping can tell it from a later one. */
  failure?: HttpFailure;
  /** Its entry in the core ledger, recorded synchronously before `fetch`. */
  request?: ProviderRequest;
}

/** Permanent write reservations plus resource dispatches, in reservation order. */
export class Dispatches extends Context.Service<Dispatches, Dispatch[]>()("connecta/http/Dispatches") {}

/** A genuine idempotency key the vendor honors, and the header that carries it, for the call's one write. */
export const IdempotencyKey = Context.Reference<{ readonly header: string; readonly key: string } | undefined>(
  "connecta/http/IdempotencyKey",
  { defaultValue: () => undefined },
);

/** Closed capacity and the requests bound to bulk items, snapshotted before the program runs. */
export class WriteCapacity extends Context.Service<
  WriteCapacity,
  ReadonlyMap<string, ReadonlyMap<string | undefined, WriteRequest | undefined>>
>()("connecta/http/WriteCapacity") {}

/** No await or fiber yield between the check and insertion. Reservations are never released. */
export function reserveWrite(
  ledger: Dispatch[],
  capacity: Context.Service.Shape<typeof WriteCapacity>,
  facts: { readonly step?: string; readonly item?: string; readonly operation?: OperationRef },
): Dispatch | RequestRefused | ResendRefused {
  const step = facts.step ?? "write";
  if (!capacity.get(step)?.has(facts.item)) {
    return new RequestRefused({ message: "This write step/item was not declared by the tool for this call." });
  }
  const first = ledger.find((entry) => entry.write && entry.step === step && entry.item === facts.item);
  if (first) return new ResendRefused({ first });
  const slot: Dispatch = {
    write: true,
    step,
    ...(facts.item === undefined ? {} : { item: facts.item }),
    ...(facts.operation ? { operation: facts.operation } : {}),
    state: "reserved",
  };
  ledger.push(slot);
  return slot;
}

/**
 * What one request inside a call is: the call's own effect, or an auxiliary
 * read inside a write tool, and which logical write. Set by `Send`, read by
 * the transport and the OAuth middleware. `sent` is filled by the transport
 * with the request it handed to `fetch`, so `Send` can record that request's
 * own failure in the ledger.
 */
export const RequestFacts = Context.Reference<{
  readonly effect: "call" | "read";
  readonly step?: string;
  readonly item?: string;
  readonly operation?: OperationRef;
  readonly sent?: { reservation?: Dispatch; dispatch?: Dispatch };
}>("connecta/http/RequestFacts", { defaultValue: () => ({ effect: "call" }) });

/** Every renewal is call-owned; interrupt it on close, including its underlying abortable I/O. */
export function duringCall<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | RequestRefused, R | Signal> {
  return Signal.use((signal) => {
    const closed = () => new RequestRefused({ message: "This call has ended; no renewal work may continue." });
    if (!signal) return work;
    if (signal.aborted) return Effect.fail(closed());
    return Effect.raceFirst(work, fromSignal(signal).pipe(Effect.mapError(closed)));
  });
}

export function fromConnectorContext(
  ctx: ConnectorContext,
  fallback: "read" | "write",
): import("../runtime/call.js").CallLease & { services: Context.Context<CallServices> } {
  const lease = callFromContext(ctx, callClassification(ctx) ?? fallback, {
    ledger: {
      open: ({ auxiliary, provider, method, key }) =>
        providerRequest(ctx, auxiliary, provider, { method, ...(key === undefined ? {} : { key }) }),
      dispatch: (entry, headers, method) => dispatchProviderRequest(ctx, entry, headers, method),
    },
  });
  return {
    ...lease,
    services: lease.services.pipe(
      Context.add(Dispatches, []),
      Context.add(WriteCapacity, new Map([["write", new Map([[undefined, undefined]])]])),
    ),
  };
}

export interface CallLease extends Omit<importCoreLease, "services"> {
  readonly services: Context.Context<CallServices>;
}
type importCoreLease = import("../runtime/call.js").CallLease;
export function openCall(inputs: import("../runtime/call.js").CallInputs): CallLease {
  const lease = openCoreCall(inputs);
  return {
    ...lease,
    services: lease.services.pipe(
      Context.add(Dispatches, []),
      Context.add(WriteCapacity, new Map([["write", new Map([[undefined, undefined]])]])),
    ),
  };
}
