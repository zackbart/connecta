// Refresh-once middleware. Unreachable from src/index.ts.
//
// Refresh-once for a connection that authenticates with a token it can
// renew: a downstream OAuth grant, a service-account assertion, a machine
// login. A 401 earns one renewal. A read is then replayed once; a second 401
// is the grant's own refusal. A write is never sent again (INV-9): the
// renewal still runs, so the next deliberate call has a fresh token, and this
// call answers with the write's own 401.
//
// This file decides nothing about that write. The transport recorded its
// answer in the call's dispatch ledger when the resource server gave it, and
// api()'s boundary delegates the verdict to the core's settleWrite. The
// middleware records facts only, including a successful renewal. By default a failed
// renewal is discarded; the static bridge can opt into the core's grant diagnostic.
// Neither path can turn the write into a known refusal or advertise a retry; the
// ledger notes only a renewal that succeeded, so the agent is not sent to
// re-authorize a credential that already works. Even a wrapper here that
// did resend would be stopped by the transport's one-dispatch guard.
//
// The core's positive-read classifier is authoritative: only a positively
// classified GET/HEAD is replayable. Overrides force a write, and a reviewed
// POST or an auxiliary label cannot bypass the physical-write reservation.
//
// The grant itself (storage, coordination across isolates, the token
// request, the request-scope latch) stays in src/auth/.

import { Routes } from "../agent-routes.js";
import type { AgentRouteNames } from "../types.js";
import { Cause, Context, Effect, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readRequest, renewedAfterUnauthorized, type ProviderRequest } from "../provider-call.js";
import { renewableGrantFor } from "../auth/renewable-grant.js";
import type { ApiOAuthAccess } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import { responseRequest, type GuardedClient } from "./client.js";
import { Refusal, RequestRefused, type HttpFailure } from "./errors.js";
import { Dispatches, Signal, duringCall, type CallServices } from "./services.js";

/** The calling owner's renewable token, as the operations a transport needs from it. */
export class Grant extends Context.Service<
  Grant,
  {
    /** The current access token. */
    readonly token: Effect.Effect<string, HttpFailure>;
    /**
     * Renew because `stale` was refused: the token another call already
     * rotated in, else one coordinated refresh.
     */
    // Interruptible call use; after claim submission the storage coordinator commits
    // rotation under its own deadline, without returning it to a closed call.
    readonly refresh: (stale: string) => Effect.Effect<string, HttpFailure>;
    /** The renewed token was refused too: latch the request scope and fail with the grant's own verdict. */
    readonly rejected: Effect.Effect<never, HttpFailure>;
    /**
     * Forget exactly this refused token without renewing, so the next call
     * obtains a fresh one. Only the opt-in renewal modes of
     * {@link refreshOnce} call it; a newer token stays.
     */
    readonly discard?: (rejected: string) => Effect.Effect<void>;
  }
>()("connecta/http/Grant") {}

/** Bridge a production static OAuth facade without adding anything to its public interface. */
export function grantFromOAuth(oauth: ApiOAuthAccess): Context.Service.Shape<typeof Grant> {
  const grant = renewableGrantFor(oauth);
  const use = <A>(work: () => Promise<A>): Effect.Effect<A, HttpFailure> =>
    Effect.tryPromise({
      try: work,
      catch: (error) =>
        new Refusal({
          error:
            error instanceof ConnectorCallError
              ? error
              : new ConnectorCallError("connector_call_failed", "The OAuth grant could not be used.", {
                  retryable: false,
                }),
        }),
    });
  const missing = () =>
    Promise.reject(new ConnectorCallError("connector_call_failed", "This OAuth facade has no renewable grant."));
  return {
    token: use(grant ? () => grant.token() : missing),
    refresh: (stale) => use(grant ? () => grant.refresh(stale) : missing),
    rejected: use(grant ? () => grant.rejected() : missing),
  };
}

/** Headers for `GuardedOptions.authenticate`: the grant's bearer token. */
export const bearer: Effect.Effect<Readonly<Record<string, string>>, HttpFailure, Grant> = Grant.use((grant) =>
  Effect.map(grant.token, (token) => ({ Authorization: `Bearer ${token}` })),
);

/** Renewal facts only: a mapper never receives either access token. */
type Write401Renewal =
  | { readonly _tag: "Renewed" }
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Failed"; readonly failure: unknown };

/**
 * Opt-in renewal modes for a grant whose provider answers its own 401s.
 * `replayRejection: "answer"` discards the token a replayed read was refused
 * with and hands that 401 to the vendor's status table, so its message comes
 * from the redacted body rather than `rejected`. `writeRenewal: "discard"`
 * discards a write's refused token without renewing: no token request is
 * sent, nothing is recorded as renewed, and the write's 401 is answered as
 * usual. Neither mode resends a write; settleWrite still decides it.
 */
export interface GrantRenewal {
  readonly replayRejection?: "answer";
  readonly writeRenewal?: "discard";
}

/** The bearer token a prepared request carried, as the grant issued it. */
function sentToken(request: HttpClientRequest.HttpClientRequest): string {
  return (request.headers["authorization"] ?? "").replace(/^Bearer /, "");
}

