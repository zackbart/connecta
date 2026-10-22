// Internal prototype for decision 0010 (B.1). Nothing under src/http/ is
// reachable from src/index.ts, and no live provider imports it yet.
//
// One downstream call's state, as Context services instead of side tables
// keyed on the ConnectorContext object, so a copy of a context can no longer
// drop the caller, the permit, or the recovery facts (the `{...ctx}` defect).
//
// A service is a value: code can keep one past its call, and ending a fiber
// revokes nothing. Lifetime is therefore explicit. `openCall` returns a lease
// whose `close` is the call's finalizer; every call-owned capability checks
// it before and after any await, so a retained or pending use fails instead
// of acting for a call that is over (INV-7). Request-owned resources (an MCP
// session, a token flight) belong to the request instead and close with it
// (`openRequest`).
//
// State every registry operation needs, call or not (discovery, status,
// startAuth), is the operation layer: the admitted caller. A Promise view of
// either layer resolves through one table keyed on the view a copy was
// derived from, so a derived copy reads the same entry and a plain spread
// copy reads nothing (fails closed).
//
// B.1 turns the direction around: invocation provides these services and
// derives the Promise `ConnectorContext` from them. Until then
// `fromConnectorContext` reads today's side tables once, at the Promise edge,
// so kit code already sees only services.

import { Context, Effect } from "effect";
import { chargeConnectorCall } from "../call-admission-context.js";
import { callClassification } from "../call-classification.js";
import { recordRecovery } from "../call-recovery.js";
import { callerOf, type ConnectorCaller } from "../connector-caller.js";
import { ConnectorCallError } from "../errors.js";
import { dispatchProviderRequest, providerRequest, type ProviderRequest } from "../provider-call.js";
import { fromSignal, runEdge } from "../runtime/run.js";
import { requestSentSecrets, sentSecretsFor, trackCredentialReads, type SentSecrets } from "../sent-secrets.js";
import type { ConnectorContext, ConnectorCredentialValues } from "../types.js";
import { RequestRefused, ResendRefused, type HttpFailure, type OperationRef } from "./errors.js";

import type { WriteRequest } from "./write-request.js";
export { writeRequestKey, type WriteRequest } from "./write-request.js";

/** Who admitted the operation; absent for a probe or a callback no request admitted. */
export class Caller extends Context.Service<Caller, ConnectorCaller | undefined>()("connecta/http/Caller") {}

/** The credentials this call may send, already registered as sent secrets when read. */
export class Credentials extends Context.Service<
  Credentials,
  { readonly values: Effect.Effect<ConnectorCredentialValues | null, ConnectorCallError> }
>()("connecta/http/Credentials") {}

/** The call's sent-secret set; every credential header and query value is registered here. */
export class Secrets extends Context.Service<Secrets, SentSecrets>()("connecta/http/Secrets") {}

/**
 * Everything the request sent, every connector's credentials included: the
 * set that redacts downstream text whole before anything cuts, trims, or
 * extracts from it (#911's `redactBeforeCut`).
 */
export class RequestSecrets extends Context.Service<RequestSecrets, SentSecrets>()("connecta/http/RequestSecrets") {}

/**
 * The enclosing invocation's admission permit, as the one thing a provider
 * may do with it: charge an auxiliary request to the same budget.
 */
export class Budget extends Context.Service<Budget, { readonly charge: Effect.Effect<void, unknown> }>()(
  "connecta/http/Budget",
) {}

/** Facts that let an agent reconcile a write whose outcome is unknown. */
export class Recovery extends Context.Service<
  Recovery,
  { readonly record: (facts: Readonly<Record<string, string>>) => Effect.Effect<void> }
>()("connecta/http/Recovery") {}

/** The call's cancellation, handed to `fetch` as guarded-fetch handed `ctx.signal`. */
export class Signal extends Context.Service<Signal, AbortSignal | undefined>()("connecta/http/Signal") {}

/**
 * The call's served classification: deployment config's verdict when it
 * gives one, else the tool's. The OAuth middleware and the write-outcome rule
 * read it; neither the builder nor the HTTP method decides.
 */
