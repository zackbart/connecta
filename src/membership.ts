// Who may open which endpoint (#837, decisions/0006): `maintainers` open plain
// `/mcp`, and each pool's static `members` open `/mcp/<pool>`. References are
// resolved once at construction; a request is matched against them and never
// names its own scope (INV-4). Pure, so core reads it without any auth module.

import { isAgentName } from "./agent-identity.js";
import { ConfigError } from "./config-schema.js";
import type { ConnectorAccess } from "./connector-access.js";
import { validIdentityReference } from "./identity.js";
import type { AuthenticatedIdentity, IdentityReference, InboundAuth } from "./types.js";

/**
 * A person or an agent, as deployment code lists it: a bare principal id in
 * the namespace of the deployment's one interactive auth provider,
 * `{ namespace, id }` when that is ambiguous or the id contains `:`, or
 * `"agent:<name>"` for an agent declared in `agents`.
 */
export type MemberRef = string | Readonly<IdentityReference>;

/** A resolved member reference. Humans match by principal, agents by name. */
export type Member = { kind: "human"; namespace: string; id: string } | { kind: "agent"; name: string };

/** A declared pool after construction-time validation. */
export interface ResolvedPool {
  /** Resolved: the pool's own `readOnly`, else the deployment's. */
  readOnly: boolean;
  /** Exactly the pool's `tools`; nothing intersects or widens it. */
  access: ConnectorAccess;
  members: readonly Member[];
  /** Trimmed `owner`: the Workspace address agents in this pool act as. */
  owner?: string;
}

const AGENT_PREFIX = "agent:";

/** What resolving a reference needs to know about the deployment. */
export interface MemberContext {
  /** `activityActorNamespace` of each interactive provider, `undefined` where it has none. */
  interactiveNamespaces: ReadonlyArray<string | undefined>;
  agents: readonly string[];
}

/** The namespaces bare ids may resolve in, read from the resolved providers. */
export function memberContext(auth: readonly InboundAuth[], agents: readonly string[]): MemberContext {
  return {
    interactiveNamespaces: auth
      .filter((provider) => provider.interactiveOperator === true)
      .map((provider) =>
        typeof provider.activityActorNamespace === "string" &&
        validIdentityReference({ namespace: provider.activityActorNamespace, id: "x" })
          ? provider.activityActorNamespace
          : undefined,
      ),
    agents,
  };
}

function resolveRef(value: unknown, path: string, context: MemberContext): Member {
  if (typeof value === "string") {
    if (value.startsWith(AGENT_PREFIX)) {
      const name = value.slice(AGENT_PREFIX.length);
      if (!isAgentName(name) || !context.agents.includes(name)) {
        throw new ConfigError(`${path} names agent "${name}", which ConnectaConfig.agents does not declare.`);
      }
      return { kind: "agent", name };
    }
    if (value.includes(":")) {
      throw new ConfigError(
        `${path} contains ":". Write a principal whose id contains ":" as { namespace, id }; ` +
          'agents are "agent:<name>".',
      );
    }
    if (!validIdentityReference({ namespace: "x", id: value })) {
      throw new ConfigError(`${path} must be a principal id of 1 to 256 printable, non-space ASCII characters.`);
    }
    const namespaces = context.interactiveNamespaces;
    if (namespaces.length !== 1) {
      throw new ConfigError(
        `${path} is a bare principal id, which resolves only when exactly one interactive auth provider is ` +
          `configured (found ${namespaces.length}). Write it as { namespace, id }.`,
      );
    }
    const namespace = namespaces[0];
    if (namespace === undefined) {
      throw new ConfigError(
        `${path} is a bare principal id, but the interactive auth provider declares no activityActorNamespace. ` +
          "Write it as { namespace, id }.",
      );
    }
    return { kind: "human", namespace, id: value };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "namespace") ||
    !Object.hasOwn(value, "id")
  ) {
    throw new ConfigError(`${path} must be a principal id string, { namespace, id }, or "agent:<name>".`);
  }
  const { namespace, id } = value as Record<string, unknown>;
  if (typeof namespace !== "string" || typeof id !== "string" || !validIdentityReference({ namespace, id })) {
    throw new ConfigError(
      `${path} must have a namespace and id of 1 to 256 printable, non-space ASCII characters each.`,
    );
  }
  return { kind: "human", namespace, id };
}

const memberKey = (member: Member): string =>
  member.kind === "agent" ? `agent\0${member.name}` : `human\0${member.namespace}\0${member.id}`;

/**
 * Resolve one list of references, throwing on any that is malformed,
 * ambiguous, unknown, or repeated (INV-11).
 */
export function resolveMembers(value: unknown, path: string, context: MemberContext): Member[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path} must be an array of principal ids, { namespace, id }, or "agent:<name>".`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const member = resolveRef(entry, `${path}[${index}]`, context);
    const key = memberKey(member);
    if (seen.has(key)) throw new ConfigError(`${path}[${index}] repeats an earlier member.`);
    seen.add(key);
    return Object.freeze(member);
  });
}

/**
 * `maintainers`: people only. Required whenever an inbound provider can admit
 * a person, which is any provider but the built-in agent-token adapter. With
 * agents alone nobody can be a maintainer, so plain `/mcp` admits nobody.
 */
export function resolveMaintainers(
  value: unknown,
  admitsPeople: boolean,
  context: MemberContext,
): readonly IdentityReference[] {
  const path = "ConnectaConfig.maintainers";
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    if (admitsPeople) {
      throw new ConfigError(
        `${path} is required with inbound auth: list the people who may use plain /mcp, administer shared ` +
          "credentials, manage agent tokens, and read activity.",
      );
    }
    return Object.freeze([]);
  }
  if (!admitsPeople) {
    throw new ConfigError(
      `${path} needs an inbound auth provider that admits people, such as clerkAuth or cloudflareAccessAuth. ` +
        "Without one no maintainer can be admitted; agents are never maintainers.",
    );
  }
  const members = resolveMembers(value, path, context);
  return Object.freeze(
    members.map((member, index) => {
      if (member.kind === "agent") {
        throw new ConfigError(
          `${path}[${index}] is an agent. Agents are never maintainers; add them to a pool's members.`,
        );
      }
      return Object.freeze({ namespace: member.namespace, id: member.id });
    }),
  );
}

/** Whether an admitted identity is this member. An agent never matches a person. */
export function isMember(member: Member, identity: Readonly<AuthenticatedIdentity>): boolean {
  if (member.kind === "agent") return identity.agent !== undefined && identity.agent === member.name;
  const principal = identity.principal;
  return (
    identity.agent === undefined &&
    principal !== undefined &&
    principal.namespace === member.namespace &&
    principal.id === member.id
  );
}

/** Whether an admitted identity is a listed maintainer. */
export function isMaintainer(
  maintainers: readonly IdentityReference[],
  identity: Readonly<AuthenticatedIdentity>,
): boolean {
  return maintainers.some((maintainer) => isMember({ kind: "human", ...maintainer }, identity));
}
