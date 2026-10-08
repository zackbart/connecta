import { Effect } from "effect";
import { closeConnectorScope } from "../connector-scope.js";
import { OAuthCallbackClaimedError, oauthStateDigest } from "../auth/downstream-oauth.js";
import { failureRecord, logFailure } from "../operator-record.js";
import { oauthFlowKeys } from "../storage/keys.js";
import type { ConnectorContext } from "../types.js";
import { escapeHtml, renderPage, resolveBranding, STATUS_ICONS } from "../branding.js";
import {
  oauthCallbackOutcome,
  providerErrorReason,
  type OAuthCallbackReason,
} from "../oauth-callback-outcome.js";
import {
  authorizeUiIdentity,
  withSessionCookies,
  mayManageConnector,
  validateAuthPermissions,
  loggableValue,
  type RouteContext,
} from "./shared.js";

const TONE_MARKS = {
  ok: { className: " ok", icon: STATUS_ICONS.ok, label: "Connected" },
  declined: { className: "", icon: STATUS_ICONS.declined, label: "Not connected" },
  problem: { className: " danger", icon: STATUS_ICONS.problem, label: "Not connected" },
} as const;

/**
 * The callback's one page, in the shared layout. It renders a reason from a
 * closed set and that reason's fixed copy, so nothing the request carried —
 * the provider's `error` parameter, an exchange failure's message — can reach
 * the body. The connector's title appears only when `connector` is passed,
 * which the route does only after the state check, and `oauthCallbackOutcome`
 * gates it by reason again; every refusal before that point is the same bytes
 * for every connector id and path. Escaping stays anyway: branding and a
 * configured title are still strings.
 *
 * The fix prompt is for whoever runs the deployment, and the person reading
 * this page is often a teammate finishing personal auth, so it sits folded
 * under a quiet disclosure rather than in the message.
 */
function html(
  reason: OAuthCallbackReason,
  opts: Pick<RouteContext["opts"], "config">,
  connector?: { id: string; title?: string | undefined },
): Response {
  const brand = resolveBranding(opts.config.ui?.branding);
  const outcome = oauthCallbackOutcome(reason, connector, brand.productName);
  const mark = TONE_MARKS[outcome.tone];
  const uiMounted = Boolean(opts.config.ui);
  const home = uiMounted
    ? `<div class="status-actions"><a class="btn${outcome.tone === "ok" ? "" : " primary"}" href="/">Return to ${escapeHtml(brand.productName)}</a></div>`
    : "";
  const details = outcome.fixPrompt
    ? `<details class="status-details">
      <summary>Details for the operator</summary>
      <p>If this keeps happening, send this to whoever runs ${escapeHtml(brand.productName)}. It is written for a coding agent working on the deployment and carries nothing from the provider's response.</p>
      <pre>${escapeHtml(outcome.fixPrompt)}</pre>
    </details>`
    : "";
  const body = `<main class="page shell" data-oauth-callback="${outcome.reason}">
  <section class="status-page">
    <div class="status-head">
      <span class="status-mark${mark.className}" aria-hidden="true">${mark.icon}</span>
      <p class="status-label${mark.className}">${mark.label}</p>
    </div>
    <h1>${escapeHtml(outcome.heading)}</h1>
    <p class="status-copy">${escapeHtml(outcome.message)}</p>
    ${home}
    ${details}
  </section>
</main>`;
  return new Response(
    renderPage(opts.config.ui?.branding, {
      title: `${outcome.heading} — ${brand.pageTitle}`,
      uiMounted,
      body,
    }),
    { status: outcome.status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * Pay the storage read a real downstream-OAuth refusal pays, on the refusal
 * paths that would otherwise pay nothing.
 *
 * Identical bodies do not hide a connector id if the clock still sorts them.
 * `KvOAuthProvider.verifyState` reads the consent the state names before it
 * can reject it, so a configured id costs a storage round trip on the
 * ordinary path while an id naming nothing used to touch no I/O. That gap is
 * an oracle: sample the two and a wordlist recovers the connector list the
 * flat 400 was meant to withhold. So zero-I/O refusals read the same key in
 * the same `conn:<id>:` namespace, where an unconfigured id gets a miss.
 *
 * This is deliberately *not* a constant-time claim: a hit and a miss are not
 * identical in a KV store, and a connector shipping its own `verifyState` may
 * do more or less work. What it
 * removes is the order-of-magnitude "no I/O versus a round trip" difference,
 * which is the only part of the signal that makes enumeration cheap.
 *
 * A throwing read is swallowed: the refusal is the answer either way, and
 * turning it into a 500 would hand back exactly the distinguishable response
 * this whole path exists to deny.
 */
async function equalizeRefusalCost(
  context: ConnectorContext,
  state: string | null,
): Promise<void> {
  try {
    await context.storage.get(oauthFlowKeys.flow(await oauthStateDigest(state ?? "")));
  } catch {
    // Deliberately ignored — see above.
  }
}

/**
 * The callback route as a step of the request's fiber, and the one step that
 * the request's signal does not interrupt.
 *
 * An authorization code is single-use. Once a browser has delivered one, the
 * handoff it consumes, the exchange, and the catalog invalidation after it are
 * one commitment: abandoned halfway, a connector could hold fresh tokens
 * behind a catalog still cached as unauthorized, or a consumed handoff with no
 * exchange behind it. A caller that hangs up mid-exchange loses only the page.
 */
export function routeOAuthCallback(
  context: RouteContext,
): Effect.Effect<Response | null> {
  if (!context.path.startsWith("/oauth/callback/")) return Effect.succeed(null);
  // Downstream OAuth uses query-mode redirects; form_post is not supported.
  if (context.request.method !== "GET") return Effect.succeed(new Response(null, {
    status: 405, headers: { Allow: "GET" },
  }));
  return Effect.uninterruptible(
    Effect.promise(() => finishOAuthCallback(context)),
  );
}

/**
 * RFC 6749's error codes (sections 4.1.2.1 and 5.2) and RFC 8707's
 * `invalid_target`. Only a code on this list is logged: the `code` an OAuth
 * error carries is the provider's own text.
 */
const TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

/** ` with OAuth error <code>` for a known code; nothing for anything else. */
function exchangeErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && TOKEN_ERROR_CODES.has(code)
    ? ` with OAuth error ${code}`
    : "";
}

/** The provider's own refusal of a duplicate callback, wherever it is wrapped. */
function claimedByAnotherCallback(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = err; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof OAuthCallbackClaimedError) return true;
    seen.add(current);
  }
  return false;
}

