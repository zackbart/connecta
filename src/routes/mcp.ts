import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { ActivityActor, ActivityRequestContext } from "../activity.js";
import {
  MCP_APPS_EXTENSION,
  PROGRAM_UI_MIME_TYPE,
  PROGRAM_UI_RESOURCE_URI,
  PROGRAM_UI_SHELL_HTML,
} from "../apps-shell.js";
import { registerExecuteTool } from "../execute.js";
import {
  ExecutorAdmissionError,
  type AdmissionLease,
} from "../executor-admission.js";
import { registerMetaTools } from "../meta-tools.js";
import type { RegistryView } from "../registry.js";
import { instructionsFor } from "../skills.js";
import type { Logger } from "../types.js";
import {
  authorize,
  type RouteContext,
  type RuntimeExecutionContext,
  type ServerOptions,
} from "./shared.js";

export const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name",
};

// Browser-based MCP clients call /mcp cross-origin. Without CORS on every
// response — errors included — the browser hides the 401, the client cannot
// read WWW-Authenticate, and OAuth discovery silently never starts.
function withMcpCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) {
    headers.set(name, value);
  }
  headers.set(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Retry-After, mcp-session-id, mcp-protocol-version",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestAdmissionFailure(error: ExecutorAdmissionError): Response {
  const overloaded = error.code === "executor_overloaded";
  const data = {
    code: overloaded ? "server_overloaded" : "server_shutting_down",
    retryable: overloaded,
    ...(overloaded && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  if (overloaded && error.retryAfterMs !== undefined) {
    headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
    );
  }
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: overloaded ? -32001 : -32002,
        message: overloaded
          ? "Server capacity is exhausted. Retry later."
          : "Server is shutting down.",
        data,
      },
    }),
    { status: 503, headers },
  );
}

/**
 * A request owns its permit through the response body, not merely until the
 * handler returns. This is what makes slow clients and response-stream failure
 * part of the same bounded lifecycle as success, error, and cancellation.
 */
function releaseAdmissionWithResponse(
  response: Response,
  lease: AdmissionLease,
  signal: AbortSignal,
): Response {
  let released = false;
  let onAbort = () => {};
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", onAbort);
    lease.release();
  };
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  onAbort = () => {
    // `cancel()` belongs to an operator/auth/SDK-provided stream and may
    // reject. Consume both outcomes: `.finally(release)` would release the
    // permit but preserve the rejection as an unhandled promise.
    void reader.cancel(signal.reason).then(release, release);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 404 for any `?toolkit=` value, kept after the feature's retirement (#178).
 *
 * Toolkits are gone, but the URLs that named them are not: clients were handed
 * MCP endpoint URLs with `?toolkit=` baked in, and nothing about upgrading the
 * server rotates them. Silently serving those clients the full registry would
 * turn a former scoping boundary into fail-open — so a request still sending
 * the param gets the same explicit 404 an unknown toolkit got before, plus an
 * operator-side log line, which (as ever — issue #47) is the channel that
 * actually reaches a human.
 */
function toolkitRetired(logger: Logger): Response {
  logger.warn(
    "[connecta] rejected an /mcp connection carrying ?toolkit= with 404: " +
      "toolkits were retired in issue #178 (see ethos.md) — one deployment " +
      "serves one audience. The client sees a transport-level failure and " +
      "never the reason, so remove the ?toolkit= value from its MCP endpoint " +
      "URL, or point it at the deployment for its audience.",
  );
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "This deployment does not accept ?toolkit=. Toolkits were retired " +
          "in issue #178 — remove the ?toolkit= value from the MCP endpoint " +
          "URL, or ask the operator for the deployment serving this audience.",
      },
    }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * U5: one static template, served by a handler that answers exactly one URI
 * and fails on every other. Registering it is also what declares the
 * `resources` capability — which is why `resources/list` has to answer, and
 * why it answers with nothing. That is the Apps spec's permitted omission of
 * UI-only resources from listing, taken exactly: the capability stays honest
 * because the method answers, and nothing downstream is ever listed or
 * aggregated. Widening this handler to proxy downstream templates is a
 * decision (see the design record), not a diff.
 */
function registerProgramUiResource(server: McpServer): void {
  server.registerResource(
    "connecta-program-ui",
    PROGRAM_UI_RESOURCE_URI,
    {
      title: "connecta program view",
      description:
        "The MCP Apps shell that renders HTML an execute_code program handed connecta.ui.",
      mimeType: PROGRAM_UI_MIME_TYPE,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: PROGRAM_UI_MIME_TYPE,
          text: PROGRAM_UI_SHELL_HTML,
        },
      ],
    }),
  );
  // The SDK's generated listing would advertise the template it just
  // registered. Replace it rather than accept that: the URI reaches the host
  // through tool metadata, so the listing has nothing to carry.
  server.server.setRequestHandler("resources/list", () => ({ resources: [] }));
}

