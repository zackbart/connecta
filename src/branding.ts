import type { ConnectaBranding, ConnectaTheme, UiAuthConfig } from "./types.js";
/** Connecta's default monochrome "C" mark. */
export const CONNECTA_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    .fg { fill: #000 }
    @media (prefers-color-scheme: dark) { .fg { fill: #fff } }
  </style>
  <path class="fg" d="M27 9.4A13 13 0 1 0 27 22.6l-4.4-2.5a8 8 0 1 1 0-8.2z"/>
</svg>`;

export interface ResolvedTheme {
  accent?: string;
  radius?: string;
  fontFamily?: string;
  monoFamily?: string;
  colorScheme: "system" | "light" | "dark";
}

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
  /** Only the tokens that survived their gate; the stylesheet owns the rest. */
  theme: ResolvedTheme;
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
    theme: resolveTheme(branding?.theme),
  };
}

/**
 * Hex colors only: `#rgb`, `#rrggbb`, `#rrggbbaa`. A hex value cannot carry a
 * `url()`, a `var()`, or a closing brace into the `:root` block it is written
 * into, which is the whole reason the gate is this narrow.
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A single non-negative CSS length, or a bare number the caller reads as px. */
const CSS_LENGTH = /^(?:0|[0-9]{1,3}(?:\.[0-9]{1,3})?)(px|rem|em)?$/;

/**
 * One family name: bare, or wrapped in matching quotes. The character class
 * excludes everything CSS needs to end a declaration or open a function (`;`,
 * `{`, `}`, `(`, `)`, backslash, `<`, `>`, `@`, `*`, `/`, `:`), and matched
 * quotes mean the value cannot leave an open string that swallows the CSS
 * after it.
 */
const FONT_NAME = /^(?:"[a-z0-9 ._-]+"|'[a-z0-9 ._-]+'|[a-z][a-z0-9 ._-]*)$/i;

/** A font-family list: comma-separated names and nothing else. */
function isFontStack(value: string): boolean {
  if (value.length > 200) return false;
  const names = value.split(",");
  return names.length <= 12 &&
    names.every((name) => FONT_NAME.test(name.trim()));
}

const COLOR_SCHEMES = ["system", "light", "dark"] as const;

/**
 * Read a theme the way branding URLs are read: gate every field, drop what
 * fails, never throw. This runs during `createConnecta`, so a malformed value
 * has to fall back to the stylesheet default instead of refusing to serve the
 * page. `droppedThemeTokens` names the drops for the startup warning.
 */
export function resolveTheme(theme?: ConnectaTheme): ResolvedTheme {
  const accent = trimmedString(theme?.accent);
  const fontFamily = trimmedString(theme?.fontFamily);
  const monoFamily = trimmedString(theme?.monoFamily);
  const scheme = trimmedString(theme?.colorScheme);
  const radius = radiusLength(theme?.radius);
  return {
    ...(accent && HEX_COLOR.test(accent) ? { accent } : {}),
    ...(radius !== undefined ? { radius } : {}),
    ...(fontFamily && isFontStack(fontFamily) ? { fontFamily } : {}),
    ...(monoFamily && isFontStack(monoFamily) ? { monoFamily } : {}),
    colorScheme: COLOR_SCHEMES.includes(scheme as (typeof COLOR_SCHEMES)[number])
      ? (scheme as ResolvedTheme["colorScheme"])
      : "system",
  };
}

/**
 * `radius` accepts a number as well as a string, since a config file is more
 * likely to say `10` than `"10px"`. A bare number means pixels; a string must
 * carry its own unit or be zero.
 */
function radiusLength(radius: unknown): string | undefined {
  if (typeof radius === "number") {
    return Number.isFinite(radius) && radius >= 0 && radius <= 999
      ? `${radius}px`
      : undefined;
  }
  const value = trimmedString(radius);
  if (!value || !CSS_LENGTH.test(value)) return undefined;
  return /[a-z]$/i.test(value) || value === "0" ? value : `${value}px`;
}

/**
 * Names of the theme tokens the operator set that failed their gate. Same
 * contract as `droppedBrandingUrls`: rendering falls back silently, so this is
 * the only place an operator learns their value never reached the page.
 */
export function droppedThemeTokens(theme?: ConnectaTheme): string[] {
  if (!theme) return [];
  const resolved = resolveTheme(theme);
  const dropped: string[] = [];
  if (isSetValue(theme.accent) && !resolved.accent) dropped.push("accent");
  if (isSetValue(theme.radius) && resolved.radius === undefined) {
    dropped.push("radius");
  }
  if (isSetValue(theme.fontFamily) && !resolved.fontFamily) {
    dropped.push("fontFamily");
  }
  if (isSetValue(theme.monoFamily) && !resolved.monoFamily) {
    dropped.push("monoFamily");
  }
  // Compared against the trimmed value the resolver reads, so `" dark "` is
  // not reported as dropped when it was applied.
  if (
    isSetValue(theme.colorScheme) &&
    trimmedString(theme.colorScheme) !== resolved.colorScheme
  ) {
    dropped.push("colorScheme");
  }
  return dropped.map((token) => `theme.${token}`);
}

/**
 * The resolved theme as a `:root` block, or "" when a deployment configured
 * nothing. It is emitted after the stylesheet so it overrides the defaults.
 * There is no escaping here: every value has already passed a gate above, and
 * anything that would need escaping is dropped rather than rewritten.
 */
export function themeCss(theme: ResolvedTheme): string {
  const declarations = [
    theme.accent ? `--accent:${theme.accent}` : "",
    theme.radius !== undefined ? `--radius:${theme.radius}` : "",
    theme.fontFamily ? `--sans:${theme.fontFamily}` : "",
    theme.monoFamily ? `--mono:${theme.monoFamily}` : "",
  ].filter(Boolean);
  return declarations.length ? `:root{${declarations.join(";")}}` : "";
}

/**
 * Whether the operator meant to supply a value here — the question every
 * dropped-value warning asks before naming a field, and one definition so the
 * branding and `uiAuth` warnings cannot answer it differently. A non-string
 * counts as set: the intent was there and is exactly what the warning reports
 * on. A blank or whitespace-only string does not; that is indistinguishable
 * from leaving the field alone, and both take the default silently.
 */
function isSetValue(value: unknown): boolean {
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
    ...(isSetValue(branding.productUrl) && !resolved.productUrl
      ? ["productUrl"]
      : []),
    ...(isSetValue(branding.ownerUrl) && !resolved.ownerUrl
      ? ["ownerUrl"]
      : []),
    ...(isSetValue(faviconHref) &&
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
function safeUrl(url: unknown, schemes: string[]): boolean {
  if (typeof url !== "string") return false;
  try {
    return schemes.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function isSafeHttpUrl(url: unknown): boolean {
  return safeUrl(url, ["http:", "https:"]);
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

/** Absolute HTTPS gate for the `UiAuthConfig` URL fields documented in types.ts. */
export function isSafeHttpsUrl(url: unknown): boolean {
  return safeUrl(url, ["https:"]);
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
 * took no default away from anyone. `isSetValue` decides that, the same way
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
    ...(isSetValue(uiAuth.signInUrl) && !isSafeHttpsUrl(uiAuth.signInUrl)
      ? ["uiAuth.signInUrl"]
      : []),
    ...(isSetValue(uiAuth.signUpUrl) && !isSafeHttpsUrl(uiAuth.signUpUrl)
      ? ["uiAuth.signUpUrl"]
      : []),
  ];
}
