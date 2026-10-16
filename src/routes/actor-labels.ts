// Display labels for stored activity actors. An actor is stored as a stable id; a label is resolved at
// read time from the one auth provider that owns the actor's directory, and
// only on an authorized read path. Nothing here is persisted, and a label a
// store happens to carry is never trusted or echoed.

import { Duration, Effect } from "effect";
import type { ActivityActor } from "../activity.js";
import type { IdentityReference, InboundAuth } from "../types.js";
import { activityActorNamespace } from "./shared.js";

const ACTOR_LABEL_CONCURRENCY = 8;
const ACTOR_LABEL_BUDGET_MS = 1_500;
const ACTOR_LABEL_MAX_LENGTH = 160;

function cleanActorLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return Array.from(compact).slice(0, ACTOR_LABEL_MAX_LENGTH).join("");
}

interface LabelLookup {
  key: string;
  id: string;
  provider: InboundAuth;
}

export function actorKey(actor: ActivityActor): string {
  return JSON.stringify([actor.kind, actor.namespace, actor.id]);
}

/**
 * One lookup per distinct actor, each against the single provider that owns
 * the actor's directory. An actor no provider can claim unambiguously gets no
 * lookup at all.
 */
function labelLookups(actors: readonly ActivityActor[], auth: readonly InboundAuth[]): LabelLookup[] {
  const identities = new Map<string, { kind: string; id: string; namespace?: string }>();
  for (const actor of actors) {
    if (!actor.id) continue;
    identities.set(actorKey(actor), {
      kind: actor.kind,
      id: actor.id,
      ...(actor.namespace ? { namespace: actor.namespace } : {}),
    });
  }
  const lookups: LabelLookup[] = [];
  for (const [key, identity] of identities) {
    const sameKindProviders = auth
      .map((provider, index) => ({ provider, index }))
      .filter(({ provider }) => provider.kind === identity.kind);
    const candidates = sameKindProviders.filter(({ provider }) => Boolean(provider.activityActorLabel));
    const eligible = identity.namespace
      ? candidates.filter(({ provider }) => activityActorNamespace(provider) === identity.namespace)
      : (() => {
          const directoryKey = ({ provider, index }: (typeof sameKindProviders)[number]) => {
            const namespace = activityActorNamespace(provider);
            return namespace === undefined ? `provider:${index}` : `namespace:${namespace}`;
          };
          // Every same-kind provider participates in the ambiguity check,
          // even if it cannot resolve labels. Otherwise a legacy ID owned
          // by a provider without a resolver could be disclosed to a
          // different provider that happens to have one.
          const directories = new Set(sameKindProviders.map(directoryKey));
          if (directories.size !== 1) return [];
          const [directory] = directories;
          return candidates.filter((candidate) => directoryKey(candidate) === directory);
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
 * Resolve labels for these actors, keyed by `actorKey`. Best-effort and
 * bounded: at most eight lookups run at once, and whatever has resolved
 * within 1.5 seconds in all is used; the rest are abandoned, as they are when
 * the reader leaves. A lookup that fails or answers nothing usable is absent.
 */
export function resolveActorLabels(
  actors: readonly ActivityActor[],
  auth: readonly InboundAuth[],
): Effect.Effect<ReadonlyMap<string, string>> {
  return Effect.suspend(() => {
    const labels = new Map<string, string>();
    const resolve = ({ key, id, provider }: LabelLookup) =>
      Effect.tryPromise(() => Promise.resolve(provider.activityActorLabel!(id))).pipe(
        Effect.map(cleanActorLabel),
        Effect.orElseSucceed(() => undefined),
        Effect.map((label) => {
          if (label) labels.set(key, label);
        }),
      );
    return Effect.forEach(labelLookups(actors, auth), resolve, {
      concurrency: ACTOR_LABEL_CONCURRENCY,
      discard: true,
    }).pipe(
      Effect.timeoutOption(Duration.millis(ACTOR_LABEL_BUDGET_MS)),
      Effect.map(() => labels),
    );
  });
}

/**
 * The activity actor a listed person would be recorded as: the principal in
 * the namespace of the interactive provider that owns that directory. People
 * no interactive provider owns have no actor, and so no label.
 */
export function principalActor(principal: IdentityReference, auth: readonly InboundAuth[]): ActivityActor | undefined {
  const provider = auth.find(
    (candidate) => candidate.interactiveOperator && activityActorNamespace(candidate) === principal.namespace,
  );
  return provider ? { kind: provider.kind, id: principal.id, namespace: principal.namespace } : undefined;
}
