// Toolkits: named, operator-defined scoped views over one deployment's
// registry, selected per client connection with `?toolkit=<name>` on /mcp.
//
// A connecta deployment belongs to an ORG; a toolkit is the view a GROUP OF
// TEAM MEMBERS inside that org gets — a "support" toolkit seeing Zendesk and
// Notion, an "exec" toolkit that also sees Gmail. This module only *defines and
// validates* scopes and the identity bindings that gate them. Enforcement lives
// in two places, each with one job:
//
//   - WHICH toolkit an identity may open: the connect-time binding check in
//     `resolveToolkitScope` (src/server.ts), run after the auth gate and before
//     any scoped registry exists.
//   - WHAT a selected toolkit may see: `ScopedRegistry` (src/registry.ts),
//     which every meta-tool inherits through `RegistryView`.

import type { Connector, InboundAuth, ToolkitBinding } from "./types.js";

/** Toolkit names share the connector-id grammar: URL-safe, no separators. */
export const TOOLKIT_NAME_RE = /^[a-z0-9_-]+$/;

/** One named scope, declared in `ConnectaConfig.toolkits` (config as code). */
export interface ToolkitDefinition {
  /** Connector ids this toolkit may see. Required, and at least one. */
  connectors: string[];
  /**
   * Optional finer grain: full tool addresses (`"<connectorId>.<toolName>"`).
   * Naming ANY address of a connector narrows that connector to exactly the
   * addresses named; connectors with no entry here keep their whole tool list.
   */
  includeTools?: string[];
  /** Optional tool addresses to hide, applied after `includeTools`. */
  excludeTools?: string[];
  /** Operator note. Never sent to clients — this is documentation for config. */
  description?: string;
}

/** `ConnectaConfig.toolkits` — toolkit name → definition. */
export type ToolkitConfig = Record<string, ToolkitDefinition>;

/** A validated toolkit: the visibility predicate the scoped registry consults. */
export interface Toolkit {
  readonly name: string;
  readonly description?: string;
  /** True when `connectorId` is inside this toolkit's scope. */
  hasConnector(connectorId: string): boolean;
  /** True when `<connectorId>.<toolName>` is inside this toolkit's scope. */
  hasTool(connectorId: string, toolName: string): boolean;
}

/**
 * Split `"<connectorId>.<toolName>"` on the FIRST dot — connector ids contain
 * no dots, so a downstream tool name may. Returns null for a malformed address.
 */
export function splitAddress(
  address: string,
): { connectorId: string; toolName: string } | null {
  const dot = address.indexOf(".");
  if (dot <= 0 || dot === address.length - 1) return null;
  return {
    connectorId: address.slice(0, dot),
    toolName: address.slice(dot + 1),
  };
}

/** Group tool addresses by connector id, validating each against the toolkit. */
function toolFilter(
  name: string,
  addresses: string[] | undefined,
  connectorIds: ReadonlySet<string>,
  staticTools: ReadonlyMap<string, ReadonlySet<string>>,
  field: "includeTools" | "excludeTools",
): Map<string, Set<string>> {
  const byConnector = new Map<string, Set<string>>();
  if (addresses !== undefined && !Array.isArray(addresses)) {
    // A bare string would otherwise iterate character by character and produce
    // a stream of confusing address errors; anything else would throw "not
    // iterable" from deep inside the loop. Name the field instead.
    throw new Error(
      `Toolkit "${name}" ${field} must be an array of "<connectorId>.<toolName>" addresses.`,
    );
  }
  if (
    addresses !== undefined &&
    addresses.length === 0 &&
    field === "includeTools"
  ) {
    // An empty allowlist reads as "only these tools" but would behave as "all
    // of them" — the one shape here that fails OPEN. (An empty excludeTools is
    // an honest no-op and is allowed.)
    throw new Error(
      `Toolkit "${name}" has an empty includeTools: remove it to expose every tool, or list the addresses this toolkit may use.`,
    );
  }
  for (const address of addresses ?? []) {
    const parts = splitAddress(address);
    if (!parts) {
      throw new Error(
        `Toolkit "${name}" ${field} entry "${address}" is not a tool address: expected "<connectorId>.<toolName>".`,
      );
    }
    if (!connectorIds.has(parts.connectorId)) {
      // A typo here would silently do nothing, quietly widening the scope the
      // operator believes they wrote. Fail at construction instead.
      throw new Error(
        `Toolkit "${name}" ${field} entry "${address}" names connector "${parts.connectorId}", which is not in this toolkit's connectors list.`,
      );
    }
    // Static-only, exactly like the registry's convention checks: an in-code
    // connector's tool list is known now, so a misspelled name — an exclude
    // that silently excludes nothing — is caught. Remote catalogs are fetched
    // lazily over the network and cannot be checked at construction.
    const known = staticTools.get(parts.connectorId);
    if (known && !known.has(parts.toolName)) {
      throw new Error(
        `Toolkit "${name}" ${field} entry "${address}" names no tool on connector "${parts.connectorId}".`,
      );
    }
    const tools = byConnector.get(parts.connectorId) ?? new Set<string>();
    tools.add(parts.toolName);
    byConnector.set(parts.connectorId, tools);
  }
  return byConnector;
}

