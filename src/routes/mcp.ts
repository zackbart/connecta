import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ActivityActor, ActivityRequestContext } from "../activity.js";
import { registerExecuteTool } from "../execute.js";
import {
  ExecutorAdmissionError,
  type AdmissionLease,
} from "../executor-admission.js";
import { registerMetaTools } from "../meta-tools.js";
import { ScopedRegistry, type Registry, type RegistryView } from "../registry.js";
import { CONNECTA_INSTRUCTIONS } from "../skills.js";
import { TOOLKIT_NAME_RE, type Toolkit } from "../toolkits.js";
import type { Logger, ToolkitBinding } from "../types.js";
import {
  MAX_ECHOED_TOOLKIT_NAME,
  authorize,
  loggableValue,
  type RouteContext,
  type RuntimeExecutionContext,
  type ServerOptions,
} from "./shared.js";

export const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-protocol-version, mcp-session-id",
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

/** What one MCP connection may see: the full registry, or one toolkit's view. */
interface McpScope {
  registry: RegistryView;
  /** Set only under `?toolkit=`; recorded on activity events. */
  toolkitId?: string;
}

/** The one refusal a bound identity ever sees. Constant on purpose — see below. */
const TOOLKIT_FORBIDDEN_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: null,
  error: {
    code: -32600,
    message:
      "Not permitted to use the requested toolkit. This credential is bound " +
      "to a specific toolkit — check the ?toolkit= value in this deployment's " +
      "MCP endpoint URL with the operator.",
  },
});

/**
 * 403 for every binding refusal, with a body that does not depend on WHY.
 *
 * A bound identity asking for a toolkit it may not open, for a toolkit that does
 * not exist, or for no toolkit at all gets byte-identical responses, so a team
 * credential cannot be used to enumerate the org's other teams — the boundary
 * would leak the very structure it exists to hide. The operator log below is
 * where the three cases are told apart.
 */
