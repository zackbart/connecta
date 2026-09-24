import { Effect } from "effect";
import { oauthValueStorageKey } from "../auth/downstream-oauth.js";
import type {
  ConnectorContext,
  ConnectaBranding,
} from "../types.js";
import { resolveBranding } from "../branding.js";
import {
  oauthCallbackOutcome,
  providerErrorReason,
  type OAuthCallbackReason,
} from "../oauth-callback-outcome.js";
import {
  authorizeUiIdentity,
  mayManageConnector,
  validateAuthPermissions,
  loggableValue,
  msg,
  type RouteContext,
} from "./shared.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The callback's one page. It renders a reason from a closed set and that
 * reason's fixed copy, so nothing the request carried — the provider's `error`
 * parameter, an exchange failure's message — can reach the body. Escaping
 * stays anyway: branding and the configured connector id are still strings.
 */
function html(
  reason: OAuthCallbackReason,
  branding?: ConnectaBranding,
  hasUi = false,
  connectorId?: string,
): Response {
  const outcome = oauthCallbackOutcome(reason, connectorId);
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
  a:focus-visible, summary:focus-visible { outline: 1px solid #000; outline-offset: 2px; }
  summary { cursor: pointer; }
  pre { font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; margin: .75rem 0 0;
    padding: .75rem; white-space: pre-wrap; border: 1px solid #000; user-select: all; }
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
  <main class="shell grid" data-oauth-callback="${outcome.reason}">
    <h1>Connection status</h1>
    <div class="copy">
      <p>${escapeHtml(outcome.message)}</p>
      ${outcome.fixPrompt ? `<details><summary>Fix prompt for a coding agent</summary><pre>${escapeHtml(outcome.fixPrompt)}</pre></details>` : ""}
      ${hasUi ? `<p><a href="/">Return to ${escapeHtml(brand.productName)}</a></p>` : ""}
    </div>
  </main>
</body>
</html>`,
    { status: outcome.status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
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
): Promise<void> {
  try {
    const generation = await context.storage.get("oauth:generation");
    await context.storage.get(
      oauthValueStorageKey("oauth:state", generation),
    );
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
  return Effect.uninterruptible(
    Effect.promise(() => finishOAuthCallback(context)),
  );
}

async function finishOAuthCallback(
  context: RouteContext,
): Promise<Response> {
  const { path, url, baseUrl, opts } = context;
  const error = url.searchParams.get("error");
  if (error) return html(providerErrorReason(error), opts.branding, Boolean(opts.ui));
  const code = url.searchParams.get("code");
  if (!code) return html("invalid_callback", opts.branding, Boolean(opts.ui));
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
  const refused = () => html("invalid_callback", opts.branding, Boolean(opts.ui));
  if (!connector || !connector.finishAuth) {
    await equalizeRefusalCost(connectorContext);
    return refused();
  }
  const expectedPrincipalKey = callbackTarget?.principalKey;
  // A browser returning from consent normally has no MCP Authorization
  // header. An interactive bearer provider therefore answers 401 here; state
  // and the saved state-to-principal handoff still prove ownership below.
  // Rejecting 401 would break that callback. A 403 is an explicit denial.
  const browserIdentity = await authorizeUiIdentity(context.request, baseUrl, opts.auth, "OAuth callback", context.runtimeContext, opts.identity);
  if (browserIdentity.ok) {
    try { validateAuthPermissions(browserIdentity, opts.registry); } catch { return refused(); }
    if (!mayManageConnector(browserIdentity, connector) || (expectedPrincipalKey && browserIdentity.principalKey !== expectedPrincipalKey)) return refused();
  } else if (browserIdentity.response.status === 403 && opts.auth.some(provider => provider.interactiveOperator)) {
    return refused();
  }
  // CSRF / login-fixation guard: this route is intentionally public, so verify
  // the `state` matches the flow connecta started BEFORE exchanging the code.
  if (!connector.verifyState) {
    await equalizeRefusalCost(connectorContext);
    opts.logger.warn(
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
    opts.logger.warn(
      `[connecta] refused an OAuth callback for connector ` +
        `${loggableValue(id)} with 400: verifyState threw ` +
        `${loggableValue(msg(err))}. No authorization code was exchanged. ` +
        "Re-run authorization from connecta and check the verifier if it " +
        "fails again.",
    );
    return refused();
  }
  if (!stateMatches) {
    opts.logger.warn(
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
  if (connector.authScope === "personal") {
    try {
      await opts.registry.clearOAuthHandoff(id, state);
    } catch (err) {
      opts.logger.warn(
        `[connecta] refused an OAuth callback for connector ` +
          `${loggableValue(id)} with 500: its principal handoff could not be ` +
          `consumed (${loggableValue(msg(err))}). No authorization code was exchanged.`,
      );
      return html("handoff_failed", opts.branding, Boolean(opts.ui), id);
    }
  }
  try {
    await connector.finishAuth(code, connectorContext, url.searchParams);
    await callbackRegistry!.invalidateStored(id);
    return html("connected", opts.branding, Boolean(opts.ui), id);
  } catch (err) {
    // The page names the reason and nothing else; what the exchange threw can
    // quote a token endpoint's body, so it goes only to the operator log.
    opts.logger.warn(
      `[connecta] OAuth callback for connector ${loggableValue(id)} failed ` +
        `with 500: the authorization code exchange threw ${loggableValue(msg(err))}.`,
    );
    return html("exchange_failed", opts.branding, Boolean(opts.ui), id);
  }
}
