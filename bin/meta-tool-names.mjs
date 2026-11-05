/** The upward meta-tool set every meta endpoint lists, shared by discovery checks and doctor. */
export const META_TOOL_NAMES = Object.freeze([
  "authorize_connector",
  "call_destructive_tool",
  "call_tool",
  "execute_code",
  "search_tools",
  "skills",
]);

/** A writable `/mcp` or `/mcp/<pool>` endpoint also lists this, unless `execute.readRoute` is false. */
export const READ_PROGRAM_TOOL = "execute_read_code";
