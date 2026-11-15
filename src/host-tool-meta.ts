import { resolveMaxResultBytes, type RegistryView } from "./registry.js";

// Claude Code tool `_meta` keys: https://code.claude.com/docs/en/mcp#raise-the-limit-for-a-specific-tool
// and https://code.claude.com/docs/en/mcp#mark-a-tool-to-load-upfront-or-stay-deferred
const HOST_INLINE_RESULT_CHARS = 50_000;
const HOST_RESULT_CEILING_CHARS = 500_000;

/** Room past a tool's capped text for a truncation notice or page header, error facts, notes and counts. */
const RESULT_ENVELOPE_CHARS = 8_192;

export const ALWAYS_LOAD_META = { "anthropic/alwaysLoad": true } as const;

/** The result-size threshold a tool whose capped text stops at `cap` needs, when a host's default would spill it. */
export function resultSizeMeta(cap: number): { "anthropic/maxResultSizeChars"?: number } {
  const chars = cap + RESULT_ENVELOPE_CHARS;
  return chars > HOST_INLINE_RESULT_CHARS
    ? { "anthropic/maxResultSizeChars": Math.min(chars, HOST_RESULT_CEILING_CHARS) }
    : {};
}

/** The largest direct-call cap among the connectors a request admits. */
export function directResultCap(registry: RegistryView): number {
  const caps = registry
    .listConnectors()
    .map((connector) => resolveMaxResultBytes(connector.maxResultBytes, registry.maxResultBytes));
  return caps.length > 0 ? Math.max(...caps) : registry.maxResultBytes;
}

/** A tool's `_meta` option from its parts, absent when every part is empty. */
export function toolMeta(...parts: Record<string, unknown>[]): { _meta?: Record<string, unknown> } {
  const meta = Object.assign({}, ...parts) as Record<string, unknown>;
  return Object.keys(meta).length > 0 ? { _meta: meta } : {};
}
