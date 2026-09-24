import { Duration, Effect } from "effect";
import {
  InvalidActivityCursorError,
  type ActivityActor,
  type ActivityPage,
  type ActivityReadPage,
} from "../activity.js";
import type { InboundAuth } from "../types.js";
import { authorized, refuse, serveOperator, type Answer } from "./operator.js";
import {
  activityActorNamespace,
  privateJson,
  type RouteContext,
} from "./shared.js";

const ACTIVITY_LABEL_CONCURRENCY = 8;
const ACTIVITY_LABEL_PAGE_BUDGET_MS = 1_500;
const ACTIVITY_LABEL_MAX_LENGTH = 160;

function cleanActivityActorLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return Array.from(compact).slice(0, ACTIVITY_LABEL_MAX_LENGTH).join("");
}

interface LabelLookup {
  key: string;
  id: string;
  provider: InboundAuth;
}

function actorKey(actor: ActivityActor): string {
  return JSON.stringify([actor.kind, actor.namespace, actor.id]);
}

/**
 * One lookup per distinct actor on the page, each against the single provider
 * that owns the actor's directory. An actor no provider can claim unambiguously
 * gets no lookup at all.
 */
function labelLookups(
  page: ActivityPage,
  auth: readonly InboundAuth[],
): LabelLookup[] {
  const identities = new Map<
    string,
    { kind: string; id: string; namespace?: string }
  >();
  for (const event of page.events) {
    if (!event.actor.id) continue;
    identities.set(actorKey(event.actor), {
      kind: event.actor.kind,
      id: event.actor.id,
      ...(event.actor.namespace ? { namespace: event.actor.namespace } : {}),
    });
  }
  const lookups: LabelLookup[] = [];
  for (const [key, identity] of identities) {
    const sameKindProviders = auth
      .map((provider, index) => ({ provider, index }))
      .filter(({ provider }) => provider.kind === identity.kind);
    const candidates = sameKindProviders.filter(({ provider }) =>
      Boolean(provider.activityActorLabel),
    );
    const eligible = identity.namespace
      ? candidates.filter(
          ({ provider }) =>
            activityActorNamespace(provider) === identity.namespace,
        )
      : (() => {
          const directoryKey = ({
            provider,
            index,
          }: (typeof sameKindProviders)[number]) => {
            const namespace = activityActorNamespace(provider);
            return namespace === undefined
              ? `provider:${index}`
              : `namespace:${namespace}`;
          };
          // Every same-kind provider participates in the ambiguity check,
          // even if it cannot resolve labels. Otherwise a legacy ID owned
          // by a provider without a resolver could be disclosed to a
          // different provider that happens to have one.
          const directories = new Set(sameKindProviders.map(directoryKey));
          if (directories.size !== 1) return [];
          const [directory] = directories;
          return candidates.filter(
            (candidate) => directoryKey(candidate) === directory,
          );
        })();
    // One namespace is one directory. Use its first configured resolver so
    // duplicate gate adapters over the same Clerk instance do not multiply
    // the provider-level concurrency cap.
    const provider = eligible[0]?.provider;
    if (provider) lookups.push({ key, id: identity.id, provider });
  }
  return lookups;
}

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
        Effect.map(cleanActivityActorLabel),
        Effect.orElseSucceed(() => undefined),
        Effect.map((label) => {
          if (label) labels.set(key, label);
        }),
      );
    return Effect.forEach(labelLookups(page, auth), resolve, {
      concurrency: ACTIVITY_LABEL_CONCURRENCY,
      discard: true,
    }).pipe(
      Effect.timeoutOption(Duration.millis(ACTIVITY_LABEL_PAGE_BUDGET_MS)),
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
