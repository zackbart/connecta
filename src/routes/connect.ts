import { ConnectorCallError } from "../errors.js";
import { authorizationCredential } from "../inbound-credential.js";
import { Effect } from "effect";
import { escapeHtml, renderPage } from "../branding.js";
import { htmlSecurityHeaders } from "../html-security.js";
import { closeConnectorScope } from "../connector-scope.js";
import { drainOAuthStartResets } from "../auth/oauth-start-reset.js";
import { consumeOAuthConnectLink, oauthConnectUnavailable, verifyOAuthHandoff } from "../oauth-handoff.js";
import { failureRecord, logFailure } from "../operator-record.js";
import { runEdge, withDeadlineEffect } from "../runtime/run.js";
import {
  authorizeUiIdentity, mayManageConnector, privateJson, validateAuthPermissions, withSessionCookies,
  type RouteContext,
} from "./shared.js";

const START_TIMEOUT_MS = 30_000;

/** Clerk establishes a browser session on this origin before retrying the link. */
function clerkSignIn(context: RouteContext): Response | undefined {
  const clerk = context.opts.config.auth.find(provider => provider.uiAuth?.kind === "clerk")?.uiAuth;
  if (clerk?.kind !== "clerk") return undefined;
  const returnUrl = new URL(context.path, context.baseUrl);
  returnUrl.search = context.url.search;
  if (clerk.signInUrl) {
    try {
      const target = new URL(clerk.signInUrl);
      if (target.protocol === "https:" && !target.username && !target.password) {
        target.searchParams.set("redirect_url", returnUrl.href);
        return new Response(null, { status: 302, headers: { Location: target.href, "Cache-Control": "no-store" } });
      }
    } catch { /* Use the local sign-in page. */ }
  }
  let origin: string;
  try {
    const frontend = new URL(clerk.frontendApiUrl);
    if (frontend.protocol !== "https:" || frontend.username || frontend.password) return undefined;
    origin = frontend.origin;
  } catch { return undefined; }
  const nonce = crypto.randomUUID();
  const target = JSON.stringify(returnUrl.href).replace(/</g, "\\u003c");
  const body = `<main class="page shell"><h1>Sign in to connect</h1><p>Sign in as the user who requested this connection.</p><div id="signin"></div></main>
<script nonce="${nonce}" crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(clerk.publishableKey)}" src="${escapeHtml(origin)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script nonce="${nonce}">window.Clerk.load().then(() => {
  if (window.Clerk.session) { window.location.replace(${target}); return; }
  window.Clerk.mountSignIn(document.getElementById("signin"), { routing: "hash", forceRedirectUrl: ${target}, signUpForceRedirectUrl: ${target} });
}).catch(() => { document.getElementById("signin").textContent = "Sign-in could not load. Try again."; });</script>`;
  return new Response(renderPage(context.opts.config.ui?.branding, { title: "Sign in to connect", uiMounted: Boolean(context.opts.config.ui), body }), {
    headers: htmlSecurityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    }, { clerkOrigin: origin, nonce }),
  });
}

export function routeConnect(context: RouteContext): Effect.Effect<Response | null> {
  if (!context.path.startsWith("/connect/")) return Effect.succeed(null);
  return Effect.promise(() => connect(context));
}

