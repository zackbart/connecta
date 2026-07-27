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
import {
  credentialTestRule,
  describeCredentialTestMismatch,
  storedCredentialShape,
} from "./credentials.js";
import type { CredentialVault } from "./credentials.js";
import { ScopedRegistry, type Registry, type RegistryView } from "./registry.js";
import {
  resolveIdentityBinding,
  TOOLKIT_NAME_RE,
  type Toolkit,
} from "./toolkits.js";
import type {
  ConnectorContext,
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
  ExecutorAdmissionError,
  isAdmittingExecutor,
  type AdmissionController,
  type AdmissionLease,
} from "./executor-admission.js";
import {
  buildUiData,
  CONNECTA_FAVICON_SVG,
  credentialManagementCapability,
  operatorPageForPath,
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

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-request base64 nonce for an operator shell's scripts (Node 20+ and Workers). */
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
      <p><a href="/">Return to ${escapeHtml(brand.productName)}</a></p>
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
      /** True only when the admitting provider can also authorize UI mutation. */
      uiAdminEligible?: boolean;
      /** The admitting identity's toolkit binding (docs/toolkits.md). */
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
  // `gate` and `toolkits` (docs/toolkits.md). Stopping at the first would make
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
    // The declared credential shape picks the hook — the same single rule the
    // Credentials page asks for its Test affordance, so a shown button reaches
    // that reads the shape the credential was stored in.
    const rule = credentialTestRule(connector);
    if (!rule.mode) {
      return privateJson(
        {
          error: rule.mismatch
            ? "this connector cannot test its credential: " +
              describeCredentialTestMismatch(rule.mismatch)
            : "this connector does not support credential testing",
        },
        { status: 400 },
      );
    }
    try {
      const values = await opts.credentialVault.getAll(connectorId);
      const shape = storedCredentialShape(connector.credential, values);
      if (shape.state === "missing") {
        return privateJson(
          {
            error:
              rule.mode === "multiple"
                ? "configure the credentials before testing them"
                : "configure the credential before testing it",
          },
          { status: 409 },
        );
      }
      if (shape.state === "mismatch") {
        return privateJson({ error: shape.message }, { status: 409 });
      }
      const storedValues = values!;
      const ctx = opts.registry.contextFor(connectorId, baseUrl);
      let result;
      if (rule.mode === "multiple") {
        result = await connector.testCredentials!(storedValues, ctx);
      } else {
        result = await connector.testCredential!(storedValues.value, ctx);
      }
      // The operator just ran the very check the liveness sweep runs; record it
      // so cached status surfaces agree with what the operator page showed.
      await opts.registry.recordCredentialHealth(connectorId, {
        state: result.ok ? "ok" : "auth_required",
        checkedAt: new Date().toISOString(),
        ...(result.message ? { message: result.message } : {}),
      });
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
      await opts.registry.invalidateStored(connectorId);
      // The credential the last verdict judged is gone; judging its replacement
      // is the next check's job, not this one's.
      await opts.registry.clearCredentialHealth(connectorId);
      return privateJson({ credential: metadata });
    } catch (err) {
      return privateJson({ error: msg(err) }, { status: 400 });
    }
  }

  if (request.method === "DELETE") {
    await opts.credentialVault.delete(connectorId);
    await opts.registry.invalidateStored(connectorId);
    await opts.registry.clearCredentialHealth(connectorId);
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
 * identity id, or OAuth callback connector id) for the operator log. Goes
 * through JSON.stringify so a caller-controlled newline or control character
 * cannot forge a log line, plus a hand-rolled escape for U+2028/U+2029, which
 * JSON.stringify leaves raw even though a log reader treats them as line
 * terminators. Truncated to a small shared cap (also the toolkit response's echo
 * limit), so an oversized value cannot flood the log either.
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
 * enforcing the caller's toolkit binding (docs/toolkits.md) on the way.
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
    ...(runtimeContext
      ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
      : {}),
  });
  if (opts.executor) {
    registerExecuteTool(server, registry, {
      baseUrl,
      executor: opts.executor,
      logger: opts.logger,
      activity,
      requestSignal: request.signal,
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * Pay the storage read a real downstream-OAuth refusal pays, on the refusal
 * paths that would otherwise pay nothing.
 *
 * Identical bodies do not hide a connector id if the clock still sorts them.
 * `KvOAuthProvider.verifyState` reads `oauth:state` and its generation before
 * it can reject a mismatched value, so a configured id costs two storage round
 * trips on the ordinary path while an id naming nothing used to touch no I/O.
 * That gap is an oracle: sample the two and a wordlist recovers the connector
 * list the flat 400 was meant to withhold. So zero-I/O refusals read the same
 * keys in the same `conn:<id>:` namespace, where an unconfigured id gets misses.
 *
 * This is deliberately *not* a constant-time claim, and docs/connectors.md says
 * so in prose: a hit and a miss are not identical in a KV store, and a connector
 * shipping its own `verifyState` may do more or less work. What it
 * removes is the order-of-magnitude "no I/O versus a round trip" difference,
 * which is the only part of the signal that makes enumeration cheap.
 *
 * A throwing read is swallowed: the refusal is the answer either way, and
 * turning it into a 500 would hand back exactly the distinguishable response
 * this whole path exists to deny.
 */
async function equalizeRefusalCost(context: ConnectorContext): Promise<void> {
  try {
    await context.storage.get("oauth:state");
    await context.storage.get("oauth:generation");
  } catch {
    // Deliberately ignored — see above.
  }
}

async function handleOAuthCallback(
  url: URL,
  registry: Registry,
  baseUrl: string,
  logger: Logger,
  branding?: ConnectaBranding,
): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) return html(`Authorization denied: ${error}`, 400, branding);
  const code = url.searchParams.get("code");
  if (!code) return html("Missing authorization code.", 400, branding);
  const id = url.pathname.slice("/oauth/callback/".length);
  const connector = registry.getConnector(id);
  // Safe to build before we know the id names anything: `contextFor` is a pure
  // constructor — a namespaced storage view over `conn:<id>:` and, only for a
  // connector that declares one, a lazy credential accessor. It neither throws
  // nor touches storage for an unknown id, which is what lets the refusals
  // below borrow it to equalize their cost.
  const context = registry.contextFor(id, baseUrl);
  const refused = () =>
    html(
      "Authorization could not be completed. Re-run authorization from " +
        "connecta and try again.",
      400,
      branding,
    );
  if (!connector || !connector.finishAuth) {
    await equalizeRefusalCost(context);
    return refused();
  }
  // CSRF / login-fixation guard: this route is intentionally public, so verify
  // the `state` matches the flow connecta started BEFORE exchanging the code.
  if (!connector.verifyState) {
    await equalizeRefusalCost(context);
    logger.warn(
      `[connecta] refused an OAuth callback for connector ` +
        `${loggableValue(id)} with 400: it implements finishAuth but no ` +
        "verifyState, so connecta cannot establish that it started this flow. " +
        "No authorization code was exchanged. Implement verifyState before " +
        "trying again.",
    );
    return refused();
  }
  const state = url.searchParams.get("state");
  let stateMatches: boolean;
  try {
    stateMatches = await connector.verifyState(state, context);
  } catch (err) {
    logger.warn(
      `[connecta] refused an OAuth callback for connector ` +
        `${loggableValue(id)} with 400: verifyState threw ` +
        `${loggableValue(msg(err))}. No authorization code was exchanged. ` +
        "Re-run authorization from connecta and check the verifier if it " +
        "fails again.",
    );
    return refused();
  }
  if (!stateMatches) {
    logger.warn(
      `[connecta] refused an OAuth callback for connector ` +
        `${loggableValue(id)} with 400: ` +
        (state === null
          ? "the state parameter was missing"
          : "the state did not match the pending authorization flow") +
        ". No authorization code was exchanged. Re-run authorization from " +
        "connecta and try again.",
    );
    return refused();
  }
  try {
    await connector.finishAuth(code, context);
    await registry.invalidateStored(id);
    // Recovery, without a restart: the grant this connector was reported dead
    // for has just been replaced, so drop the verdict rather than let a stale
    // `auth_required` survive until the next scheduled check.
    await registry.clearCredentialHealth(id);
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
  return async function fetch(
    request: Request,
    runtimeContext?: RuntimeExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = publicUrl ?? url.origin;
    const path = url.pathname;
    const defer = runtimeContext
      ? runtimeContext.waitUntil.bind(runtimeContext)
      : undefined;

    /**
     * Piggyback a DUE credential liveness sweep on traffic that has already been
     * authenticated (issue #24). Started beside the request and never awaited by
     * it: it must not add latency or change a result, so it is handed to
     * `ctx.waitUntil` where the runtime has one (Workers, and the Node adapter's
     * shim) to settle after the response. The registry answers `undefined`
     * unless a sweep is actually due, so the ordinary request pays nothing.
     */
    const sweepCredentials = (): void => {
      // Belt and braces: a rejected sweep is already absorbed below, and this
      // catches the synchronous half — arming the gate, or a connector list that
      // throws while deciding whether anything is due. Nothing about a
      // background health check may turn a served request into a 500.
      try {
        const sweep = registry.sweepCredentialHealthIfDue(baseUrl, defer);
        if (!sweep) return;
        const settled = sweep.then(
          () => {},
          (err) => {
            opts.logger.warn("[connecta] credential health sweep failed", err);
          },
        );
        if (defer) defer(settled);
        else void settled;
      } catch (err) {
        opts.logger.warn("[connecta] credential health sweep failed", err);
      }
    };
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
      // Canonicalize the legacy bookmark while upgrading it so an old /ui URL
      // reaches the new Connections entry point in one permanent redirect.
      const targetPath = path === "/ui" ? "/" : url.pathname;
      // Assign the path and query onto the configured URL instead of resolving
      // attacker-controlled text against it. A pathname beginning with `//`
      // (including a backslash form normalized by URL parsing) is an authority
      // when passed to `new URL(value, base)` and would otherwise replace the
      // deployment host.
      const target = new URL(publicUrl);
      target.pathname = targetPath;
      target.search = url.search;
      target.hash = "";
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
        const codeAdmission =
          opts.executor && isAdmittingExecutor(opts.executor)
            ? opts.executor.admissionSnapshot?.()
            : undefined;
        return Response.json({
          status: "ok",
          connectors: registry.listConnectors().length,
          server: opts.serverInfo,
          admission: {
            policy: "global-fifo",
            requests: opts.requestAdmission.snapshot(),
            code: opts.executor
              ? (codeAdmission ?? { managedByExecutor: true })
              : null,
            reservedRoutes: [
              "/health",
              "/",
              "/credentials",
              "/activity",
              "/ui",
              "/ui/*",
            ],
          },
          ...(opts.deploymentInfo ? { deployment: opts.deploymentInfo } : {}),
        });
      }

      if (path.startsWith("/oauth/callback/")) {
        return handleOAuthCallback(
          url,
          registry,
          baseUrl,
          opts.logger,
          opts.branding,
        );
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
        if (request.method !== "GET") {
          return privateJson({ error: "method not allowed" }, { status: 405 });
        }
        const target = new URL(`/${url.search}`, baseUrl);
        return new Response(null, {
          status: 308,
          headers: { Location: target.toString() },
        });
      }

      const operatorPage = operatorPageForPath(path);
      if (operatorPage) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return privateJson({ error: "method not allowed" }, { status: 405 });
        }
        // Open shell — carries no operator data; everything comes from the
        // authenticated /ui/* APIs after the browser establishes a session.
        const uiAuth = auth.find((provider) => provider.uiAuth)?.uiAuth;
        const mcpUrl = new URL("/mcp", baseUrl).toString();
        // Nonce the page's inline script (and the Clerk loader). 'strict-dynamic'
        // lets scripts the nonced Clerk loader injects at runtime execute; the
        // https:/'unsafe-inline' fallbacks are ignored by CSP3 browsers that
        // honour the nonce and only cover legacy ones. No default-src, so Clerk's
        // style/font/network needs and the page's inline <style> stay unrestricted
        // — only script execution, the XSS sink, is gated.
        const nonce = uiScriptNonce();
        return new Response(
          request.method === "HEAD"
            ? null
            : renderUiHtml(uiAuth, mcpUrl, opts.branding, nonce, operatorPage),
          {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy":
                `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'; ` +
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
      }

      if (path === "/ui/data") {
        const authz = await authorize(request, baseUrl, auth, opts.logger);
        if (!authz.ok) return authz.response;
        if (isToolkitRestricted(authz.toolkitBinding)) {
          return restrictedOperatorSurface();
        }
        // After the restriction check, not before: an identity that may not
        // read this surface should not get to trigger background work from it.
        sweepCredentials();
        const eligibleClerkOperator = authz.uiAdminEligible === true;
        const credentialManagement = credentialManagementCapability({
          eligibleClerkOperator,
          hasCredentialSlots: registry
            .listConnectors()
            .some((connector) => Boolean(connector.credential)),
          hasCredentialVault: Boolean(opts.credentialVault),
        });
        const data = await buildUiData(
          registry,
          baseUrl,
          serverInfo,
          // The static headless bearer may read connector health, but only a
          // Clerk-authenticated operator receives credential metadata.
          eligibleClerkOperator ? opts.credentialVault : undefined,
          Boolean(opts.activity?.list),
          credentialManagement,
          opts.toolkits,
          defer,
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
          const authz = await authorize(request, baseUrl, auth, opts.logger);
          if (!authz.ok) {
            return releaseAdmissionWithResponse(
              withMcpCors(authz.response),
              admission,
              request.signal,
            );
          }
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