/**
 * Validate one toolkit definition against the deployment's connectors.
 *
 * Structural mistakes THROW at construction rather than warn: a typo'd id in
 * an allowlist is a scope the operator did not write, and a scope nobody wrote
 * is not one an operator can reason about. (A definition scopes visibility only;
 * WHICH identity may select it is the separate binding below — see the module
 * header and documentation.md §16.) Tool names are checked only for connectors that expose
 * `staticTools` (i.e. `api()`); a remote connector's catalog is fetched lazily
 * over the network and is unknown at construction time.
 */
function resolveToolkit(
  name: string,
  definition: ToolkitDefinition,
  known: ReadonlySet<string>,
  staticTools: ReadonlyMap<string, ReadonlySet<string>>,
): Toolkit {
  if (!TOOLKIT_NAME_RE.test(name)) {
    throw new Error(
      `Invalid toolkit name "${name}": must match ${TOOLKIT_NAME_RE.source}`,
    );
  }
  if (
    !Array.isArray(definition.connectors) ||
    definition.connectors.length === 0
  ) {
    throw new Error(
      `Toolkit "${name}" selects no connectors: list at least one connector id in "connectors".`,
    );
  }
  const connectorIds = new Set<string>();
  for (const id of definition.connectors) {
    if (!known.has(id)) {
      throw new Error(
        `Toolkit "${name}" references unknown connector "${id}".`,
      );
    }
    connectorIds.add(id);
  }
  const includes = toolFilter(
    name,
    definition.includeTools,
    connectorIds,
    staticTools,
    "includeTools",
  );
  const excludes = toolFilter(
    name,
    definition.excludeTools,
    connectorIds,
    staticTools,
    "excludeTools",
  );
  return {
    name,
    ...(definition.description ? { description: definition.description } : {}),
    hasConnector: (connectorId) => connectorIds.has(connectorId),
    hasTool: (connectorId, toolName) => {
      if (!connectorIds.has(connectorId)) return false;
      const include = includes.get(connectorId);
      if (include && !include.has(toolName)) return false;
      return !excludes.get(connectorId)?.has(toolName);
    },
  };
}

/**
 * Validate every declared toolkit against the connector set. Returns undefined
 * when no toolkits are configured, so an existing deployment keeps exactly its
 * current (unscoped) behavior.
 */
export function resolveToolkits(
  toolkits: ToolkitConfig | undefined,
  connectors: readonly Connector[],
): ReadonlyMap<string, Toolkit> | undefined {
  if (!toolkits) return undefined;
  // Object.entries (not a keyed lookup) so no config key — `__proto__` and
  // friends included — can ever resolve through the prototype chain. Names are
  // then held in a Map, which has no prototype to pollute.
  const entries = Object.entries(toolkits);
  if (entries.length === 0) return undefined;
  const known = new Set(connectors.map((connector) => connector.id));
  const staticTools = new Map<string, ReadonlySet<string>>();
  for (const connector of connectors) {
    if (connector.staticTools) {
      staticTools.set(
        connector.id,
        new Set(connector.staticTools.map((tool) => tool.name)),
      );
    }
  }
  const resolved = new Map<string, Toolkit>();
  for (const [name, definition] of entries) {
    resolved.set(name, resolveToolkit(name, definition, known, staticTools));
  }
  return resolved;
}