export class Classification extends Context.Service<Classification, "read" | "write">()(
  "connecta/http/Classification",
) {}

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

/**
 * The core's request ledger for this call (src/provider-call.ts), which the
 * `api()` boundary reads to decide every write verdict (INV-9). The transport
 * opens an entry for each resource request with its method and any genuine
 * idempotency key it carries, dispatches it synchronously before `fetch`
 * (which refuses a request whose call has ended), and records its status
 * when answered. A dispatch also joins the request to the invocation's
 * logical call, so identities are captured when the request leaves.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly open: (facts: {
      readonly auxiliary: boolean;
      readonly provider: string;
      readonly method: string;
      readonly key?: string;
    }) => ProviderRequest;
    readonly dispatch: (request: ProviderRequest) => void;
  }
>()("connecta/http/Ledger") {}

/**
 * A ledger no `api()` boundary reads: what a lease built without a context
 * (a unit test) records into. It still marks each request dispatched.
 */
const detachedLedger: Context.Service.Shape<typeof Ledger> = {
  open: ({ auxiliary, provider, method, key }) => ({
    dispatched: false,
    auxiliary,
    provider,
    method,
    ...(key === undefined ? {} : { key }),
  }),
  dispatch: (request) => {
    request.dispatched = true;
  },
};

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

type OperationServices = Caller;
export type CallServices =
  | OperationServices
  | Credentials
  | Secrets
  | RequestSecrets
  | Budget
  | Recovery
  | Signal
  | Classification
  | Dispatches
  | Ledger
  | WriteCapacity;

function ended(): ConnectorCallError {
  return new ConnectorCallError(
    "connector_call_failed",
    "This call has ended; a capability kept from it can no longer be used.",
    { retryable: false },
  );
}

/** Every renewal is call-owned; interrupt it on close, including its underlying abortable I/O. */
export function duringCall<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | RequestRefused, R | Signal> {
  return Signal.use((signal) => {
    const closed = () => new RequestRefused({ message: "This call has ended; no renewal work may continue." });
    if (!signal) return work;
    if (signal.aborted) return Effect.fail(closed());
    return Effect.raceFirst(work, fromSignal(signal).pipe(Effect.mapError(closed)));
  });
}

/** A call's services and the finalizer that ends them. */
export interface CallLease {
  readonly services: Context.Context<CallServices>;
  /** Whether `close` has run. */
  readonly closed: () => boolean;
  /** The call's finalizer: every call-owned capability refuses from now on, pending uses included. */
  readonly close: () => void;
}

export interface CallInputs {
  readonly caller: ConnectorCaller | undefined;
  readonly classification: "read" | "write";
  readonly credentials: (signal: AbortSignal) => Promise<ConnectorCredentialValues | null>;
  readonly charge: (signal: AbortSignal) => Promise<void>;
  readonly record: (facts: Readonly<Record<string, string>>) => void;
  readonly secrets: SentSecrets;
  /** The request's whole set; defaults to `secrets`. */
  readonly requestSecrets?: SentSecrets;
  readonly signal: AbortSignal | undefined;
  /** The core ledger the boundary reads; a detached one when no context is behind the call. */
  readonly ledger?: Context.Service.Shape<typeof Ledger>;
}

