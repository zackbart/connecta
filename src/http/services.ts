// Internal prototype for decision 0010 (B.1). Nothing under src/http/ is
// reachable from src/index.ts, and no live provider imports it yet.
//
// One downstream call's state, as Context services instead of side tables
// keyed on the ConnectorContext object. A service is provided to the call's
// fiber and ends with it, so a copy of a context can no longer drop the
// caller, the permit, or the recovery facts (the `{...ctx}` defect), and
// nothing here can outlive the request that admitted the call (INV-7).
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
import { sentSecretsFor, trackCredentialReads, type SentSecrets } from "../sent-secrets.js";
import type { ConnectorContext, ConnectorCredentialValues } from "../types.js";

/** Who admitted the call; absent for a probe no request admitted. */
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
 * The tool's declared classification. The OAuth middleware reads it to decide
 * whether a 401 may be replayed (INV-9); the HTTP method never decides.
 */
export class Classification extends Context.Service<Classification, "read" | "write">()(
  "connecta/http/Classification",
) {}

/**
 * How many requests this call has handed to `fetch`. The write-outcome rule
 * reads it (src/http/errors.ts): a failure before the first dispatch proves
 * nothing was sent, whatever its code.
 */
export class Dispatches extends Context.Service<Dispatches, { count: number }>()("connecta/http/Dispatches") {}

export type CallServices = Caller | Credentials | Secrets | Budget | Recovery | Signal | Classification | Dispatches;

/**
 * The strangler bridge: read a context's call state once, at the edge. Kit
 * code below this line never sees the context object.
 */
export function fromConnectorContext(
  ctx: ConnectorContext,
  classification: "read" | "write",
): Context.Context<CallServices> {
  trackCredentialReads(ctx);
  const credential = ctx.credential;
  return Context.make(Caller, callerOf(ctx)).pipe(
    Context.add(Credentials, {
      values: Effect.tryPromise({
        try: async () => (credential ? await credential.getAll() : null),
        catch: () =>
          new ConnectorCallError("auth_required", "The connector's stored credential could not be read.", {
            retryable: false,
          }),
      }),
    }),
    Context.add(Secrets, sentSecretsFor(ctx)),
    Context.add(Budget, {
      charge: Effect.tryPromise({ try: () => chargeConnectorCall(ctx), catch: (error) => error }),
    }),
    Context.add(Recovery, { record: (facts) => Effect.sync(() => recordRecovery(ctx, facts)) }),
    Context.add(Signal, ctx.signal),
    Context.add(Classification, classification),
    Context.add(Dispatches, { count: 0 }),
  );
}
