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
  serverInfo: ConstructorParameters<typeof McpServer>[0];
  logger: Logger;
  activity?: ActivityStore;
  activityReadGate?: ActivityReadGate;
  activityDeploymentId?: string;
  deploymentInfo?: Record<string, unknown>;
  defaultToolTimeoutMs?: number;
  probeTimeoutMs?: number;
  discoveryConcurrency?: number;
  executor?: Executor;
  requestAdmission: AdmissionController;
  credentialVault?: CredentialVault;
  branding?: ConnectaBranding;
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

export function loggableValue(requested: string): string {
  const bounded = requested.slice(0, MAX_LOGGED_VALUE_LENGTH);
  const escaped = JSON.stringify(bounded).replace(
    /[\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
  return escaped + (bounded.length < requested.length ? " (truncated)" : "");
}

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
      uiAdminEligible?: boolean;
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

export function isToolkitRestricted(
  binding: ToolkitBinding | undefined,
): boolean {
  return Boolean(binding && !binding.unscoped);
}

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
