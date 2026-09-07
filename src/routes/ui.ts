import { CONNECTA_VERSION } from "../version.js";
import { CONNECTA_FAVICON_ICO } from "../favicon.js";
import {
  buildUiData,
  CONNECTA_FAVICON_SVG,
  operatorPageForPath,
  renderUiHtml,
} from "../ui.js";
import {
  authorize,
  mayManageConnector,
  validateAuthPermissions,
  msg,
  privateJson,
  type RouteContext,
} from "./shared.js";

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

/** Per-request base64 nonce for an operator shell's scripts (Node 22+ and Workers). */
function uiScriptNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function routeUi(
  context: RouteContext,
): Promise<Response | null> {
  const { request, url, path, baseUrl, opts, defer, runtimeContext } = context;
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
  if (operatorPage && (operatorPage !== "activity" || opts.activity?.list)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return privateJson({ error: "method not allowed" }, { status: 405 });
    }
    // Open shell — carries no operator data; everything comes from the
    // authenticated /ui/* APIs after the browser establishes a session.
    const ambient = runtimeContext?.access
      ? opts.auth.find(
          (provider) => provider.uiAuth?.kind === "cloudflare-access",
        )?.uiAuth
      : undefined;
    const uiAuth = ambient ?? opts.auth.find(
      (provider) =>
        provider.uiAuth && provider.uiAuth.kind !== "cloudflare-access",
    )?.uiAuth;
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
  const detail = /^\/ui\/connectors\/([a-z0-9_-]+)$/.exec(path);
  if (path !== "/ui/data" && !detail) return null;
  if (request.method !== "GET") return privateJson({ error: "method not allowed" }, { status: 405 });

  const authz = await authorize(
    request,
    baseUrl,
    opts.auth,
    runtimeContext,
    opts.identity,
  );
  if (!authz.ok) return authz.response;
  let registry;
  try {
    validateAuthPermissions(authz, opts.registry);
    registry = opts.registry.scoped({
      connectorIds: authz.connectorIds,
      ...(authz.subjectKey ? { subjectKey: authz.subjectKey } : {}),
      ...(authz.principalKey ? { principalKey: authz.principalKey } : {}),
    });
  } catch (error) {
    return privateJson({ error: msg(error) }, { status: 403 });
  }
  const visible = registry.listConnectors();
  const mayManage = (id: string) => { const connector = registry.getConnector(id); return Boolean(connector && mayManageConnector(authz, connector)); };
  const permissions = (connector: typeof visible[number]) => ({
    use: true,
    manageSharedAuth: connector.authScope !== "personal" && mayManage(connector.id),
    connectPersonal: connector.authScope === "personal" && mayManage(connector.id),
  });
  const activityEnabled = Boolean(opts.activity?.list) && authz.operator;
  const credentialManagement = visible.some(c => c.credential && mayManage(c.id))
    ? opts.credentialVault ? "available" as const : "vault_not_configured" as const
    : authz.identity.interactive && !visible.some(c => c.credential) ? "no_slots" as const : "requires_operator" as const;
  if (detail) {
    const connector = registry.getConnector(detail[1]!);
    if (!connector) return privateJson({ error: "unknown connector" }, { status: 404 });
    const one = opts.registry.scoped({ connectorIds: [connector.id], ...(authz.subjectKey ? { subjectKey: authz.subjectKey } : {}), ...(authz.principalKey ? { principalKey: authz.principalKey } : {}) });
    const data = await buildUiData(one, baseUrl, opts.serverInfo, opts.credentialVault, activityEnabled, credentialManagement, defer, false, 1, authz.principalKey, { mayManage, timeoutMs: opts.probeTimeoutMs ?? 30_000, signal: request.signal });
    return privateJson({ ...data.connectors[0], permissions: permissions(connector) });
  }
  return privateJson({
    serverInfo: opts.serverInfo,
    connectaVersion: CONNECTA_VERSION,
    activityEnabled,
    credentialManagement,
    oauthManagement: visible.some(c => mayManage(c.id)),
    connectors: visible.map(c => ({ id: c.id, ...(c.title ? { title: c.title } : {}), ...(c.description ? { description: c.description } : {}), authScope: c.authScope ?? "shared", status: "loading", toolCount: 0, tools: [], oauth: Boolean(c.startAuth && c.disconnectAuth), permissions: permissions(c) })),
  });
}
