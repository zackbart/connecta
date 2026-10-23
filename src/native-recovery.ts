import type { ToolResult } from "./meta-tools.js";

/** Adapt only Connecta error envelopes; successful downstream payloads stay untouched. */
export function nativeRecovery(result: unknown, executeCode: boolean, wireName?: string): unknown {
  const response = result as ToolResult;
  const body = response?.structuredContent;
  if (!response?.isError || !body || typeof body.error !== "object" || !body.error) return result;
  const error = { ...(body.error as Record<string, unknown>) };
  const action = error.nextAction as
    | { tool?: string; arguments?: Record<string, unknown>; purpose?: string }
    | undefined;
  if (action?.tool === "search_tools" || (!action && error.code === "unknown_tool")) {
    error.nextAction = {
      host: "search",
      arguments: action?.arguments ?? { query: wireName },
      purpose: action?.purpose,
    };
  } else if (action?.tool === "authorize_connector") {
    const url = error.authorizationUrl ?? error.operatorUrl;
    error.nextAction = url
      ? { url, purpose: "Give this handoff to the user or operator." }
      : { operator: "Check connector authentication in deployment configuration." };
  } else if (action?.tool === "call_tool" || action?.tool === "call_destructive_tool") {
    error.nextAction = wireName
      ? {
          tool: wireName,
          arguments: action.arguments?.args ?? {},
          purpose: `${action.purpose ?? "Retry the original native call."}${action.arguments?.argsRedacted ? " Resend the original arguments; sensitive fields were omitted." : ""}`,
        }
      : { host: "search", purpose: action.purpose };
  }
  // These are Connecta-authored recovery fields, never arbitrary downstream data.
  for (const key of ["message", "instructions", "retry"]) {
    if (typeof error[key] === "string")
      error[key] = error[key]
        .replaceAll("authorize_connector", "the returned authorization handoff")
        .replaceAll("search_tools", "your host's tool search")
        .replaceAll("call_destructive_tool", "the original native tool")
        .replaceAll("call_tool", "the original native tool")
        .replaceAll("execute_code", executeCode ? "execute_code" : "your host's tool search");
  }
  if (!executeCode && typeof error.instructions === "string") {
    error.instructions = error.instructions.replace(
      /; connecta\.search[\s\S]*$/,
      ". Retry the original native call after recovery.",
    );
  }
  return {
    ...response,
    structuredContent: { ...body, error },
    content: [{ type: "text", text: JSON.stringify({ ...body, error }) }],
  };
}