function toolkitForbidden(): Response {
  return new Response(TOOLKIT_FORBIDDEN_BODY, {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** How a rejected connection is named in the operator log. */
function identityLabel(actor: ActivityActor): string {
  return actor.id ? `${actor.kind} ${loggableValue(actor.id)}` : actor.kind;
}

/**
 * Resolve `?toolkit=<name>` into the registry view this connection may see,
 * enforcing the caller's toolkit binding (documentation/toolkits.md) on the way.
 *
 * For an UNBOUND identity (no binding configured — the pre-#37 shape):
 *
 * - absent → the full registry, byte-identical to a deployment with no toolkits
 * - known → a `ScopedRegistry` over that toolkit (the one visibility boundary)
 * - anything else, including `?toolkit=` with an empty value → an explicit
 *   404. Never a silent fallback to the full registry.
 *
 * For a BOUND identity, membership is checked FIRST and refusal is a flat 403:
 * a toolkit outside the binding, an unknown name, and (without `unscoped`) an
 * omitted `?toolkit=` are all refused before any `ScopedRegistry` is built, and
 * all three produce the same response.
 *
 * Neither error enumerates the configured toolkits: the name selects a scope, so
 * a wrong guess gets a flat refusal, not a directory.
 *
 * Because of that — and because SDK clients treat a 404/403 on the transport
 * endpoint as a transport failure and discard the body — every rejection is also
 * logged operator-side (issue #47), which is the channel that actually reaches a
 * human. The log line may name the configured or bound toolkits; the response
 * still may not.
 */
function resolveToolkitScope(
  url: URL,
  registry: Registry,
  toolkits: ReadonlyMap<string, Toolkit> | undefined,
  logger: Logger,
  identity: { actor: ActivityActor; binding?: ToolkitBinding },
):
  | { ok: true; scope: McpScope }
  | { ok: false; response: Response } {
  const requested = url.searchParams.get("toolkit");
  const binding = identity.binding;
  const scopeFor = (toolkit: Toolkit) => ({
    ok: true as const,
    scope: {
      registry: new ScopedRegistry(registry, toolkit),
      toolkitId: toolkit.name,
    },
  });

  if (binding) {
    const who = identityLabel(identity.actor);
    const bound = `Bound toolkits: ${binding.toolkits.join(", ") || "(none)"}${
      binding.unscoped ? ", plus unscoped access" : ""
    }.`;
    if (requested === null) {
      if (binding.unscoped) return { ok: true, scope: { registry } };
      logger.warn(
        `[connecta] refused an unscoped /mcp connection from ${who} with 403: ` +
          "its toolkit binding does not allow the full registry. " +
          bound +
          " The client sees a transport-level failure and never the reason, so " +
          "give it an MCP endpoint URL with a ?toolkit= value it is bound to.",
      );
      return { ok: false, response: toolkitForbidden() };
    }
    const permitted = binding.toolkits.includes(requested);
    const toolkit = permitted ? toolkits?.get(requested) : undefined;
    if (toolkit) return scopeFor(toolkit);
    logger.warn(
      `[connecta] refused an /mcp connection from ${who} with 403: it asked ` +
        `for toolkit ${loggableValue(requested)}, which ` +
        (permitted
          ? "its binding allows but this deployment does not configure"
          : "its toolkit binding does not include") +
        ". " +
        bound +
        " The client sees a transport-level failure and never the reason, so " +
        "check the ?toolkit= value in its MCP endpoint URL.",
    );
    return { ok: false, response: toolkitForbidden() };
  }

  if (requested === null) return { ok: true, scope: { registry } };
  const toolkit = toolkits?.get(requested);
  if (toolkit) return scopeFor(toolkit);
  const configured = toolkits && toolkits.size > 0 ? [...toolkits.keys()] : [];
  logger.warn(
    "[connecta] rejected an /mcp connection asking for unknown toolkit " +
      `${loggableValue(requested)} with 404. ` +
      (configured.length > 0
        ? `Configured toolkits: ${configured.join(", ")}.`
        : "This deployment configures no toolkits, so no ?toolkit= value is accepted.") +
      " The client sees a transport-level failure and never the reason, so " +
      "check the ?toolkit= value in its MCP endpoint URL.",
  );
  const label =
    requested.length <= MAX_ECHOED_TOOLKIT_NAME &&
    TOOLKIT_NAME_RE.test(requested)
      ? `"${requested}"`
      : "requested";
  return {
    ok: false,
    response: new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message:
            `Unknown toolkit ${label}. Check the ?toolkit= value in this ` +
            "deployment's MCP endpoint URL with the operator.",
        },
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    ),
  };
}

async function serveMcp(
  request: Request,
  opts: ServerOptions,
  baseUrl: string,
  actor: ActivityActor,
  scope: McpScope,
  runtimeContext?: RuntimeExecutionContext,
): Promise<Response> {
  // Fresh McpServer + transport per request (SDK ≥1.26 requirement), stateless.
  const server = new McpServer(opts.serverInfo, {
    instructions: CONNECTA_INSTRUCTIONS,
  });
  const activity: ActivityRequestContext | undefined = opts.activity
    ? {
        sink: opts.activity,
        actor,
        requestId: crypto.randomUUID(),
        serverInfo: opts.serverInfo,
        ...(opts.activityDeploymentId
          ? { deploymentId: opts.activityDeploymentId }
          : {}),
        ...(scope.toolkitId ? { toolkitId: scope.toolkitId } : {}),
        ...(runtimeContext?.waitUntil
          ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
          : {}),
        logger: opts.logger,
      }
    : undefined;
  // `scope.registry` is the connection's VIEW — the full registry, or one
  // toolkit's ScopedRegistry. Nothing below may reach for `opts.registry`.
  const registry = scope.registry;
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
    ...(runtimeContext
      ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
      : {}),
  });
  if (opts.executor) {
    registerExecuteTool(server, registry, {
      baseUrl,
      executor: opts.executor,
      logger: opts.logger,
      ...(activity ? { activity } : {}),
      requestSignal: request.signal,
      ...(opts.discoveryConcurrency !== undefined
        ? { discoveryConcurrency: opts.discoveryConcurrency }
        : {}),
    });
  }
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
      url,
      baseUrl,
      runtimeContext,
      sweepCredentials,
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
      // Authenticate BEFORE resolving ?toolkit=: an unauthenticated caller
      // must not be able to probe which toolkit names exist.
      const authz = await authorize(request, baseUrl, opts.auth, opts.logger);
      if (!authz.ok) {
        return releaseAdmissionWithResponse(
          withMcpCors(authz.response),
          admission,
          request.signal,
        );
      }
      const selected = resolveToolkitScope(
        url,
        opts.registry,
        opts.toolkits,
        opts.logger,
        {
          actor: authz.actor,
          ...(authz.toolkitBinding
            ? { binding: authz.toolkitBinding }
            : {}),
        },
      );
      if (!selected.ok) {
        return releaseAdmissionWithResponse(
          withMcpCors(selected.response),
          admission,
          request.signal,
        );
      }
      sweepCredentials();
      return releaseAdmissionWithResponse(
        withMcpCors(
          await serveMcp(
            request,
            opts,
            baseUrl,
            authz.actor,
            selected.scope,
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