/**
 * The binding half of an inbound-auth adapter's options — the shape every
 * shipped adapter (`bearerToken`, `clerkAuth`) mixes into its own options so an
 * operator writes one thing in one style, next to the credential it binds.
 */
export interface ToolkitBindingOptions {
  /**
   * Toolkit names this credential may select with `?toolkit=<name>`. Present ⇒
   * the identity is BOUND: any other toolkit, and (unless `unscoped`) a
   * connection with no `?toolkit=`, is refused at connect time. Absent ⇒
   * unbound, exactly as before bindings existed.
   */
  toolkits?: readonly string[];
  /**
   * Also allow a connection with no `?toolkit=` (the full registry, and the
   * deployment-wide operator surfaces). Only meaningful beside `toolkits`.
   */
  unscoped?: boolean;
}

/**
 * Validate one adapter's binding options into a `ToolkitBinding`, or undefined
 * when the adapter declares none. Structural mistakes THROW where the operator
 * wrote them (adapter construction), for the same reason toolkit definitions do:
 * a binding that does not say what its author meant is worse than none, because
 * it is invisible until the day it denies — or admits — the wrong caller.
 *
 * Names are only checked against the *grammar* here; cross-checking them
 * against the configured toolkits happens in `validateToolkitBindings`, which
 * runs in `createConnecta` where both halves are finally in scope.
 */
export function resolveToolkitBinding(
  source: string,
  options: ToolkitBindingOptions,
): ToolkitBinding | undefined {
  const { toolkits, unscoped } = options;
  if (toolkits === undefined) {
    if (unscoped !== undefined) {
      // `unscoped` alone reads like a permission but grants nothing an unbound
      // identity does not already have, so it is almost certainly a half-written
      // binding — the one shape here that would silently fail OPEN.
      throw new Error(
        `${source}: \`unscoped\` only means something beside \`toolkits\`. ` +
          "List the toolkits this credential may open, or drop `unscoped` to " +
          "leave the credential unbound.",
      );
    }
    return undefined;
  }
  if (!Array.isArray(toolkits)) {
    throw new Error(
      `${source}: \`toolkits\` must be an array of toolkit names.`,
    );
  }
  const names: string[] = [];
  for (const name of toolkits) {
    if (typeof name !== "string" || !TOOLKIT_NAME_RE.test(name)) {
      // A name outside the grammar can never match a declared toolkit, so this
      // would bind the credential to nothing selectable.
      throw new Error(
        `${source}: \`toolkits\` entry ${JSON.stringify(name)} is not a ` +
          `toolkit name (must match ${TOOLKIT_NAME_RE.source}).`,
      );
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0 && unscoped !== true) {
    throw new Error(
      `${source}: binds no toolkits and no unscoped access, so this credential ` +
        "could authenticate but never connect. List at least one toolkit, or " +
        "pass `unscoped: true` to bind it to the full registry only.",
    );
  }
  return Object.freeze({
    toolkits: Object.freeze(names) as readonly string[],
    ...(unscoped === true ? { unscoped: true } : {}),
  });
}

/**
 * Cross-check every statically declared binding against the deployment's
 * toolkits, in `createConnecta`. A name that no toolkit declares is a typo, and
 * a typo here fails CLOSED — the credential would be refused every connection
 * with a 403 the client reads as a transport failure — so it throws at
 * construction rather than becoming a support ticket.
 *
 * Bindings a provider mints per-identity (`AuthResult.toolkitBinding`) are not
 * visible here and are not validated; they are still enforced identically.
 */
export function validateToolkitBindings(
  auth: readonly InboundAuth[],
  toolkits: ReadonlyMap<string, Toolkit> | undefined,
): void {
  for (const provider of auth) {
    const binding = provider.toolkitBinding;
    if (!binding) continue;
    if (!toolkits || toolkits.size === 0) {
      throw new Error(
        `Inbound auth provider "${provider.kind}" binds toolkits ` +
          `(${binding.toolkits.join(", ")}) but this deployment configures no ` +
          "toolkits. Declare them in `toolkits`, or drop the binding.",
      );
    }
    for (const name of binding.toolkits) {
      if (!toolkits.has(name)) {
        throw new Error(
          `Inbound auth provider "${provider.kind}" binds unknown toolkit ` +
            `"${name}". Configured toolkits: ${[...toolkits.keys()].join(", ")}.`,
        );
      }
    }
  }
}
