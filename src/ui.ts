import type { OperatorSurface } from "./module-contracts.js";
import { routeUi } from "./routes/ui.js";
import { routeCredentials } from "./routes/credentials.js";
import { routeOAuthManagement } from "./routes/oauth-management.js";
import { withDeadline } from "./timeout.js";
import {
  credentialTestRule,
  describeUndeclaredCredentialFields,
  storedCredentialShape,
} from "./credential-rules.js";
import type { CredentialVault } from "./credential-contract.js";
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
import type { RegistryView } from "./registry.js";
import type {
  ConnectaBranding,
  ConnectorStatus,
  UiAuthConfig,
} from "./types.js";
import { CONNECTA_VERSION } from "./version.js";

export {
  filterUiConnectors,
  type CredentialManagementCapability,
  type UiConnector,
  type UiData,
} from "./operator-ui/model.js";

import { resolveBranding, isSafeHttpsUrl } from "./branding.js";
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
  | "activity";

const OPERATOR_PAGE_LABELS: Readonly<Record<OperatorPage, string>> = {
  connections: "Connections",
  activity: "Activity",
};

export function operatorPageForPath(path: string): OperatorPage | undefined {
  if (path === "/") return "connections";
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
  detailOptions: { mayManage?: (id: string) => boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<UiData> {
  const requestScope = {};
  const connectorSet = registry.listConnectors();
  const concurrency = resolveDiscoveryConcurrency(discoveryConcurrency);
  const settled = await mapSettledWithConcurrency(
    connectorSet,
    concurrency,
    async (c): Promise<UiConnector> => {
      try {
        return await withDeadline(async outerSignal => {
          const drift = await registry.credentialDriftFor(c.id);
          outerSignal.throwIfAborted();
          let tools: UiTool[] = [];
          let status: ConnectorStatus;
          try {
            status = await withDeadline(async signal => {
              if (drift) return { state: "auth_required", message: drift } as ConnectorStatus;
              const current = await registry.statusFor(c.id, baseUrl, requestScope, { signal });
              if (current.state === "ok" && !signal.aborted) {
                try {
                  tools = (await registry.getTools(c.id, baseUrl, requestScope, { signal })).map(t => ({ name: t.name, address: `${c.id}.${t.name}`, ...(t.description ? { description: t.description } : {}) }));
                } catch { /* The registry owns the failed catalog observation. */ }
              }
              return current;
            }, { timeoutMs: detailOptions.timeoutMs ?? 30_000, signal: outerSignal, timeoutError: new Error("Connection details timed out. Retry this connection.") });
          } catch (error) { status = { state: "error", message: error instanceof Error ? error.message : "Connection details unavailable" }; }
          let credential: UiConnector["credential"];
          const mayManageAuth = detailOptions.mayManage?.(c.id) ?? (c.authScope === "personal" ? Boolean(personalCredentialOwner) : oauthManagement);
          if (c.credential && credentialVault && mayManageAuth) {
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
            const credentialCard = {
              label: c.credential.label,
              ...(c.credential.description
                ? { description: c.credential.description }
                : {}),
              ...(c.credential.placeholder
                ? { placeholder: c.credential.placeholder }
                : {}),
            };
            try {
              const metadata = await credentialVault.metadata(
                c.id,
                c.authScope === "personal" ? personalCredentialOwner : undefined,
              );
              const fields = credentialFields(metadata);
              const shape = storedCredentialShape(
                c.credential,
                metadata?.fields ?? null,
              );
              credential = {
                ...credentialCard,
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
                ...credentialCard,
                ...(fields?.length ? { fields } : {}),
                configured: false,
                removable: true,
                testable: testRule.mode !== null,
                error: "Stored credential could not be read.",
              };
            }
          }
          outerSignal.throwIfAborted();
          return {
            id: c.id,
            authScope: c.authScope ?? "shared",
            ...(c.title ? { title: c.title } : {}),
            ...(c.description !== undefined
              ? { description: c.description }
              : {}),
            status: status.state,
            ...(status.message ? { message: status.message } : {}),
            toolCount: tools.length,
            tools,
            // Counts only, and only when a refresh in this runtime produced them.
            // `Registry.statusFor` already rebuilt the report through
            // `boundedCatalogDrift`, so what lands here cannot carry a name or a
            // schema even if the plugin seam returned one.
            ...(status.catalogDrift ? { catalogDrift: status.catalogDrift } : {}),
            ...(status.catalogAccess
              ? { catalogAccess: status.catalogAccess }
              : {}),
            ...(c.disconnectAuth &&
            c.startAuth &&
            (oauthManagement ||
              c.authScope === "personal" ||
              !personalCredentialOwner)
              ? { oauth: true }
              : {}),
            ...(credential ? { credential } : {}),
          };
        }, {
          timeoutMs: detailOptions.timeoutMs ?? 30_000,
          ...(detailOptions.signal ? { signal: detailOptions.signal } : {}),
          timeoutError: new Error("Connection details timed out. Retry this connection."),
        });
      } catch (error) {
        return {
          id: c.id,
          ...(c.title ? { title: c.title } : {}),
          authScope: c.authScope ?? "shared",
          status: "error",
          message: error instanceof Error ? error.message : "Connection details unavailable",
          toolCount: 0,
          tools: [],
        };
      } finally {
        await closeConnectorScope(
          c,
          registry.contextFor(c.id, baseUrl, requestScope),
          defer,
        );
      }
    },
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
    oauthManagement: oauthManagement || Boolean(personalCredentialOwner),
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
      ? `<script${nonceAttr} crossorigin="anonymous" data-clerk-publishable-key="${escapeHtmlAttr(clerk.publishableKey)}" src="${escapeHtmlAttr(clerkScriptOrigin)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>`
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
    <div id="operatorNav"></div>
  </div>
</header>

<main id="operatorContent" class="page shell" tabindex="-1">
  <div class="lead pgrid">
    <h1 class="pcap">${OPERATOR_PAGE_LABELS[page]}</h1>
    <div class="pbody lead-copy">
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
const TITLE_SUFFIX = ${jsonForInlineScript(brand.pageTitle)};
const PRODUCT_NAME = ${stringForInlineScript(brand.productName)};
const PRODUCT_DESCRIPTION = ${stringForInlineScript(brand.description)};
const PRODUCT_OPERATOR_LABEL = ${stringForInlineScript(brand.productName + " operator")};
${OPERATOR_UI_SCRIPT}</script>
</body>
</html>`;
}

/** Mount the connection UI without enabling any storage or activity module. */
export function operatorUi(
  options: { branding?: ConnectaBranding } = {},
): OperatorSurface {
  return {
    ...options,
    reservedPaths: ["/", "/ui", "/ui/*", "/favicon.svg", "/favicon.ico"],
    credentialHandoffUrl(baseUrl) {
      return new URL("/", baseUrl).toString();
    },
    async handle(context) {
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
