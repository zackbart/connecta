import {
  InvalidActivityCursorError,
  type ActivityActor,
  type ActivityPage,
  type ActivityReadPage,
} from "../activity.js";
import type { InboundAuth } from "../types.js";
import {
  activityActorNamespace,
  authorize,
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

async function boundedActivityActorLabel(
  hook: NonNullable<InboundAuth["activityActorLabel"]>,
  id: string,
  budgetMs: number,
): Promise<string | undefined> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      Promise.resolve(hook(id))
        .then(cleanActivityActorLabel)
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Add display-only actor labels to one authorized activity page. Resolution is
 * best-effort, bounded, and read-time only: stored events retain stable ids and
 * a profile-provider outage falls back to those ids without failing the page.
 */
async function enrichActivityActorLabels(
  page: ActivityPage,
  auth: readonly InboundAuth[],
): Promise<ActivityReadPage> {
  const identities = new Map<
    string,
    { kind: string; id: string; namespace?: string }
  >();
  for (const event of page.events) {
    if (!event.actor.id) continue;
    identities.set(
      JSON.stringify([
        event.actor.kind,
        event.actor.namespace,
        event.actor.id,
      ]),
      {
        kind: event.actor.kind,
        id: event.actor.id,
        ...(event.actor.namespace
          ? { namespace: event.actor.namespace }
          : {}),
      },
    );
  }
  const queue = [...identities.entries()];
  const labels = new Map<string, string>();
  let next = 0;
  const deadline = Date.now() + ACTIVITY_LABEL_PAGE_BUDGET_MS;
  const workers = Array.from(
    { length: Math.min(ACTIVITY_LABEL_CONCURRENCY, queue.length) },
    async () => {
      while (next < queue.length) {
        const entry = queue[next++];
        if (!entry) return;
        const [key, identity] = entry;
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
              const directories = new Set(
                sameKindProviders.map(directoryKey),
              );
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
        if (!provider) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const label = await boundedActivityActorLabel(
          provider.activityActorLabel!.bind(provider),
          identity.id,
          remaining,
        );
        if (label) labels.set(key, label);
      }
    },
  );
  await Promise.all(workers);
  return {
    ...page,
    events: page.events.map((event) => {
      const resolved = event.actor.id
        ? labels.get(
            JSON.stringify([
              event.actor.kind,
              event.actor.namespace,
              event.actor.id,
            ]),
          )
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
  };
}

export async function routeActivity(
  context: RouteContext,
): Promise<Response | null> {
  const { path, request, url, baseUrl, opts, runtimeContext } = context;
  if (path !== "/ui/activity") return null;
  if (request.method !== "GET") {
    return privateJson({ error: "method not allowed" }, { status: 405 });
  }
  const authz = await authorize(
    request,
    baseUrl,
    opts.auth,
    runtimeContext,
    opts.identity,
    false,
  );
  if (!authz.ok) return authz.response;
  if (opts.identity?.operatorAccess && !authz.operator) {
    return privateJson({ error: "operator access required" }, { status: 403 });
  }
  if (
    opts.activityReadGate &&
    !(await opts.activityReadGate(authz.actor))
  ) {
    return privateJson({ error: "forbidden" }, { status: 403 });
  }
  if (!opts.activity?.list) {
    return privateJson(
      { error: "activity history is not configured" },
      { status: 404 },
    );
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor && cursor.length > 500) {
    return privateJson({ error: "invalid cursor" }, { status: 400 });
  }
  const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
    : 50;
  try {
    const page = await opts.activity.list({
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });
    return privateJson(await enrichActivityActorLabels(page, opts.auth));
  } catch (error) {
    if (error instanceof InvalidActivityCursorError) {
      return privateJson({ error: error.message }, { status: 400 });
    }
    opts.logger.error("[connecta] activity read failed", error);
    return privateJson(
      { error: "activity history is temporarily unavailable" },
      { status: 503 },
    );
  }
}
