import {
  credentialTestRule,
  describeUndeclaredCredentialFields,
  storedCredentialShape,
} from "./credentials.js";
import type { CredentialVault } from "./credentials.js";
import {
  closeConnectorScope,
  type DeferredWork,
} from "./connector-scope.js";
import {
  mapSettledWithConcurrency,
  resolveDiscoveryConcurrency,
} from "./concurrency.js";
import {
  type CredentialManagementCapability,
  type UiConnector,
  type UiData,
  type UiTool,
} from "./operator-ui/model.js";
import {
  OPERATOR_UI_CSS,
  OPERATOR_UI_SCRIPT,
} from "./operator-ui/generated.js";
import type { Registry } from "./registry.js";
import type { ConnectaBranding, UiAuthConfig } from "./types.js";
import { CONNECTA_VERSION } from "./version.js";

export {
  filterUiConnectors,
  type CredentialManagementCapability,
  type UiConnector,
  type UiData,
} from "./operator-ui/model.js";

/** Connecta's default monochrome "C" mark. */
export const CONNECTA_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    .fg { fill: #000 }
    @media (prefers-color-scheme: dark) { .fg { fill: #fff } }
  </style>
  <path class="fg" d="M27 9.4A13 13 0 1 0 27 22.6l-4.4-2.5a8 8 0 1 1 0-8.2z"/>
</svg>`;

interface ResolvedBranding {
  productName: string;
  productUrl?: string;
  ownerName?: string;
  ownerUrl?: string;
  description: string;
  /** Browser tab title and page meta name. */
  pageTitle: string;
  /** href for the page's icon link. */
  faviconHref: string;
  themeColor: string;
}

const DEFAULT_FAVICON_HREF = "/favicon.svg";

/**
 * Branding arrives from operator config, which is untyped at a JS call site, so
 * every field is treated as `unknown`: a non-string is read as unset rather than
 * throwing on `.trim()`. Rendering must degrade to defaults for a malformed
 * value, never fail — `createConnecta` calls this during construction.
 */
function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function resolveBranding(
  branding?: ConnectaBranding,
): ResolvedBranding {
  const productName = trimmedString(branding?.productName) ?? "Connecta";
  const ownerName = trimmedString(branding?.ownerName);
  // Operator branding URLs become masthead/callback hrefs, so a non-http(s)
  // scheme (javascript:, data:) is dropped the same as an unset URL — the
  // callers already render a <span> instead of an <a> when it is absent.
  const productUrl = trimmedString(branding?.productUrl);
  const ownerUrl = trimmedString(branding?.ownerUrl);
  const faviconHref = trimmedString(branding?.favicon?.href);
  return {
    productName,
    ...(productUrl && isSafeHttpUrl(productUrl) ? { productUrl } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(ownerUrl && isSafeHttpUrl(ownerUrl) ? { ownerUrl } : {}),
    description:
      trimmedString(branding?.description) ??
      `Manage the services this ${productName} instance makes available to agents.`,
    pageTitle:
      trimmedString(branding?.pageTitle) ??
      (ownerName ? `${productName} — ${ownerName}` : productName),
    faviconHref:
      faviconHref && isSafeIconHref(faviconHref)
        ? faviconHref
        : DEFAULT_FAVICON_HREF,
    themeColor: trimmedString(branding?.themeColor) ?? "#ffffff",
  };
}

/**
 * Whether the operator meant to supply a value here — the question every
 * dropped-URL warning asks before naming a field, and one definition so the
 * branding and `uiAuth` warnings cannot answer it differently. A non-string
 * counts as set: the intent was there and is exactly what the warning reports
 * on. A blank or whitespace-only string does not; that is indistinguishable
 * from leaving the field alone, and both take the default silently.
 */
function isSetUrlValue(value: unknown): boolean {
  return typeof value === "string"
    ? trimmedString(value) !== undefined
    : value !== undefined && value !== null;
}

/**
 * A JS string literal safe to inline in a script element. Escaping `/` keeps
 * an operator-supplied `</script>` from terminating the element early.
 */
function stringForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/\//g, "\\/");
}

/**
 * Names of the branding URLs the operator set that failed their gate and were
 * replaced by a default. Lives beside the gates so the startup warning cannot
 * drift from them, and takes `unknown` fields for the same reason
 * `resolveBranding` does — a warning helper must never throw.
 */
export function droppedBrandingUrls(branding?: ConnectaBranding): string[] {
  if (!branding) return [];
  const resolved = resolveBranding(branding);
  const faviconHref = branding.favicon?.href;
  return [
    ...(isSetUrlValue(branding.productUrl) && !resolved.productUrl
      ? ["productUrl"]
      : []),
    ...(isSetUrlValue(branding.ownerUrl) && !resolved.ownerUrl
      ? ["ownerUrl"]
      : []),
    ...(isSetUrlValue(faviconHref) &&
    trimmedString(faviconHref) !== resolved.faviconHref
      ? ["favicon.href"]
      : []),
  ];
}

/**
 * True only for absolute `http:`/`https:` URLs. Downstream connectors control
 * their `authorizationUrl`, so a hostile/misconfigured one could hand back a
 * `javascript:` (or other) scheme; gate it before it can become an href.
 */
export function isSafeHttpUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

/**
 * Only the second check's base; any origin works because the check is whether
 * the href stays on whatever origin it is resolved against. It is deliberately
 * never the sole gate: a value whose own authority equals this host (say
 * `//connecta.invalid/x`) would resolve to this exact origin and pass, so the
 * structural check below runs first and is what actually rejects `//host`.
 */
const SAME_ORIGIN_PROBE = "https://connecta.invalid";

/** Removed anywhere in a URL by the parser, so a gate must ignore them too. */
const URL_STRIPPED_CHARS = /[\t\n\r]/g;

/**
 * True for values allowed in the page's `<link rel="icon" href>`: an absolute
 * `http(s)` URL (an icon the operator hosts elsewhere) or a path rooted at this
 * origin. The relative carve-out is deliberate rather than accidental — the
 * default href is the relative `/favicon.svg`, which `isSafeHttpUrl` alone would
 * reject — and it is kept narrow on both ends.
 *
 * Root-relative only, because operator and OAuth callback pages sit at
 * different depths and a document-relative path would resolve differently.
 *
 * "Root-relative" is enforced structurally: exactly one leading `/` followed by
 * a character that is neither `/` nor `\`. Both of those would make the value an
 * authority (`//host`, and `/\host` because the URL parser folds `\` to `/` in
 * special schemes), pointing at an origin this server does not control. The test
 * runs on a copy with tab/newline/CR removed, since the parser strips those
 * anywhere and `/\t/host` would otherwise slip through as single-slash. The
 * origin comparison that follows is defense in depth, not the authority check —
 * on its own it would accept an authority that happened to equal the probe host.
 */
export function isSafeIconHref(href: unknown): boolean {
  if (typeof href !== "string") return false;
  if (isSafeHttpUrl(href)) return true;
  if (!/^\/(?![/\\])/.test(href.replace(URL_STRIPPED_CHARS, ""))) return false;
  try {
    return new URL(href, SAME_ORIGIN_PROBE).origin === SAME_ORIGIN_PROBE;
  } catch {
    return false;
  }
}

/**
 * True only for an absolute `https:` URL — the gate every `uiAuth` URL passes:
 * `frontendApiUrl`, which becomes the operator shell's sign-in loader source,
 * and `signInUrl`/`signUpUrl`, which ClerkJS uses as *navigation targets* when
 * the operator signs in. With those three gated, no operator-config value
 * reaches the browser in a URL position — attribute or navigation — without
 * validation, and there is no exception left to remember.
 *
 * Stricter than `isSafeHttpUrl` on purpose: no `http:` carve-out, no loopback
 * carve-out, and no relative form. Nobody types `frontendApiUrl` — the shipped
 * Clerk adapter derives it from the publishable key, and Clerk's Frontend API is
 * always https — and a cleartext script source on an operator page would be a
 * downgrade even where a browser's mixed-content rules had not already blocked
 * it. `signInUrl`/`signUpUrl` *are* typed by the operator, but what belongs
 * there is a hosted Account Portal address (`https://accounts.<domain>` or
 * `https://<slug>.accounts.dev`), which is https as well; `http:` would carry a
 * sign-in over cleartext, and a path relative to this origin is meaningless
 * because this server hosts no sign-in page of its own. So the looser gate would
 * buy nothing real, and the same strictness holds for all three.
 */
export function isSafeHttpsUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Names of the `uiAuth` URLs an inbound-auth provider supplied that failed their
 * gate. Lives beside the gate for the same reason `droppedBrandingUrls` does: the
 * startup warning cannot then drift from what rendering actually drops. Every
 * field is read defensively rather than trusted, because a custom `InboundAuth`
 * is untyped at a JS call site — `isSafeHttpsUrl` takes `unknown`, and a
 * `uiAuth` that is not the clerk shape is reported as nothing to warn about.
 *
 * `frontendApiUrl` is required, so anything that fails its gate is a drop.
 * `signInUrl` and `signUpUrl` are optional, so only a value the operator
 * *supplied* and the gate then rejected is worth a warning — an unset field
 * took no default away from anyone. `isSetUrlValue` decides that, the same way
 * and for the same reasons it decides it for the branding URLs: a warning that
 * fires for one and not the other would be reporting on the field rather than
 * on the operator's intent. Rendering is not consulted for this: it drops on
 * the gate alone, and a blank string fails that gate too — it is simply not
 * *reported*, because a blank is indistinguishable from leaving the field
 * alone.
 */
export function droppedUiAuthUrls(uiAuth?: UiAuthConfig): string[] {
  if (!uiAuth || uiAuth.kind !== "clerk") return [];
  return [
    ...(isSafeHttpsUrl(uiAuth.frontendApiUrl) ? [] : ["uiAuth.frontendApiUrl"]),
    ...(isSetUrlValue(uiAuth.signInUrl) && !isSafeHttpsUrl(uiAuth.signInUrl)
      ? ["uiAuth.signInUrl"]
      : []),
    ...(isSetUrlValue(uiAuth.signUpUrl) && !isSafeHttpsUrl(uiAuth.signUpUrl)
      ? ["uiAuth.signUpUrl"]
      : []),
  ];
}

export type OperatorPage = "connections" | "credentials" | "activity";

const OPERATOR_PAGE_LABELS: Readonly<Record<OperatorPage, string>> = {
  connections: "Connections",
  credentials: "Credentials",
  activity: "Activity",
};

export function operatorPageForPath(path: string): OperatorPage | undefined {
  if (path === "/") return "connections";
  if (path === "/credentials") return "credentials";
  if (path === "/activity") return "activity";
  return undefined;
}

export function operatorPageTitle(
  page: OperatorPage,
  configuredTitle: string,
): string {
  return `${OPERATOR_PAGE_LABELS[page]} — ${configuredTitle}`;
}

export function credentialManagementCapability(input: {
  eligibleClerkOperator: boolean;
  hasCredentialSlots: boolean;
  hasCredentialVault: boolean;
}): CredentialManagementCapability {
  if (!input.eligibleClerkOperator) return "requires_clerk";
  if (!input.hasCredentialSlots) return "no_slots";
  if (!input.hasCredentialVault) return "vault_not_configured";
  return "available";
}

/**
 * Build the read-only status payload served at `/ui/data`. Broken connectors are
 * isolated: they surface status "error" with an empty tool list rather than
 * failing the whole payload.
 */
export async function buildUiData(
  registry: Registry,
  baseUrl: string,
  serverInfo: { name: string; version: string },
  credentialVault?: CredentialVault,
  activityEnabled = false,
  credentialManagement: CredentialManagementCapability = credentialVault
    ? "available"
    : "requires_clerk",
  defer?: DeferredWork,
  oauthManagement = false,
  discoveryConcurrency?: number,
): Promise<UiData> {
  const requestScope = {};
  const connectorSet = registry.listConnectors();
  const concurrency = resolveDiscoveryConcurrency(discoveryConcurrency);
  const settled = await mapSettledWithConcurrency(
    connectorSet,
    concurrency,
    async (c): Promise<UiConnector> => {
      const status = await registry.statusFor(c.id, baseUrl, requestScope);
      const credentialCheck = await registry.credentialHealthFor(c.id);
      let tools: UiTool[] = [];
      // `status()` on an unauthenticated remote connector starts OAuth and
      // stores its state + PKCE verifier. Probing listTools immediately
      // afterward would start a second flow, overwrite that state, and return
      // the now-stale first URL to the operator. Only inspect tools after
      // status proves the connector is healthy.
      if (status.state === "ok") {
        try {
          tools = (
            await registry.getTools(c.id, baseUrl, requestScope)
          ).map((t) => ({
            name: t.name,
            address: `${c.id}.${t.name}`,
            ...(t.description !== undefined
              ? { description: t.description }
              : {}),
          }));
        } catch {
          // broken connector: reported via status "error", tools stay empty
        }
      }
      let credential: UiConnector["credential"];
      if (c.credential && credentialVault) {
        // One rule, shared with the test route: only the hook matching the
        // declared credential shape can run, so the button is offered only
        // where a click can succeed (src/credentials.ts).
        const testRule = credentialTestRule(c);
        const credentialFields = (
          metadata?: Awaited<ReturnType<CredentialVault["metadata"]>>,
        ) =>
          c.credential?.fields?.map((field) => {
            const fieldMetadata = metadata?.fields?.[field.name];
            return {
              name: field.name,
              label: field.label,
              ...(field.description
                ? { description: field.description }
                : {}),
              ...(field.placeholder
                ? { placeholder: field.placeholder }
                : {}),
              inputType: field.inputType ?? "password",
              configured: Boolean(fieldMetadata),
              ...(fieldMetadata
                ? {
                    lastFour: fieldMetadata.lastFour,
                    updatedAt: fieldMetadata.updatedAt,
                  }
                : {}),
            };
          });
        try {
          const metadata = await credentialVault.metadata(c.id);
          const fields = credentialFields(metadata);
          const shape = storedCredentialShape(
            c.credential,
            metadata?.fields ?? null,
          );
          credential = {
            label: c.credential.label,
            ...(c.credential.description
              ? { description: c.credential.description }
              : {}),
            ...(c.credential.placeholder
              ? { placeholder: c.credential.placeholder }
              : {}),
            ...(fields?.length ? { fields } : {}),
            configured: shape.state === "valid",
            removable: Boolean(metadata),
            ...(metadata
              ? {
                  lastFour: metadata.lastFour,
                  updatedAt: metadata.updatedAt,
                }
              : {}),
            testable:
              testRule.mode !== null && shape.state !== "mismatch",
            ...(shape.state === "mismatch"
              ? { error: shape.message }
              : {}),
            // A dropped field leaves its secret in the vault, and the field
            // list below only renders fields the connector still declares —
            // so without this line there is nowhere an operator could see it.
            ...(shape.state === "valid" && shape.undeclared.length
              ? {
                  notice: describeUndeclaredCredentialFields(
                    shape.undeclared,
                  ),
                }
              : {}),
          };
        } catch {
          const fields = credentialFields();
          credential = {
            label: c.credential.label,
            ...(c.credential.description
              ? { description: c.credential.description }
              : {}),
            ...(c.credential.placeholder
              ? { placeholder: c.credential.placeholder }
              : {}),
            ...(fields?.length ? { fields } : {}),
            configured: false,
            removable: true,
            testable: testRule.mode !== null,
            error: "Stored credential could not be read.",
          };
        }
      }
      return {
        id: c.id,
        ...(c.title ? { title: c.title } : {}),
        ...(c.description !== undefined
          ? { description: c.description }
          : {}),
        status: status.state,
        ...(status.message ? { message: status.message } : {}),
        ...(isSafeHttpUrl(status.authorizationUrl)
          ? { authorizationUrl: status.authorizationUrl }
          : {}),
        toolCount: tools.length,
        tools,
        ...(c.disconnectAuth && c.startAuth ? { oauth: true } : {}),
        ...(credentialCheck
          ? {
              credentialCheck: {
                state: credentialCheck.state,
                checkedAt: credentialCheck.checkedAt,
                ...(credentialCheck.message
                  ? { message: credentialCheck.message }
                  : {}),
              },
            }
          : {}),
        ...(credential ? { credential } : {}),
      };
    },
  );
  await mapSettledWithConcurrency(
    connectorSet,
    concurrency,
    (connector) =>
      closeConnectorScope(
        connector,
        registry.contextFor(connector.id, baseUrl, requestScope),
        defer,
      ),
  );
  const connectors = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  return {
    serverInfo,
    connectaVersion: CONNECTA_VERSION,
    connectors,
    activityEnabled,
    credentialManagement,
    oauthManagement,
  };
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/**
 * Every operator page serves this same data-free shell. Connector, credential,
 * and activity data arrives only through the authenticated `/ui/*` APIs.
 */
export function renderUiHtml(
  uiAuth?: UiAuthConfig,
  mcpUrl = "/mcp",
  branding?: ConnectaBranding,
  nonce?: string,
  page: OperatorPage = "connections",
): string {
  const clerk = uiAuth?.kind === "clerk" ? uiAuth : undefined;
  // The Clerk loader's origin. A value that fails the gate is dropped rather
  // than escaped into the page: the loader tag is simply not emitted, the gate
  // reports that Clerk could not load, and the rest of the shell still renders —
  // the same fallback-and-warn posture the branding URLs take, with the drop
  // named in a startup warning (see `droppedUiAuthUrls`).
  const clerkScriptOrigin =
    clerk && isSafeHttpsUrl(clerk.frontendApiUrl)
      ? clerk.frontendApiUrl
      : undefined;
  // Enumerated field by field, because this object is serialized into the page's
  // inline script: a rejected frontendApiUrl must not reach the document through
  // `AUTH` after being kept out of the `<script src>`, and a rejected
  // signInUrl/signUpUrl — which `AUTH` is the only path into the page for — must
  // not reach it at all. Dropping one leaves the key absent, so `Clerk.load`
  // falls back to its own default the same way it does for an unset value.
  const auth = clerk
    ? {
        kind: clerk.kind,
        publishableKey: clerk.publishableKey,
        ...(clerkScriptOrigin ? { frontendApiUrl: clerkScriptOrigin } : {}),
        ...(isSafeHttpsUrl(clerk.signInUrl)
          ? { signInUrl: clerk.signInUrl }
          : {}),
        ...(isSafeHttpsUrl(clerk.signUpUrl)
          ? { signUpUrl: clerk.signUpUrl }
          : {}),
      }
    : (uiAuth ?? { kind: "bearer" as const });
  const brand = resolveBranding(branding);
  const title = operatorPageTitle(page, brand.pageTitle);
  // When an operator shell ships a nonce-based CSP, every script it emits must
  // carry that nonce to run; without a nonce the markup is unchanged.
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
  // Top-left corner. With an owner set it reads "<owner> <product>"; without
  // one the product label stands alone. Either half links out when the
  // matching URL is configured.
  const owner = brand.ownerName
    ? brand.ownerUrl
      ? `<a class="brand navlink" href="${escapeHtmlAttr(brand.ownerUrl)}">${escapeHtmlAttr(brand.ownerName)}</a>`
      : `<span class="brand">${escapeHtmlAttr(brand.ownerName)}</span>`
    : brand.productUrl
      ? `<a class="brand navlink" href="${escapeHtmlAttr(brand.productUrl)}">${escapeHtmlAttr(brand.productName)}</a>`
      : `<span class="brand">${escapeHtmlAttr(brand.productName)}</span>`;
  const product = brand.ownerName
    ? brand.productUrl
      ? `<a class="product navlink" href="${escapeHtmlAttr(brand.productUrl)}">${escapeHtmlAttr(brand.productName)}</a>`
      : `<span class="product">${escapeHtmlAttr(brand.productName)}</span>`
    : "";
  const clerkScript =
    clerk && clerkScriptOrigin
      ? `<script${nonceAttr} defer crossorigin="anonymous" data-clerk-publishable-key="${escapeHtmlAttr(clerk.publishableKey)}" src="${escapeHtmlAttr(clerkScriptOrigin)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${escapeHtmlAttr(brand.themeColor)}">
<meta name="description" content="${escapeHtmlAttr(brand.description)}">
<link rel="icon" href="${escapeHtmlAttr(brand.faviconHref)}" type="image/svg+xml">
<link rel="shortcut icon" href="/favicon.ico">
<title>${escapeHtmlAttr(title)}</title>
${clerkScript}
<style>${OPERATOR_UI_CSS}</style>
</head>
<body>
<a class="skip-link" href="#operatorContent">Skip to operator page</a>
<header class="masthead shell pgrid">
  ${owner}
  <div class="mast-nav">
    ${product}
    <div id="appNav" class="mast-actions hidden">
      <nav class="page-nav" aria-label="Operator pages">
        <a id="connectionsNav" class="navlink" href="/"
          data-operator-page="connections"${page === "connections" ? ' aria-current="page"' : ""}>Connections</a>
        <a id="credentialsNav" class="navlink hidden" href="/credentials"
          data-operator-page="credentials"${page === "credentials" ? ' aria-current="page"' : ""}>Credentials</a>
        <a id="activityNav" class="navlink hidden" href="/activity"
          data-operator-page="activity"${page === "activity" ? ' aria-current="page"' : ""}>Activity</a>
      </nav>
      <div class="session-actions" aria-label="Session actions">
        <button id="change" class="navlink hidden" type="button">Change token</button>
        <button id="signout" class="navlink hidden" type="button">Sign out</button>
      </div>
    </div>
  </div>
</header>

<main id="operatorContent" class="page shell" tabindex="-1">
  <section id="gate" class="hidden">
    <div class="lead pgrid">
      <h1 id="gateHeading" class="pcap" tabindex="-1">${OPERATOR_PAGE_LABELS[page]}</h1>
      <div class="pbody lead-copy">
        <p>${escapeHtmlAttr(brand.description)}</p>
        <p id="gateCopy" class="meta"></p>
        <div id="tokenGate" class="row gate-actions hidden">
          <input id="token" type="password" placeholder="Bearer token" autocomplete="off"
            aria-label="Bearer token">
          <button id="save" class="linklike" type="button">Open operator pages</button>
        </div>
        <div id="clerkGate" class="actions gate-actions hidden">
          <button id="signin" class="linklike" type="button">Team sign in</button>
          <button id="gateSignout" class="linklike hidden" type="button">Sign out</button>
        </div>
        <p id="err" role="alert"></p>
      </div>
    </div>
  </section>

  <div id="app" class="hidden">
  <section id="connectionsView"${page === "connections" ? "" : ' class="hidden"'}>
    <div class="lead pgrid">
      <h1 id="connectionsHeading" class="pcap" tabindex="-1">Connections</h1>
      <div class="pbody lead-copy">
        <p>Use this endpoint to give an MCP client access to the tools below.</p>
        <div class="endpoint">
          <div class="endpoint-row">
            <code id="mcpUrl" class="mono"></code>
            <button id="copyMcpUrl" class="linklike" type="button">Copy URL</button>
          </div>
        </div>
        <p class="cap" id="serverInfo">${escapeHtmlAttr(brand.productName)} operator</p>
        <p id="oauthNotice" class="meta" role="status" aria-live="polite" tabindex="-1"></p>
      </div>
    </div>
    <section class="section pgrid" aria-labelledby="connectorLedgerHeading">
      <h2 class="pcap" id="connectorLedgerHeading">Connectors</h2>
      <div class="pbody">
        <div class="row toolbar">
          <input id="filter" type="search" placeholder="Filter connectors or tools…"
            aria-label="Filter connectors or tools">
        </div>
        <div id="list" class="connector-tools" aria-busy="false"></div>
      </div>
    </section>
  </section>

  <section id="credentialsView"${page === "credentials" ? "" : ' class="hidden"'}>
    <div class="lead pgrid">
      <h1 id="credentialsHeading" class="pcap" tabindex="-1">Credentials</h1>
      <div class="pbody">
        <p class="activity-copy">Rotate operator-managed connector credentials. Stored values are never returned or displayed.</p>
        <p id="credentialNotice" class="meta" role="status" aria-live="polite"
          tabindex="-1"></p>
        <div id="credentialUnavailable" class="unavailable hidden"></div>
        <div id="credentialList" class="credential-ledger" aria-busy="false"></div>
      </div>
    </div>
  </section>

  <section id="activityView"${page === "activity" ? "" : ' class="hidden"'}>
    <div class="lead pgrid">
      <h1 id="activityHeading" class="pcap" tabindex="-1">Activity</h1>
      <div class="pbody">
        <p class="activity-copy" id="activitySummary">Arguments and results are never stored.</p>
        <div id="activityUnavailable" class="unavailable hidden">
          Activity history is not configured. Add an <span class="mono">activity.store</span>
          with a list reader to enable this page.
        </div>
        <div id="activityAvailable">
          <div class="row activity-controls">
            <input id="activitySearch" type="search"
              placeholder="Search user, tool, or outcome…"
              aria-label="Search loaded activity">
            <button id="refreshActivity" class="linklike" type="button">Refresh</button>
          </div>
          <p id="activityNotice" class="meta" role="status" aria-live="polite"></p>
          <div id="activityList" class="activity-ledger" aria-busy="false"></div>
          <button id="moreActivity" class="linklike activity-more hidden" type="button">Load older</button>
        </div>
      </div>
    </div>
  </section>
  </div>
</main>

<script${nonceAttr}>
const AUTH = ${jsonForInlineScript(auth)};
const MCP_URL = ${jsonForInlineScript(mcpUrl)};
const INITIAL_PAGE = ${jsonForInlineScript(page)};
const TITLE_SUFFIX = ${jsonForInlineScript(brand.pageTitle)};
const PRODUCT_NAME = ${stringForInlineScript(brand.productName)};
const PRODUCT_OPERATOR_LABEL = ${stringForInlineScript(brand.productName + " operator")};
${OPERATOR_UI_SCRIPT}</script>
</body>
</html>`;
}
