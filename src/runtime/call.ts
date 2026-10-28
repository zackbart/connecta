// Operation and call services. Only the Promise view bridge is keyed on a
// context object; authority lives in Context values, shared by derived views.
import { Context, Effect } from "effect";
import type { ConnectorCaller } from "../connector-caller.js";
import { ConnectorCallError } from "../errors.js";
import {
  dispatchProviderRequest,
  type ProviderRequest,
  type ProviderCall,
  type LogicalCall,
} from "../provider-call.js";
import { SentSecrets, sentSecretsForRequest, registerCredentialValues } from "../sent-secrets.js";
import type { ConnectorContext, ConnectorCredentialValues, KVStorage } from "../types.js";
import { recordRecovery } from "../call-recovery.js";
import { fromSignal, runEdge } from "./run.js";
import { RequestScope, requestOwner as requestOf } from "./request-scope.js";

/** Who admitted the operation; absent for a probe or a callback no request admitted. */
export class Caller extends Context.Service<Caller, ConnectorCaller | undefined>()("connecta/call/Caller") {}

/** The deployment's root store, used only for its durable continuation-signing key. */
export const ContinuationStorage = Context.Reference<KVStorage | undefined>("connecta/call/ContinuationStorage", {
  defaultValue: () => undefined,
});

/** Admitted connection and credential owner or per-call identity; never derived from tool arguments. */
export const ContinuationBinding = Context.Reference<{
  readonly connection: string;
  readonly principal: string | null;
}>("connecta/call/ContinuationBinding", { defaultValue: () => ({ connection: "", principal: null }) });

/** The credentials this call may send, already registered as sent secrets when read. */
export class Credentials extends Context.Service<
  Credentials,
  { readonly values: Effect.Effect<ConnectorCredentialValues | null, ConnectorCallError> }
>()("connecta/call/Credentials") {}

/** Native operation credential access; custom contexts retain their Promise leaf. */
export const OperationCredentials = Context.Reference<
  Effect.Effect<ConnectorCredentialValues | null, unknown> | undefined
>("connecta/operation/Credentials", { defaultValue: () => undefined });

/** The call's sent-secret set; every credential header and query value is registered here. */
export class Secrets extends Context.Service<Secrets, SentSecrets>()("connecta/call/Secrets") {}

/**
 * Everything the request sent, every connector's credentials included: the
 * set that redacts downstream text whole before anything cuts, trims, or
 * extracts from it (#911's `redactBeforeCut`).
 */
export class RequestSecrets extends Context.Service<RequestSecrets, SentSecrets>()("connecta/call/RequestSecrets") {}

/**
 * The enclosing invocation's admission permit, as the one thing a provider
 * may do with it: charge an auxiliary request to the same budget.
 */
export class Budget extends Context.Service<Budget, { readonly charge: Effect.Effect<void, unknown> }>()(
  "connecta/call/Budget",
) {}

/** Facts that let an agent reconcile a write whose outcome is unknown. */
export class Recovery extends Context.Service<
  Recovery,
  {
    readonly record: (facts: Readonly<Record<string, string>>) => Effect.Effect<void>;
    readonly recordNow?: (facts: Readonly<Record<string, string>>) => void;
  }
>()("connecta/call/Recovery") {}

/** The call's cancellation, handed to `fetch` as guarded-fetch handed `ctx.signal`. */
class SourceSignal extends Context.Service<
  SourceSignal,
  {
    readonly signal: AbortSignal | undefined;
    readonly requestSignal: AbortSignal | undefined;
  }
>()("connecta/call/SourceSignal") {}
export class Signal extends Context.Service<Signal, AbortSignal | undefined>()("connecta/call/Signal") {}

/**
 * The call's served classification: deployment config's verdict when it
 * gives one, else the tool's. The OAuth middleware and the write-outcome rule
 * read it; neither the builder nor the HTTP method decides.
 */
