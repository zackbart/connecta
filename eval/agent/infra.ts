import { toolId, type StreamEvent } from "./trace.js";

export function infraError(events: StreamEvent[], exitCode: number | null, loadedTools: string[]): string | undefined {
  const results = events.filter((event) => event.type === "result");
  const failed = results.find((event) => event.subtype !== "success");
  const failureText = String(failed?.result ?? "");
  const info = failed?.codex_error_info;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  if (["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"].includes(code ?? "")) {
    return `rate or usage limit (${code}): ${failureText.slice(0, 300)}`;
  }
  if (code === "unauthorized") return `authentication failure: ${failureText.slice(0, 300)}`;
  if (
    [
      "serverOverloaded",
      "internalServerError",
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ].includes(code ?? "")
  ) {
    return `backend failure (${code}): ${failureText.slice(0, 300)}`;
  }
  if (failed && /rate[ -]?limit|too many requests|\b429\b/i.test(failureText))
    return `rate limited: ${failureText.slice(0, 300)}`;
  if (failed && /authentication|unauthorized|invalid api key|please run \/login|\b401\b/i.test(failureText)) {
    return `authentication failure: ${failureText.slice(0, 300)}`;
  }
  if (failed) return `Agent turn failed: ${String(failed.result ?? failed.subtype)}`;
  if (results.length && !loadedTools.includes(toolId("skills"))) {
    return "the connecta MCP server was not connected when the session started";
  }
  const apiError = results.find((event) => event.api_error_status != null);
  if (apiError) return `API error ${String(apiError.api_error_status)}: ${String(apiError.result ?? "").slice(0, 300)}`;
  if (results.length === 0) return `Agent produced no result (exit ${String(exitCode)})`;
  return undefined;
}

/**
 * Not a result: the reload revoked the host's token and dropped observed programs.
 * Agent trials serve a frozen snapshot, so a source edit in this checkout cannot do it.
 */
export const WORKER_RELOADED =
  "Worker reloaded during the trial: its process restarted or its served snapshot changed, which rotated the host's token";

/**
 * A rejected or unreachable connection at trial end means the host lost its
 * deployment mid-conversation, so the transcript does not measure the agent.
 * A slow answer proves nothing and is not treated as a loss.
 */
export async function connectionLost(mcpUrl: string, token: string): Promise<string | undefined> {
  try {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return response.status === 401 || response.status === 403
      ? `the deployment rejected the agent's token at trial end (HTTP ${response.status})`
      : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return undefined;
    return `the deployment was unreachable at trial end: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A reload explains a rejected token, so it wins over the loss the rejection looks like. */
export function trialInfraFailure(
  reloaded: boolean | undefined,
  lost: string | undefined,
  infra: string | undefined,
): string | undefined {
  return reloaded ? WORKER_RELOADED : (lost ?? infra);
}

export function stopsBatch(error: string | undefined): boolean {
  return /rate or usage limit|rate limited|authentication failure|backend failure|outside the fake MCP config|inventory could not be verified|served graph/i.test(
    error ?? "",
  );
}
