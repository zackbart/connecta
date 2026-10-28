// The Effect plumbing the operator and activity data routes share.
//
// Each JSON route under /ui/* is one Effect program, run at its Promise edge
// by serveOperator. A route that settles its answer early — a refusal, or an
// auth provider's own challenge — fails with an Answer carrying that exact
// Response, and the edge serves it. That is the whole error model: every
// status, body, and header is still built by privateJson or by the provider,
// so the wire format cannot drift from what these routes have always sent.
// Anything else that goes wrong is a defect and rejects the edge, as a throw
// from the async handlers did.
//
// Effect's HttpApi was measured for this and not used (P1-S18). Declaring
// these seven endpoints added about 101 KB gzip to ./ui and 131 KB to
// ./activity, most of it Schema, and matching the wire format would have
// meant opting out of nearly everything it does: unowned paths fall through
// to the next module rather than 404, a wrong method is a JSON 405, the
// Content-Type and size checks run before a body is read, and a credential
// field error names the field in words the page already shows. Plain routing
// over one error channel keeps the behavior and costs nothing, because ./ui
// already carries Effect through its deadlines.
//
// Imported by the /ui and /activity graphs only; never from the root entry.

import { Effect } from "effect";
import { operatorViewerKeys } from "../storage/keys.js";
import type { KVStorage } from "../types.js";
import type { RegistryScope, RegistryView } from "../registry.js";
import { runEdge, withDeadlineEffect } from "../runtime/run.js";
import { isMaintainer } from "../membership.js";
import {
  admitsMaintainer,
  authorize,
  authorizeUiIdentity,
  memberConnectors,
  privateJson,
  type RouteContext,
} from "./shared.js";

/** A response the route has already decided on. */
export class Answer {
  readonly _tag = "Answer";
  constructor(readonly response: Response) {}
}

/** End the route with a private JSON error, as every route here does. */
export function refuse(error: string, status: number): Effect.Effect<never, Answer> {
  return Effect.fail(new Answer(privateJson({ error }, { status })));
}

export type Authorized = Extract<Awaited<ReturnType<typeof authorize>>, { ok: true }>;

function admitted(result: Promise<Awaited<ReturnType<typeof authorize>>>): Effect.Effect<Authorized, Answer> {
  return Effect.flatMap(
    Effect.promise(() => result),
    (authz) => (authz.ok ? Effect.succeed(authz) : Effect.fail(new Answer(authz.response))),
  );
}

/** Any configured caller. The gate's refusal, challenge headers and all, is the answer. */
export function authorized(
  { request, baseUrl, opts, runtimeContext }: RouteContext,
  partitionIdentity = true,
): Effect.Effect<Authorized, Answer> {
  return Effect.suspend(() =>
    admitted(
      authorize(request, baseUrl, opts.config.auth, runtimeContext, partitionIdentity, false, opts.config.logger),
    ),
  );
}

/** A signed-in person, for a route that changes how a connector authenticates. */
export function authorizedPerson(
  { request, baseUrl, opts, runtimeContext }: RouteContext,
  purpose: string,
): Effect.Effect<Authorized, Answer> {
  return Effect.suspend(() =>
    admitted(authorizeUiIdentity(request, baseUrl, opts.config.auth, purpose, runtimeContext, opts.config.logger)),
  );
}

// Cache resolved keys only; request promises and identities never outlive a read.
const viewerSigningKeys = new WeakMap<KVStorage, CryptoKey>();

/** Stable across isolates, opaque even for guessable Access email identities. */
export function operatorViewerKey(context: RouteContext, authz: Authorized): Effect.Effect<string, Answer> {
  const attempt = <A>(read: () => Promise<A>) => Effect.tryPromise({ try: read, catch: (error) => error });
  return withDeadlineEffect(
    () =>
      Effect.gen(function* () {
        const storage = context.opts.config.storage;
        let key = viewerSigningKeys.get(storage);
        if (!key) {
          let raw = yield* attempt(() => storage.get(operatorViewerKeys.signingKey));
          if (raw === null) {
            const candidate = crypto.randomUUID();
            raw = (yield* attempt(() => storage.compareAndSet(operatorViewerKeys.signingKey, null, candidate)))
              ? candidate
              : yield* attempt(() => storage.get(operatorViewerKeys.signingKey));
          }
          if (!raw || !/^[0-9a-f-]{36}$/.test(raw))
            return yield* Effect.fail(new Error("Operator viewer key unavailable"));
          const bytes = new TextEncoder().encode(raw);
          key = yield* attempt(() =>
            crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
          );
          viewerSigningKeys.set(storage, key);
        }
        const { principal, subject, actor, interactive, agent } = authz.identity;
        const identity = new TextEncoder().encode(
          JSON.stringify([
            principal?.namespace,
            principal?.id,
            subject?.namespace,
            subject?.id,
            actor.kind,
            actor.namespace,
            actor.id,
            interactive,
            agent,
          ]),
        );
        const signingKey = key;
        const digest = yield* attempt(() => crypto.subtle.sign("HMAC", signingKey, identity));
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      }),
    {
      timeoutMs: 500,
      signal: context.request.signal,
      timeoutError: new Error("Operator viewer key timed out"),
    },
  ).pipe(Effect.catch(() => refuse("operator identity could not be read", 503)));
}

/** The partition an identity carries into a registry view of the given connectors. */
export function scopeFor(
  authz: Authorized,
  authenticated: boolean,
  connectorIds: RegistryScope["connectorIds"] = "all",
): RegistryScope {
  return {
    connectorIds,
    ...(authz.subjectKey ? { subjectKey: authz.subjectKey } : {}),
    ...(authz.principalKey ? { principalKey: authz.principalKey } : {}),
    operatorCaller: { identity: authz.identity, authenticated },
  };
}

/**
 * The whole registry, for a maintainer only (#837). Everyone else gets the
 * private 404 plain `/mcp` gives them.
 */
export function visibleRegistry({ opts }: RouteContext, authz: Authorized): Effect.Effect<RegistryView, Answer> {
  // Operator catalogs describe the default endpoint's view, never a pool view.
  if (!admitsMaintainer(opts, authz)) return refuse("not found", 404);
  return Effect.succeed(opts.registry.scoped(scopeFor(authz, opts.config.auth.length > 0)));
}

/**
 * The connectors a connector-auth route may resolve (#837): every connector
 * for a maintainer, the connectors of their pools for a pool member, and the
 * private 404 for anyone else. mayManageConnector still decides each action.
 */
export function managementRegistry({ opts }: RouteContext, authz: Authorized): Effect.Effect<RegistryView, Answer> {
  if (isMaintainer(opts.maintainers, authz.identity))
    return Effect.succeed(opts.registry.scoped(scopeFor(authz, opts.config.auth.length > 0)));
  const ids = memberConnectors(opts, authz.identity);
  if (ids !== "all" && ids.size === 0) return refuse("not found", 404);
  return Effect.succeed(
    opts.registry.scoped(scopeFor(authz, opts.config.auth.length > 0, ids === "all" ? "all" : [...ids])),
  );
}

/**
 * Run one route program to its Response.
 *
 * A read passes the request's signal, so a caller who leaves stops whatever
 * the read was waiting on. A mutation passes none: once a vault write or an
 * OAuth disconnect has started, the cache invalidation that follows it must
 * run too, whether or not anyone is still waiting for the answer.
 */
export function serveOperator(program: Effect.Effect<Response, Answer>, signal?: AbortSignal): Promise<Response> {
  return runEdge(
    Effect.catch(program, (answer) => Effect.succeed(answer.response)),
    signal ? { signal } : undefined,
  );
}
