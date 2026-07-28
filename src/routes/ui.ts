import { CONNECTA_FAVICON_ICO } from "../favicon.js";
import {
  buildUiData,
  CONNECTA_FAVICON_SVG,
  credentialManagementCapability,
  operatorPageForPath,
  renderUiHtml,
} from "../ui.js";
import {
  authorize,
  isToolkitRestricted,
  privateJson,
  restrictedOperatorSurface,
  type RouteContext,
} from "./shared.js";

const INERT_ICON_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

function uiScriptNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function routeUi(
  context: RouteContext,
): Promise<Response | null> {
  const { request, url, path, baseUrl, opts, defer, sweepCredentials } =
    context;
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
    const uiAuth = opts.auth.find((provider) => provider.uiAuth)?.uiAuth;
    const mcpUrl = new URL("/mcp", baseUrl).toString();
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
  if (path !== "/ui/data") return null;

  const authz = await authorize(request, baseUrl, opts.auth, opts.logger);
  if (!authz.ok) return authz.response;
  if (isToolkitRestricted(authz.toolkitBinding)) {
    return restrictedOperatorSurface();
  }
  sweepCredentials();
  const eligibleClerkOperator = authz.uiAdminEligible === true;
  const credentialManagement = credentialManagementCapability({
    eligibleClerkOperator,
    hasCredentialSlots: opts.registry
      .listConnectors()
      .some((connector) => Boolean(connector.credential)),
    hasCredentialVault: Boolean(opts.credentialVault),
  });
  const data = await buildUiData(
    opts.registry,
    baseUrl,
    opts.serverInfo,
    eligibleClerkOperator ? opts.credentialVault : undefined,
    Boolean(opts.activity?.list),
    credentialManagement,
    opts.toolkits,
    defer,
    eligibleClerkOperator,
    opts.discoveryConcurrency,
  );
  return privateJson(data);
}
