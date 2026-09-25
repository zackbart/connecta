import type { OperatorSurface } from "./module-contracts.js";
import { routeUi } from "./routes/ui.js";
import { routeCredentials } from "./routes/credentials.js";
import { routeOAuthManagement } from "./routes/oauth-management.js";
import { uiData } from "./routes/ui-data.js";
import { runEdge } from "./runtime/run.js";
import type { CredentialVault } from "./credential-contract.js";
import { type DeferredWork } from "./connector-scope.js";
import {
  type CredentialManagementCapability,
  type UiData,
  type UiProblem,
  type UiToolSafety,
} from "./operator-ui/model.js";
import { isExplicitlyReadOnly, type ApprovalPolicy } from "./tool-safety.js";
import {
  OPERATOR_UI_CSS,
  OPERATOR_UI_SCRIPT,
} from "./operator-ui/generated.js";
import type { RegistryView } from "./registry.js";
import type {
  ConnectaBranding,
  Connector,
  ConnectorStatus,
  ToolDef,
  UiAuthConfig,
} from "./types.js";

export {
  filterUiConnectors,
  type CredentialManagementCapability,
  type UiConnector,
  type UiData,
} from "./operator-ui/model.js";

import { resolveBranding, isSafeHttpsUrl, themeCss } from "./branding.js";
export { CONNECTA_FAVICON_SVG, resolveBranding, isSafeHttpUrl, isSafeHttpsUrl, isSafeIconHref } from "./branding.js";
/**
 * A JS string literal safe to inline in a script element. Escaping `/` keeps
 * an operator-supplied `</script>` from terminating the element early.
 */
function stringForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/\//g, "\\/");
}

export type OperatorPage =
  | "connections"
  | "activity"
  | "artifacts"
  | "artifact";

const OPERATOR_PAGE_LABELS: Readonly<Record<OperatorPage, string>> = {
  connections: "Connections",
  activity: "Activity",
  artifacts: "Artifacts",
  artifact: "Artifact",
};

/** `/artifacts/<id>` and its snapshots, `/artifacts/<id>/v/<version>`. */
const ARTIFACT_PAGE = /^\/artifacts\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\/v\/\d{1,9})?$/;

export function operatorPageForPath(path: string): OperatorPage | undefined {
  if (path === "/") return "connections";
  if (path === "/activity") return "activity";
  if (path === "/artifacts") return "artifacts";
  if (ARTIFACT_PAGE.test(path)) return "artifact";
  return undefined;
}

/** Everything artifact pages own: shells, their API, and the frame. */
function isArtifactPath(path: string): boolean {
  return path === "/artifacts" || path.startsWith("/artifacts/");
}

export function operatorPageTitle(
  page: OperatorPage,
  configuredTitle: string,
): string {
  return `${OPERATOR_PAGE_LABELS[page]} — ${configuredTitle}`;
}

/**
 * The badge a tool earns, from the predicates core enforces with. Computed
 * here so the page reports the rule rather than restating it. `exempt` is the
 * config exemption (#566), which `isApprovalExempt` already refuses to grant
 * a read-only tool.
 */
export function uiToolSafety(definition: ToolDef, exempt = false): UiToolSafety {
  if (isExplicitlyReadOnly(definition)) return "runs_in_programs";
  return exempt ? "exempt" : "needs_approval";
}

/**
 * The fix-prompt key for a connector that is not usable. Chosen from the
 * status state and the connector's declared auth shape — configuration, never
 * the status message, which can carry a downstream error body.
 */
export function uiProblemFor(
  connector: Pick<Connector, "credential" | "startAuth">,
  status: ConnectorStatus["state"],
  observed: { credentialDrift: boolean; catalogFailed: boolean },
): UiProblem | undefined {
  if (observed.credentialDrift) return "credential_mismatch";
  if (status === "error") return "connector_unavailable";
  if (status === "auth_required") {
    if (connector.startAuth) return "oauth_required";
    return connector.credential ? "credential_required" : "auth_required";
  }
  return observed.catalogFailed ? "catalog_failed" : undefined;
}

