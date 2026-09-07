import type { AgentFriction } from "./activity.js";
/** Coarse recovery class derived without inspecting payloads or error prose. */
export function agentFrictionForCode(
  code: string | undefined,
): AgentFriction | undefined {
  switch (code) {
    case "unknown_address":
    case "unknown_tool":
    case "ambiguous_tool_alias":
      return "tool_not_found";
    case "invalid_args":
      return "schema_retry";
    case "destructive_tool_requires_approval":
      return "destructive_reroute";
    case "auth_required":
      return "auth_required";
    case "result_too_large":
      return "result_too_large";
    default:
      return undefined;
  }
}
