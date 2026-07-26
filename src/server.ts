import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerExecuteTool } from "./execute.js";
import { registerMetaTools } from "./meta-tools.js";
import { CONNECTA_INSTRUCTIONS } from "./skills.js";
import type {
  ActivityActor,
  ActivityReadGate,
  ActivityRequestContext,
  ActivityStore,
} from "./activity.js";
import { InvalidActivityCursorError } from "./activity.js";
import type { CredentialVault } from "./credentials.js";
import { ScopedRegistry, type Registry, type RegistryView } from "./registry.js";
import {
  resolveIdentityBinding,
  TOOLKIT_NAME_RE,
  type Toolkit,
} from "./toolkits.js";
import type {
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  ConnectaBranding,
  Executor,
  InboundAuth,
  Logger,
  ToolkitBinding,
} from "./types.js";
import { CONNECTA_FAVICON_ICO } from "./favicon.js";
import {
  buildUiData,
  CONNECTA_FAVICON_SVG,
  resolveBranding,
  renderUiHtml,
} from "./ui.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-protocol-version, mcp-session-id",
};

/**
 * Headers that make an operator-supplied favicon body inert on this origin.
 * The SVG route is the sharp one: `image/svg+xml` is an *active* content type,
 * so a `<script>` inside a branding SVG would run on the deployment origin the
 * moment anyone navigated straight to `/favicon.svg` — strictly more powerful
 * than the `favicon.href` vector the branding gates close, because the payload
 * is same-origin. Neutralizing the response rather than inspecting the body
 * keeps every valid static SVG (the built-in mark included) byte-identical:
 *
 * - `sandbox` (no tokens ⇒ every restriction) drops the document into an opaque
 *   origin with scripting off, so even a script that ran would have nothing to
 *   reach.
 * - `default-src 'none'` denies script, network, and framing outright.
 * - `style-src 'unsafe-inline'` is the single allowance: the default mark styles
 *   itself inline to follow the OS colour scheme, and CSS cannot script.
 * - `nosniff` keeps the declared type authoritative in both directions — an SVG
 *   can never be re-read as HTML, and `.ico` bytes can never be re-read as SVG.
 *
 * `.ico` bodies are deliberately in scope: they are inert bytes rather than
 * active content, so they are still served verbatim, but they carry the same
 * headers so the invariant is "every favicon route is neutralized" rather than
 * "whichever route got attention".
 */
const INERT_ICON_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

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
  /** When set, the execute_code meta-tool is registered on top of the nine. */
  executor?: Executor;
  /** Encrypted connector-credential storage backing the authenticated /ui controls. */
  credentialVault?: CredentialVault;
  /** Optional browser UI and OAuth result-page labels. */
  branding?: ConnectaBranding;
  /**
   * Validated named scopes, selected per connection with `?toolkit=<name>` on
   * `/mcp`. Omit (or leave empty) and every connection sees the full registry.
   */
  toolkits?: ReadonlyMap<string, Toolkit>;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-request base64 nonce for the /ui page's inline scripts (Node 20+ and Workers). */
function uiScriptNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** `body` is escaped — callback params and error messages are attacker-influenced. */
function html(
  body: string,
  status = 200,
  branding?: ConnectaBranding,
): Response {
  const brand = resolveBranding(branding);
  const title = brand.pageTitle;
  const owner = brand.ownerName
    ? brand.ownerUrl
      ? `<a class="brand" href="${escapeHtml(brand.ownerUrl)}">${escapeHtml(brand.ownerName)}</a>`
      : `<span class="brand">${escapeHtml(brand.ownerName)}</span>`
    : brand.productUrl
      ? `<a class="brand" href="${escapeHtml(brand.productUrl)}">${escapeHtml(brand.productName)}</a>`
      : `<span class="brand">${escapeHtml(brand.productName)}</span>`;
  const product = brand.ownerName
    ? brand.productUrl
      ? `<a class="product" href="${escapeHtml(brand.productUrl)}">${escapeHtml(brand.productName)}</a>`
      : `<span class="product">${escapeHtml(brand.productName)}</span>`
    : "";
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="${escapeHtml(brand.themeColor)}">
<link rel="icon" href="${escapeHtml(brand.faviconHref)}" type="image/svg+xml">
<link rel="shortcut icon" href="/favicon.ico">
<title>${escapeHtml(title)}</title>
<style>
  * { border-radius: 0; box-sizing: border-box; }
  html { color: #000; background: #fff; font: 16px/1.5 "Helvetica Neue",
    Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  body { margin: 0; min-height: 100vh; }
  ::selection { color: #fff; background: #000; }
  .shell { margin: 0 auto; max-width: 70rem; padding: 1rem; }
  .grid { display: grid; gap: 1rem 1.5rem;
    grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .brand { font-weight: 500; grid-column: 1; text-decoration: none; }
  .product { grid-column: 2 / -1; }
  main { margin-top: 5rem; }
  h1, p { font: inherit; margin: 0; }
  h1 { grid-column: 1; }
  .copy { grid-column: 2 / -1; max-width: 34em; }
  .copy > * + * { margin-top: 1.5rem; }
  a { color: inherit; text-decoration: underline; text-decoration-thickness: 1.5px;
    text-underline-offset: .22em; }
  a:hover { text-decoration-color: transparent; }
  a:focus-visible { outline: 1px solid #000; outline-offset: 2px; }
  @media (max-width: 36.99rem) {
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .product { grid-column: 2; }
    main { margin-top: 3rem; }
    h1, .copy { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
  <header class="shell grid">
    ${owner}
    ${product}
  </header>
  <main class="shell grid">
    <h1>Connection status</h1>
    <div class="copy">
      <p>${escapeHtml(body)}</p>
      <p><a href="/ui">Return to ${escapeHtml(brand.productName)}</a></p>
    </div>
  </main>
</body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
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

async function authorize(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  logger: Logger,
): Promise<
  | {
      ok: true;
      actor: ActivityActor;
      providerKind?: string;
      userId?: string;
      /** The admitting identity's toolkit binding, if it has one (§16). */
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
      return {
        ok: true,
        actor: {
          kind: provider.kind,
          ...(subjectId ? { id: subjectId } : {}),
        },
        providerKind: provider.kind,
        ...(result.userId ? { userId: result.userId } : {}),
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

function privateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(body), { ...init, headers });
}

// Browser-based MCP clients call /mcp cross-origin. Without CORS on every
// response — errors included — the browser hides the 401, the client cannot
// read WWW-Authenticate, and OAuth discovery silently never starts.
function withMcpCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  headers.set(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, mcp-session-id, mcp-protocol-version",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withSecurityHeaders(
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
  if (path === "/ui") {
    // The /ui GET response ships its own nonce-based script CSP (which already
    // includes frame-ancestors 'none'); only fall back to the framing-only
    // directive when no CSP is present (e.g. HTTPS redirects, error responses).
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

async function authorizeUiAdmin(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  logger: Logger,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  // Credential mutation is intentionally narrower than /mcp and /ui/data: only
  // an interactive Clerk provider may admit it. A static bearer token is useful
  // for headless tool calls but must not become a vault-admin key.
  //
  // EVERY Clerk provider gets a turn, the way the /mcp gate does, because the
  // documented per-team pattern is several `clerkAuth(...)`s that differ only in
  // `gate` and `toolkits` (§16). Stopping at the first would make admission
  // depend on config order: the team-bound provider listed first would refuse
  // the operator outright, and a refusal here — a failed gate, a missing user, a
  // toolkit-bound identity — is exactly the case where a later provider is the
  // one meant to admit. The last refusal is returned if none do.
  const providers = auth.filter(
    (candidate) => candidate.uiAuth?.kind === "clerk",
  );
  if (providers.length === 0) {
    return {
      ok: false,
      response: privateJson(
        { error: "credential management requires Clerk authentication" },
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
        `[connecta] refused a credential-API request admitted by inbound auth ` +
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

function isSameOrigin(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

type CredentialInput =
  | { kind: "single"; value: string }
  | { kind: "multiple"; values: ConnectorCredentialValues };

async function readCredentialInput(
  request: Request,
  config: ConnectorCredentialConfig,
): Promise<
  { ok: true; input: CredentialInput } | { ok: false; response: Response }
> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return {
      ok: false,
      response: privateJson(
        { error: "Content-Type must be application/json" },
        { status: 415 },
      ),
    };
  }
  const raw = await request.text();
  if (raw.length > 20_000) {
    return {
      ok: false,
      response: privateJson(
        { error: "request body is too large" },
        { status: 413 },
      ),
    };
  }
  try {
    const body = JSON.parse(raw) as {
      value?: unknown;
      values?: unknown;
    };
    if (!config.fields?.length) {
      if (typeof body.value !== "string" || !body.value.trim()) {
        return {
          ok: false,
          response: privateJson(
            { error: "value must be a non-empty string" },
            { status: 400 },
          ),
        };
      }
      return { ok: true, input: { kind: "single", value: body.value } };
    }
    if (
      !body.values ||
      typeof body.values !== "object" ||
      Array.isArray(body.values)
    ) {
      return {
        ok: false,
        response: privateJson(
          { error: "values must be an object" },
          { status: 400 },
        ),
      };
    }
    const rawValues = body.values as Record<string, unknown>;
    const expected = new Set(config.fields.map((field) => field.name));
    const unexpected = Object.keys(rawValues).find(
      (field) => !expected.has(field),
    );
    if (unexpected) {
      return {
        ok: false,
        response: privateJson(
          { error: `unexpected credential field "${unexpected}"` },
          { status: 400 },
        ),
      };
    }
    const values: ConnectorCredentialValues = {};
    for (const field of config.fields) {
      const value = rawValues[field.name];
      if (typeof value !== "string" || !value.trim()) {
        return {
          ok: false,
          response: privateJson(
            { error: `${field.name} must be a non-empty string` },
            { status: 400 },
          ),
        };
      }
      values[field.name] = value;
    }
    return { ok: true, input: { kind: "multiple", values } };
  } catch {
    return {
      ok: false,
      response: privateJson({ error: "invalid JSON body" }, { status: 400 }),
    };
  }
}

async function handleCredentialRequest(
  request: Request,
  connectorId: string,
  action: string | undefined,
  opts: ServerOptions,
  baseUrl: string,
): Promise<Response> {
  if (!opts.credentialVault) {
    return privateJson(
      { error: "credential storage is not configured" },
      { status: 503 },
    );
  }
  if (!isSameOrigin(request, baseUrl)) {
    return privateJson(
      { error: "same-origin request required" },
      { status: 403 },
    );
  }
  const admin = await authorizeUiAdmin(
    request,
    baseUrl,
    opts.auth,
    opts.logger,
  );
  if (!admin.ok) return admin.response;

  const connector = opts.registry.getConnector(connectorId);
  if (!connector?.credential) {
    return privateJson({ error: "unknown credential slot" }, { status: 404 });
  }

  if (action === "test") {
    if (request.method !== "POST") {
      return privateJson({ error: "method not allowed" }, { status: 405 });
    }
    if (!connector.testCredential && !connector.testCredentials) {
      return privateJson(
        { error: "this connector does not support credential testing" },
        { status: 400 },
      );
    }
    try {
      const ctx = opts.registry.contextFor(connectorId, baseUrl);
      let result;
      if (connector.testCredentials) {
        const values = await opts.credentialVault.getAll(connectorId);
        if (!values) {
          return privateJson(
            { error: "configure the credentials before testing them" },
            { status: 409 },
          );
        }
        result = await connector.testCredentials(values, ctx);
      } else {
        const value = await opts.credentialVault.get(connectorId);
        if (!value) {
          return privateJson(
            { error: "configure the credential before testing it" },
            { status: 409 },
          );
        }
        result = await connector.testCredential!(value, ctx);
      }
      return privateJson(result);
    } catch (err) {
      return privateJson({ ok: false, message: msg(err) });
    }
  }

  if (action) {
    return privateJson({ error: "not found" }, { status: 404 });
  }

  if (request.method === "PUT") {
    const input = await readCredentialInput(request, connector.credential);
    if (!input.ok) return input.response;
    try {
      const metadata =
        input.input.kind === "single"
          ? await opts.credentialVault.set(
              connectorId,
              input.input.value,
              admin.userId,
            )
          : await opts.credentialVault.setAll(
              connectorId,
              input.input.values,
              admin.userId,
            );
      opts.registry.invalidate(connectorId);
      return privateJson({ credential: metadata });
    } catch (err) {
      return privateJson({ error: msg(err) }, { status: 400 });
    }
  }

  if (request.method === "DELETE") {
    await opts.credentialVault.delete(connectorId);
    opts.registry.invalidate(connectorId);
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  return privateJson({ error: "method not allowed" }, { status: 405 });
}

/** Length beyond which a rejected toolkit name is not echoed back. */
const MAX_ECHOED_TOOLKIT_NAME = 64;

/** What one MCP connection may see: the full registry, or one toolkit's view. */
interface McpScope {
  registry: RegistryView;
  /** Set only under `?toolkit=`; recorded on activity events. */
  toolkitId?: string;
}

/**
 * Bounded, escaped form of a caller-influenced value (a rejected toolkit name,
 * an identity id) for the operator log. Goes through JSON.stringify so a
 * caller-controlled newline or control character cannot forge a log line, plus a
 * hand-rolled escape for U+2028/U+2029, which JSON.stringify leaves raw even
 * though a log reader treats them as line terminators. Truncated to the same
 * length the response body echoes at, so an oversized value cannot flood the log
 * either.
 */
function loggableValue(requested: string): string {
  const bounded = requested.slice(0, MAX_ECHOED_TOOLKIT_NAME);
  const escaped = JSON.stringify(bounded).replace(
    /[\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
  return escaped + (bounded.length < requested.length ? " (truncated)" : "");
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
 * enforcing the caller's toolkit binding (§16) on the way.
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

/**
 * True when this identity is confined to one or more toolkits — bound, without
 * `unscoped`. Such a credential belongs to a team's agent, not to the operator
 * running the deployment, so the deployment-wide operator surfaces (`/ui/data`,
 * `/ui/activity`, the credential API) refuse it: their payloads describe every
 * connector in the org, which is exactly what the binding exists to withhold.
 */
function isToolkitRestricted(binding: ToolkitBinding | undefined): boolean {
  return Boolean(binding && !binding.unscoped);
}

/** The refusal the deployment-wide operator surfaces give a bound identity. */
function restrictedOperatorSurface(): Response {
  return privateJson(
    {
      error:
        "this credential is bound to a toolkit and may not read " +
        "deployment-wide operator data",
    },
    { status: 403 },
  );
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
    activity,
    defaultToolTimeoutMs: opts.defaultToolTimeoutMs,
    probeTimeoutMs: opts.probeTimeoutMs,
  });
  if (opts.executor) {
    registerExecuteTool(server, registry, {
      baseUrl,
      executor: opts.executor,
      logger: opts.logger,
      activity,
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function handleOAuthCallback(
  url: URL,
  registry: Registry,
  baseUrl: string,
  branding?: ConnectaBranding,
): Promise<Response> {
  const id = url.pathname.slice("/oauth/callback/".length);
  const connector = registry.getConnector(id);
  if (!connector || !connector.finishAuth) {
    return html(`Unknown connector "${id}".`, 404, branding);
  }
  const error = url.searchParams.get("error");
  if (error) return html(`Authorization denied: ${error}`, 400, branding);
  const code = url.searchParams.get("code");
  if (!code) return html("Missing authorization code.", 400, branding);
  const context = registry.contextFor(id, baseUrl);
  // CSRF / login-fixation guard: this route is intentionally public, so verify
  // the `state` matches the flow connecta started BEFORE exchanging the code.
  if (connector.verifyState) {
    const state = url.searchParams.get("state");
    const ok = await connector.verifyState(state, context);
    if (!ok) {
      return html(
        "Authorization state mismatch — this callback did not originate from " +
          "a flow started by connecta. Re-run authorization and try again.",
        400,
        branding,
      );
    }
  }
  try {
    await connector.finishAuth(code, context);
    await registry.invalidateStored(id);
    return html(
      `Connected "${id}". You can close this window.`,
      200,
      branding,
    );
  } catch (err) {
    return html(`Authorization failed: ${msg(err)}`, 500, branding);
  }
}

/** Build the Web-standard fetch handler that serves connecta. */
export function createFetchHandler(
  opts: ServerOptions,
): (
  request: Request,
  runtimeContext?: RuntimeExecutionContext,
) => Promise<Response> {
  const { registry, auth, publicUrl, serverInfo } = opts;
  return async function fetch(
    request: Request,
    runtimeContext?: RuntimeExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = publicUrl ?? url.origin;
    const path = url.pathname;
    // Container and orchestrator probes reach /health over plain HTTP on
    // loopback, where no proxy has set X-Forwarded-Proto. Redirecting them to
    // the public origin would make an internal liveness check depend on
    // external DNS, TLS, and the tunnel in front of connecta — so /health is
    // exempt. It is unauthenticated, returns no user data, and sets no
    // cookies, so forcing HTTPS on it protects nothing.
    if (
      publicUrl &&
      path !== "/health" &&
      new URL(publicUrl).protocol === "https:" &&
      url.protocol === "http:"
    ) {
      const target = new URL(`${url.pathname}${url.search}`, publicUrl);
      return withSecurityHeaders(
        new Response(null, {
          status: 308,
          headers: { Location: target.toString() },
        }),
        url,
        path,
      );
    }

    const route = async (): Promise<Response> => {
      const credentialMatch =
        /^\/ui\/credentials\/([a-z0-9_-]+)(?:\/([a-z]+))?$/.exec(path);
      if (credentialMatch) {
        // Never opt these mutation routes into the server's wildcard CORS
        // preflight behavior.
        if (request.method === "OPTIONS") {
          return privateJson({ error: "method not allowed" }, { status: 405 });
        }
        return handleCredentialRequest(
          request,
          credentialMatch[1],
          credentialMatch[2],
          opts,
          baseUrl,
        );
      }

      if (request.method === "OPTIONS") {
        for (const a of auth) {
          if (a.handleMetadata) {
            const r = await a.handleMetadata(request, baseUrl);
            if (r) return r;
          }
        }
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (path.startsWith("/.well-known/")) {
        for (const a of auth) {
          if (a.handleMetadata) {
            const r = await a.handleMetadata(request, baseUrl);
            if (r) return r;
          }
        }
        return new Response("Not Found", { status: 404 });
      }

      if (path === "/health") {
        return Response.json({
          status: "ok",
          connectors: registry.listConnectors().length,
          server: opts.serverInfo,
          ...(opts.deploymentInfo ? { deployment: opts.deploymentInfo } : {}),
        });
      }

      if (path.startsWith("/oauth/callback/")) {
        return handleOAuthCallback(url, registry, baseUrl, opts.branding);
      }

      if (request.method === "GET" && path === "/favicon.svg") {
        return new Response(opts.branding?.favicon?.svg ?? CONNECTA_FAVICON_SVG, {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=86400",
            ...INERT_ICON_HEADERS,
          },
        });
      }

      if (request.method === "GET" && path === "/favicon.ico") {
        return new Response(opts.branding?.favicon?.ico ?? CONNECTA_FAVICON_ICO, {
          headers: {
            "Content-Type": "image/x-icon",
            "Cache-Control": "public, max-age=86400",
            ...INERT_ICON_HEADERS,
          },
        });
      }

      if (path === "/ui") {
        // Open shell — carries no data; data comes only from the gated /ui/data.
        const uiAuth = auth.find((provider) => provider.uiAuth)?.uiAuth;
        const mcpUrl = new URL("/mcp", baseUrl).toString();
        // Nonce the page's inline script (and the Clerk loader). 'strict-dynamic'
        // lets scripts the nonced Clerk loader injects at runtime execute; the
        // https:/'unsafe-inline' fallbacks are ignored by CSP3 browsers that
        // honour the nonce and only cover legacy ones. No default-src, so Clerk's
        // style/font/network needs and the page's inline <style> stay unrestricted
        // — only script execution, the XSS sink, is gated.
        const nonce = uiScriptNonce();
        return new Response(renderUiHtml(uiAuth, mcpUrl, opts.branding, nonce), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'; ` +
              "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (path === "/ui/data") {
        const authz = await authorize(request, baseUrl, auth, opts.logger);
        if (!authz.ok) return authz.response;
        if (isToolkitRestricted(authz.toolkitBinding)) {
          return restrictedOperatorSurface();
        }
        const data = await buildUiData(
          registry,
          baseUrl,
          serverInfo,
          // The static headless bearer may read connector health, but only a
          // Clerk-authenticated operator receives credential metadata.
          authz.providerKind === "clerk" && authz.userId
            ? opts.credentialVault
            : undefined,
          Boolean(opts.activity?.list),
        );
        return privateJson(data);
      }

      if (path === "/ui/activity") {
        if (request.method !== "GET") {
          return privateJson({ error: "method not allowed" }, { status: 405 });
        }
        const authz = await authorize(request, baseUrl, auth, opts.logger);
        if (!authz.ok) return authz.response;
        if (isToolkitRestricted(authz.toolkitBinding)) {
          return restrictedOperatorSurface();
        }
        if (
          opts.activityReadGate &&
          !(await opts.activityReadGate(authz.actor))
        ) {
          return privateJson({ error: "forbidden" }, { status: 403 });
        }
        if (!opts.activity?.list) {
          return privateJson(
            { error: "activity history is not configured" },
            { status: 404 },
          );
        }
        const cursor = url.searchParams.get("cursor") ?? undefined;
        if (cursor && cursor.length > 500) {
          return privateJson({ error: "invalid cursor" }, { status: 400 });
        }
        const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isFinite(requestedLimit)
          ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
          : 50;
        try {
          return privateJson(await opts.activity.list({ cursor, limit }));
        } catch (error) {
          if (error instanceof InvalidActivityCursorError) {
            return privateJson({ error: error.message }, { status: 400 });
          }
          opts.logger.error("[connecta] activity read failed", error);
          return privateJson(
            { error: "activity history is temporarily unavailable" },
            { status: 503 },
          );
        }
      }

      if (path === "/mcp") {
        // Authenticate BEFORE resolving ?toolkit=: an unauthenticated caller
        // must not be able to probe which toolkit names exist.
        const authz = await authorize(request, baseUrl, auth, opts.logger);
        if (!authz.ok) return withMcpCors(authz.response);
        const selected = resolveToolkitScope(
          url,
          registry,
          opts.toolkits,
          opts.logger,
          {
            actor: authz.actor,
            ...(authz.toolkitBinding
              ? { binding: authz.toolkitBinding }
              : {}),
          },
        );
        if (!selected.ok) return withMcpCors(selected.response);
        return withMcpCors(
          await serveMcp(
            request,
            opts,
            baseUrl,
            authz.actor,
            selected.scope,
            runtimeContext,
          ),
        );
      }

      // Connector-owned public routes, dispatched last: a connector can add a
      // route but never shadow one of connecta's own. A throw here is the
      // connector's bug, not a missing route, so it surfaces as 500 rather
      // than falling through to 404.
      for (const connector of registry.listConnectors()) {
        if (!connector.handleRequest) continue;
        try {
          const connectorResponse = await connector.handleRequest(
            request,
            registry.contextFor(connector.id, baseUrl),
          );
          if (connectorResponse) return connectorResponse;
        } catch (error) {
          opts.logger.error(
            `[connecta] connector "${connector.id}" handleRequest failed`,
            error,
          );
          return new Response("Internal Server Error", { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    };
    return withSecurityHeaders(await route(), url, path);
  };
}

interface RuntimeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
