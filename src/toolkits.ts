// Toolkits: named, operator-defined scoped views over one deployment's
// registry, selected per client connection with `?toolkit=<name>` on /mcp.
//
// A connecta deployment belongs to an ORG; a toolkit is the view a GROUP OF
// TEAM MEMBERS inside that org gets — a "support" toolkit seeing Zendesk and
// Notion, an "exec" toolkit that also sees Gmail. This module only *defines and
// validates* scopes. Enforcement lives in one place: `ScopedRegistry`
// (src/registry.ts), which every meta-tool inherits through `RegistryView`.

import type { Connector } from "./types.js";

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
 * Structural mistakes THROW at construction rather than warn: a toolkit is an
 * access boundary, and a typo'd id in an allowlist is a scope the operator did
 * not write. Tool names are checked only for connectors that expose
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
