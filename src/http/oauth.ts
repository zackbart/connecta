// Internal prototype for decision 0010 (B.2). Unreachable from src/index.ts.
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
// the one mapping (src/http/errors.ts) reads it from there: unknown, unless
// the vendor documents that it authenticates first. A renewal that fails,
// for any reason, is the authorization server's failure and is discarded,
// so it can neither turn the write into a refusal nor advertise a retry.
//
// Whether a request is a write comes from the call's served classification
// and the request's own effect (an auxiliary read inside a write tool may be
// replayed), never from the HTTP method: Breeze writes with GET, and the REST
// vendors read with reviewed POSTs.
//
// The grant itself (storage, coordination across isolates, the token
// request, the request-scope latch) stays in src/auth/.

import { Context, Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { GuardedClient } from "./client.js";
import type { HttpFailure } from "./errors.js";
import { Classification, RequestFacts, type CallServices } from "./services.js";

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
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const response = yield* inner.execute(request);
      if (response.status !== 401) return response;
      // Read under the ceiling now, so nothing is left open while renewing.
      const reply = yield* guarded.read(response);
      const grant = yield* Grant;
      const stale = (response.request.headers["authorization"] ?? "").replace(/^Bearer /, "");
      if ((yield* Classification) === "write" && (yield* RequestFacts).effect === "call") {
        yield* Effect.exit(grant.refresh(stale));
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.text ?? "", { status: reply.status, headers: reply.headers }),
        );
      }
      yield* grant.refresh(stale);
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