/** Wrap a guarded client whose `authenticate` is {@link bearer}. */
export function refreshOnce(
  guarded: GuardedClient<CallServices | Grant>,
  options?: GrantRenewal & {
    /** Words a write's unanswered 401 with the call's route names; it runs during the call. */
    readonly writeUnauthorized?: (renewal: Write401Renewal, routes: AgentRouteNames) => ConnectorCallError;
    readonly challengeMaxBytes?: number;
  },
): GuardedClient<CallServices | Grant> {
  if (options?.writeRenewal === "discard" && options.writeUnauthorized)
    throw new Error("A write that is not renewed has no renewal facts to map.");
  const inner = guarded.client;
  const challengeFailure = (entry: ProviderRequest | undefined): Effect.Effect<never, HttpFailure, CallServices> =>
    Effect.gen(function* () {
      const error = new ConnectorCallError(
        "connector_call_failed",
        "The OAuth challenge exceeded its response ceiling.",
        { retryable: false },
      );
      const refusal = new Refusal({
        error:
          !readRequest(entry ?? {}) && options?.writeUnauthorized
            ? options.writeUnauthorized({ _tag: "Failed", failure: error }, yield* Routes)
            : error,
      });
      const dispatch = entry ? (yield* Dispatches).find((item) => item.request === entry) : undefined;
      if (dispatch) dispatch.failure = refusal;
      return yield* Effect.fail(refusal);
    });
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const response = yield* inner.execute(request).pipe(
        Effect.catchTag("ResponseTooLarge", (failure): Effect.Effect<never, HttpFailure, CallServices> => {
          const entry = responseRequest(failure);
          return options?.challengeMaxBytes !== undefined && entry?.status === 401
            ? challengeFailure(entry)
            : Effect.fail(failure);
        }),
      );
      if (response.status !== 401) return response;
      // Read under the ceiling now, so nothing is left open while renewing.
      const reply = yield* guarded
        .read(response, options?.challengeMaxBytes)
        .pipe(
          Effect.catchTag("ResponseTooLarge", (failure): Effect.Effect<never, HttpFailure, CallServices> =>
            options?.challengeMaxBytes !== undefined
              ? challengeFailure(responseRequest(response))
              : Effect.fail(failure),
          ),
        );
      const grant = yield* Grant;
      const stale = sentToken(response.request);
      const entry = responseRequest(response);
      if (!readRequest(entry ?? {}) && options?.writeRenewal === "discard") {
        // No renewal: the next deliberate call obtains a fresh token. The
        // write's own 401 is answered; nothing is marked renewed (Q8).
        if (grant.discard) yield* grant.discard(stale);
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.text ?? "", { status: reply.status, headers: reply.headers }),
        );
      }
      if (!readRequest(entry ?? {})) {
        // Whatever renewal meets is the authorization server's, not the
        // write's. The ledger keeps only whether it succeeded, which decides
        // whether the agent still needs the handoff, never the outcome.
        const renewal = yield* Effect.exit(grant.refresh(stale));
        // Recorded on this request's own ledger entry, and only for a token
        // other than the one it sent; the core decides from it (Q8).
        if (renewal._tag === "Success" && !(yield* Signal)?.aborted)
          renewedAfterUnauthorized(entry, stale, renewal.value);
        if (options?.writeUnauthorized) {
          const cause = renewal._tag === "Failure" ? Cause.findErrorOption(renewal.cause) : Option.none();
          const failure = Option.isSome(cause) ? cause.value : undefined;
          const facts: Write401Renewal =
            renewal._tag === "Success"
              ? { _tag: renewal.value === stale ? "Unchanged" : "Renewed" }
              : {
                  _tag: "Failed",
                  failure:
                    failure?._tag === "Refusal"
                      ? failure.error
                      : (failure ?? new Error("OAuth renewal did not complete.")),
                };
          // This is still the resource request's own 401. The common failure
          // mapper attaches its provenance; settleWrite decides the outcome.
          return yield* Effect.fail(new Refusal({ error: options.writeUnauthorized(facts, yield* Routes) }));
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.text ?? "", { status: reply.status, headers: reply.headers }),
        );
      }
      const fresh = yield* grant.refresh(stale);
      if ((yield* Signal)?.aborted)
        return yield* Effect.fail(
          new RequestRefused({ message: "This call has ended; no renewal work may continue." }),
        );
      renewedAfterUnauthorized(entry, stale, fresh);
      // `authenticate` runs again on the replay and reads the renewed token.
      const replay = yield* inner
        .execute(request)
        .pipe(
          Effect.catchTag("ResponseTooLarge", (failure) =>
            options?.challengeMaxBytes !== undefined && responseRequest(failure)?.status === 401
              ? grant.rejected
              : Effect.fail(failure),
          ),
        );
      if (replay.status !== 401) return replay;
      if (options?.replayRejection === "answer") {
        // The connection reads and redacts this answer like any other.
        if (grant.discard) yield* grant.discard(sentToken(replay.request));
        return replay;
      }
      yield* Effect.ignore(guarded.read(replay));
      return yield* grant.rejected;
    }).pipe(
      duringCall,
      Effect.catchTag("RequestRefused", (failure) =>
        Signal.use((signal) =>
          Effect.fail(
            signal?.aborted
              ? new Refusal({
                  error: new ConnectorCallError(
                    "connector_call_failed",
                    "This call has ended; no renewal work may continue.",
                  ),
                })
              : failure,
          ),
        ),
      ),
    );
  return {
    provider: guarded.provider,
    client: HttpClient.makeWith(
      (request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpFailure, CallServices | Grant>) =>
        Effect.flatMap(request, execute),
      (request: HttpClientRequest.HttpClientRequest) => Effect.succeed(request),
    ),
    read: guarded.read,
  };
}