export function credentialManagementCapability(input: {
  eligibleOperator: boolean;
  hasCredentialSlots: boolean;
  hasCredentialVault: boolean;
}): CredentialManagementCapability {
  if (!input.eligibleOperator) return "requires_operator";
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
  registry: RegistryView,
  baseUrl: string,
  serverInfo: { name: string; version: string },
  credentialVault?: CredentialVault,
  activityEnabled = false,
  credentialManagement: CredentialManagementCapability = credentialVault
    ? "available"
    : "requires_operator",
  defer?: DeferredWork,
  oauthManagement = false,
  discoveryConcurrency?: number,
  personalCredentialOwner?: string,
  detailOptions: {
    mayManage?: (id: string) => boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    approval?: ApprovalPolicy;
  } = {},
): Promise<UiData> {
  return runEdge(
    uiData(registry, baseUrl, {
      serverInfo,
      credentialVault,
      activityEnabled,
      credentialManagement,
      defer,
      oauthManagement,
      discoveryConcurrency,
      personalCredentialOwner,
      ...detailOptions,
    }),
  );
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
  options: {
    /** Where the Connections page lives, when this shell is on another origin. */
    homeUrl?: string;
  } = {},
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
      ? `<script${nonceAttr} crossorigin="anonymous" data-clerk-publishable-key="${escapeHtmlAttr(clerk.publishableKey)}" src="${escapeHtmlAttr(clerkScriptOrigin)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>`
      : "";

  // A pinned scheme is an attribute, not a stylesheet edit: the dark palette
  // keys off `html[data-scheme]`, so "system" leaves the attribute off and the
  // media query decides.
  const schemeAttr =
    brand.theme.colorScheme === "system"
      ? ""
      : ` data-scheme="${brand.theme.colorScheme}"`;

  return `<!doctype html>
<html lang="en"${schemeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${escapeHtmlAttr(brand.themeColor)}">
<meta name="description" content="${escapeHtmlAttr(brand.description)}">
<link rel="icon" href="${escapeHtmlAttr(brand.faviconHref)}" type="image/svg+xml">
<link rel="shortcut icon" href="/favicon.ico">
<title>${escapeHtmlAttr(title)}</title>
${clerkScript}
<style>${OPERATOR_UI_CSS}${themeCss(brand.theme)}</style>
</head>
<body>
<a class="skip-link" href="#operatorContent">Skip to operator page</a>
<header class="masthead shell">
  <div class="masthead-inner">
    <div class="mast-nav">
      ${owner}
      ${product}
    </div>
    <div id="operatorNav"></div>
  </div>
</header>

<main id="operatorContent" class="page shell" tabindex="-1">
  <div class="lead">
    <h1>${OPERATOR_PAGE_LABELS[page]}</h1>
    <div class="lead-copy">
      <p>${escapeHtmlAttr(brand.description)}</p>
      <noscript><p class="msg">The operator pages need JavaScript. Nothing else here
      does — agents reach this deployment through <span class="mono">/mcp</span>.</p></noscript>
    </div>
  </div>
</main>

<script${nonceAttr}>
const AUTH = ${jsonForInlineScript(auth)};
const MCP_URL = ${jsonForInlineScript(mcpUrl)};
const INITIAL_PAGE = ${jsonForInlineScript(page)};
const HOME_URL = ${jsonForInlineScript(options.homeUrl ?? "/")};
const TITLE_SUFFIX = ${jsonForInlineScript(brand.pageTitle)};
const PRODUCT_NAME = ${stringForInlineScript(brand.productName)};
const PRODUCT_DESCRIPTION = ${stringForInlineScript(brand.description)};
const PRODUCT_OPERATOR_LABEL = ${stringForInlineScript(brand.productName + " operator")};
${OPERATOR_UI_SCRIPT}</script>
</body>
</html>`;
}

function ownsOperatorPath(reserved: readonly string[], path: string): boolean {
  if (path === "/activity") return true;
  return reserved.some((pattern) =>
    pattern.endsWith("/*")
      ? path.startsWith(pattern.slice(0, -1))
      : path === pattern,
  );
}

/** Mount the connection UI without enabling any storage or activity module. */
export function operatorUi(
  options: { branding?: ConnectaBranding } = {},
): OperatorSurface {
  const reservedPaths = ["/", "/ui", "/ui/*", "/favicon.svg", "/favicon.ico"];
  return {
    ...options,
    reservedPaths,
    credentialHandoffUrl(baseUrl) {
      return new URL("/", baseUrl).toString();
    },
    async handle(context) {
      // Everything else belongs to the server, and reaches it untouched: no
      // route here, and no activity module, runs for a path this surface does
      // not own. The Activity page is the one addition; the server reserves
      // it only when history is readable, and routeUi checks the same thing.
      // Artifact pages are the other: they exist only beside the module.
      const artifacts = context.opts.artifactsModule;
      const artifactPath = Boolean(artifacts) && isArtifactPath(context.path);
      if (!artifactPath && !ownsOperatorPath(reservedPaths, context.path)) return null;
      if (artifactPath && !operatorPageForPath(context.path)) {
        // The pages' JSON API and the sandboxed frame; the module owns both,
        // and this bundle imports none of it.
        return (await artifacts?.handle(context)) ??
          new Response("Not Found", { status: 404 });
      }
      const routes = [
        ...(context.opts.credentialVault ? [routeCredentials] : []),
        routeOAuthManagement,
        routeUi,
      ];
      for (const route of routes) {
        const response = await route(context);
        if (response) {
          if (operatorPageForPath(context.path) || context.path === "/ui") {
            response.headers.set("X-Frame-Options", "DENY");
            if (!response.headers.has("Content-Security-Policy")) {
              response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
            }
          }
          return response;
        }
      }
      return context.opts.activityModule?.handle(context) ?? null;
    },
  };
}
