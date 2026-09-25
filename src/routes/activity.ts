import { Duration, Effect } from "effect";
import {
  InvalidActivityCursorError,
  type ActivityActor,
  type ActivityPage,
  type ActivityReadPage,
} from "../activity.js";
import type { InboundAuth } from "../types.js";
import {
  ACTOR_LABEL_BUDGET_MS,
  ACTOR_LABEL_CONCURRENCY,
  actorKey,
  cleanActorLabel,
  labelLookups,
  type LabelLookup,
} from "./actor-labels.js";
import { authorized, refuse, serveOperator, type Answer } from "./operator.js";
import { privateJson, type RouteContext } from "./shared.js";

/**
 * Add display-only actor labels to one authorized activity page. Resolution is
 * best-effort, bounded, and read-time only: stored events retain stable ids and
 * a profile-provider outage falls back to those ids without failing the page.
 *
 * At most eight lookups run at once, and the page waits for them for 1.5
 * seconds in all: whatever has resolved by then is used, and the rest are
 * abandoned, as they are when the reader leaves.
 */
function enrichActivityActorLabels(
  page: ActivityPage,
  auth: readonly InboundAuth[],
): Effect.Effect<ActivityReadPage> {
  return Effect.suspend(() => {
    const labels = new Map<string, string>();
    const resolve = ({ key, id, provider }: LabelLookup) =>
      Effect.tryPromise(() =>
        Promise.resolve(provider.activityActorLabel!(id)),
      ).pipe(
        Effect.map(cleanActorLabel),
        Effect.orElseSucceed(() => undefined),
        Effect.map((label) => {
          if (label) labels.set(key, label);
        }),
      );
    return Effect.forEach(
      labelLookups(page.events.map((event) => event.actor), auth),
      resolve,
      {
        concurrency: ACTOR_LABEL_CONCURRENCY,
        discard: true,
      },
    ).pipe(
      Effect.timeoutOption(Duration.millis(ACTOR_LABEL_BUDGET_MS)),
      Effect.map(() => ({
        ...page,
        events: page.events.map((event) => {
          const resolved = event.actor.id
            ? labels.get(actorKey(event.actor))
            : undefined;
          // Never trust or echo a `label` supplied by storage. The persisted event
          // schema has no label; only this authenticated read path may add one.
          const actor: ActivityActor = {
            kind: event.actor.kind,
            ...(event.actor.id ? { id: event.actor.id } : {}),
            ...(event.actor.namespace
              ? { namespace: event.actor.namespace }
              : {}),
          };
          return {
            ...event,
            actor: resolved ? { ...actor, label: resolved } : actor,
          };
        }),
      })),
    );
  });
}

function activityRead(context: RouteContext): Effect.Effect<Response, Answer> {
  const { url, opts } = context;
  return Effect.gen(function* () {
    const authz = yield* authorized(context, false);
    if (!authz.operator) return yield* refuse("operator access required", 403);
    if (
      opts.activityReadGate &&
      !(yield* Effect.promise(async () => opts.activityReadGate!(authz.actor)))
    ) {
      return yield* refuse("forbidden", 403);
    }
    const list = opts.activity?.list?.bind(opts.activity);
    if (!list) return yield* refuse("activity history is not configured", 404);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor && cursor.length > 500) return yield* refuse("invalid cursor", 400);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
      : 50;
    return yield* Effect.tryPromise({
      try: () => list({ ...(cursor !== undefined ? { cursor } : {}), limit }),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((page) => enrichActivityActorLabels(page, opts.auth)),
      Effect.map((page) => privateJson(page)),
      // A page too malformed to label or serialize is the store's failure,
      // like any other.
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.catch((error) => {
        if (error instanceof InvalidActivityCursorError) {
          return refuse(error.message, 400);
        }
        opts.logger.error("[connecta] activity read failed", error);
        return refuse("activity history is temporarily unavailable", 503);
      }),
    );
  });
}

export async function routeActivity(
  context: RouteContext,
): Promise<Response | null> {
  const { path, request } = context;
  if (path !== "/ui/activity") return null;
  if (request.method !== "GET") {
    return privateJson({ error: "method not allowed" }, { status: 405 });
  }
  // A read: a reader who leaves stops the label lookups still queued.
  return serveOperator(activityRead(context), request.signal);
}