export class ServedClassification extends Context.Service<ServedClassification, "read" | "write" | undefined>()(
  "connecta/call/ServedClassification",
) {}
export class Classification extends Context.Service<Classification, "read" | "write">()(
  "connecta/call/Classification",
) {}

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
    readonly dispatch: (request: ProviderRequest, headers?: HeadersInit, method?: string) => void;
  }
>()("connecta/call/Ledger") {}

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
  dispatch: (request, headers, method) => dispatchProviderRequest(undefined, request, headers, method),
};

export class ProviderLedger extends Context.Service<ProviderLedger, ProviderCall | undefined>()(
  "connecta/call/ProviderLedger",
) {}
export class LogicalLedger extends Context.Service<LogicalLedger, LogicalCall | undefined>()(
  "connecta/call/LogicalLedger",
) {}
class CallMemo extends Context.Service<CallMemo, Map<object, unknown>>()("connecta/call/Memo") {}
/** Construction-owned keys keep provider memoization on the call, including derived views. */
export function callMemo<A>(view: ConnectorContext, key: object, create: () => A): A {
  if (viewClosed(view)) throw ended();
  let memo = serviceFor(view, CallMemo);
  if (!memo) {
    memo = new Map();
    setViewService(view, CallMemo, memo);
  }
  if (!memo.has(key)) memo.set(key, create());
  return memo.get(key) as A;
}
type OperationServices = Caller | Secrets | RequestSecrets | RequestScope;
export class Operation extends Context.Service<Operation, ConnectorContext | undefined>()("connecta/call/Operation") {}
export class ActiveCall extends Context.Service<ActiveCall, CallLease>()("connecta/call/ActiveCall") {}
export type CallServices = OperationServices | Credentials | Budget | Recovery | Signal | Classification | Ledger;
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
  readonly served?: "read" | "write" | undefined;
  readonly credentials: (signal: AbortSignal) => Promise<ConnectorCredentialValues | null>;
  readonly charge: (signal: AbortSignal) => Promise<void>;
  readonly chargeEffect?: ((signal: AbortSignal) => Effect.Effect<void, unknown>) | undefined;
  readonly credentialsEffect?: Effect.Effect<ConnectorCredentialValues | null, unknown> | undefined;
  readonly chargeClosed?: () => unknown;
  readonly record: (facts: Readonly<Record<string, string>>) => void;
  readonly secrets: SentSecrets;
  /** The request's whole set; defaults to `secrets`. */
  readonly requestSecrets?: SentSecrets;
  readonly signal: AbortSignal | undefined;
  readonly requestSignal?: AbortSignal;
  /** Original request cancellation, distinct from an invocation deadline's cleanup. */
  readonly requestSourceSignal?: AbortSignal | undefined;
  /** The core ledger the boundary reads; a detached one when no context is behind the call. */
  readonly ledger?: Context.Service.Shape<typeof Ledger>;
  readonly parent?: CallLease;
  readonly operation?: ConnectorContext;
  readonly providerLedger?: ProviderCall;
}

