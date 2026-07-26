import type { CredentialVault } from "./credentials.js";
import type { Registry } from "./registry.js";
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
 * Names of the branding URLs the operator set that failed their gate and were
 * replaced by a default. Lives beside the gates so the startup warning cannot
 * drift from them, and takes `unknown` fields for the same reason
 * `resolveBranding` does — a warning helper must never throw.
 */
export function droppedBrandingUrls(branding?: ConnectaBranding): string[] {
  if (!branding) return [];
  const resolved = resolveBranding(branding);
  // A non-string still counts as "set": the operator meant to supply a URL, and
  // that intent is exactly what the warning reports on. A blank string does not.
  const isSet = (value: unknown) =>
    typeof value === "string"
      ? trimmedString(value) !== undefined
      : value !== undefined && value !== null;
  const faviconHref = branding.favicon?.href;
  return [
    ...(isSet(branding.productUrl) && !resolved.productUrl ? ["productUrl"] : []),
    ...(isSet(branding.ownerUrl) && !resolved.ownerUrl ? ["ownerUrl"] : []),
    ...(isSet(faviconHref) &&
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
 * Root-relative only, because `/ui` and `/oauth/callback/<id>` sit at different
 * depths and a document-relative path would resolve differently on each.
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
 * True only for an absolute `https:` URL — the gate for `uiAuth.frontendApiUrl`,
 * the last operator-config value that lands in a URL-valued HTML position (the
 * `<script src>` of `/ui`'s sign-in loader). `javascript:` in a `src` does not
 * execute, so this closes a hole in the *invariant* rather than a live vector:
 * every operator value reaching an `href`/`src` is validated, with no exception
 * left to remember.
 *
 * Stricter than `isSafeHttpUrl` on purpose. There is no `http:` carve-out and no
 * loopback carve-out, because nobody types this value: the shipped Clerk adapter
 * derives it from the publishable key and Clerk's Frontend API is always https.
 * A cleartext script source on the dashboard would be a downgrade even where a
 * browser's mixed-content rules had not already blocked it.
 */
export function isSafeScriptSrcUrl(url: unknown): boolean {
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
 * is untyped at a JS call site — `isSafeScriptSrcUrl` takes `unknown`, and a
 * `uiAuth` that is not the clerk shape is reported as nothing to warn about.
 */
export function droppedUiAuthUrls(uiAuth?: UiAuthConfig): string[] {
  if (!uiAuth || uiAuth.kind !== "clerk") return [];
  return isSafeScriptSrcUrl(uiAuth.frontendApiUrl)
    ? []
    : ["uiAuth.frontendApiUrl"];
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
  };
}

export interface UiData {
  serverInfo: { name: string; version: string };
  connectors: UiConnector[];
  activityEnabled: boolean;
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
): Promise<UiData> {
  const requestScope = {};
  const connectors = await Promise.all(
    registry.listConnectors().map(async (c): Promise<UiConnector> => {
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
          credential = {
            label: c.credential.label,
            ...(c.credential.description
              ? { description: c.credential.description }
              : {}),
            ...(c.credential.placeholder
              ? { placeholder: c.credential.placeholder }
              : {}),
            ...(fields?.length ? { fields } : {}),
            configured: fields?.length
              ? fields.every((field) => field.configured)
              : Boolean(metadata),
            removable: Boolean(metadata),
            ...(metadata
              ? {
                  lastFour: metadata.lastFour,
                  updatedAt: metadata.updatedAt,
                }
              : {}),
            testable: Boolean(c.testCredential || c.testCredentials),
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
            testable: Boolean(c.testCredential || c.testCredentials),
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
  );
  return { serverInfo, connectors, activityEnabled };
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
 * The `/ui` shell carries no connector data: everything comes client-side from
 * the auth-gated `/ui/data`. A configured Clerk provider gives operators a
 * normal sign-in flow and a short-lived session token; bearer-only deployments
 * retain the manual-token fallback.
 */
export function renderUiHtml(
  uiAuth?: UiAuthConfig,
  mcpUrl = "/mcp",
  branding?: ConnectaBranding,
  nonce?: string,
): string {
  const clerk = uiAuth?.kind === "clerk" ? uiAuth : undefined;
  // The Clerk loader's origin. A value that fails the gate is dropped rather
  // than escaped into the page: the loader tag is simply not emitted, the gate
  // reports that Clerk could not load, and the rest of the shell still renders —
  // the same fallback-and-warn posture the branding URLs take, with the drop
  // named in a startup warning (see `droppedUiAuthUrls`).
  const clerkScriptOrigin =
    clerk && isSafeScriptSrcUrl(clerk.frontendApiUrl)
      ? clerk.frontendApiUrl
      : undefined;
  // Enumerated field by field, because this object is serialized into the page's
  // inline script: a rejected frontendApiUrl must not reach the document through
  // `AUTH` after being kept out of the `<script src>`.
  const auth = clerk
    ? {
        kind: clerk.kind,
        publishableKey: clerk.publishableKey,
        ...(clerkScriptOrigin ? { frontendApiUrl: clerkScriptOrigin } : {}),
        ...(clerk.signInUrl ? { signInUrl: clerk.signInUrl } : {}),
        ...(clerk.signUpUrl ? { signUpUrl: clerk.signUpUrl } : {}),
      }
    : (uiAuth ?? { kind: "bearer" as const });
  const brand = resolveBranding(branding);
  const title = brand.pageTitle;
  // When the /ui response ships a nonce-based CSP, every <script> it emits must
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
  .navlink,
  .linklike {
    text-decoration: underline;
    text-decoration-thickness: 1.5px;
    text-underline-offset: .22em;
  }
  .navlink { text-decoration-color: transparent; }
  .navlink:hover,
  .navlink:focus-visible,
  .navlink.active { text-decoration-color: currentColor; }
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
  .card { border-top: 1px solid var(--rule); padding: .75rem 0; }
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
  .card h2 { overflow-wrap: anywhere; }
  .connector-state { text-align: right; }
  .dot {
    border: 1px solid var(--ink);
    display: inline-block;
    flex: none;
    height: .5rem;
    width: .5rem;
  }
  .dot.ok { background: var(--ink); }
  .dot.auth_required {
    background: linear-gradient(90deg, var(--ink) 50%, var(--paper) 50%);
  }
  .connector-description { margin-top: .25rem; max-width: 40rem; }
  .connector-message,
  .connector-auth { margin-top: .75rem; }

  .credential { border-top: 1px solid var(--rule); margin-top: .75rem; padding-top: .75rem; }
  .credential-head {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: .25rem var(--gap);
    justify-content: space-between;
  }
  .credential-copy { margin-top: .25rem; max-width: 40rem; }
  .credential-actions { display: flex; flex-wrap: wrap; gap: var(--gap); margin-top: .75rem; }
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
    padding: .75rem 0;
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

  @media (max-width: 36.99rem) {
    .pgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pcap,
    .pbody { grid-column: 1 / -1; }
    .masthead .brand { grid-column: 1; }
    .mast-nav { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
    .product { display: none; }
    .mast-actions { font-size: .875rem; gap: .5rem; white-space: nowrap; }
    .lead { margin-top: 4rem; }
    .section,
    .section + .section { margin-top: 2.5rem; }
    .connector-head,
    .tool,
    .activity-item { grid-template-columns: 1fr; }
    .connector-state { text-align: left; }
    .credential-field { align-items: start; grid-template-columns: 1fr; gap: .25rem; }
  }
</style>
</head>
<body>
<header class="masthead shell pgrid">
  ${owner}
  <div class="mast-nav">
    ${product}
    <nav id="appNav" class="mast-actions hidden" aria-label="Dashboard views">
      <button id="configTab" class="navlink active" type="button"
        aria-pressed="true">Connections</button>
      <button id="activityTab" class="navlink hidden" type="button"
        aria-pressed="false">Activity</button>
      <button id="change" class="navlink hidden" type="button">Change token</button>
      <button id="signout" class="navlink hidden" type="button">Sign out</button>
    </nav>
  </div>
</header>

<main id="gate" class="page shell hidden">
  <section class="lead pgrid">
    <h1 class="pcap">Tool connections</h1>
    <div class="pbody lead-copy">
      <p>${escapeHtmlAttr(brand.description)}</p>
      <p id="gateCopy" class="meta"></p>
      <div id="tokenGate" class="row gate-actions hidden">
        <input id="token" type="password" placeholder="Bearer token" autocomplete="off"
          aria-label="Bearer token">
        <button id="save" class="linklike" type="button">Open dashboard</button>
      </div>
      <div id="clerkGate" class="actions gate-actions hidden">
        <button id="signin" class="linklike" type="button">Team sign in</button>
        <button id="gateSignout" class="linklike hidden" type="button">Sign out</button>
      </div>
      <p id="err"></p>
    </div>
  </section>
</main>

<main id="app" class="page shell hidden">
  <section id="configView">
    <div class="lead pgrid">
      <h1 class="pcap">MCP connection</h1>
      <div class="pbody lead-copy">
        <p>Use this endpoint to give an MCP client access to the tools below.</p>
        <div class="endpoint">
          <div class="endpoint-row">
            <code id="mcpUrl" class="mono"></code>
            <button id="copyMcpUrl" class="linklike" type="button">Copy URL</button>
          </div>
        </div>
        <p class="cap" id="serverInfo">${escapeHtmlAttr(brand.productName)} status dashboard</p>
      </div>
    </div>
    <section class="section pgrid" aria-labelledby="connectorsHeading">
      <h2 class="pcap" id="connectorsHeading">Connectors</h2>
      <div class="pbody">
        <div class="row toolbar">
          <input id="filter" type="search" placeholder="Filter connectors or tools…"
            aria-label="Filter connectors or tools">
        </div>
        <p id="notice" role="status" aria-live="polite"></p>
        <div id="list" class="connector-tools"></div>
      </div>
    </section>
  </section>
  <section id="activityView" class="hidden">
    <div class="lead pgrid">
      <h1 class="pcap">Tool activity</h1>
      <div class="pbody">
        <p class="activity-copy" id="activitySummary">Arguments and results are never stored.</p>
        <div class="row activity-controls">
          <input id="activitySearch" type="search"
            placeholder="Search user, tool, or outcome…"
            aria-label="Search loaded activity">
          <button id="refreshActivity" class="linklike" type="button">Refresh</button>
        </div>
        <p id="activityNotice" class="meta" role="status" aria-live="polite"></p>
        <div id="activityList" class="activity-ledger"></div>
        <button id="moreActivity" class="linklike activity-more hidden" type="button">Load older</button>
      </div>
    </div>
  </section>
</main>

<script${nonceAttr}>
const AUTH = ${jsonForInlineScript(auth)};
const MCP_URL = ${jsonForInlineScript(mcpUrl)};
const filterUiConnectors = ${filterUiConnectors.toString()};
const KEY = "connecta:token";
const $ = (id) => document.getElementById(id);
let DATA = null;
let ACTIVITY = [];
let ACTIVITY_CURSOR = null;
let ACTIVITY_LOADED = false;
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
  $("notice").textContent = message || "";
  $("notice").classList.toggle("error-notice", Boolean(isError));
}

async function sessionToken() {
  return AUTH.kind === "clerk"
    ? await Clerk.session?.getToken()
    : localStorage.getItem(KEY);
}

function showGate(msg) {
  $("app").classList.add("hidden");
  $("appNav").classList.add("hidden");
  $("gate").classList.remove("hidden");
  $("err").textContent = msg || "";
  if (AUTH.kind === "clerk") {
    const signedIn = Boolean(window.Clerk && Clerk.user);
    $("gateCopy").textContent = signedIn
      ? "Signed in with Clerk, but this account cannot open the dashboard."
      : "Sign in with Clerk to open the dashboard.";
    $("signin").classList.toggle("hidden", signedIn);
    $("gateSignout").classList.toggle("hidden", !signedIn);
  } else {
    $("gateCopy").textContent = "";
  }
}

async function load() {
  let token;
  try {
    token = await sessionToken();
  } catch (e) {
    return showGate("Could not read the Clerk session: " + e.message);
  }
  if (!token) return showGate("");
  let res;
  try {
    res = await fetch("/ui/data", { headers: { Authorization: "Bearer " + token } });
  } catch (e) {
    return showGate("Network error: " + e.message);
  }
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
  DATA = await res.json();
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("appNav").classList.remove("hidden");
  const si = DATA.serverInfo || {};
  $("serverInfo").textContent = (si.name || ${escapeScriptString(brand.productName)}) + " v" + (si.version || "?");
  $("activityTab").classList.toggle("hidden", !DATA.activityEnabled);
  render();
}

function showView(view) {
  const activity = view === "activity";
  $("configView").classList.toggle("hidden", activity);
  $("activityView").classList.toggle("hidden", !activity);
  $("configTab").classList.toggle("active", !activity);
  $("activityTab").classList.toggle("active", activity);
  $("configTab").setAttribute("aria-pressed", String(!activity));
  $("activityTab").setAttribute("aria-pressed", String(activity));
  if (activity && !ACTIVITY_LOADED) loadActivity(true);
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
    item.className = "activity-item " + esc(event.outcome);
    const retryCopy = event.attempts > 1 ? " · " + event.attempts + " attempts" : "";
    const errorCopy = event.errorCode ? " · " + esc(event.errorCode) : "";
    item.innerHTML =
      '<div><div class="activity-time">' + esc(formatDate(event.occurredAt)) +
      '</div><div class="activity-actor">' + esc(actorLabel(event.actor)) + '</div></div>' +
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
  $("activityNotice").textContent = "Loading activity…";
  $("refreshActivity").disabled = true;
  $("moreActivity").disabled = true;
  try {
    const token = await sessionToken();
    if (!token) throw new Error("Your session has expired.");
    const cursor = reset ? null : ACTIVITY_CURSOR;
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch("/ui/activity?" + params, {
      headers: { Authorization: "Bearer " + token },
    });
    let payload = {};
    try { payload = await res.json(); } catch (e) {}
    if (!res.ok) {
      throw new Error(payload.error || "Activity could not be loaded (" + res.status + ").");
    }
    ACTIVITY = reset
      ? (payload.events || [])
      : ACTIVITY.concat(payload.events || []);
    ACTIVITY_CURSOR = payload.nextCursor || null;
    ACTIVITY_LOADED = true;
    $("activityNotice").textContent = "";
    renderActivity();
  } catch (e) {
    $("activityNotice").textContent = e.message || "Activity could not be loaded.";
  } finally {
    $("refreshActivity").disabled = false;
    $("moreActivity").disabled = false;
  }
}

function render() {
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
      const cred = c.credential;
      const configured = Boolean(cred.configured);
      const removable = configured || Boolean(cred.removable);
      const state = configured
        ? "configured · ••••" + esc(cred.lastFour || "")
        : "not configured";
      const updated = configured && cred.updatedAt
        ? " · updated " + esc(formatDate(cred.updatedAt))
        : "";
      head += '<section class="credential" aria-label="' + esc(cred.label) + '">';
      head += '<div class="credential-head"><span class="credential-label">' +
        esc(cred.label) + '</span><span class="credential-state">' + state +
        updated + "</span></div>";
      if (cred.description) {
        head += '<p class="credential-copy meta">' + esc(cred.description) + "</p>";
      }
      if (cred.error) {
        head += '<div class="msg">' + esc(cred.error) + "</div>";
      }
      if (AUTH.kind === "clerk") {
        head += '<div class="credential-actions">';
        head += '<button class="linklike" type="button" data-credential-action="edit" data-connector="' +
          esc(c.id) + '">' + (removable ? "Replace" : "Add credential") + "</button>";
        if (configured && cred.testable) {
          head += '<button class="linklike" type="button" data-credential-action="test" data-connector="' +
            esc(c.id) + '">Test</button>';
        }
        if (removable) {
          head += '<button type="button" class="linklike danger" data-credential-action="remove" data-connector="' +
            esc(c.id) + '">Remove</button>';
        }
        head += "</div>";
        head += '<div class="credential-form hidden" data-credential-form="' +
          esc(c.id) + '">';
        if (cred.fields && cred.fields.length) {
          head += '<div class="credential-fields">';
          for (const field of cred.fields) {
            head += '<div class="credential-field"><label>' +
              esc(field.label) + '</label><input type="' +
              esc(field.inputType || "password") + '" data-credential-field="' +
              esc(field.name) + '" aria-label="' + esc(field.label) +
              '" placeholder="' + esc(field.placeholder || field.label) +
              '" autocomplete="' +
              (field.inputType === "password" ? "new-password" : "off") +
              '" autocapitalize="none" spellcheck="false"></div>';
          }
          head += "</div>";
        } else {
          head += '<input type="password" data-credential-input="' +
            esc(c.id) + '" aria-label="' + esc(cred.label) + '" placeholder="' +
            esc(cred.placeholder || "Paste credential") +
            '" autocomplete="new-password" autocapitalize="none" spellcheck="false">';
        }
        head += '<button class="linklike" type="button" data-credential-action="save" data-connector="' +
          esc(c.id) + '">Save</button><button class="linklike" type="button" data-credential-action="cancel" data-connector="' +
          esc(c.id) + '">Cancel</button></div>';
      } else {
        head += '<p class="credential-copy meta">Team sign in is required to manage this credential.</p>';
      }
      head += "</section>";
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
    list.innerHTML = '<p class="empty">No connectors or tools match this filter.</p>';
  }
}

async function credentialRequest(connector, method, action, body) {
  const token = await sessionToken();
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

$("list").onclick = async (event) => {
  const button = event.target.closest("[data-credential-action]");
  if (!button) return;
  const connector = button.dataset.connector;
  const action = button.dataset.credentialAction;
  const form = credentialForm(connector);

  if (action === "edit") {
    form.classList.remove("hidden");
    form.querySelector("input")?.focus();
    return;
  }
  if (action === "cancel") {
    form.querySelectorAll("input").forEach((input) => { input.value = ""; });
    form.classList.add("hidden");
    return;
  }
  if (action === "remove" && !window.confirm(
    "Remove this credential? The connector will stop authenticating until a replacement is added."
  )) return;

  setNotice("");
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
        await credentialRequest(connector, "PUT", "", { values });
      } else {
        const input = form.querySelector("[data-credential-input]");
        const value = input.value.trim();
        if (!value) throw new Error("Paste a credential before saving.");
        await credentialRequest(connector, "PUT", "", { value });
      }
      form.querySelectorAll("input").forEach((input) => { input.value = ""; });
      setNotice("Credential saved.");
      await load();
    } else if (action === "remove") {
      await credentialRequest(connector, "DELETE");
      setNotice("Credential removed.");
      await load();
    } else if (action === "test") {
      const result = await credentialRequest(connector, "POST", "test");
      setNotice(
        result.message || (result.ok ? "Credential is valid." : "Credential test failed."),
        !result.ok,
      );
    }
  } catch (e) {
    setNotice(e.message || "Credential action failed.", true);
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
};

$("save").onclick = () => {
  const v = $("token").value.trim();
  if (!v) return;
  localStorage.setItem(KEY, v);
  $("token").value = "";
  load();
};
$("change").onclick = () => { localStorage.removeItem(KEY); showGate(""); };
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
$("signin").onclick = () => Clerk.redirectToSignIn({
  signInFallbackRedirectUrl: window.location.href,
  signUpFallbackRedirectUrl: window.location.href,
});
$("gateSignout").onclick = () => Clerk.signOut({ redirectUrl: window.location.href });
$("signout").onclick = () => Clerk.signOut({ redirectUrl: window.location.href });
$("filter").oninput = () => { if (DATA) render(); };
$("configTab").onclick = () => showView("config");
$("activityTab").onclick = () => showView("activity");
$("refreshActivity").onclick = () => loadActivity(true);
$("moreActivity").onclick = () => loadActivity(false);
$("activitySearch").oninput = () => renderActivity();

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
    } catch (e) {
      return showGate("Clerk could not initialize: " + e.message);
    }
  } else {
    $("tokenGate").classList.remove("hidden");
    $("change").classList.remove("hidden");
  }
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