/** Build one call's services. Invocation calls this in the scoped attempt that owns the permit (B.1). */
export function openCall(inputs: CallInputs): CallLease {
  let open = true;
  const controller = new AbortController();
  const abort = () => controller.abort(inputs.signal?.reason);
  if (inputs.signal?.aborted) abort();
  else inputs.signal?.addEventListener("abort", abort, { once: true });
  // Closure settles the Effect immediately and interrupts its Promise bridge.
  // Inputs receive that cancellation too, so their owned I/O can be aborted.
  const live = <A>(work: (signal: AbortSignal) => Promise<A>, fail: (error: unknown) => unknown) =>
    Effect.suspend(() =>
      open && !controller.signal.aborted
        ? Effect.raceFirst(
            Effect.tryPromise({
              try: (interrupted) => work(AbortSignal.any([interrupted, controller.signal])),
              catch: fail,
            }),
            fromSignal(controller.signal).pipe(Effect.mapError(ended)),
          ).pipe(
            Effect.flatMap((value) =>
              open && !controller.signal.aborted ? Effect.succeed(value) : Effect.fail(ended()),
            ),
          )
        : Effect.fail(ended()),
    );
  const services = Context.make(Caller, inputs.caller).pipe(
    Context.add(Credentials, {
      values: live(inputs.credentials, () =>
        open
          ? new ConnectorCallError("auth_required", "The connector's stored credential could not be read.", {
              retryable: false,
            })
          : ended(),
      ) as Effect.Effect<ConnectorCredentialValues | null, ConnectorCallError>,
    }),
    Context.add(Secrets, inputs.secrets),
    Context.add(RequestSecrets, inputs.requestSecrets ?? inputs.secrets),
    Context.add(Budget, { charge: live(inputs.charge, (error) => error) }),
    Context.add(Recovery, {
      // Late facts are dropped: invocation has already read the record.
      record: (facts) => Effect.sync(() => (open ? inputs.record(facts) : undefined)),
    }),
    Context.add(Signal, controller.signal),
    Context.add(Classification, inputs.classification),
    Context.add(Dispatches, []),
    Context.add(Ledger, inputs.ledger ?? detachedLedger),
    Context.add(WriteCapacity, new Map([["write", new Map([[undefined, undefined]])]])),
  );
  return {
    services,
    closed: () => !open,
    close: () => {
      if (!open) return;
      open = false;
      inputs.signal?.removeEventListener("abort", abort);
      controller.abort(ended());
    },
  };
}

// --- The Promise view (custom handlers, unmigrated providers, remoteMcp) ----------

interface Entry {
  readonly caller: ConnectorCaller | undefined;
  readonly request: object;
  call?: CallLease;
}

const entries = new WeakMap<object, Entry>();
const origins = new WeakMap<object, object>();

function entryOf(view: object): Entry | undefined {
  return entries.get(origins.get(view) ?? view);
}

/**
 * A registry operation's view (discovery, status, startAuth, a resource
 * read), carrying the admitted caller beside it. The registry builds one for
 * every operation of a scoped view, not only for calls.
 */
export function operationView(base: ConnectorContext, caller: ConnectorCaller | undefined): ConnectorContext {
  const view = { ...base, requestScope: base.requestScope ?? {} };
  const request = requestOf(view.requestScope);
  // A view of a request that already closed resolves nothing.
  if (request.open) {
    entries.set(view, { caller, request: view.requestScope });
    request.views.push(view);
  }
  return view;
}

/**
 * A copy that shares its origin's entry (A.2's `deriveContext`): startAuth's
 * authorizing copy, a catalog listing's copy. It keeps the request scope.
 */
export function deriveView<T extends ConnectorContext>(view: ConnectorContext, overrides: Partial<T>): T {
  const origin = origins.get(view) ?? view;
  const derived = { ...view, ...overrides, requestScope: view.requestScope } as T;
  origins.set(derived, origin);
  return derived;
}

/** The admitted caller of a view or anything derived from it; undefined once its request closed. */
export function viewCaller(view: ConnectorContext): ConnectorCaller | undefined {
  return entryOf(view)?.caller;
}

/**
 * A call's view, derived from its operation's view: `credential` and the
 * call-state readers go through the lease, so they refuse once it closes,
 * whoever kept the view.
 */
export function callView(operation: ConnectorContext, lease: CallLease): ConnectorContext {
  const values = Context.get(lease.services, Credentials).values;
  const signal = Context.get(lease.services, Signal);
  const view = deriveView(operation, {
    ...(signal ? { signal } : {}),
    credential: {
      getAll: () => runEdge(values),
      get: async (field = "value") => {
        const all = await runEdge(values);
        return all && Object.hasOwn(all, field) ? all[field]! : null;
      },
    },
  });
  const entry = entryOf(operation);
  origins.delete(view);
  const request = entry ? requestOf(entry.request) : undefined;
  if (entry && request?.open) {
    entries.set(view, { ...entry, call: lease });
    request.views.push(view);
  }
  return view;
}