/** Build one call's services. Invocation calls this in the scoped attempt that owns the permit (B.1). */
function openCall(inputs: CallInputs): CallLease {
  let open = true;
  const parentSignal = inputs.parent ? Context.get(inputs.parent.services, Signal) : undefined;
  const parents = [inputs.signal, parentSignal, inputs.requestSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const controller = new AbortController();
  const detachParents: Array<() => void> = [];
  const failures: unknown[] = [];
  const attempt = (step: () => void) => {
    try {
      step();
    } catch (failure) {
      failures.push(failure);
    }
  };
  // Revocation never throws, including when reached by a parent's abort
  // listener. Report detach failures at the next explicit close, once every
  // capability and listener is revoked. Abort before touching any facade.
  const revoke = (reason: unknown) => {
    if (!open) return;
    open = false;
    attempt(() => controller.abort(reason));
    for (const detach of detachParents.splice(0)) attempt(detach);
  };
  // Forward structurally rather than passing a caller's signal to a native
  // brand check: adapters can supply a signal facade owned by their request.
  for (const signal of parents) {
    if (!open) break;
    const abort = () => revoke(signal.reason);
    if (signal.aborted) abort();
    else {
      detachParents.push(() => signal.removeEventListener("abort", abort));
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  // Closure settles the Effect immediately and interrupts its Promise bridge.
  // Inputs receive that cancellation too, so their owned I/O can be aborted.
  const live = <A, E>(
    work: (signal: AbortSignal) => Effect.Effect<A, E>,
    fail: (error: unknown) => unknown,
    closed: () => unknown = ended,
  ) =>
    Effect.suspend(() =>
      open && !controller.signal.aborted
        ? Effect.raceFirst(
            Effect.suspend(() => work(controller.signal)).pipe(
              Effect.mapError(fail),
              Effect.catchDefect((error) => Effect.fail(fail(error))),
            ),
            fromSignal(controller.signal).pipe(Effect.mapError(closed)),
          ).pipe(
            Effect.flatMap((value) =>
              open && !controller.signal.aborted ? Effect.succeed(value) : Effect.fail(closed()),
            ),
          )
        : Effect.fail(closed()),
    );
  const owner = requestOf(
    inputs.operation
      ? (views.get(inputs.operation)?.request ?? inputs.operation.requestScope ?? inputs.operation)
      : inputs,
  );
  sentSecretsForRequest(owner.identity, inputs.requestSecrets ?? inputs.secrets);
  const services = Context.make(RequestScope, owner).pipe(
    Context.add(Caller, inputs.caller),
    Context.add(Credentials, {
      values: live(
        (signal) =>
          (
            inputs.credentialsEffect ??
            Effect.tryPromise({
              try: (interrupted) => inputs.credentials(AbortSignal.any([signal, interrupted])),
              catch: (error) => error,
            })
          ).pipe(Effect.tap((values) => Effect.sync(() => registerCredentialValues(inputs.secrets, values)))),
        (error) =>
          open
            ? error instanceof ConnectorCallError
              ? error
              : new ConnectorCallError("auth_required", "The connector's stored credential could not be read.", {
                  retryable: false,
                })
            : ended(),
      ) as Effect.Effect<ConnectorCredentialValues | null, ConnectorCallError>,
    }),
    Context.add(Secrets, inputs.secrets),
    Context.add(RequestSecrets, inputs.requestSecrets ?? inputs.secrets),
    Context.add(Budget, {
      charge: live(
        (signal) =>
          inputs.chargeEffect?.(signal) ??
          Effect.tryPromise({
            try: (interrupted) => inputs.charge(AbortSignal.any([signal, interrupted])),
            catch: (error) => error,
          }),
        (error) => error,
        inputs.chargeClosed,
      ),
    }),
    Context.add(Recovery, {
      // Late facts are dropped: invocation has already read the record.
      record: (facts) => Effect.sync(() => (open && !controller.signal.aborted ? inputs.record(facts) : undefined)),
      recordNow: (facts) => {
        if (open && !controller.signal.aborted) inputs.record(facts);
      },
    }),
    Context.add(Signal, controller.signal),
    Context.add(SourceSignal, {
      signal: inputs.operation ? callerSignal(inputs.operation) : inputs.signal,
      requestSignal: Object.hasOwn(inputs, "requestSourceSignal")
        ? inputs.requestSourceSignal
        : inputs.operation
          ? requestCallerSignal(inputs.operation)
          : inputs.signal,
    }),
    Context.add(Classification, inputs.classification),
    Context.add(ServedClassification, inputs.served),
    Context.add(Ledger, {
      open: (facts) => {
        if (!open || controller.signal.aborted) throw ended();
        return (inputs.ledger ?? detachedLedger).open(facts);
      },
      dispatch: (request, headers, method) => {
        if (!open || controller.signal.aborted) throw ended();
        (inputs.ledger ?? detachedLedger).dispatch(request, headers, method);
      },
    }),
    Context.add(CallMemo, new Map()),
    Context.add(ProviderLedger, inputs.providerLedger),
    Context.add(LogicalLedger, inputs.operation ? serviceFor(inputs.operation, LogicalLedger) : undefined),
  );
  const lease: CallLease = {
    get services() {
      return Context.add(Context.add(services, ActiveCall, lease), Operation, inputs.operation);
    },
    closed: () => !open || controller.signal.aborted,
    close: () => {
      revoke(ended());
      if (failures.length) throw new AggregateError(failures.splice(0), "Closing the call: signal cleanup failed.");
    },
  };
  return lease;
}

interface Entry {
  services: Context.Context<any>;
  request: object;
  readonly base: ConnectorContext;
  call?: CallLease;
  credentialWrapped?: boolean;
  scopeBound?: boolean;
}
const views = new WeakMap<object, Entry>();
function entryOf(view: object): Entry | undefined {
  const entry = views.get(view);
  return entry && requestOf(entry.request).open ? entry : undefined;
}
export function serviceFor<I, S>(view: object, key: Context.Key<I, S>): S | undefined {
  const entry = entryOf(view);
  return entry ? Context.getOrUndefined(entry.services, key) : undefined;
}
/** Settlement retains facts after revocation; it never acquires a live capability. */
export function recordedService<I, S>(view: object, key: Context.Key<I, S>): S | undefined {
  const entry = views.get(view);
  return entry ? Context.getOrUndefined(entry.services, key) : undefined;
}
export function viewClosed(view: ConnectorContext): boolean {
  const entry = views.get(view);
  return entry !== undefined && (!requestOf(entry.request).open || entry.call?.closed() === true);
}
/** Request revocation is independent of call authority, including on an unregistered copy. */
export function requestClosed(view: ConnectorContext): boolean {
  const scope = views.get(view)?.request ?? view.requestScope ?? view;
  return !requestOf(scope).open;
}
export function setViewService<I, S>(view: ConnectorContext, key: Context.Key<I, S>, value: S): void {
  const entry = ensureOperation(view);
  if (requestOf(entry.request).open) entry.services = Context.add(entry.services, key, value);
}
function ensureOperation(base: ConnectorContext, explicitOperation = false): Entry {
  const existing = views.get(base);
  if (existing) {
    // Custom contexts can acquire an explicit requestScope after their caller
    // was attached. Bind that initial scope before deriving any call view;
    // call views and contexts already bound to an explicit scope never move.
    if (
      !existing.call &&
      !existing.scopeBound &&
      existing.request === base &&
      requestOf(existing.request).open &&
      base.requestScope &&
      base.requestScope !== base
    ) {
      requestOf(existing.request).entries.delete(existing);
      existing.request = base.requestScope;
      const all = sentSecretsForRequest(existing.request);
      all.include(Context.get(existing.services, Secrets));
      existing.services = Context.add(
        Context.add(existing.services, RequestSecrets, all),
        RequestScope,
        requestOf(existing.request),
      );
      requestOf(existing.request).entries.add(existing);
    }
    return existing;
  }
  // A copied view has no authority. Request membership is evidence only that
  // authority is required, never a way to recover the original call's state.
  // Registry operations and anonymous probes are constructed explicitly.
  if (!explicitOperation && callScopeKnown(base)) throw ended();
  const request = base.requestScope ?? base;
  const secrets = new SentSecrets();
  const all = sentSecretsForRequest(request);
  all.include(secrets);
  const entry: Entry = {
    services: Context.make(Caller, undefined).pipe(
      Context.add(Secrets, secrets),
      Context.add(RequestSecrets, all),
      Context.add(RequestScope, requestOf(request)),
    ),
    request,
    base,
  };
  views.set(base, entry);
  requestOf(request).entries.add(entry);
  return entry;
}
export function operationView(base: ConnectorContext, caller: ConnectorCaller | undefined): ConnectorContext {
  const view = { ...base, requestScope: base.requestScope ?? {} };
  const entry = ensureOperation(view, true);
  if (requestOf(entry.request).open) entry.services = Context.add(entry.services, Caller, caller);
  return view;
}
export function deriveView<T extends ConnectorContext = ConnectorContext>(
  view: ConnectorContext,
  overrides: Partial<T>,
): T {
  const entry = ensureOperation(view);
  entry.scopeBound = true;
  const derived = { ...view, ...overrides, requestScope: entry.request } as T;
  views.set(derived, entry);
  return derived;
}
export function viewLease(view: ConnectorContext): CallLease | undefined {
  return views.get(view)?.call;
}
export function viewServices(view: ConnectorContext): Context.Context<CallServices | ActiveCall | Operation> {
  return ensureOperation(view).services;
}
export function contextView(lease: CallLease, operation: ConnectorContext): ConnectorContext {
  const origin = ensureOperation(operation);
  origin.scopeBound = true;
  const values = Context.get(lease.services, Credentials).values;
  const signal = Context.get(lease.services, Signal);
  const view: ConnectorContext = {
    ...operation,
    requestScope: origin.request,
    ...(signal ? { signal } : {}),
    ...(operation.credential
      ? {
          credential: {
            getAll: () => settleOnClose(view, () => runEdge(values)),
            get: (field = "value") =>
              settleOnClose(view, async () => {
                const all = await runEdge(values);
                return all && Object.hasOwn(all, field) ? all[field]! : null;
              }),
          },
        }
      : {}),
  };
  const entry: Entry = {
    services: Context.add(Context.merge(origin.services, lease.services), Caller, serviceFor(operation, Caller)),
    request: origin.request,
    base: origin.base,
    call: lease,
    credentialWrapped: true,
  };
  views.set(view, entry);
  const request = requestOf(origin.request);
  request.entries.add(entry);
  request.calls.add(lease);
  if (!request.open) lease.close();
  return view;
}
export function chargeView(view: ConnectorContext): Promise<void> {
  const budget = recordedService(view, Budget);
  return budget ? runEdge(budget.charge) : Promise.reject(ended());
}
/** Admission is sticky until request close; ending a call never makes its copies standalone. */
export function callScopeKnown(view: ConnectorContext): boolean {
  const scope = requestOf(views.get(view)?.request ?? view.requestScope ?? view);
  return scope !== undefined && (!scope.open || scope.admitted);
}
export function viewSecrets(view: ConnectorContext): SentSecrets {
  const entry = ensureOperation(view);
  return Context.get(entry.services, Secrets);
}
/** Register operation credentials once; call credentials are supplied by the lease. */
export function wrapViewCredentials(view: ConnectorContext): void {
  const entry = ensureOperation(view);
  if (!view.credential || entry.credentialWrapped) return;
  entry.credentialWrapped = true;
  const access = view.credential;
  view.credential = {
    get: (field) =>
      settleOnClose(
        view,
        async () => {
          const value = await access.get(field);
          registerCredentialValues(viewSecrets(view), value === null ? null : { [field ?? "value"]: value });
          return value;
        },
        true,
      ),
    getAll: () =>
      settleOnClose(
        view,
        async () => {
          const values = await access.getAll();
          registerCredentialValues(viewSecrets(view), values);
          return values;
        },
        true,
      ),
  };
}
/** Credentials for request-owned transports use the operation, never a closed call. */
export function operationContext(view: ConnectorContext): ConnectorContext {
  return views.get(view)?.base ?? view;
}
export function openRequest(scope: object): {
  readonly signal: AbortSignal;
  readonly own: (finalizer: () => void) => void;
  readonly close: () => void;
} {
  const state = requestOf(scope);
  return { signal: state.controller.signal, own: (finalizer) => state.own(finalizer), close: () => state.close() };
}
/** Open a child lease from operation services, never read security side tables. */
export function callFromContext(
  ctx: ConnectorContext,
  classification: "read" | "write",
  overrides: Partial<CallInputs> & { readonly admitted?: true; readonly anonymous?: true } = {},
): CallLease {
  const { admitted, anonymous, ...callOverrides } = overrides;
  const entry = ensureOperation(ctx);
  const scope = requestOf(entry.request);
  // Direct api() calls on an unadmitted scope and explicit anonymous probes
  // have no served invocation to charge. Once a permit has existed, however,
  // no missing Budget may become a standalone call, even if an anonymous
  // entry was registered before admission or the admitted call already ended.
  if (scope.admitted && !recordedService(ctx, Budget) && !admitted && !anonymous) throw ended();
  if (admitted) scope.admitted = true;
  if (Object.hasOwn(callOverrides, "requestSourceSignal")) {
    // The operation's credentials also serve request-owned transports. Keep
    // their request source separate from the attempt's expiring deadline.
    entry.services = Context.add(entry.services, SourceSignal, {
      signal: callerSignal(ctx),
      requestSignal: callOverrides.requestSourceSignal,
    });
  }
  const request = openRequest(entry.request);
  const credential = ctx.credential;
  const secrets = new SentSecrets();
  secrets.include(Context.get(entry.services, Secrets));
  Context.get(entry.services, RequestSecrets).include(secrets);
  const lease = openCall({
    caller: serviceFor(ctx, Caller),
    classification,
    served: serviceFor(ctx, ServedClassification),
    credentials: async () => (credential ? credential.getAll() : null),
    credentialsEffect: Object.hasOwn(callOverrides, "credentials")
      ? undefined
      : entry.call
        ? recordedService(ctx, Credentials)?.values
        : serviceFor(ctx, OperationCredentials),
    charge: () => (serviceFor(ctx, Budget) ? chargeView(ctx) : Promise.resolve()),
    chargeEffect: Object.hasOwn(callOverrides, "charge")
      ? undefined
      : () => serviceFor(ctx, Budget)?.charge ?? Effect.void,
    record: (facts) => recordRecovery(ctx, facts),
    secrets,
    requestSecrets: serviceFor(ctx, RequestSecrets)!,
    signal: ctx.signal,
    requestSignal: request.signal,
    ...(entry.call ? { parent: entry.call } : {}),
    operation: ctx,
    ...callOverrides,
  });
  requestOf(entry.request).calls.add(lease);
  if (!requestOf(entry.request).open) lease.close();
  return lease;
}

// An owner can revoke a wait without granting access to any context service.
type CloseOwner = {
  readonly requestScope?: object | undefined;
  readonly signal?: AbortSignal | undefined;
};

/** Cancellation is request-owned for operations and auxiliaries, call-owned otherwise. */
export function viewSignal(ctx: CloseOwner, requestOwned = false): AbortSignal {
  const state = requestOf(views.get(ctx)?.request ?? ctx.requestScope ?? ctx);
  const request = state.controller.signal;
  // The original caller signal is distinct from the revocable call signal:
  // ending a call must not stop its request's session or auxiliary work.
  const source = requestOwned ? requestCallerSignal(ctx) : ctx.signal;
  const leaseSignal = requestOwned ? undefined : recordedService(ctx, Signal);
  // A derived transport signal can add cancellation, never replace the lease
  // that owns this wait. Both inputs here are native, even for source facades.
  const owned = (signal: AbortSignal) =>
    leaseSignal && leaseSignal !== source ? AbortSignal.any([signal, leaseSignal]) : signal;
  if (!source || source === request) return owned(request);
  let binding = state.signals.get(source);
  if (!binding) {
    const controller = new AbortController();
    const failures: unknown[] = [];
    let attached = false;
    const detach = () => {
      if (!attached) return;
      attached = false;
      for (const remove of [
        () => source.removeEventListener("abort", fromSource),
        () => request.removeEventListener("abort", fromRequest),
      ]) {
        try {
          remove();
        } catch (error) {
          failures.push(error);
        }
      }
    };
    const revoke = (reason: unknown) => {
      controller.abort(reason);
      detach();
    };
    const fromSource = () => revoke(source.reason);
    const fromRequest = () => revoke(request.reason);
    // Read structurally, as openCall does: a request-owned facade need not
    // pass AbortSignal.any's native brand check. Never share it across scopes.
    const refresh = () => {
      if (controller.signal.aborted) return;
      if (request.aborted) fromRequest();
      else if (source.aborted) fromSource();
    };
    refresh();
    if (!controller.signal.aborted) {
      attached = true;
      source.addEventListener("abort", fromSource, { once: true });
      if (!controller.signal.aborted) request.addEventListener("abort", fromRequest, { once: true });
      state.finalizers.push(() => {
        detach();
        if (failures.length) throw new AggregateError(failures.splice(0), "Closing the operation signal failed.");
      });
    }
    binding = { signal: controller.signal, refresh };
    state.signals.set(source, binding);
  }
  // Some adapters expose cancellation through a live getter without an abort
  // event. Poll it at each boundary, including after an awaited operation.
  binding.refresh();
  return owned(binding.signal);
}

/** Compose native work under the same revocation guards as the Promise view. */
export function duringViewEffect<A, E, R>(
  ctx: CloseOwner,
  work: (signal: AbortSignal) => Effect.Effect<A, E, R>,
  requestOwned = false,
): Effect.Effect<A, E | unknown, R> {
  return Effect.suspend(() => {
    const lease = views.get(ctx)?.call;
    if (!requestOwned && lease?.closed()) return Effect.fail(Context.get(lease.services, Signal)?.reason ?? ended());
    const signal = viewSignal(ctx, requestOwned);
    if (signal.aborted) return Effect.fail(signal.reason);
    return Effect.raceFirst(
      Effect.suspend(() => work(signal)),
      fromSignal(signal),
    ).pipe(
      Effect.flatMap((value) => {
        const current = viewSignal(ctx, requestOwned);
        return current.aborted ? Effect.fail(current.reason) : Effect.succeed(value);
      }),
    );
  });
}

/**
 * Settle an entire Promise boundary when its owner closes, regardless of the
 * internal seam currently awaiting. Interruption observes late rejections;
 * detached work still has to pass the transport and lease guards before any
 * dispatch or call-owned commit. Refresh coordinator ownership is independent
 * of this caller's wait once its claim has been submitted.
 */
export async function settleOnClose<A>(
  ctx: CloseOwner,
  work: (signal: AbortSignal) => Promise<A>,
  requestOwned = false,
): Promise<A> {
  const lease = views.get(ctx)?.call;
  if (!requestOwned && lease?.closed()) throw Context.get(lease.services, Signal)?.reason ?? ended();
  const signal = viewSignal(ctx, requestOwned);
  if (signal.aborted) throw signal.reason;
  // Enter synchronously after the guard, as the original Promise method did:
  // shared-session waiter accounting and claim ownership precede cancellation.
  const pending = work(signal);
  void pending.catch(() => {});
  const value = await runEdge(Effect.tryPromise({ try: () => pending, catch: (error) => error }), { signal });
  const current = viewSignal(ctx, requestOwned);
  if (current.aborted) throw current.reason;
  return value;
}

/** Also pass the resolved owner to I/O that can release resources on abort. */
export function duringViewCall<A>(
  ctx: ConnectorContext,
  work: (signal: AbortSignal) => Promise<A>,
  requestOwned = false,
): Promise<A> {
  return settleOnClose(ctx, work, requestOwned);
}

export function callerSignal(view: CloseOwner): AbortSignal | undefined {
  const source = recordedService(view, SourceSignal);
  return source ? source.signal : view.signal;
}

function requestCallerSignal(view: CloseOwner): AbortSignal | undefined {
  const source = recordedService(view, SourceSignal);
  return source ? source.requestSignal : view.signal;
}
