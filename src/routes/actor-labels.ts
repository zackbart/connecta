// Display labels for stored activity actors. An actor is stored as a stable id; a label is resolved at
// read time from the one auth provider that owns the actor's directory, and
// only on an authorized read path. Nothing here is persisted, and a label a
// store happens to carry is never trusted or echoed.

import type { ActivityActor } from "../activity.js";
import type { InboundAuth } from "../types.js";
import { activityActorNamespace } from "./shared.js";

export const ACTOR_LABEL_CONCURRENCY = 8;
export const ACTOR_LABEL_BUDGET_MS = 1_500;
const ACTOR_LABEL_MAX_LENGTH = 160;

export function cleanActorLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return Array.from(compact).slice(0, ACTOR_LABEL_MAX_LENGTH).join("");
}

export interface LabelLookup {
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
export function labelLookups(actors: readonly ActivityActor[], auth: readonly InboundAuth[]): LabelLookup[] {
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
