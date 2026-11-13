import { hasControlCharacters } from "./tool-name.js";
import type { ToolAccess } from "./registry.js";

export const POOL_NAME_RE = /^[a-z0-9_-]+$/;

/**
 * One derived view: which connectors, and for connectors granted by address
 * only, which tools. A connector absent from `toolAccess` is visible whole.
 */
export interface ConnectorAccess {
  connectorIds: "all" | readonly string[];
  toolAccess?: ToolAccess;
  writes?: ToolAccess;
}

const CONNECTOR_ID_RE = /^[a-z0-9_-]+$/;
// MCP does not restrict tool names, and remote servers ship spaced and
// non-ASCII ones. Only control characters are refused, so a pool naming a
// legitimately named tool still constructs.
const TOOL_ADDRESS_RE = /^[a-z0-9_-]+\..{1,256}$/su;

/**
 * Normalize a pool's `tools`. A bare connector id grants every tool on that
 * connector; a `connector.tool` address grants one tool. Grants are additive,
 * so a bare id beside addresses for the same connector means the whole
 * connector. Anything else throws: a grant that cannot be parsed must never
 * fail open.
 */
export function parseConnectorAccess(value: unknown): ConnectorAccess {
  if (!Array.isArray(value)) throw new Error("invalid connector permission");
  const whole = new Set<string>();
  const partial = new Map<string, Set<string>>();
  for (const address of value) {
    if (typeof address === "string" && CONNECTOR_ID_RE.test(address)) {
      whole.add(address);
      continue;
    }
    const [connectorId, tool] = splitToolAddress(address);
    const tools = partial.get(connectorId) ?? new Set<string>();
    tools.add(tool);
    partial.set(connectorId, tools);
  }
  for (const id of whole) partial.delete(id);
  const connectorIds = [...new Set([...whole, ...partial.keys()])];
  return { connectorIds, ...(partial.size > 0 ? { toolAccess: partial } : {}) };
}

function splitToolAddress(address: unknown): [connectorId: string, tool: string] {
  if (typeof address !== "string" || !TOOL_ADDRESS_RE.test(address) || hasControlCharacters(address)) {
    throw new Error("invalid connector permission");
  }
  const dot = address.indexOf(".");
  return [address.slice(0, dot), address.slice(dot + 1)];
}

export const isConnectorId = (value: unknown): boolean => typeof value === "string" && CONNECTOR_ID_RE.test(value);

export function parseWriteGrants(value: readonly unknown[]): ToolAccess {
  const grants = new Map<string, Set<string>>();
  for (const address of value) {
    if (isConnectorId(address)) throw new Error("whole connector");
    const [connectorId, tool] = splitToolAddress(address);
    const tools = grants.get(connectorId) ?? new Set<string>();
    tools.add(tool);
    grants.set(connectorId, tools);
  }
  return grants;
}

export function withWrites(access: ConnectorAccess, writes: ToolAccess): ConnectorAccess {
  if (access.connectorIds === "all") return { ...access, writes };
  const whole = access.connectorIds.filter((id) => !access.toolAccess?.has(id));
  const toolAccess = new Map(access.toolAccess);
  for (const [id, tools] of writes) {
    if (!whole.includes(id)) toolAccess.set(id, new Set([...(toolAccess.get(id) ?? []), ...tools]));
  }
  return {
    connectorIds: [...new Set([...access.connectorIds, ...writes.keys()])],
    ...(toolAccess.size > 0 ? { toolAccess } : {}),
    writes,
  };
}
