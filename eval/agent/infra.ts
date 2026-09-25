import { toolId, type StreamEvent } from "./trace.js";

export function infraError(events: StreamEvent[], exitCode: number | null, loadedTools: string[]): string | undefined {
  const results = events.filter((event) => event.type === "result");
  const failed = results.find(event => event.subtype !== "success");
  const failureText = String(failed?.result ?? "");
  const info = failed?.codex_error_info;
  const code = typeof info === "string" ? info :
    info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  if (["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"].includes(code ?? "")) {
    return `rate or usage limit (${code}): ${failureText.slice(0, 300)}`;
  }
  if (code === "unauthorized") return `authentication failure: ${failureText.slice(0, 300)}`;
  if (["serverOverloaded", "internalServerError", "httpConnectionFailed",
    "responseStreamConnectionFailed", "responseStreamDisconnected",
    "responseTooManyFailedAttempts"].includes(code ?? "")) {
    return `backend failure (${code}): ${failureText.slice(0, 300)}`;
  }
  if (failed && /rate[ -]?limit|too many requests|\b429\b/i.test(failureText)) return `rate limited: ${failureText.slice(0, 300)}`;
  if (failed && /authentication|unauthorized|invalid api key|please run \/login|\b401\b/i.test(failureText)) {
    return `authentication failure: ${failureText.slice(0, 300)}`;
  }
  if (failed) return `Codex turn failed: ${String(failed.result ?? failed.subtype).slice(0, 300)}`;
  if (results.length && !loadedTools.includes(toolId("execute_code"))) {
    return "the connecta MCP server was not connected when the session started";
  }
  const apiError = results.find((event) => event.api_error_status != null);
  if (apiError) return `API error ${String(apiError.api_error_status)}: ${String(apiError.result ?? "").slice(0, 300)}`;
  if (results.length === 0) return `Codex produced no result (exit ${String(exitCode)})`;
  return undefined;
}

export function stopsBatch(error: string | undefined): boolean {
  return /rate or usage limit|rate limited|authentication failure|backend failure/i.test(error ?? "");
}

