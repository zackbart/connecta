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
import { recordRecovery } from "../call-recovery.js";
import { callerOf, type ConnectorCaller } from "../connector-caller.js";
import { ConnectorCallError } from "../errors.js";
import { runEdge } from "../runtime/run.js";
import { sentSecretsFor, trackCredentialReads, type SentSecrets } from "../sent-secrets.js";
import type { ConnectorContext, ConnectorCredentialValues } from "../types.js";
import type { OperationRef } from "./errors.js";

/** Who admitted the operation; absent for a probe or a callback no request admitted. */
export class Caller extends Context.Service<Caller, ConnectorCaller | undefined>()("connecta/http/Caller") {}

/** The credentials this call may send, already registered as sent secrets when read. */
export class Credentials extends Context.Service<
  Credentials,
  { readonly values: Effect.Effect<ConnectorCredentialValues | null, ConnectorCallError> }
>()("connecta/http/Credentials") {}

/** The request's sent-secret set; every credential header and query value is registered here. */
export class Secrets extends Context.Service<Secrets, SentSecrets>()("connecta/http/Secrets") {}

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

/** How one resource request of this call ended, recorded as it happened. */
export interface Dispatch {
  /** It counts as the call's write: every request of a write call except one sent with `{ effect: "read" }`. */
  readonly write: boolean;
  readonly operation?: OperationRef;
  /** `unconnected` only when `fetch` rejected with an errno proving no connection; `lost` for any other rejection. */
  state: "pending" | "unconnected" | "lost" | "answered";
  status?: number;
  headers?: Headers;
}

/** Every resource request this call handed to `fetch`, in order. The write-outcome rule (B.3) reads it. */
export class Dispatches extends Context.Service<Dispatches, Dispatch[]>()("connecta/http/Dispatches") {}

/**
 * What one request inside a call is: the call's own effect, or an auxiliary
 * read inside a write tool. Set by `Send`, read by the transport and the
 * OAuth middleware.
 */
export const RequestFacts = Context.Reference<{ readonly effect: "call" | "read"; readonly operation?: OperationRef }>(
  "connecta/http/RequestFacts",
  { defaultValue: () => ({ effect: "call" }) },
);

type OperationServices = Caller;
export type CallServices =
  | OperationServices
  | Credentials
  | Secrets
  | Budget
  | Recovery
  | Signal
  | Classification
  | Dispatches;

function ended(): ConnectorCallError {
  return new ConnectorCallError(
    "connector_call_failed",
    "This call has ended; a capability kept from it can no longer be used.",
    { retryable: false },
  );
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
  readonly credentials: () => Promise<ConnectorCredentialValues | null>;
  readonly charge: () => Promise<void>;
  readonly record: (facts: Readonly<Record<string, string>>) => void;
  readonly secrets: SentSecrets;
  readonly signal: AbortSignal | undefined;
}

/** Build one call's services. Invocation calls this in the scoped attempt that owns the permit (B.1). */
export function openCall(inputs: CallInputs): CallLease {
  let open = true;
  // Checked before the work starts and again when it settles: a read that
  // was pending when the call closed does not deliver for it.
  const live = <A>(work: () => Promise<A>, fail: (error: unknown) => ConnectorCallError | unknown) =>
    Effect.suspend(() =>
      open
        ? Effect.tryPromise({ try: work, catch: fail }).pipe(
            Effect.flatMap((value) => (open ? Effect.succeed(value) : Effect.fail(ended()))),
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
    Context.add(Budget, { charge: live(inputs.charge, (error) => error) }),
    Context.add(Recovery, {
      // Late facts are dropped: invocation has already read the record.
      record: (facts) => Effect.sync(() => (open ? inputs.record(facts) : undefined)),
    }),
    Context.add(Signal, inputs.signal),
    Context.add(Classification, inputs.classification),
    Context.add(Dispatches, []),
  );
  return {
    services,
    closed: () => !open,
    close: () => {
      open = false;
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
  entries.set(view, { caller, request: view.requestScope });
  requestOf(view.requestScope).views.push(view);
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
  if (entry) {
    entries.set(view, { ...entry, call: lease });
    requestOf(entry.request).views.push(view);
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
      state.controller.abort(new Error("The request ended."));
      for (const finalizer of state.finalizers.splice(0).reverse()) finalizer();
      // Its views stop resolving: a kept operation view reads no caller.
      for (const view of state.views.splice(0)) entries.delete(view);
    },
  };
}

// --- The strangler bridge ---------------------------------------------------------------

const served = new WeakMap<object, "read" | "write">();

/**
 * A.2's `attachCallClassification` (#902), which invocation sets from the
 * served definition. The prototype carries this copy until #902 merges; B.1
 * replaces both with the Classification service.
 */
export function attachServedClassification(ctx: ConnectorContext, classification: "read" | "write"): void {
  served.set(ctx, classification);
}

/**
 * Read a context's call state once, at the edge. Kit code below this line
 * never sees the context object. `fallback` is the tool's own verdict, for a
 * context no invocation dispatched (a probe).
 */
export function fromConnectorContext(ctx: ConnectorContext, fallback: "read" | "write"): CallLease {
  trackCredentialReads(ctx);
  const credential = ctx.credential;
  return openCall({
    caller: callerOf(ctx),
    classification: served.get(ctx) ?? fallback,
    credentials: async () => (credential ? await credential.getAll() : null),
    charge: () => chargeConnectorCall(ctx),
    record: (facts) => recordRecovery(ctx, facts),
    secrets: sentSecretsFor(ctx),
    signal: ctx.signal,
  });
}