async function serveMcp(
  request: Request,
  opts: ServerOptions,
  baseUrl: string,
  actor: ActivityActor,
  registry: RegistryView,
  runtimeContext?: RuntimeExecutionContext,
): Promise<Response> {
  const createServer = (): McpServer => {
    const server = new McpServer(opts.serverInfo, {
      instructions: instructionsFor(),
      // U11: the Apps extension must be explicitly negotiated, and a
      // conforming client acts on an extension only when both sides declare
      // it — without this line no host reads execute_code's _meta.ui, no host
      // fetches the shell, and the whole design is inert. This is the one
      // extension connecta advertises; the versioned extensions framework
      // stays declined as a general surface (https://github.com/zackbart/connecta/blob/main/records/mcp-2026-07-28.md).
      capabilities: {
        extensions: {
          [MCP_APPS_EXTENSION]: { mimeTypes: [PROGRAM_UI_MIME_TYPE] },
        },
        // Registering the shell below declares `resources` on its own, but it
        // would default `listChanged` to true. Connecta serves one build-time
        // template and never sends a list_changed notification, so say so:
        // a client that subscribes on the strength of that flag would wait
        // forever for an event this server has no way to produce.
        resources: { listChanged: false },
      },
      cacheHints: {
        "tools/list": {
          ttlMs: 3_600_000,
          cacheScope: "private",
        },
      },
    });
    registerProgramUiResource(server);
    const activity: ActivityRequestContext | undefined = opts.activity
      ? {
          sink: opts.activity,
          actor,
          requestId: crypto.randomUUID(),
          serverInfo: opts.serverInfo,
          ...(opts.activityDeploymentId
            ? { deploymentId: opts.activityDeploymentId }
            : {}),
          ...(runtimeContext?.waitUntil
            ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
            : {}),
          logger: opts.logger,
        }
      : undefined;
    registerMetaTools(server, registry, {
      baseUrl,
      ...(activity ? { activity } : {}),
      ...(opts.defaultToolTimeoutMs !== undefined
        ? { defaultToolTimeoutMs: opts.defaultToolTimeoutMs }
        : {}),
      ...(opts.probeTimeoutMs !== undefined
        ? { probeTimeoutMs: opts.probeTimeoutMs }
        : {}),
      ...(opts.discoveryConcurrency !== undefined
        ? { discoveryConcurrency: opts.discoveryConcurrency }
        : {}),
      requestSignal: request.signal,
      ...(runtimeContext?.waitUntil
        ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
        : {}),
    });
    registerExecuteTool(server, registry, {
      baseUrl,
      executor: opts.executor,
      logger: opts.logger,
      ...(activity ? { activity } : {}),
      requestSignal: request.signal,
      ...(runtimeContext?.waitUntil
        ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
        : {}),
      ...(opts.discoveryConcurrency !== undefined
        ? { discoveryConcurrency: opts.discoveryConcurrency }
        : {}),
      ...(opts.probeTimeoutMs !== undefined
        ? { probeTimeoutMs: opts.probeTimeoutMs }
        : {}),
      ...(opts.maxEmittedBytes !== undefined
        ? { maxEmittedBytes: opts.maxEmittedBytes }
        : {}),
      ...(opts.maxEmittedBlocks !== undefined
        ? { maxEmittedBlocks: opts.maxEmittedBlocks }
        : {}),
    });
    return server;
  };

  // The v2 entry's built-in legacy fallback streams 2025 results as SSE.
  // Connecta's established wire contract is JSON, so retain the documented
  // user-land legacy branch with the same transport setting while the modern
  // branch uses the fetch-native handler.
  if (!(await isLegacyRequest(request))) {
    return createMcpHandler(createServer, {
      legacy: "reject",
      onerror: (error) => opts.logger.error("[connecta] MCP handler error", error),
    }).fetch(request);
  }

  // Fresh server + transport per legacy request, stateless and JSON-shaped.
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export function createMcpRoute(
  opts: ServerOptions,
): (context: RouteContext) => Promise<Response | null> {
  let lastAdmissionWarningAt = 0;
  let suppressedAdmissionWarnings = 0;
  const warnAdmissionRejected = (error: ExecutorAdmissionError): void => {
    const now = Date.now();
    if (now - lastAdmissionWarningAt < 1_000) {
      suppressedAdmissionWarnings++;
      return;
    }
    opts.logger.warn("[connecta] MCP request admission rejected", {
      retryAfterMs: error.retryAfterMs,
      active: opts.requestAdmission.activeCount,
      queued: opts.requestAdmission.queuedCount,
      suppressedSinceLastWarning: suppressedAdmissionWarnings,
    });
    lastAdmissionWarningAt = now;
    suppressedAdmissionWarnings = 0;
  };

  return async function routeMcp(
    context: RouteContext,
  ): Promise<Response | null> {
    const {
      path,
      request,
      baseUrl,
      runtimeContext,
    } = context;
    if (path !== "/mcp") return null;
    let admission: AdmissionLease;
    try {
      admission = await opts.requestAdmission.acquire({
        signal: request.signal,
      });
      if (admission.waitMs > 0) {
        opts.logger.debug("[connecta] MCP request admitted after queue wait", {
          waitMs: admission.waitMs,
          active: opts.requestAdmission.activeCount,
          queued: opts.requestAdmission.queuedCount,
        });
      }
    } catch (error) {
      if (
        error instanceof ExecutorAdmissionError &&
        error.code === "executor_cancelled"
      ) {
        throw request.signal.reason ?? error;
      }
      if (error instanceof ExecutorAdmissionError) {
        if (error.code === "executor_overloaded") {
          warnAdmissionRejected(error);
        }
        return withMcpCors(requestAdmissionFailure(error));
      }
      throw error;
    }
    try {
      const authz = await authorize(request, baseUrl, opts.auth);
      if (!authz.ok) {
        return releaseAdmissionWithResponse(
          withMcpCors(authz.response),
          admission,
          request.signal,
        );
      }
      if (new URL(request.url).searchParams.has("toolkit")) {
        return releaseAdmissionWithResponse(
          withMcpCors(toolkitRetired(opts.logger)),
          admission,
          request.signal,
        );
      }
      return releaseAdmissionWithResponse(
        withMcpCors(
          await serveMcp(
            request,
            opts,
            baseUrl,
            authz.actor,
            opts.registry,
            runtimeContext,
          ),
        ),
        admission,
        request.signal,
      );
    } catch (error) {
      admission.release();
      throw error;
    }
  };
}
