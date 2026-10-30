import { withDeadlineEffect } from "../runtime/run.js";
import { operatorAsset } from "../operator-ui/assets.js";
import { operatorActivityContext } from "./activity-context.js";
import { isSafeHttpsUrl } from "../branding.js";
import { htmlSecurityHeaders } from "../html-security.js";
import { oauthConnectUrl, oauthConnectUnavailable } from "../oauth-handoff.js";
import { authorizationCredential } from "../inbound-credential.js";
import { Effect } from "effect";
import { CONNECTA_VERSION } from "../version.js";
import { CONNECTA_FAVICON_ICO } from "../favicon.js";
import type { RegistryView } from "../registry.js";
import type { Connector } from "../types.js";
import { CONNECTA_FAVICON_SVG, operatorPageForPath, renderUiHtml } from "../ui.js";
import {
  authorized,
  operatorViewerKey,
  refuse,
  scopeFor,
  serveOperator,
  visibleRegistry,
  type Answer,
  type Authorized,
} from "./operator.js";
import { managesAgentTokens, mayManageConnector, privateJson, readsActivity, type RouteContext } from "./shared.js";
import { routeUiConfig, scanOperatorActivity } from "./ui-config.js";
import { uiData } from "./ui-data.js";

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
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

export async function routeUi(context: RouteContext): Promise<Response | null> {
  const { request, url, path, baseUrl, opts, runtimeContext } = context;
  if (path.startsWith("/ui/assets/")) return operatorAsset(request, path);
  if (request.method === "GET" && path === "/favicon.svg") {
    return new Response(opts.config.ui?.branding?.favicon?.svg ?? CONNECTA_FAVICON_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
        ...INERT_ICON_HEADERS,
      },
    });
  }
  if (request.method === "GET" && path === "/favicon.ico") {
    return new Response(opts.config.ui?.branding?.favicon?.ico ?? CONNECTA_FAVICON_ICO, {
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
  if (
    operatorPage &&
    (operatorPage !== "activity" || opts.config.activity?.store.list) &&
    (operatorPage !== "tokens" || opts.config.accessTokens || opts.config.agents.length > 0)
  ) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return privateJson({ error: "method not allowed" }, { status: 405 });
    }
    // Open shell — carries no operator data; everything comes from the
    // authenticated /ui/* APIs after the browser establishes a session.
    const ambient =
      authorizationCredential(request).kind === "absent" && runtimeContext?.access
        ? opts.config.auth.find((provider) => provider.uiAuth?.kind === "cloudflare-access")?.uiAuth
        : undefined;
    const uiAuth =
      ambient ??
      opts.config.auth.find((provider) => provider.uiAuth && provider.uiAuth.kind !== "cloudflare-access")?.uiAuth ??
      opts.config.auth.find((provider) => provider.uiAuth?.kind === "cloudflare-access")?.uiAuth;
    const mcpUrl = new URL("/mcp", baseUrl).toString();
    const clerkOrigin =
      uiAuth?.kind === "clerk" && isSafeHttpsUrl(uiAuth.frontendApiUrl)
        ? new URL(uiAuth.frontendApiUrl).origin
        : undefined;
    return new Response(
      request.method === "HEAD"
        ? null
        : renderUiHtml(uiAuth, mcpUrl, opts.config.ui?.branding, undefined, operatorPage),
      {
        status: 200,
        headers: htmlSecurityHeaders(
          {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
          clerkOrigin ? { clerkOrigin } : {},
        ),
      },
    );
  }
  const configResponse = await routeUiConfig(context);
  if (configResponse) return configResponse;
  const detail = /^\/ui\/connectors\/([a-z0-9_-]+)$/.exec(path);
  if (path !== "/ui/data" && !detail) return null;
  if (request.method !== "GET") return privateJson({ error: "method not allowed" }, { status: 405 });
  // Reads: a caller who leaves stops whatever the payload was waiting on.
  return serveOperator(detail ? connectorDetail(context, detail[1]!) : summary(context), request.signal);
}

/** What this identity may see and do, for the summary and a detail alike. */
function operatorView({ opts }: RouteContext, authz: Authorized, registry: RegistryView) {
  const visible = registry.listConnectors();
  const mayManage = (id: string) => {
    const connector = registry.getConnector(id);
    return Boolean(connector && mayManageConnector(opts, authz, connector));
  };
  const permissions = (connector: Connector) => ({
    use: true,
    manageSharedAuth: connector.authScope !== "personal" && mayManage(connector.id),
    connectPersonal: connector.authScope === "personal" && mayManage(connector.id),
  });
  const activityEnabled = Boolean(opts.config.activity?.store.list) && readsActivity(opts, authz);
  const credentialManagement = visible.some((c) => c.credential && mayManage(c.id))
    ? opts.config.vault
      ? ("available" as const)
      : ("vault_not_configured" as const)
    : authz.identity.interactive && !visible.some((c) => c.credential)
      ? ("no_slots" as const)
      : ("requires_operator" as const);
  return { visible, mayManage, permissions, activityEnabled, credentialManagement };
}

/**
 * How long a detail read waits on the downstream before its row reports
 * `connector_timeout`. A cold remote MCP handshake with an OAuth refresh is
 * about five sequential round trips, so 8 s allows ~1.5 s each; anything
 * slower is shown as slow or unreachable rather than holding one of the
 * page's few detail slots for the full discovery deadline. A deployment that
 * set a shorter `discovery.probeTimeoutMs` keeps that one deadline, which also
 * ends in `connector_timeout`.
 */
const DETAIL_OBSERVE_TIMEOUT_MS = 8000;

/** One connector's probed row, the page's second request per card. */
function connectorDetail(context: RouteContext, id: string): Effect.Effect<Response, Answer> {
  const { request, baseUrl, opts, defer } = context;
  return Effect.gen(function* () {
    const authz = yield* authorized(context);
    const registry = yield* visibleRegistry(context, authz);
    const { mayManage, permissions, activityEnabled, credentialManagement } = operatorView(context, authz, registry);
    const connector = registry.getConnector(id);
    if (!connector) return yield* refuse("unknown connector", 404);
    const data = yield* uiData(
      opts.registry.scoped(scopeFor(authz, opts.config.auth.length > 0, [connector.id])),
      baseUrl,
      {
        serverInfo: opts.config.serverInfo,
        activityContext: operatorActivityContext(context, authz),
        credentialVault: opts.config.vault,
        activityEnabled,
        credentialManagement,
        defer,
        oauthManagement: false,
        ...(!oauthConnectUnavailable(opts)
          ? { oauthConnectUrl: (id: string) => oauthConnectUrl(opts, baseUrl, id, authz.principalKey) }
          : {}),
        discoveryConcurrency: 1,
        personalCredentialOwner: authz.principalKey,
        mayManage,
        // A live read records its observation; `?observation=stored` answers
        // from the current one instead and leaves the live read to the browser.
        statusObservation: context.url.searchParams.get("observation") === "stored" ? "stored" : "record",
        timeoutMs: opts.config.discovery.probeTimeoutMs,
        ...(opts.config.discovery.probeTimeoutMs > DETAIL_OBSERVE_TIMEOUT_MS
          ? { observeTimeoutMs: DETAIL_OBSERVE_TIMEOUT_MS }
          : {}),
        signal: request.signal,
      },
    );
    const detail = data.connectors[0]!;
    if (detail.overlay)
      yield* withDeadlineEffect(() => scanOperatorActivity(context, authz, registry, [detail.overlay!], []), {
        timeoutMs: 500,
        signal: request.signal,
        timeoutError: new Error("Activity observation timed out."),
      }).pipe(Effect.catch(() => Effect.succeed("unavailable" as const)));
    return privateJson({
      ...detail,
      viewerKey: yield* operatorViewerKey(context, authz),
      permissions: permissions(connector),
    });
  });
}

/** The summary: every visible connector as "loading", with no probe at all. */
function summary(context: RouteContext): Effect.Effect<Response, Answer> {
  const { opts } = context;
  return Effect.gen(function* () {
    const authz = yield* authorized(context);
    const registry = yield* visibleRegistry(context, authz);
    const { visible, mayManage, permissions, activityEnabled, credentialManagement } = operatorView(
      context,
      authz,
      registry,
    );
    // Only maintainers reach here; setup commands are offered for every
    // declared pool, since they administer them all.
    const pools = [...opts.pools.keys()];
    return privateJson({
      viewerKey: yield* operatorViewerKey(context, authz),
      ...(pools.length ? { pools } : {}),
      serverInfo: opts.config.serverInfo,
      connectaVersion: CONNECTA_VERSION,
      activityEnabled,
      ...(opts.config.accessTokens
        ? {
            accessTokenManagement: managesAgentTokens(opts, authz) ? "available" : "requires_operator",
          }
        : {}),
      credentialManagement,
      oauthManagement: visible.some((c) => mayManage(c.id)),
      connectors: visible.map((c) => ({
        id: c.id,
        ...(c.title ? { title: c.title } : {}),
        ...(c.description ? { description: c.description } : {}),
        authScope: c.authScope ?? "shared",
        status: "loading",
        toolCount: 0,
        tools: [],
        oauth: Boolean(c.startAuth && c.disconnectAuth),
        permissions: permissions(c),
      })),
    });
  });
}