/** Charge the call's budget through a view, as `chargeConnectorCall` does today. */
export function chargeView(view: ConnectorContext): Promise<void> {
  const lease = entryOf(view)?.call;
  return lease ? runEdge(Context.get(lease.services, Budget).charge) : Promise.reject(ended());
}

// --- Request-owned resources ---------------------------------------------------------

interface RequestState {
  open: boolean;
  readonly controller: AbortController;
  readonly finalizers: Array<() => void>;
  readonly views: object[];
}

const requests = new WeakMap<object, RequestState>();

function requestOf(scope: object): RequestState {
  let state = requests.get(scope);
  if (!state) {
    state = { open: true, controller: new AbortController(), finalizers: [], views: [] };
    requests.set(scope, state);
  }
  return state;
}

/**
 * Resources that outlive one call but not the request (an MCP session, a
 * request-token flight). They see the request's signal, never a call's, and
 * close when the request does (D.1 makes this a RequestScope service).
 *
 * `close` cannot be cut short. Revocation comes first and cannot throw: the
 * request's views stop resolving and every call lease reached through them
 * closes, so no credential, charge, or caller outlives the request whatever a
 * finalizer does. Then the signal aborts and every finalizer runs, each on
 * its own, in reverse order. Failures are collected and thrown together once
 * all of it ran, so a second `close` has nothing left to do.
 */
export function openRequest(scope: object): {
  readonly signal: AbortSignal;
  readonly own: (finalizer: () => void) => void;
  readonly close: () => void;
} {
  const state = requestOf(scope);
  return {
    signal: state.controller.signal,
    own: (finalizer) => {
      if (state.open) state.finalizers.push(finalizer);
      else finalizer();
    },
    close: () => {
      if (!state.open) return;
      state.open = false;
      for (const view of state.views.splice(0)) {
        entries.get(view)?.call?.close();
        entries.delete(view);
      }
      const failures: unknown[] = [];
      const attempt = (step: () => void) => {
        try {
          step();
        } catch (failure) {
          failures.push(failure);
        }
      };
      attempt(() => state.controller.abort(new Error("The request ended.")));
      for (const finalizer of state.finalizers.splice(0).reverse()) attempt(finalizer);
      if (failures.length > 0) {
        throw new AggregateError(failures, `Closing the request: ${failures.length} cleanup step(s) failed.`);
      }
    },
  };
}

// --- The strangler bridge ---------------------------------------------------------------

/**
 * Read a context's call state once, at the edge. Kit code below this line
 * never sees the context object. The classification is the one invocation
 * served (A.2's `callClassification`); `fallback` is the tool's own verdict,
 * for a context no invocation dispatched (a probe). The ledger is the core's,
 * on the context `api()` hands its handler. B.1 replaces both readers with
 * the services invocation provides.
 */
export function fromConnectorContext(ctx: ConnectorContext, fallback: "read" | "write"): CallLease {
  trackCredentialReads(ctx);
  const credential = ctx.credential;
  const request = ctx.requestScope ? openRequest(ctx.requestScope) : undefined;
  const lease = openCall({
    caller: callerOf(ctx),
    classification: callClassification(ctx) ?? fallback,
    credentials: async () => (credential ? await credential.getAll() : null),
    charge: () => chargeConnectorCall(ctx),
    record: (facts) => recordRecovery(ctx, facts),
    secrets: sentSecretsFor(ctx),
    requestSecrets: requestSentSecrets(ctx),
    signal: request ? (ctx.signal ? AbortSignal.any([ctx.signal, request.signal]) : request.signal) : ctx.signal,
    ledger: {
      open: ({ auxiliary, provider, method, key }) =>
        providerRequest(ctx, auxiliary, provider, { method, ...(key === undefined ? {} : { key }) }),
      dispatch: (entry) => dispatchProviderRequest(ctx, entry),
    },
  });
  request?.own(lease.close);
  return lease;
}
