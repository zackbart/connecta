import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActivityActor, ActivityReadGate, ActivityStore } from "../activity.js";
import type { CredentialVault } from "../credentials.js";
import type { DeferredWork } from "../connector-scope.js";
import type { AdmissionController } from "../executor-admission.js";
import type { Registry } from "../registry.js";
import type {
  ConnectaBranding,
  Executor,
  InboundAuth,
  Logger,
} from "../types.js";
import { operatorPageForPath } from "../ui.js";

export interface ServerOptions {
  registry: Registry;
  auth: InboundAuth[];
  publicUrl?: string;
  // The SDK's Implementation shape: name/version plus optional title,
  // websiteUrl, and icons (MCP icons spec) that clients may render.
  serverInfo: ConstructorParameters<typeof McpServer>[0];
  logger: Logger;
  activity?: ActivityStore;
  activityReadGate?: ActivityReadGate;
  activityDeploymentId?: string;
  deploymentInfo?: Record<string, unknown>;
  /** Deadline for call_tool/batch_call calls that pass no timeoutMs. Off when unset. */
  defaultToolTimeoutMs?: number;
  /** Per-connector deadline for the list/search/describe probe fan-out. Default 30_000. */
  probeTimeoutMs?: number;
  /** Maximum simultaneous connector discovery operations. Default 4. */
  discoveryConcurrency?: number;
  /** When set, the execute_code meta-tool is registered on top of the nine. */
  executor?: Executor;
  /** Global FIFO boundary for all non-preflight `/mcp` requests. */
  requestAdmission: AdmissionController;
  /** Encrypted connector-credential storage backing the Credentials page. */
  credentialVault?: CredentialVault;
  /** Optional browser UI and OAuth result-page labels. */
  branding?: ConnectaBranding;
}

export interface RuntimeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RouteContext {
  request: Request;
  url: URL;
  path: string;
  baseUrl: string;
  opts: ServerOptions;
  defer: DeferredWork | undefined;
  runtimeContext: RuntimeExecutionContext | undefined;
}

export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function privateJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(body), { ...init, headers });
}

const MAX_LOGGED_VALUE_LENGTH = 64;

/**
 * Bounded, escaped form of a caller-influenced value (an identity id or OAuth
 * callback connector id) for the operator log. Goes
 * through JSON.stringify so a caller-controlled newline or control character
 * cannot forge a log line, plus a hand-rolled escape for U+2028/U+2029, which
 * JSON.stringify leaves raw even though a log reader treats them as line
 * terminators. Truncated to a small shared cap so an oversized value cannot
 * flood the log either.
 */
export function loggableValue(requested: string): string {
  const bounded = requested.slice(0, MAX_LOGGED_VALUE_LENGTH);
  const escaped = JSON.stringify(bounded).replace(
    /[\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
  return escaped + (bounded.length < requested.length ? " (truncated)" : "");
}

const ACTIVITY_ACTOR_NAMESPACE_RE = /^[\x21-\x7e]{1,256}$/;

export function activityActorNamespace(
  provider: InboundAuth,
): string | undefined {
  return typeof provider.activityActorNamespace === "string" &&
    ACTIVITY_ACTOR_NAMESPACE_RE.test(provider.activityActorNamespace)
    ? provider.activityActorNamespace
    : undefined;
}

export async function authorize(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  _logger: Logger,
): Promise<
  | {
      ok: true;
      actor: ActivityActor;
      /** True only when the admitting provider can also authorize UI mutation. */
      uiAdminEligible?: boolean;
    }
  | { ok: false; response: Response }
> {
  if (auth.length === 0) {
    return { ok: true, actor: { kind: "anonymous" } };
  }
  let lastResponse: Response | null = null;
  for (const provider of auth) {
    const result = await provider.authorize(request, baseUrl);
    if (result.ok) {
      const subjectId = result.subjectId ?? result.userId;
      const actorNamespace = activityActorNamespace(provider);
      return {
        ok: true,
        actor: {
          kind: provider.kind,
          ...(subjectId ? { id: subjectId } : {}),
          ...(subjectId && actorNamespace
            ? { namespace: actorNamespace }
            : {}),
        },
        ...(result.userId && provider.uiAuth?.kind === "clerk"
          ? { uiAdminEligible: true }
          : {}),
      };
    }
    lastResponse = result.response;
  }
  return {
    ok: false,
    response:
      lastResponse ??
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      }),
  };
}

export async function authorizeUiAdmin(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  _logger: Logger,
  purpose = "credential management",
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  // Operator mutation is intentionally narrower than /mcp and /ui/data: only
  // an interactive Clerk provider may admit it. A static bearer token is useful
  // for headless tool calls but must not become a deployment-admin key.
  //
  // Every Clerk provider gets a turn, the way the /mcp gate does. Stopping at
  // the first would make admission depend on config order: a failed gate or
  // missing user may simply mean a later provider is the one meant to admit.
  // The last refusal is returned if none do.
  const providers = auth.filter(
    (candidate) => candidate.uiAuth?.kind === "clerk",
  );
  if (providers.length === 0) {
    return {
      ok: false,
      response: privateJson(
        { error: `${purpose} requires Clerk authentication` },
        { status: 403 },
      ),
    };
  }
  let lastResponse: Response | null = null;
  for (const provider of providers) {
    const result = await provider.authorize(request, baseUrl);
    if (!result.ok) {
      lastResponse = result.response;
      continue;
    }
    if (!result.userId) {
      lastResponse = privateJson(
        { error: "authenticated user required" },
        { status: 403 },
      );
      continue;
    }
    return { ok: true, userId: result.userId };
  }
  return {
    ok: false,
    response:
      lastResponse ??
      privateJson({ error: "forbidden" }, { status: 403 }),
  };
}

export function isSameOrigin(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function withSecurityHeaders(
  response: Response,
  requestUrl: URL,
  path: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (requestUrl.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (operatorPageForPath(path) || path === "/ui") {
    // Operator HTML responses ship their own nonce-based script CSP (which
    // already includes frame-ancestors 'none'); only fall back to the
    // framing-only directive when no CSP is present (for example redirects).
    if (!headers.has("Content-Security-Policy")) {
      headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    }
    headers.set("X-Frame-Options", "DENY");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
