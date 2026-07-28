import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActivityActor, ActivityReadGate, ActivityStore } from "../activity.js";
import type { CredentialVault } from "../credentials.js";
import type { DeferredWork } from "../connector-scope.js";
import type { AdmissionController } from "../executor-admission.js";
import type { Registry } from "../registry.js";
import { resolveIdentityBinding, type Toolkit } from "../toolkits.js";
import type {
  ConnectaBranding,
  Executor,
  InboundAuth,
  Logger,
  ToolkitBinding,
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
  /**
   * Validated named scopes, selected per connection with `?toolkit=<name>` on
   * `/mcp`. Omit (or leave empty) and every connection sees the full registry.
   */
  toolkits?: ReadonlyMap<string, Toolkit>;
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
  sweepCredentials(): void;
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
 * Bounded, escaped form of a caller-influenced value (a rejected toolkit name,
 * identity id, or OAuth callback connector id) for the operator log. Goes
 * through JSON.stringify so a caller-controlled newline or control character
 * cannot forge a log line, plus a hand-rolled escape for U+2028/U+2029, which
 * JSON.stringify leaves raw even though a log reader treats them as line
 * terminators. Truncated to a small shared cap (also the toolkit response's echo
 * limit), so an oversized value cannot flood the log either.
 */
export function loggableValue(requested: string): string {
  const bounded = requested.slice(0, MAX_LOGGED_VALUE_LENGTH);
  const escaped = JSON.stringify(bounded).replace(
    /[\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
  return escaped + (bounded.length < requested.length ? " (truncated)" : "");
}

/** Length beyond which a rejected toolkit name is not echoed back. */
export const MAX_ECHOED_TOOLKIT_NAME = MAX_LOGGED_VALUE_LENGTH;

const ACTIVITY_ACTOR_NAMESPACE_RE = /^[\x21-\x7e]{1,256}$/;

export function activityActorNamespace(
  provider: InboundAuth,
): string | undefined {
  return typeof provider.activityActorNamespace === "string" &&
    ACTIVITY_ACTOR_NAMESPACE_RE.test(provider.activityActorNamespace)
    ? provider.activityActorNamespace
    : undefined;
}

/**
 * Refusal for an identity whose toolkit binding cannot be trusted — a malformed
 * declaration, or a malformed per-identity binding out of `authorize`. The
 * caller is authenticated, so this is a 403, and it is deliberately opaque: the
 * cause is an operator bug, and the operator reads it in the log, not the client.
 */
function unusableBinding(): Response {
  return privateJson({ error: "forbidden" }, { status: 403 });
}

export async function authorize(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  logger: Logger,
): Promise<
  | {
      ok: true;
      actor: ActivityActor;
      /** True only when the admitting provider can also authorize UI mutation. */
      uiAdminEligible?: boolean;
      /** The admitting identity's toolkit binding (documentation/toolkits.md). */
      toolkitBinding?: ToolkitBinding;
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
      // Re-validate both halves and cap the per-identity one by the provider's
      // declaration (see resolveIdentityBinding). A binding that does not
      // type-check at runtime refuses the request rather than evaporating:
      // dropping it would hand the caller the full registry, which is the one
      // outcome a binding exists to prevent.
      const binding = resolveIdentityBinding(
        provider.toolkitBinding,
        result.toolkitBinding,
      );
      if (!binding.ok) {
        logger.warn(
          `[connecta] refused a request admitted by inbound auth provider ` +
            `"${provider.kind}" with 403: ${binding.reason}. Until it is fixed ` +
            "this provider cannot admit anyone, because connecta cannot tell " +
            "which toolkits the identity may use.",
        );
        return { ok: false, response: unusableBinding() };
      }
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
        ...(binding.binding ? { toolkitBinding: binding.binding } : {}),
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

/**
 * True when this identity is confined to one or more toolkits — bound, without
 * `unscoped`. Such a credential belongs to a team's agent, not to the operator
 * running the deployment, so the deployment-wide operator surfaces (`/ui/data`,
 * `/ui/activity`, the credential API) refuse it: their payloads describe every
 * connector in the org, which is exactly what the binding exists to withhold.
 */
export function isToolkitRestricted(
  binding: ToolkitBinding | undefined,
): boolean {
  return Boolean(binding && !binding.unscoped);
}

/** The refusal the deployment-wide operator surfaces give a bound identity. */
export function restrictedOperatorSurface(): Response {
  return privateJson(
    {
      error:
        "this credential is bound to a toolkit and may not read " +
        "deployment-wide operator data",
    },
    { status: 403 },
  );
}

export async function authorizeUiAdmin(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  logger: Logger,
  purpose = "credential management",
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  // Operator mutation is intentionally narrower than /mcp and /ui/data: only
  // an interactive Clerk provider may admit it. A static bearer token is useful
  // for headless tool calls but must not become a deployment-admin key.
  //
  // EVERY Clerk provider gets a turn, the way the /mcp gate does, because the
  // documented per-team pattern is several `clerkAuth(...)`s that differ only in
  // `gate` and `toolkits` (documentation/toolkits.md). Stopping at the first would make
  // admission depend on config order: the team-bound provider listed first
  // would refuse the operator outright, and a refusal here — a failed gate, a
  // missing user, a toolkit-bound identity — is exactly the case where a later
  // provider is the one meant to admit. The last refusal is returned if none do.
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
    const binding = resolveIdentityBinding(
      provider.toolkitBinding,
      result.toolkitBinding,
    );
    if (!binding.ok) {
      logger.warn(
        `[connecta] refused an operator-mutation request admitted by inbound auth ` +
          `provider "${provider.kind}" with 403: ${binding.reason}.`,
      );
      lastResponse = unusableBinding();
      continue;
    }
    // A toolkit-bound identity is a team's credential, not a vault admin key:
    // credentials are deployment-wide, so writing one reaches every toolkit.
    if (isToolkitRestricted(binding.binding)) {
      lastResponse = restrictedOperatorSurface();
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
