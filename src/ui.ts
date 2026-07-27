import {
  credentialTestRule,
  describeUndeclaredCredentialFields,
  storedCredentialShape,
} from "./credentials.js";
import type { CredentialVault } from "./credentials.js";
import { closeConnectorScope } from "./connector-scope.js";
import type { Registry } from "./registry.js";
import type { Toolkit } from "./toolkits.js";
import type { ConnectaBranding, UiAuthConfig } from "./types.js";

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

export const DEFAULT_FAVICON_HREF = "/favicon.svg";

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
 * A JS string literal safe to inline in a <script> block. JSON.stringify alone
 * leaves `/` untouched, so a value containing "</script>" would close the
 * element early — operator-supplied branding still goes through here.
 */
function escapeScriptString(value: string): string {
  return JSON.stringify(value).replace(/\//g, "\\/");
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

export interface UiTool {
  name: string;
  address: string;
  description?: string;
}

export interface UiConnector {
  id: string;
  title?: string;
  description?: string;
  status: "ok" | "auth_required" | "error";
  message?: string;
  authorizationUrl?: string;
  toolCount: number;
  tools: UiTool[];
  /**
   * Verdict of the last proactive credential liveness check (issue #24), for the
   * connectors that hold a credential connecta stores. Shown beside the live
   * status so an operator can tell "checked just now" from "last verified an
   * hour ago", and see a dead credential the page's own probe may not reach.
   */
  credentialCheck?: {
    state: "ok" | "auth_required" | "error";
    checkedAt: string;
    message?: string;
  };
  credential?: {
    label: string;
    description?: string;
    placeholder?: string;
    fields?: Array<{
      name: string;
      label: string;
      description?: string;
      placeholder?: string;
      inputType: "email" | "password" | "text";
      configured: boolean;
      lastFour?: string;
      updatedAt?: string;
    }>;
    configured: boolean;
    /** A stored value exists and may be deleted even if it cannot be decrypted. */
    removable?: boolean;
    lastFour?: string;
    updatedAt?: string;
    testable: boolean;
    error?: string;
    /**
     * Something true and non-blocking about a working credential — today, that
     * the vault still holds fields the connector has stopped declaring.
     * Distinct from `error`, which means the credential cannot be used.
     */
    notice?: string;
  };
}

export interface UiData {
  serverInfo: { name: string; version: string };
  connectors: UiConnector[];
  /** Read-only projection of the validated deployment config. */
  toolkits: UiToolkit[];
  activityEnabled: boolean;
  credentialManagement: CredentialManagementCapability;
}

export interface UiToolkit {
  name: string;
  connectors: string[];
  includeTools: string[];
  excludeTools: string[];
  /** Tools currently loaded through healthy connectors and visible in this view. */
  toolCount: number;
}

export type CredentialManagementCapability =
  | "available"
  | "requires_clerk"
  | "vault_not_configured"
  | "no_slots";

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

export interface FilteredUiConnector {
  connector: UiConnector;
  tools: UiTool[];
}

/**
 * Filter by connector identity/description or tool name/description. A
 * connector-level match stays visible even when it currently exposes no tools
 * (for example while authorization is required).
 */
export function filterUiConnectors(
  connectors: UiConnector[],
  query: string,
): FilteredUiConnector[] {
  const q = query.trim().toLowerCase();
  const filtered: FilteredUiConnector[] = [];
  for (const connector of connectors) {
    const connectorText = [
      connector.id,
      connector.title,
      connector.description,
      connector.status,
    ]
      .join(" ")
      .toLowerCase();
    const connectorMatches = Boolean(q && connectorText.includes(q));
    const tools = connector.tools.filter(
      (tool) =>
        !q ||
        connectorMatches ||
        `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(q),
    );
    if (q && tools.length === 0 && !connectorMatches) continue;
    filtered.push({ connector, tools });
  }
  return filtered;
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
  toolkits?: ReadonlyMap<string, Toolkit>,
): Promise<UiData> {
  const requestScope = {};
  const connectorSet = registry.listConnectors();
  const connectors = await Promise.all(
    connectorSet.map(async (c): Promise<UiConnector> => {
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
            description: t.description,
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
        description: c.description,
        status: status.state,
        ...(status.message ? { message: status.message } : {}),
        ...(isSafeHttpUrl(status.authorizationUrl)
          ? { authorizationUrl: status.authorizationUrl }
          : {}),
        toolCount: tools.length,
        tools,
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
    }),
  ).finally(async () => {
    await Promise.all(
      connectorSet.map((connector) =>
        closeConnectorScope(
          connector,
          registry.contextFor(connector.id, baseUrl, requestScope),
        ),
      ),
    );
  });
  const toolkitData: UiToolkit[] = [...(toolkits?.values() ?? [])].map(
    (toolkit) => ({
      name: toolkit.name,
      connectors: [...toolkit.connectors],
      includeTools: [...toolkit.includeTools],
      excludeTools: [...toolkit.excludeTools],
      toolCount: connectors.reduce(
        (count, connector) =>
          count +
          (toolkit.hasConnector(connector.id)
            ? connector.tools.filter((tool) =>
                toolkit.hasTool(connector.id, tool.name),
              ).length
            : 0),
        0,
      ),
    }),
  );
  return {
    serverInfo,
    connectors,
    toolkits: toolkitData,
    activityEnabled,
    credentialManagement,
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
<style>
  :root {
    color-scheme: light;
    --ink: #000;
    --paper: #fff;
    --rule: #ccc;
    --muted: #666;
    --trace: #f5f5f5;
    --shell: 70rem;
    --pad: 1rem;
    --gap: 1.5rem;
    --sans: "Helvetica Neue", Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", Consolas,
      monospace;
  }
  * { border-radius: 0; box-sizing: border-box; }
  html {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  body { margin: 0; min-height: 100vh; }
  ::selection { background: var(--ink); color: var(--paper); }
  :is(h1, h2, h3, p, ul, ol) { margin: 0; padding: 0; }
  :is(h1, h2, h3) { font-size: inherit; font-weight: 400; }
  :is(ul, ol) { list-style: none; }
  a { color: inherit; }
  button, input { font: inherit; }
  button {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    margin: 0;
    padding: 0;
    text-align: left;
  }
  button:disabled { cursor: wait; opacity: .5; }
  input {
    background: var(--paper);
    border: 1px solid var(--rule);
    color: var(--ink);
    min-height: 2rem;
    padding: .2rem .5rem;
  }
  input:focus-visible { outline-offset: -1px; }
  :is(a, button, input, summary):focus-visible {
    outline: 1px solid var(--ink);
  }
  :is(a, button, summary):focus-visible { outline-offset: 2px; }
  .skip-link {
    background: var(--paper);
    left: var(--pad);
    padding: .5rem;
    position: fixed;
    top: -4rem;
    z-index: 10;
  }
  .skip-link:focus { top: var(--pad); }

  .shell {
    margin: 0 auto;
    max-width: var(--shell);
    padding-left: var(--pad);
    padding-right: var(--pad);
  }
  .pgrid {
    column-gap: var(--gap);
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    row-gap: 1rem;
  }
  .pcap { grid-column: 1; }
  .pbody { grid-column: 2 / -1; min-width: 0; }
  .cap, .meta { color: var(--muted); font-size: .9em; }
  .mono { font-family: var(--mono); font-size: .78rem; }
  .hidden { display: none !important; }
  .visually-hidden {
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .masthead {
    align-items: start;
    padding-bottom: var(--pad);
    padding-top: var(--pad);
  }
  .brand {
    font-weight: 500;
    grid-column: 1;
    text-decoration: none;
  }
  .mast-nav {
    display: flex;
    gap: var(--gap);
    grid-column: 2 / -1;
    justify-content: space-between;
    min-width: 0;
  }
  .mast-actions {
    display: flex;
    gap: var(--gap);
    justify-content: flex-end;
    min-width: 0;
  }
  .page-nav,
  .session-actions {
    display: flex;
    flex-wrap: wrap;
    gap: .5rem var(--gap);
  }
  .mast-actions :is(a, button) {
    align-items: center;
    display: inline-flex;
    min-height: 2rem;
  }
  .navlink,
  .linklike {
    text-decoration: underline;
    text-decoration-thickness: 1.5px;
    text-underline-offset: .22em;
  }
  .navlink { text-decoration-color: transparent; }
  .navlink:hover,
  .navlink:focus-visible,
  .navlink[aria-current="page"] { text-decoration-color: currentColor; }
  .linklike { text-decoration-color: currentColor; }
  .linklike:hover,
  .linklike:focus-visible { text-decoration-color: transparent; }

  .page { padding-bottom: 5rem; }
  .lead { margin-top: 6rem; }
  .section,
  .section + .section { margin-top: 3rem; }
  .lead-copy,
  .body-copy { max-width: 34em; }
  .lead-copy > * + *,
  .body-copy > * + * { margin-top: 1.5rem; }
  .row,
  .actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap);
  }
  .row input { flex: 1; min-width: 12rem; }

  .gate-actions { margin-top: 1.5rem; }
  #err { margin-top: 1.5rem; text-decoration: underline; }

  .endpoint { border-bottom: 1px solid var(--rule); border-top: 1px solid var(--rule); }
  .endpoint-row {
    align-items: baseline;
    display: flex;
    gap: var(--gap);
    min-width: 0;
    padding: .75rem 0;
  }
  .endpoint-row code {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    white-space: nowrap;
  }
  .endpoint-row button { flex: none; }

  .connector-tools { border-bottom: 1px solid var(--rule); }
  .toolbar { margin-bottom: 1.5rem; }
  .toolbar input { flex-basis: 18rem; }
  #notice { margin-bottom: .75rem; }
  #notice:empty { display: none; }
  #notice:not(:empty) { text-decoration: underline; }
  .error-notice, .msg { text-decoration: underline; }
  .card,
  .credential-card,
  .activity-item {
    padding-left: 1.25rem;
    position: relative;
  }
  .card::before,
  .credential-card::before,
  .activity-item::before {
    background: var(--rule);
    bottom: 0;
    content: "";
    left: .25rem;
    position: absolute;
    top: 0;
    width: 1px;
  }
  .card { border-top: 1px solid var(--rule); padding-bottom: .75rem; padding-top: .75rem; }
  .connector-head {
    display: grid;
    gap: var(--gap);
    grid-template-columns: minmax(0, 2fr) minmax(10rem, 1fr);
  }
  .connector-title {
    align-items: baseline;
    display: flex;
    gap: .5rem;
  }
  .connector-title .dot,
  .activity-stamp .dot {
    margin-left: -1.25rem;
  }
  .activity-stamp {
    align-items: baseline;
    display: flex;
    gap: .75rem;
  }
  .card h2 { overflow-wrap: anywhere; }
  .connector-state { text-align: right; }
  .dot {
    background: var(--paper);
    border: 1px solid var(--ink);
    display: inline-block;
    flex: none;
    height: .5rem;
    width: .5rem;
    z-index: 1;
  }
  .dot.ok { background: var(--ink); }
  .dot.auth_required {
    background: linear-gradient(90deg, var(--ink) 50%, var(--paper) 50%);
  }
  .connector-description { margin-top: .25rem; max-width: 40rem; }
  .connector-message,
  .connector-auth { margin-top: .75rem; }
  .connector-toolkits {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: .25rem .5rem;
    margin-top: .5rem;
  }
  .scope-label {
    border: 1px solid var(--rule);
    display: inline-block;
    font-family: var(--mono);
    font-size: .72rem;
    padding: .05rem .35rem;
  }

  .toolkit-copy { margin-bottom: 1rem; max-width: 42rem; }
  .toolkit-ledger { border-bottom: 1px solid var(--rule); }
  .toolkit-card {
    border-top: 1px solid var(--rule);
    padding: .9rem 0 1rem;
  }
  .toolkit-head {
    display: grid;
    gap: var(--gap);
    grid-template-columns: minmax(0, 2fr) minmax(10rem, 1fr);
  }
  .toolkit-name {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: .5rem;
  }
  .toolkit-name h3 { overflow-wrap: anywhere; }
  .toolkit-state { text-align: right; }
  .toolkit-connectors {
    display: flex;
    flex-wrap: wrap;
    gap: .5rem;
    margin-top: .75rem;
  }
  .toolkit-connector {
    border-left: 1px solid var(--ink);
    display: inline-flex;
    flex-wrap: wrap;
    gap: .4rem;
    padding-left: .5rem;
  }
  .toolkit-rules { margin-top: .75rem; }
  .toolkit-rules > * + * { margin-top: .25rem; }
  .toolkit-endpoint { margin-top: .75rem; }

  .credential-ledger { border-bottom: 1px solid var(--rule); }
  .credential-card { border-top: 1px solid var(--rule); padding-bottom: .75rem; padding-top: .75rem; }
  .credential-head {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: .25rem var(--gap);
    justify-content: space-between;
  }
  .credential-copy { margin-top: .25rem; max-width: 40rem; }
  .credential-field-summary {
    border-top: 1px solid var(--rule);
    margin-top: .75rem;
  }
  .credential-field-summary > div {
    border-bottom: 1px solid var(--rule);
    display: flex;
    flex-wrap: wrap;
    gap: .25rem var(--gap);
    justify-content: space-between;
    padding: .5rem 0;
  }
  .credential-actions { display: flex; flex-wrap: wrap; gap: var(--gap); margin-top: .75rem; }
  .credential-actions button,
  .credential-form button,
  .activity-controls button,
  .activity-more {
    align-items: center;
    display: inline-flex;
    min-height: 2.75rem;
  }
  .credential-form {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: .75rem var(--gap);
    margin-top: .75rem;
  }
  .credential-form > input { flex: 1 1 18rem; }
  .credential-fields { display: grid; flex: 1 1 100%; gap: .75rem; }
  .credential-field {
    align-items: center;
    display: grid;
    gap: var(--gap);
    grid-template-columns: minmax(9rem, 12rem) 1fr;
  }
  .credential-field input { min-width: 0; width: 100%; }
  .danger { text-decoration-style: double; }

  details { margin-top: .75rem; }
  summary { cursor: pointer; list-style: none; width: max-content; }
  summary::-webkit-details-marker { display: none; }
  .tool-list { border-bottom: 1px solid var(--rule); margin-top: .5rem; }
  .tool {
    border-top: 1px solid var(--rule);
    display: grid;
    gap: .25rem var(--gap);
    grid-template-columns: minmax(12rem, 1fr) minmax(0, 2fr);
    padding: .5rem 0;
  }
  .tool code { font-family: var(--mono); font-size: .78rem; overflow-wrap: anywhere; }
  .tool .td { color: var(--muted); font-size: .9em; }
  .empty { border-top: 1px solid var(--rule); padding: .75rem 0; }

  .activity-copy { margin-bottom: 1.5rem; }
  .activity-controls { margin-bottom: 1.5rem; }
  .activity-controls input { flex: 1 1 18rem; }
  #activityNotice { margin-bottom: .75rem; }
  .activity-ledger { border-bottom: 1px solid var(--rule); }
  .activity-item {
    border-top: 1px solid var(--rule);
    display: grid;
    gap: .25rem var(--gap);
    grid-template-columns: minmax(9rem, .85fr) minmax(12rem, 1.4fr) minmax(8rem, .9fr);
    padding-bottom: .75rem;
    padding-top: .75rem;
  }
  .activity-time,
  .activity-actor,
  .activity-detail { color: var(--muted); font-size: .82rem; }
  .activity-address { font-family: var(--mono); font-size: .78rem; overflow-wrap: anywhere; }
  .activity-outcome { font-size: .9em; }
  .activity-item.error .activity-outcome,
  .activity-item.timeout .activity-outcome { text-decoration: underline; }
  .activity-empty { border-top: 1px solid var(--rule); padding: .75rem 0; }
  .activity-more { margin-top: .75rem; }
  .unavailable {
    background: var(--trace);
    border-bottom: 1px solid var(--rule);
    border-top: 1px solid var(--rule);
    padding: .75rem;
  }

  @media (prefers-reduced-motion: reduce) {
    html:focus-within { scroll-behavior: auto; }
  }

  @media (max-width: 36.99rem) {
    .pgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pcap,
    .pbody { grid-column: 1 / -1; }
    .masthead .brand { grid-column: 1; }
    .mast-nav { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
    .product { display: none; }
    .mast-actions {
      align-items: flex-start;
      flex-direction: column;
      font-size: .875rem;
      gap: .25rem;
    }
    .lead { margin-top: 4rem; }
    .section,
    .section + .section { margin-top: 2.5rem; }
    .connector-head,
    .toolkit-head,
    .tool,
    .activity-item { grid-template-columns: 1fr; }
    .connector-state,
    .toolkit-state { text-align: left; }
    .credential-field { align-items: start; grid-template-columns: 1fr; gap: .25rem; }
    input { min-height: 2.75rem; }
  }
</style>
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
    <section class="section pgrid" aria-labelledby="toolkitLedgerHeading">
      <h2 class="pcap" id="toolkitLedgerHeading">Toolkits</h2>
      <div class="pbody">
        <p class="toolkit-copy meta">
          Read-only views from deployment config. Change the config and redeploy
          to update them.
        </p>
        <div id="toolkitList" class="toolkit-ledger"></div>
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
const filterUiConnectors = ${filterUiConnectors.toString()};
const KEY = "connecta:token";
const $ = (id) => document.getElementById(id);
const PAGE_META = {
  connections: { path: "/", label: "Connections" },
  credentials: { path: "/credentials", label: "Credentials" },
  activity: { path: "/activity", label: "Activity" },
};
let DATA = null;
let ACTIVITY = [];
let ACTIVITY_CURSOR = null;
let ACTIVITY_LOADED = false;
let CURRENT_PAGE = INITIAL_PAGE;
let SESSION_GENERATION = 0;
let ACTIVITY_GENERATION = 0;
let CLERK_SESSION_ID = null;
$("mcpUrl").textContent = MCP_URL;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Only http/https may become a clickable href — mirrors the server-side gate
// so a hostile scheme (javascript:, data:) can never be linked. Defense in depth.
function safeHttp(u) {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:" ? u : null;
  } catch (e) { return null; }
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString();
}

function setNotice(message, isError) {
  $("credentialNotice").textContent = message || "";
  $("credentialNotice").classList.toggle("error-notice", Boolean(isError));
  $("credentialNotice").setAttribute("role", isError ? "alert" : "status");
}

async function sessionToken() {
  return AUTH.kind === "clerk"
    ? await Clerk.session?.getToken()
    : localStorage.getItem(KEY);
}

function clearActivityState() {
  ACTIVITY_GENERATION += 1;
  ACTIVITY = [];
  ACTIVITY_CURSOR = null;
  ACTIVITY_LOADED = false;
  $("activityList").innerHTML = "";
  $("activityList").setAttribute("aria-busy", "false");
  $("activityNotice").textContent = "";
  $("activityNotice").setAttribute("role", "status");
  $("activitySummary").textContent = "Arguments and results are never stored.";
  $("activitySearch").value = "";
  $("refreshActivity").disabled = false;
  $("moreActivity").disabled = false;
  $("moreActivity").classList.add("hidden");
}

function clearIdentityState() {
  SESSION_GENERATION += 1;
  DATA = null;
  clearActivityState();
  $("list").innerHTML = "";
  $("toolkitList").innerHTML = "";
  $("filter").value = "";
  $("credentialList").innerHTML = "";
  $("credentialList").setAttribute("aria-busy", "false");
  $("credentialNotice").textContent = "";
  $("credentialNotice").setAttribute("role", "status");
  $("credentialNotice").classList.remove("error-notice");
  $("credentialUnavailable").textContent = "";
  $("credentialUnavailable").classList.add("hidden");
  $("credentialList").classList.add("hidden");
  $("activityUnavailable").classList.add("hidden");
  $("activityAvailable").classList.add("hidden");
  $("credentialsNav").classList.add("hidden");
  $("activityNav").classList.add("hidden");
  $("serverInfo").textContent = ${escapeScriptString(brand.productName + " operator")};
}

function showGate(msg) {
  clearIdentityState();
  $("app").classList.add("hidden");
  $("appNav").classList.add("hidden");
  $("gate").classList.remove("hidden");
  $("err").textContent = msg || "";
  if (AUTH.kind === "clerk") {
    const signedIn = Boolean(window.Clerk && Clerk.user);
    $("gateCopy").textContent = signedIn
      ? "Signed in with Clerk, but this account cannot open deployment-wide operator pages."
      : "Sign in with Clerk to open this operator page.";
    $("signin").classList.toggle("hidden", signedIn);
    $("gateSignout").classList.toggle("hidden", !signedIn);
  } else {
    $("gateCopy").textContent = "";
  }
}

function pageForPath(path) {
  if (path === "/credentials") return "credentials";
  if (path === "/activity") return "activity";
  return "connections";
}

function credentialUnavailableCopy(capability) {
  if (capability === "no_slots") {
    return "No connectors declare operator-managed credential slots. Connector credentials remain configuration-as-code until a slot is declared.";
  }
  if (capability === "vault_not_configured") {
    return "Credential storage is not configured. Set credentials.encryptionKey before managing connector credentials here.";
  }
  return "Credential management requires an eligible Clerk operator. Bearer-authenticated sessions can inspect connections but cannot manage stored credentials.";
}

function updateCapabilities() {
  const credentialsAvailable =
    DATA?.credentialManagement === "available";
  $("credentialsNav").classList.toggle("hidden", !credentialsAvailable);
  $("activityNav").classList.toggle("hidden", !DATA?.activityEnabled);
  $("credentialUnavailable").classList.toggle("hidden", credentialsAvailable);
  $("credentialList").classList.toggle("hidden", !credentialsAvailable);
  $("credentialUnavailable").textContent = credentialsAvailable
    ? ""
    : credentialUnavailableCopy(DATA?.credentialManagement);
  $("activityUnavailable").classList.toggle("hidden", Boolean(DATA?.activityEnabled));
  $("activityAvailable").classList.toggle("hidden", !DATA?.activityEnabled);
}

function activatePage(page, options) {
  const next = PAGE_META[page] ? page : "connections";
  CURRENT_PAGE = next;
  for (const name of Object.keys(PAGE_META)) {
    $(name + "View").classList.toggle("hidden", name !== next);
    const link = $(name + "Nav");
    if (name === next) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("gateHeading").textContent = PAGE_META[next].label;
  document.title = PAGE_META[next].label + " — " + TITLE_SUFFIX;
  if (DATA) {
    updateCapabilities();
    if (next === "connections") renderConnections();
    if (next === "credentials") renderCredentials();
    if (next === "activity" && DATA.activityEnabled && !ACTIVITY_LOADED) {
      loadActivity(true);
    }
  }
  if (next !== "credentials") {
    $("credentialList").innerHTML = "";
    setNotice("");
  }
  // Focus what is actually on screen. While gated the page views are hidden, so
  // focusing their heading is a silent no-op that drops focus to <body> and
  // restarts the next Tab from the top of the document — the gate's own h1 is
  // the visible heading, and activatePage has just relabelled it.
  if (options?.focus) $(DATA ? next + "Heading" : "gateHeading").focus();
}

function navigateTo(page, href) {
  history.pushState({ operatorPage: page }, "", href);
  activatePage(page, { focus: true });
}

async function load() {
  const generation = SESSION_GENERATION;
  let token;
  try {
    token = await sessionToken();
  } catch (e) {
    if (generation !== SESSION_GENERATION) return;
    return showGate("Could not read the Clerk session: " + e.message);
  }
  if (generation !== SESSION_GENERATION) return;
  if (!token) return showGate("");
  let res;
  try {
    res = await fetch("/ui/data", { headers: { Authorization: "Bearer " + token } });
  } catch (e) {
    if (generation !== SESSION_GENERATION) return;
    return showGate("Network error: " + e.message);
  }
  if (generation !== SESSION_GENERATION) return;
  if (res.status === 401 || res.status === 403) {
    if (AUTH.kind === "clerk") {
      return showGate(
        res.status === 403
          ? "This Clerk account is not allowed to access connecta."
          : "Your Clerk session was not accepted. Sign out and try again."
      );
    }
    localStorage.removeItem(KEY);
    return showGate("Token rejected — enter a valid bearer token.");
  }
  if (!res.ok) return showGate("Error " + res.status);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    if (generation !== SESSION_GENERATION) return;
    return showGate("Operator data could not be read.");
  }
  if (generation !== SESSION_GENERATION) return;
  DATA = data;
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("appNav").classList.remove("hidden");
  const si = DATA.serverInfo || {};
  $("serverInfo").textContent = (si.name || ${escapeScriptString(brand.productName)}) + " v" + (si.version || "?");
  updateCapabilities();
  activatePage(CURRENT_PAGE);
}

function actorLabel(actor) {
  if (!actor || !actor.kind) return "unknown";
  return actor.id ? actor.kind + " · " + actor.id : actor.kind;
}

function renderActivity() {
  const list = $("activityList");
  list.innerHTML = "";
  const query = $("activitySearch").value.trim().toLowerCase();
  const visible = ACTIVITY.filter((event) => {
    if (!query) return true;
    const actor = event.actor || {};
    return [
      event.address,
      event.connectorId,
      event.toolName,
      event.source,
      event.outcome,
      event.errorCode,
      actor.kind,
      actor.id,
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
  const uniqueTools = new Set(ACTIVITY.map((event) => event.address)).size;
  $("activitySummary").textContent = ACTIVITY.length
    ? ACTIVITY.length + " loaded call" + (ACTIVITY.length === 1 ? "" : "s") +
      " · " + uniqueTools + " tool" + (uniqueTools === 1 ? "" : "s") +
      " · no arguments or results stored"
    : "Arguments and results are never stored.";
  if (visible.length === 0) {
    list.innerHTML = '<div class="activity-empty">' +
      (query ? "No loaded activity matches this search." :
        "No connector tool calls recorded yet.") + "</div>";
  }
  for (const event of visible) {
    const item = document.createElement("article");
    const outcomeClass = ["success", "error", "timeout"].includes(event.outcome)
      ? event.outcome
      : "error";
    item.className = "activity-item " + outcomeClass;
    const retryCopy = event.attempts > 1
      ? " · " + esc(event.attempts) + " attempts"
      : "";
    const errorCopy = event.errorCode ? " · " + esc(event.errorCode) : "";
    item.innerHTML =
      '<div class="activity-stamp"><span class="dot ' +
      (outcomeClass === "success" ? "ok" : "") +
      '" aria-hidden="true"></span><div><time class="activity-time" datetime="' +
      esc(event.occurredAt) + '">' +
      esc(formatDate(event.occurredAt)) +
      '</time><div class="activity-actor">' + esc(actorLabel(event.actor)) + '</div></div></div>' +
      '<div><div class="activity-address">' + esc(event.address) +
      '</div><div class="activity-detail">' + esc(event.source) + retryCopy +
      errorCopy + '</div></div>' +
      '<div><div class="activity-outcome">' + esc(event.outcome) +
      '</div><div class="activity-detail">' + esc(event.durationMs) + ' ms</div></div>';
    list.appendChild(item);
  }
  $("moreActivity").classList.toggle("hidden", !ACTIVITY_CURSOR);
}

async function loadActivity(reset) {
  if (!DATA?.activityEnabled) return;
  const sessionGeneration = SESSION_GENERATION;
  if (reset) ACTIVITY_GENERATION += 1;
  const activityGeneration = ACTIVITY_GENERATION;
  const isCurrent = () =>
    sessionGeneration === SESSION_GENERATION &&
    activityGeneration === ACTIVITY_GENERATION;
  $("activityNotice").textContent = "Loading activity…";
  $("activityNotice").setAttribute("role", "status");
  $("activityList").setAttribute("aria-busy", "true");
  $("refreshActivity").disabled = true;
  $("moreActivity").disabled = true;
  try {
    const token = await sessionToken();
    if (!isCurrent()) return;
    if (!token) return showGate("Your session has expired.");
    const cursor = reset ? null : ACTIVITY_CURSOR;
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch("/ui/activity?" + params, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!isCurrent()) return;
    let payload = {};
    try { payload = await res.json(); } catch (e) {}
    if (!isCurrent()) return;
    if (res.status === 401) {
      return showGate("Your session was not accepted. Sign in again.");
    }
    if (res.status === 403) {
      clearActivityState();
      $("activityNotice").setAttribute("role", "alert");
      $("activityNotice").textContent =
        "This identity may not read activity history.";
      return;
    }
    if (!res.ok) {
      throw new Error(
        payload.error || "Activity could not be loaded (" + res.status + ")."
      );
    }
    ACTIVITY = reset
      ? (payload.events || [])
      : ACTIVITY.concat(payload.events || []);
    ACTIVITY_CURSOR = payload.nextCursor || null;
    ACTIVITY_LOADED = true;
    $("activityNotice").textContent = "";
    renderActivity();
  } catch (e) {
    if (!isCurrent()) return;
    $("activityNotice").setAttribute("role", "alert");
    $("activityNotice").textContent = e.message || "Activity could not be loaded.";
  } finally {
    if (isCurrent()) {
      $("activityList").setAttribute("aria-busy", "false");
      $("refreshActivity").disabled = false;
      $("moreActivity").disabled = false;
    }
  }
}

function toolkitMcpUrl(name) {
  const url = new URL(MCP_URL, window.location.href);
  url.searchParams.set("toolkit", name);
  return url.toString();
}

function renderToolkits() {
  const list = $("toolkitList");
  const toolkits = DATA.toolkits || [];
  list.innerHTML = "";
  if (!toolkits.length) {
    list.innerHTML =
      '<p class="empty">No toolkits are configured. Unscoped clients see the full connector registry.</p>';
    return;
  }
  const connectors = new Map(
    DATA.connectors.map((connector) => [connector.id, connector]),
  );
  for (const toolkit of toolkits) {
    const el = document.createElement("article");
    el.className = "toolkit-card";
    const connectorCount = toolkit.connectors.length;
    const toolCount = toolkit.toolCount || 0;
    let body =
      '<div class="toolkit-head"><div><div class="toolkit-name">' +
      '<h3 class="mono">' + esc(toolkit.name) + "</h3>" +
      '<span class="cap">configured view</span></div>';
    body += '</div><div class="toolkit-state cap">' +
      connectorCount + (connectorCount === 1 ? " connector" : " connectors") +
      " · " + toolCount + (toolCount === 1 ? " loaded tool" : " loaded tools") +
      "</div></div>";
    body += '<ul class="toolkit-connectors" aria-label="Included connectors">';
    for (const id of toolkit.connectors) {
      const connector = connectors.get(id);
      body += '<li class="toolkit-connector"><span>' +
        esc(connector?.title || id) + '</span><code class="mono">' +
        esc(id) + "</code></li>";
    }
    body += "</ul>";
    body += '<div class="toolkit-rules meta">';
    if (toolkit.includeTools.length) {
      body += '<p>Per-connector allowlist: <span class="mono">' +
        toolkit.includeTools.map(esc).join('</span>, <span class="mono">') +
        "</span>. Connectors without an allowlist keep all tools.</p>";
    }
    if (toolkit.excludeTools.length) {
      body += '<p>Hidden: <span class="mono">' +
        toolkit.excludeTools.map(esc).join('</span>, <span class="mono">') +
        "</span></p>";
    }
    if (!toolkit.includeTools.length && !toolkit.excludeTools.length) {
      body += "<p>All tools on the included connectors are visible.</p>";
    }
    body += "</div>";
    const endpoint = toolkitMcpUrl(toolkit.name);
    body += '<div class="endpoint toolkit-endpoint"><div class="endpoint-row">' +
      '<code class="mono">' + esc(endpoint) + "</code>" +
      '<button class="linklike" type="button" data-toolkit-copy="' +
      esc(toolkit.name) + '" aria-label="Copy endpoint for ' +
      esc(toolkit.name) + '">Copy URL</button></div></div>';
    el.innerHTML = body;
    list.appendChild(el);
  }
}

function renderConnections() {
  const q = $("filter").value.trim().toLowerCase();
  const list = $("list");
  list.innerHTML = "";
  for (const filtered of filterUiConnectors(DATA.connectors, q)) {
    const c = filtered.connector;
    const tools = filtered.tools;
    const el = document.createElement("div");
    el.className = "card";
    const status = c.status === "ok"
      ? "Connected"
      : c.status === "auth_required"
        ? "Authorization needed"
        : "Unavailable";
    let head = '<div class="connector-head"><div><div class="connector-title">' +
      '<span class="dot ' + esc(c.status) + '" aria-hidden="true"></span>' +
      '<h2>' + esc(c.title || c.id) + "</h2></div>";
    if (c.description) {
      head += '<p class="connector-description meta">' + esc(c.description) + "</p>";
    }
    const memberships = (DATA.toolkits || [])
      .filter((toolkit) => toolkit.connectors.includes(c.id))
      .map((toolkit) => toolkit.name);
    if (memberships.length) {
      head += '<div class="connector-toolkits meta"><span>Toolkits</span>' +
        memberships.map((name) =>
          '<span class="scope-label">' + esc(name) + "</span>"
        ).join("") + "</div>";
    }
    head += '</div><div class="connector-state cap">' + esc(status) + " · " +
      c.toolCount + (c.toolCount === 1 ? " tool" : " tools") +
      '<br><span class="mono">' + esc(c.id) + "</span></div></div>";
    if (c.message) {
      head += '<p class="connector-message msg">' + esc(c.message) + "</p>";
    }
    if (c.credentialCheck) {
      const check = c.credentialCheck;
      const verdict = check.state === "ok"
        ? "credential verified"
        : check.state === "auth_required"
          ? "credential needs authorization"
          : "credential check failed";
      head += '<p class="connector-check meta">Credential check: ' +
        esc(verdict) + " · " + esc(formatDate(check.checkedAt)) +
        (check.message && check.message !== c.message
          ? " — " + esc(check.message)
          : "") + "</p>";
    }
    if (c.authorizationUrl) {
      const safe = safeHttp(c.authorizationUrl);
      head += safe
        ? '<p class="connector-auth"><a class="linklike" href="' + esc(safe) +
          '" target="_blank" rel="noopener">Authorize connector →</a></p>'
        : '<p class="connector-auth meta">Authorization URL: ' +
          esc(c.authorizationUrl) + "</p>";
    }
    if (c.credential) {
      head += '<p class="connector-auth"><a class="linklike" href="/credentials" ' +
        'data-operator-page="credentials">Manage credential →</a></p>';
    }
    let body = "";
    if (tools.length) {
      body = "<details" + (q ? " open" : "") +
        '><summary class="linklike">Show tools (' + tools.length + ")</summary>" +
        '<div class="tool-list">';
      for (const t of tools) {
        body += '<div class="tool"><code>' + esc(t.address) + "</code>";
        if (t.description) body += '<span class="td">' + esc(t.description) + "</span>";
        body += "</div>";
      }
      body += "</div></details>";
    }
    el.innerHTML = head + body;
    list.appendChild(el);
  }
  if (!list.children.length) {
    list.innerHTML = '<p class="empty">' +
      (q
        ? "No connectors or tools match this filter."
        : "No connectors are declared in this deployment.") +
      "</p>";
  }
  renderToolkits();
}

function renderCredentials() {
  const list = $("credentialList");
  list.innerHTML = "";
  if (DATA.credentialManagement !== "available") return;
  for (const c of DATA.connectors.filter((connector) => connector.credential)) {
    const cred = c.credential;
    const configured = Boolean(cred.configured);
    const removable = configured || Boolean(cred.removable);
    const state = configured
      ? cred.fields?.length
        ? "configured"
        : "configured · ••••" + esc(cred.lastFour || "")
      : "not configured";
    const updated = configured && cred.updatedAt
      ? " · updated " + esc(formatDate(cred.updatedAt))
      : "";
    const el = document.createElement("section");
    el.className = "credential-card";
    el.id = "credential-" + c.id;
    el.setAttribute("aria-labelledby", "credential-title-" + c.id);
    let body = '<div class="credential-head"><div class="connector-title">' +
      '<span class="dot ' + (configured ? "ok" : "auth_required") +
      '" aria-hidden="true"></span><h2 id="credential-title-' + esc(c.id) + '">' +
      esc(c.title || c.id) + '</h2></div><span class="credential-state">' +
      state + updated + "</span></div>";
    body += '<p class="mono">' + esc(c.id) + " · " + esc(cred.label) + "</p>";
    if (cred.description) {
      body += '<p class="credential-copy meta">' + esc(cred.description) + "</p>";
    }
    if (cred.fields?.length) {
      body += '<div class="credential-field-summary">';
      for (const field of cred.fields) {
        const fieldState = field.configured
          ? "configured · ••••" + esc(field.lastFour || "") +
            (field.updatedAt ? " · updated " + esc(formatDate(field.updatedAt)) : "")
          : "not configured";
        body += '<div><span>' + esc(field.label) +
          '</span><span class="meta">' + fieldState + "</span></div>";
      }
      body += "</div>";
    }
    if (c.credentialCheck) {
      const check = c.credentialCheck;
      const verdict = check.state === "ok"
        ? "healthy"
        : check.state === "auth_required"
          ? "needs authorization"
          : "check failed";
      body += '<p class="connector-check meta">Liveness: ' + esc(verdict) +
        " · " + esc(formatDate(check.checkedAt)) +
        (check.message ? " — " + esc(check.message) : "") + "</p>";
    }
    if (cred.error) body += '<div class="msg">' + esc(cred.error) + "</div>";
    // Leftover stored fields are not an error — the credential still works, so
    // this stays muted copy rather than the msg block an actual failure earns.
    if (cred.notice) {
      body += '<p class="credential-copy meta">' + esc(cred.notice) + "</p>";
    }
    body += '<div class="credential-actions">';
    body += '<button class="linklike" type="button" data-credential-action="edit" data-connector="' +
      esc(c.id) + '">' + (removable ? "Replace" : "Add credential") + "</button>";
    if (configured && cred.testable) {
      body += '<button class="linklike" type="button" data-credential-action="test" data-connector="' +
        esc(c.id) + '">Test</button>';
    }
    if (removable) {
      body += '<button type="button" class="linklike danger" data-credential-action="remove" data-connector="' +
        esc(c.id) + '">Remove</button>';
    }
    body += "</div>";
    body += '<div class="credential-form hidden" data-credential-form="' +
      esc(c.id) + '">';
    if (cred.fields && cred.fields.length) {
      body += '<div class="credential-fields">';
      for (let index = 0; index < cred.fields.length; index += 1) {
        const field = cred.fields[index];
        const inputId = "credential-input-" + c.id + "-" + index;
        body += '<div class="credential-field"><label for="' + esc(inputId) + '">' +
          esc(field.label) + '</label><input id="' + esc(inputId) + '" type="' +
          esc(field.inputType || "password") + '" data-credential-field="' +
          esc(field.name) + '" placeholder="' + esc(field.placeholder || field.label) +
          '" autocomplete="' +
          (field.inputType === "password" ? "new-password" : "off") +
          '" autocapitalize="none" spellcheck="false"></div>';
      }
      body += "</div>";
    } else {
      const inputId = "credential-input-" + c.id;
      body += '<label class="visually-hidden" for="' + esc(inputId) + '">' +
        esc(cred.label) + '</label><input id="' + esc(inputId) +
        '" type="password" data-credential-input="' +
        esc(c.id) + '" aria-label="' + esc(cred.label) + '" placeholder="' +
        esc(cred.placeholder || "Paste credential") +
        '" autocomplete="new-password" autocapitalize="none" spellcheck="false">';
    }
    body += '<button class="linklike" type="button" data-credential-action="save" data-connector="' +
      esc(c.id) + '">Save</button><button class="linklike" type="button" data-credential-action="cancel" data-connector="' +
      esc(c.id) + '">Cancel</button></div>';
    el.innerHTML = body;
    list.appendChild(el);
  }
}

async function credentialRequest(connector, method, action, body, generation) {
  const token = await sessionToken();
  if (generation !== SESSION_GENERATION) {
    throw new Error("The operator session changed.");
  }
  if (!token) throw new Error("Your Clerk session has expired.");
  const suffix = action ? "/" + action : "";
  const res = await fetch(
    "/ui/credentials/" + encodeURIComponent(connector) + suffix,
    {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (res.status === 204) return null;
  let payload = {};
  try { payload = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(payload.error || "Request failed (" + res.status + ").");
  return payload;
}

function credentialForm(connector) {
  return document.querySelector('[data-credential-form="' +
    CSS.escape(connector) + '"]');
}

$("credentialList").onclick = async (event) => {
  const button = event.target.closest("[data-credential-action]");
  if (!button) return;
  const connector = button.dataset.connector;
  const action = button.dataset.credentialAction;
  const form = credentialForm(connector);
  const generation = SESSION_GENERATION;

  if (action === "edit") {
    form.classList.remove("hidden");
    form.querySelector("input")?.focus();
    return;
  }
  if (action === "cancel") {
    form.querySelectorAll("input").forEach((input) => { input.value = ""; });
    form.classList.add("hidden");
    document.querySelector(
      '[data-credential-action="edit"][data-connector="' +
      CSS.escape(connector) + '"]'
    )?.focus();
    return;
  }
  if (action === "remove" && !window.confirm(
    "Remove this credential? The connector will stop authenticating until a replacement is added."
  )) return;

  setNotice("");
  $("credentialList").setAttribute("aria-busy", "true");
  const buttons = [...document.querySelectorAll(
    '[data-connector="' + CSS.escape(connector) + '"]'
  )];
  buttons.forEach((item) => { item.disabled = true; });
  try {
    if (action === "save") {
      const fieldInputs = [...form.querySelectorAll("[data-credential-field]")];
      if (fieldInputs.length) {
        const values = {};
        for (const input of fieldInputs) {
          const value = input.value.trim();
          if (!value) throw new Error("Complete every credential field before saving.");
          values[input.dataset.credentialField] = value;
        }
        await credentialRequest(connector, "PUT", "", { values }, generation);
      } else {
        const input = form.querySelector("[data-credential-input]");
        const value = input.value.trim();
        if (!value) throw new Error("Paste a credential before saving.");
        await credentialRequest(connector, "PUT", "", { value }, generation);
      }
      if (generation !== SESSION_GENERATION) return;
      form.querySelectorAll("input").forEach((input) => { input.value = ""; });
      setNotice("Credential saved.");
      await load();
      if (generation !== SESSION_GENERATION) return;
      $("credentialNotice").focus();
    } else if (action === "remove") {
      await credentialRequest(connector, "DELETE", "", null, generation);
      if (generation !== SESSION_GENERATION) return;
      setNotice("Credential removed.");
      await load();
      if (generation !== SESSION_GENERATION) return;
      $("credentialNotice").focus();
    } else if (action === "test") {
      const result = await credentialRequest(
        connector,
        "POST",
        "test",
        null,
        generation,
      );
      if (generation !== SESSION_GENERATION) return;
      setNotice(
        result.message || (result.ok ? "Credential is valid." : "Credential test failed."),
        !result.ok,
      );
    }
  } catch (e) {
    if (generation !== SESSION_GENERATION) return;
    setNotice(e.message || "Credential action failed.", true);
  } finally {
    if (generation === SESSION_GENERATION) {
      $("credentialList").setAttribute("aria-busy", "false");
      buttons.forEach((item) => { item.disabled = false; });
    }
  }
};

$("save").onclick = async () => {
  const v = $("token").value.trim();
  if (!v) return;
  clearIdentityState();
  localStorage.setItem(KEY, v);
  $("token").value = "";
  await load();
  if (DATA) $(CURRENT_PAGE + "Heading").focus();
};
$("change").onclick = () => {
  localStorage.removeItem(KEY);
  showGate("");
  $("token").focus();
};
$("copyMcpUrl").onclick = async () => {
  const button = $("copyMcpUrl");
  try {
    await navigator.clipboard.writeText(MCP_URL);
    button.textContent = "Copied";
  } catch (e) {
    button.textContent = "Copy failed";
  }
  window.setTimeout(() => { button.textContent = "Copy URL"; }, 1600);
};
$("toolkitList").onclick = async (event) => {
  const button = event.target.closest("[data-toolkit-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(
      toolkitMcpUrl(button.dataset.toolkitCopy),
    );
    button.textContent = "Copied";
  } catch (e) {
    button.textContent = "Copy failed";
  }
  window.setTimeout(() => { button.textContent = "Copy URL"; }, 1600);
};
$("signin").onclick = () => Clerk.redirectToSignIn({
  signInFallbackRedirectUrl: window.location.href,
  signUpFallbackRedirectUrl: window.location.href,
});
function signOut() {
  clearIdentityState();
  return Clerk.signOut({ redirectUrl: window.location.href });
}
$("gateSignout").onclick = signOut;
$("signout").onclick = signOut;
$("filter").oninput = () => { if (DATA) renderConnections(); };
$("refreshActivity").onclick = () => loadActivity(true);
$("moreActivity").onclick = () => loadActivity(false);
$("activitySearch").oninput = () => renderActivity();
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-operator-page]");
  if (
    !link ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) return;
  const target = new URL(link.href, window.location.href);
  if (target.origin !== window.location.origin) return;
  event.preventDefault();
  navigateTo(link.dataset.operatorPage, target.pathname + target.search + target.hash);
});
window.addEventListener("popstate", () => {
  activatePage(pageForPath(window.location.pathname), { focus: true });
});

async function init() {
  if (AUTH.kind === "clerk") {
    $("clerkGate").classList.remove("hidden");
    $("signout").classList.remove("hidden");
    try {
      if (!window.Clerk) {
        return showGate("Clerk could not load. Check your network and try again.");
      }
      await Clerk.load({
        ...(AUTH.signInUrl ? { signInUrl: AUTH.signInUrl } : {}),
        ...(AUTH.signUpUrl ? { signUpUrl: AUTH.signUpUrl } : {}),
        signInFallbackRedirectUrl: window.location.href,
        signUpFallbackRedirectUrl: window.location.href,
        afterSignOutUrl: window.location.href,
      });
      CLERK_SESSION_ID = Clerk.session?.id ?? null;
      Clerk.addListener((resources) => {
        const nextSessionId = resources.session?.id ?? null;
        if (nextSessionId === CLERK_SESSION_ID) return;
        CLERK_SESSION_ID = nextSessionId;
        // Clerk has already updated its public session before notifying
        // listeners. Clear synchronously so stale identity-scoped data cannot
        // be repainted while the replacement identity is being fetched.
        showGate("");
        void load();
      });
    } catch (e) {
      return showGate("Clerk could not initialize: " + e.message);
    }
  } else {
    $("tokenGate").classList.remove("hidden");
    $("change").classList.remove("hidden");
  }
  activatePage(pageForPath(window.location.pathname));
  await load();
}

if (AUTH.kind === "clerk") {
  window.addEventListener("load", init);
} else {
  init();
}
</script>
</body>
</html>`;
}
