import type { CallErrorDetails } from "./errors.js";

/** Actions outside the tool namespace never invent a route on a serving surface. */
export function utilityRecovery(
  code: string,
  message: string,
  retryable = false,
): CallErrorDetails & { nextAction: NonNullable<CallErrorDetails["nextAction"]> } {
  return {
    code,
    message,
    retryable,
    nextAction: {
      action: ["unsupported_capability", "input_required_unsupported", "invalid_args"].includes(code)
        ? "inspect_capabilities"
        : code === "not_found"
          ? "recover_result"
          : "contact_operator",
      purpose: ["unsupported_capability", "input_required_unsupported", "invalid_args"].includes(code)
        ? "Inspect the supported utility input and client capabilities before a fresh call. Never repeat a write whose outcome is unknown."
        : code === "not_found"
          ? "Use a retained result handle if available. Otherwise report the missing output; never repeat a write to recover output."
          : "Ask the operator to restore availability. Retry reads only after recovery; reconcile any write whose outcome is unknown.",
    },
  };
}

/** Missing skill names need local discovery, never service restoration or result recovery. */
export function skillLookupRecovery(message: string): CallErrorDetails {
  return {
    code: "not_found",
    message,
    retryable: false,
    nextAction: {
      tool: "skills",
      arguments: {},
      purpose: "List available skills, then fetch an exact name from that list.",
    },
  };
}
