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
 */
export interface ConnectorAccess {
  connectorIds: "all" | readonly string[];
  toolAccess?: ToolAccess;
}

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
 * connector. Anything else — an unknown shape, an empty tool name, a
 * non-string — throws, and the caller decides whether that is a construction
 * failure or a 403: a grant that cannot be parsed must never fail open.
 */
export function parseConnectorAccess(value: unknown): ConnectorAccess {
  if (value === "all") return { connectorIds: "all" };
  if (!Array.isArray(value)) throw new Error("invalid connector permission");
  const whole = new Set<string>();
  const partial = new Map<string, Set<string>>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("invalid connector permission");
    if (CONNECTOR_ID_RE.test(entry)) {
      whole.add(entry);
      continue;
    }
    if (!TOOL_ADDRESS_RE.test(entry) || hasControlCharacter(entry)) throw new Error("invalid connector permission");
    const dot = entry.indexOf(".");
    const connectorId = entry.slice(0, dot);
    const tools = partial.get(connectorId) ?? new Set<string>();
    tools.add(entry.slice(dot + 1));
    partial.set(connectorId, tools);
  }
  for (const id of whole) partial.delete(id);
  const connectorIds = [...new Set([...whole, ...partial.keys()])];
  return partial.size > 0
    ? { connectorIds, toolAccess: partial }
    : { connectorIds };
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
    connectorIds.push(id);
  }
  return toolAccess.size > 0 ? { connectorIds, toolAccess } : { connectorIds };
}