async function finishOAuthCallback(
  context: RouteContext,
): Promise<Response> {
  const { path, url, baseUrl, opts } = context;
  const error = url.searchParams.get("error");
  if (error) return html(providerErrorReason(error), opts);
  const code = url.searchParams.get("code");
  if (!code) return html("invalid_callback", opts);
  const id = path.slice("/oauth/callback/".length);
  const state = url.searchParams.get("state");
  const callbackTarget = await opts.registry.oauthCallbackView(id, state);
  const callbackRegistry = callbackTarget?.registry;
  const connector = callbackRegistry?.getConnector(id);
  // Safe to build before we know the id names anything: `contextFor` is a pure
  // constructor — a namespaced storage view over `conn:<id>:` and, only for a
  // connector that declares one, a lazy credential accessor. It neither throws
  // nor touches storage for an unknown id, which is what lets the refusals
  // below borrow it to equalize their cost.
  const connectorContext = callbackRegistry
    ? callbackRegistry.contextFor(id, baseUrl)
    : opts.registry.contextFor(id, baseUrl);
  const refused = () => html("invalid_callback", opts);
  if (!connector || !connector.finishAuth) {
    await equalizeRefusalCost(connectorContext, state);
    return refused();
  }
  try {
    const expectedPrincipalKey = callbackTarget?.principalKey;
    const browserIdentity = await authorizeUiIdentity(context.request, baseUrl, opts.config.auth, "OAuth callback", context.runtimeContext, opts.config.identity);
    if (!browserIdentity.ok) {
      // A Clerk browser handshake refreshes its session and returns to this
      // exact callback. It grants no identity and exchanges no code yet.
      if (browserIdentity.response.status === 307 && browserIdentity.response.headers.has("location")) return browserIdentity.response;
      return refused();
    }
    if (!expectedPrincipalKey || browserIdentity.principalKey !== expectedPrincipalKey) return refused();
    try { validateAuthPermissions(browserIdentity, opts.registry); } catch { return refused(); }
    if (!mayManageConnector(browserIdentity, connector)) return refused();
    // CSRF / login-fixation guard: this route is intentionally public, so verify
    // the `state` matches the flow connecta started BEFORE exchanging the code.
    if (!connector.verifyState) {
      await equalizeRefusalCost(connectorContext, state);
      opts.config.logger.warn(
        `[connecta] refused an OAuth callback for connector ` +
          `${loggableValue(id)} with 400: it implements finishAuth but no ` +
          "verifyState, so connecta cannot establish that it started this flow. " +
          "No authorization code was exchanged. Implement verifyState before " +
          "trying again.",
      );
      return refused();
    }
    let stateMatches: boolean;
    try {
      stateMatches = await connector.verifyState(state, connectorContext);
    } catch (err) {
      logFailure(
        opts.config.logger,
        "OAuth callback verifyState threw; no authorization code was exchanged",
        failureRecord({ connector: id }, err),
      );
      return refused();
    }
    if (!stateMatches) {
      opts.config.logger.warn(
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
    {
      try {
        if (!await opts.registry.consumeOAuthHandoff(id, state, expectedPrincipalKey)) return refused();
      } catch (err) {
        logFailure(
          opts.config.logger,
          "OAuth callback handoff could not be consumed; no authorization code was exchanged",
          failureRecord({ connector: id }, err),
        );
        return html("handoff_failed", opts, connector);
      }
    }
    try {
      await connector.finishAuth(code, connectorContext, url.searchParams);
      await callbackRegistry!.invalidateStored(id);
      return withSessionCookies(html("connected", opts, connector), browserIdentity.sessionCookies);
    } catch (err) {
      // A duplicate of a callback that already claimed this consent sent
      // nothing: it is the already-used link the flat refusal describes, not
      // an exchange the provider rejected.
      if (claimedByAnotherCallback(err)) {
        opts.config.logger.warn(
          `[connecta] refused an OAuth callback for connector ` +
            `${loggableValue(id)} with 400: another callback had already ` +
            "claimed its state. No authorization code was exchanged.",
        );
        return refused();
      }
      // Neither the page nor the log repeats what the exchange threw: the SDK
      // quotes the token endpoint's error_description or raw body, and a
      // provider echoing a client_secret_post request puts the secret there.
      opts.config.logger.warn(
        `[connecta] OAuth callback for connector ${loggableValue(id)} failed ` +
          `with 500: the authorization code exchange failed${exchangeErrorCode(err)}. ` +
          "Check the connector's client configuration and re-run authorization.",
      );
      return withSessionCookies(html("exchange_failed", opts, connector), browserIdentity.sessionCookies);
    }
  } finally {
    await closeConnectorScope(connector, connectorContext, context.defer);
  }
}
