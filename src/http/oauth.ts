// Internal prototype for decision 0010 (B.2). Unreachable from src/index.ts.
//
// Refresh-once for a connection that authenticates with a token it can
// renew: a downstream OAuth grant, a service-account assertion, a machine
// login. A 401 earns one renewal. A read is then replayed once; a second 401
// is the grant's own refusal. A write is never sent again (INV-9): the
// renewal still happens, so the next deliberate call has a fresh token, but
// this call reports an unknown outcome, because a server may act on a
// request before it rejects the token. That verdict and its words are A.2's
// for `ctx.oauth.fetch`, so both paths say the same thing.
//
// Whether a call is a write comes from the call's served classification
// (the Classification service), never from the HTTP method: Breeze writes
// with GET, and the REST vendors read with reviewed POSTs.
//
// The grant itself (storage, coordination across isolates, the token
// request, the request-scope latch) stays in src/auth/; this file only
// decides what a 401 may cause.

import { Context, Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ConnectorCallError } from "../errors.js";
import type { GuardedClient } from "./client.js";
import { Refusal, type HttpFailure } from "./errors.js";
import { Classification, type CallServices } from "./services.js";

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
    readonly refresh: (stale: string) => Effect.Effect<string, HttpFailure>;
    /** The renewed token was refused too: latch the request scope and fail with the grant's own verdict. */
    readonly rejected: Effect.Effect<never, HttpFailure>;
  }
>()("connecta/http/Grant") {}

/** Headers for `GuardedOptions.authenticate`: the grant's bearer token. */
export const bearer: Effect.Effect<Readonly<Record<string, string>>, HttpFailure, Grant> = Grant.use((grant) =>
  Effect.map(grant.token, (token) => ({ Authorization: `Bearer ${token}` })),
);

/** Wrap a guarded client whose `authenticate` is {@link bearer}. */
export function refreshOnce(guarded: GuardedClient<CallServices | Grant>): GuardedClient<CallServices | Grant> {
  const inner = guarded.client;
  const unsent = new Refusal({
    error: new ConnectorCallError(
      "connector_call_failed",
      `${guarded.provider} answered a write with HTTP 401. The grant is renewed, but the write was not sent ` +
        "again, so whether it took effect is unknown: check the target before repeating it.",
      { retryable: false },
    ),
  });
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const response = yield* inner.execute(request);
      if (response.status !== 401) return response;
      yield* Effect.ignore(guarded.read(response));
      const grant = yield* Grant;
      yield* grant.refresh((response.request.headers["authorization"] ?? "").replace(/^Bearer /, ""));
      if ((yield* Classification) === "write") return yield* Effect.fail(unsent);
      // `authenticate` runs again on the replay and reads the renewed token.
      const replay = yield* inner.execute(request);
      if (replay.status !== 401) return replay;
      yield* Effect.ignore(guarded.read(replay));
      return yield* grant.rejected;
    });
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