async function connect(context: RouteContext): Promise<Response> {
  const { opts, request, baseUrl, runtimeContext } = context;
  const refuse = (error: string, status = 403) => privateJson({ error }, { status });
  if (request.method !== "GET") return privateJson({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET" } });
  const unavailable = oauthConnectUnavailable(opts);
  if (unavailable) return refuse(unavailable);
  const id = context.path.slice("/connect/".length);
  const handoff = await verifyOAuthHandoff(opts, baseUrl, id, context.url.searchParams.get("h"));
  if (!handoff) return refuse("Invalid or expired connection link. Request a new link from connecta.", 400);
  const authPage = () => {
    const target = new URL(`/connectors/${id}`, baseUrl);
    target.searchParams.set("h", context.url.searchParams.get("h")!);
    target.hash = "auth";
    return new Response(null, { status: 302, headers: { Location: target.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  };
  const authz = await authorizeUiIdentity(request, baseUrl, opts.config.auth, "OAuth connection", runtimeContext, opts.config.identity);
  if (!authz.ok) {
    // Access sign-in is enforced at the edge. Clerk needs its own sign-in page.
    if (authz.response.status === 401 && authorizationCredential(request).kind === "absent" && !runtimeContext?.access) {
      if (opts.config.ui) return authPage();
      const signIn = clerkSignIn(context);
      if (signIn) return signIn;
    }
    return authz.response;
  }
  try { validateAuthPermissions(authz, opts.registry); } catch { return refuse("forbidden"); }
  const connector = opts.registry.getConnector(id)!;
  if (authz.principalKey !== handoff.principal || !mayManageConnector(authz, connector)) {
    return refuse("Sign in as the user who requested this connection and has permission to manage it.");
  }
  if (!connector.startAuth) {
    if (!connector.credential || !opts.config.ui || !opts.config.vault) return refuse("unknown OAuth connector", 404);
    let target: URL;
    try { target = new URL(opts.config.ui.credentialHandoffUrl(baseUrl), baseUrl); }
    catch { return refuse("Credential management URL is unavailable", 503); }
    if (target.origin !== new URL(baseUrl).origin || target.username || target.password) return refuse("Credential management URL is unavailable", 503);
    if (!await consumeOAuthConnectLink(opts, handoff)) return refuse("Invalid or expired connection link. Request a new link from connecta.", 400);
    // Credential entry stays in the authenticated operator UI on this origin.
    return withSessionCookies(new Response(null, { status: 302, headers: {
      Location: target.href, "Cache-Control": "no-store",
    } }), authz.sessionCookies);
  }
  if (opts.config.ui && context.url.searchParams.get("start") !== "1") return withSessionCookies(authPage(), authz.sessionCookies);
  const registry = opts.registry.scoped({ connectorIds: [id], principalKey: authz.principalKey, ...(authz.subjectKey ? { subjectKey: authz.subjectKey } : {}) });
  const scope = {};
  let ctx = registry.contextFor(id, baseUrl, scope, context.defer ? { defer: context.defer } : {});
  const timeoutError = new ConnectorCallError("timeout", "OAuth authorization start timed out");
  try {
    if (!await consumeOAuthConnectLink(opts, handoff)) return refuse("Invalid or expired connection link. Request a new link from connecta.", 400);
    const status = await runEdge(withDeadlineEffect(signal => Effect.tryPromise({
      try: async () => {
        ctx = registry.contextFor(id, baseUrl, scope, { signal, ...(context.defer ? { defer: context.defer } : {}) });
        const started = await connector.startAuth!(ctx, { force: handoff.force });
        if (signal.aborted) throw signal.reason;
        if (started.authorizationUrl) {
          let target: URL | undefined;
          try { target = new URL(started.authorizationUrl); } catch { /* Refused below. */ }
          if (target && ["https:", "http:"].includes(target.protocol) && !target.username && !target.password) {
            await registry.bindOAuthHandoff(id, target.href);
          } else {
            return { ...started, authorizationUrl: undefined };
          }
        }
        return started;
      },
      catch: error => error,
    }), { timeoutMs: START_TIMEOUT_MS, signal: request.signal, timeoutError }));
    if (handoff.force || (!status.authorizationReused && status.state !== "ok")) await registry.invalidateStored(id);
    if (status.state === "ok") return withSessionCookies(new Response("This connector is already connected.", { headers: { "Cache-Control": "no-store" } }), authz.sessionCookies);
    if (status.state !== "auth_required" || !status.authorizationUrl) {
      // The start's message can be a downstream's refusal, which an agent
      // may read but a log may not (INV-6): the record keeps the checked
      // state only, since a plugin's `startAuth` returns whatever it likes.
      logFailure(opts.config.logger, "OAuth start failed", failureRecord({
        connector: id,
        mode: handoff.force ? "restart" : "continue",
        state: status.state,
      }));
      return refuse(status.state === "auth_required" ? "OAuth authorization requires consent but no safe URL is available" : "OAuth authorization could not start", 502);
    }
    const target = new URL(status.authorizationUrl);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) return refuse("OAuth authorization returned no safe URL", 502);
    return withSessionCookies(new Response(null, { status: 302, headers: { Location: target.href, "Cache-Control": "no-store" } }), authz.sessionCookies);
  } catch (error) {
    await drainOAuthStartResets(scope);
    await registry.invalidateStored(id);
    if (error === timeoutError) return refuse("OAuth authorization start timed out", 504);
    logFailure(opts.config.logger, "OAuth start failed", failureRecord({ connector: id }, error));
    return refuse("OAuth authorization could not start", 400);
  } finally {
    await closeConnectorScope(connector, ctx, context.defer);
  }
}
