import type { ToolAccess } from "./registry.js";
import type { AuthenticatedIdentity } from "./types.js";

/** A declared pool after construction-time validation. */
export interface ResolvedPool {
  access: ConnectorAccess;
  grant(identity: Readonly<AuthenticatedIdentity>): boolean | Promise<boolean>;
}

export const POOL_NAME_RE = /^[a-z0-9_-]+$/;

/**
 * One derived view: which connectors, and for connectors granted by address
 * only, which tools. A connector absent from `toolAccess` is visible whole.
 * `guardedToolAccess` is a subset of `toolAccess` checked against the loaded
 * catalog each time tools are discovered or invoked.
 */
export interface ConnectorAccess {
  connectorIds: "all" | readonly string[];
  toolAccess?: ToolAccess;
  /** Exact tool grants that also require a current explicit read-only annotation. */
  guardedToolAccess?: ToolAccess;
}

interface ReadOnlyToolGrant {
  tool: string;
  requireReadOnly: true;
}

export type ConnectorGrant = string | ReadOnlyToolGrant;

const CONNECTOR_ID_RE = /^[a-z0-9_-]+$/;
// MCP does not restrict tool names, and remote servers ship spaced and
// non-ASCII ones. Only control characters are refused, so a grant for a
// legitimately named tool cannot 403 the whole identity at request time.
const TOOL_ADDRESS_RE = /^[a-z0-9_-]+\..{1,256}$/su;
const hasControlCharacter = (value: string): boolean =>
  [...value].some((ch) => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });

/**
 * Normalize a grant list. A bare connector id grants every tool on that
 * connector; a `connector.tool` address grants one tool. Grants are additive,
 * so a bare id beside addresses for the same connector means the whole
 * connector. Identity resolution can opt into `{ tool, requireReadOnly: true }`
 * for a fixed address that also needs a current explicit read-only annotation;
 * pool declarations remain strings. Anything else throws, and the caller
 * decides whether that is a construction failure or a 403: a grant that
 * cannot be parsed must never fail open.
 */
export function parseConnectorAccess(
  value: unknown,
  options: { allowReadOnly?: boolean } = {},
): ConnectorAccess {
  if (value === "all") return { connectorIds: "all" };
  if (!Array.isArray(value)) throw new Error("invalid connector permission");
  const whole = new Set<string>();
  const plain = new Map<string, Set<string>>();
  const guarded = new Map<string, Set<string>>();
  for (const entry of value) {
    if (typeof entry === "string" && CONNECTOR_ID_RE.test(entry)) {
      whole.add(entry);
      continue;
    }
    const isGuarded = typeof entry !== "string";
    if (isGuarded && (!options.allowReadOnly || entry === null ||
      typeof entry !== "object" || Array.isArray(entry) ||
      !Object.hasOwn(entry, "tool") || !Object.hasOwn(entry, "requireReadOnly") ||
      Object.keys(entry).length !== 2 || entry.requireReadOnly !== true)) {
      throw new Error("invalid connector permission");
    }
    const address = isGuarded ? entry.tool : entry;
    if (typeof address !== "string" || !TOOL_ADDRESS_RE.test(address) || hasControlCharacter(address)) {
      throw new Error("invalid connector permission");
    }
    const dot = address.indexOf(".");
    const connectorId = address.slice(0, dot);
    const target = isGuarded ? guarded : plain;
    const tools = target.get(connectorId) ?? new Set<string>();
    tools.add(address.slice(dot + 1));
    target.set(connectorId, tools);
  }
  for (const id of whole) {
    plain.delete(id);
    guarded.delete(id);
  }
  for (const [id, names] of plain) {
    const restricted = guarded.get(id);
    if (!restricted) continue;
    for (const name of names) restricted.delete(name);
    if (restricted.size === 0) guarded.delete(id);
  }
  const partial = new Map<string, Set<string>>(plain);
  for (const [id, names] of guarded) {
    const combined = partial.get(id) ?? new Set<string>();
    for (const name of names) combined.add(name);
    partial.set(id, combined);
  }
  const connectorIds = [...new Set([...whole, ...partial.keys()])];
  return {
    connectorIds,
    ...(partial.size > 0 ? { toolAccess: partial } : {}),
    ...(guarded.size > 0 ? { guardedToolAccess: guarded } : {}),
  };
}

/**
 * The view a pool endpoint serves: the pool's grants, never wider than the
 * identity's own. A connector or tool outside either side is gone; a
 * connector whose tool intersection is empty is gone too, so the pool can
 * only narrow what the identity resolver already allowed.
 */
export function intersectAccess(
  ceiling: ConnectorAccess,
  pool: ConnectorAccess,
): ConnectorAccess {
  if (pool.connectorIds === "all") return ceiling;
  const allowedIds = ceiling.connectorIds === "all"
    ? null
    : new Set(ceiling.connectorIds);
  const connectorIds: string[] = [];
  const toolAccess = new Map<string, ReadonlySet<string>>();
  const guardedToolAccess = new Map<string, ReadonlySet<string>>();
  for (const id of pool.connectorIds) {
    if (allowedIds && !allowedIds.has(id)) continue;
    const fromPool = pool.toolAccess?.get(id);
    const fromCeiling = ceiling.toolAccess?.get(id);
    if (fromPool && fromCeiling) {
      const both = new Set([...fromPool].filter((name) => fromCeiling.has(name)));
      if (both.size === 0) continue;
      toolAccess.set(id, both);
    } else if (fromPool ?? fromCeiling) {
      toolAccess.set(id, (fromPool ?? fromCeiling)!);
    }
    const guarded = ceiling.guardedToolAccess?.get(id);
    if (guarded) {
      const allowed = toolAccess.get(id);
      const retained = allowed
        ? new Set([...guarded].filter((name) => allowed.has(name)))
        : guarded;
      if (retained.size > 0) guardedToolAccess.set(id, retained);
    }
    connectorIds.push(id);
  }
  return {
    connectorIds,
    ...(toolAccess.size > 0 ? { toolAccess } : {}),
    ...(guardedToolAccess.size > 0 ? { guardedToolAccess } : {}),
  };
}
