import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";
import type { ActivityRequestContext } from "./activity.js";

/** Client declarations are request facts, never authenticated authority. */
export interface McpClientContext {
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
}

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A null-prototype copy, so a declared key can never shadow an inherited one. */
function ownCapabilities(capabilities: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(capabilities)) {
    if (!RESERVED_KEYS.has(key)) copy[key] = value;
  }
  return copy;
}

/** Lift only the SDK-validated envelope, without retaining unrelated metadata. */
export function bindMcpClient(
  context: ServerContext,
  client: McpClientContext,
  activity?: ActivityRequestContext,
): void {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  const info = envelope?.[CLIENT_INFO_META_KEY];
  delete client.clientCapabilities;
  delete client.clientInfo;
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
    client.clientCapabilities = ownCapabilities(capabilities as Record<string, unknown>);
  }
  if (
    info &&
    typeof info === "object" &&
    "name" in info &&
    "version" in info &&
    typeof info.name === "string" &&
    typeof info.version === "string"
  ) {
    client.clientInfo = { name: info.name, version: info.version };
  }
  if (activity) {
    delete activity.clientInfo;
    if (client.clientInfo) activity.clientInfo = client.clientInfo;
  }
}

const USER_AGENT_PRODUCT = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\/([!#$%&'*+.^_`|~0-9A-Za-z-]+))?/;

/**
 * The leading `product/version` of a User-Agent header. A legacy (2025-era)
 * request carries no per-request client envelope, and its `initialize`
 * arrives in an earlier stateless exchange, so this header is the only
 * self-declared client identity on its later calls.
 */
export function userAgentClient(header: string | null): { name: string; version?: string } | undefined {
  const product = header === null ? null : USER_AGENT_PRODUCT.exec(header.trim());
  if (!product) return undefined;
  return { name: product[1]!, ...(product[2] !== undefined ? { version: product[2] } : {}) };
}
