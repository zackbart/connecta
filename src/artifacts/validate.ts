// Static validation for artifact pages and documents.
//
// The viewer's CSP and sandbox are what keep a page in its frame; this is the
// lint that tells an agent, before it saves, what that frame will refuse — a
// relative URL, a script from an origin the CSP does not name, an element that
// cannot work there — in a message it can act on from the message alone. Every
// finding names a line where there is one, quotes the source only through the
// shared echo bound, and says what to do instead.

import { boundedEchoText } from "../errors.js";
import { utf8Bytes } from "../run-journal.js";
import { lineLocator, scanHtml, type HtmlAttribute } from "./html-scan.js";
import { jsonProblem, scriptSafeJson } from "./json.js";
import { markdownPage, MarkdownNestingError } from "./markdown.js";
import {
  DEFAULT_ARTIFACT_ALLOWLIST,
  DEFAULT_ARTIFACT_LIMITS,
  type ArtifactAllowlist,
  type ArtifactIssue,
  type ArtifactKind,
  type ArtifactLimits,
  type ArtifactValidation,
} from "./types.js";

/** An artifact id: the URL slug. No leading `_`, so `_api` and `_frame` stay free. */
export const ARTIFACT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** A document name: what a page reads as `artifact.data.<name>`. */
const DOCUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Plain-object document maps must never resolve a name through their prototype. */
export function validDocumentName(name: unknown): name is string {
  return typeof name === "string" && DOCUMENT_NAME.test(name) &&
    !Object.hasOwn(Object.prototype, name) && name !== "prototype";
}

const MAX_REPORTED = 20;
const QUOTE_BYTES = 120;
/** What the viewer adds around a page beyond its source and documents. */
const FRAME_OVERHEAD_BYTES = 4096;

const quote = (text: string) => boundedEchoText(text, QUOTE_BYTES);
const count = (n: number) => n.toLocaleString("en-US");
const kib = (bytes: number) =>
  bytes % (1024 * 1024) === 0
    ? `${bytes / (1024 * 1024)} MiB`
    : bytes % 1024 === 0
      ? `${bytes / 1024} KiB`
      : `${count(bytes)} bytes`;

/** Fill in defaults; a deployment may only tighten a limit. Throws on anything else. */
export function resolveLimits(partial: Partial<ArtifactLimits> = {}): ArtifactLimits {
  if (partial === null || typeof partial !== "object") {
    throw new TypeError("artifacts: limits must be an object");
  }
  const limits = { ...DEFAULT_ARTIFACT_LIMITS };
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in DEFAULT_ARTIFACT_LIMITS)) {
      throw new TypeError(`artifacts: unknown limit "${key}"`);
    }
    const ceiling = DEFAULT_ARTIFACT_LIMITS[key as keyof ArtifactLimits];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > ceiling) {
      throw new TypeError(
        `artifacts: limits.${key} must be a whole number from 1 to ${ceiling}; ` +
          "limits can be tightened, not raised",
      );
    }
    limits[key as keyof ArtifactLimits] = value as number;
  }
  return limits;
}

/** Normalize an allowlist: every entry an exact `https:` origin. Throws on anything else. */
export function resolveAllowlist(
  partial: Partial<ArtifactAllowlist> = {},
): ArtifactAllowlist {
  if (partial === null || typeof partial !== "object") {
    throw new TypeError("artifacts: allowlist must be an object");
  }
  const resolved: Record<keyof ArtifactAllowlist, readonly string[]> = {
    scripts: DEFAULT_ARTIFACT_ALLOWLIST.scripts,
    styles: DEFAULT_ARTIFACT_ALLOWLIST.styles,
    fonts: DEFAULT_ARTIFACT_ALLOWLIST.fonts,
  };
  for (const [key, list] of Object.entries(partial)) {
    if (!(key in resolved)) {
      throw new TypeError(`artifacts: unknown allowlist field "${key}"`);
    }
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new TypeError(`artifacts: allowlist.${key} must be an array of origins`);
    }
    const origins = list.map((entry: unknown) => {
      let origin: string | undefined;
      try {
        origin = typeof entry === "string" ? new URL(entry).origin : undefined;
      } catch {
        origin = undefined;
      }
      if (origin === undefined || origin !== entry || !origin.startsWith("https://")) {
        throw new TypeError(
          `artifacts: allowlist.${key} entries must be exact https: origins ` +
            "like https://cdn.jsdelivr.net, with no path or trailing slash",
        );
      }
      return origin;
    });
    resolved[key as keyof ArtifactAllowlist] = Object.freeze([...new Set(origins)]);
  }
  return resolved;
}

/** The URL with the characters a browser ignores removed, for scheme checks. */
function normalizedUrl(value: string): string {
  // A URL parser strips leading and trailing C0 controls and spaces, and
  // tabs and newlines anywhere, so `java\tscript:` is still a scheme.
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end).replace(/[\t\n\r]/g, "");
}

function schemeOf(value: string): string | undefined {
  return /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(normalizedUrl(value))?.[1]?.toLowerCase();
}

function httpsOrigin(value: string): { origin: string; credentials: boolean; url: URL } | undefined {
  const normalized = normalizedUrl(value);
  if (schemeOf(normalized) !== "https") return undefined;
  try {
    const url = new URL(normalized);
    return { origin: url.origin, credentials: Boolean(url.username || url.password), url };
  } catch {
    return undefined;
  }
}

/**
 * The URLs in a `srcset`, split the way the standard splits them: a URL is a
 * run of non-space characters, so the commas inside a `data:` URL stay put.
 */
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i] ?? "")) i++;
    const start = i;
    while (i < value.length && !/\s/.test(value[i] ?? "")) i++;
    let url = value.slice(start, i);
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      // Skip the descriptors, up to the comma that ends this candidate.
      let depth = 0;
      while (i < value.length && (value[i] !== "," || depth > 0)) {
        if (value[i] === "(") depth++;
        else if (value[i] === ")") depth = Math.max(0, depth - 1);
        i++;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

/** Whether a CDN URL names an exact version. `@latest` and bare package paths do not. */
function pinned(url: URL): boolean {
  const path = url.pathname.replace(/%40/gi, "@");
  if (/@latest\b/i.test(path)) return false;
  if (url.hostname === "cdnjs.cloudflare.com") {
    return /^\/ajax\/libs\/[^/]+\/\d/.test(path);
  }
  return /@v?\d/.test(path);
}

const PINNED_EXAMPLE =
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";

const EMBEDDING: Record<string, string> = {
  iframe: "pages cannot embed other pages",
  frame: "pages cannot embed other pages",
  frameset: "pages cannot embed other pages",
  portal: "pages cannot embed other pages",
  object: "pages cannot embed plugins or other documents",
  embed: "pages cannot embed plugins or other documents",
  applet: "pages cannot embed plugins or other documents",
  form: "pages cannot submit forms; use inputs without a <form> and read them from a script",
  base: "it would change how every URL on the page resolves",
};

const FORBIDDEN_ATTRIBUTES: Record<string, string> = {
  srcdoc: "it embeds another document",
  ping: "it sends a request when a link is followed, and pages have no network",
  formaction: "pages cannot submit forms",
  action: "pages cannot submit forms",
};

/** Attributes that fetch what they name. */
const RESOURCE_ATTRIBUTES = new Set(["src", "poster", "background", "data", "lowsrc", "dynsrc"]);
/** Attributes a reader follows. */
const NAVIGATION_ATTRIBUTES = new Set(["cite", "longdesc"]);

const NETWORK = /\b(fetch\s*\(|XMLHttpRequest\b|WebSocket\b|EventSource\b|sendBeacon\b|importScripts\s*\()/;
const DATA_READS = [
  /\bartifact\s*\.\s*data\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\bartifact\s*\.\s*data\s*\[\s*["']([^"'\\]{1,64})["']\s*\]/g,
];

export interface ViewCheckInput {
  kind: ArtifactKind;
  source: string;
  /** The title a Markdown page renders with. */
  title?: string;
  /** Document names the page will receive, for the missing-name warning. */
  documentNames: readonly string[];
  /** Serialized bytes of every document the page will receive. */
  dataBytes: number;
}

export interface CheckContext {
  limits: ArtifactLimits;
  allowlist: ArtifactAllowlist;
}

interface Findings {
  errors: ArtifactIssue[];
  warnings: ArtifactIssue[];
}

/** Every static finding for a page's source. */
export function checkView(input: ViewCheckInput, context: CheckContext): Findings {
  const findings: Findings = { errors: [], warnings: [] };
  const { source, kind } = input;
  const { limits } = context;
  if (typeof source !== "string" || !source.trim()) {
    findings.errors.push({
      code: "E_EMPTY",
      severity: "error",
      message:
        kind === "markdown"
          ? "The source is empty. Write the Markdown the page should show."
          : 'The source is empty. Write a complete page, e.g. <!doctype html><main id="artifact-root">…</main>.',
    });
    return findings;
  }
  const bytes = utf8Bytes(source);
  if (bytes > limits.sourceBytes) {
    findings.errors.push({
      code: "E_TOO_LARGE",
      severity: "error",
      message:
        `The source is ${count(bytes)} bytes; the limit is ${count(limits.sourceBytes)} (${kib(limits.sourceBytes)}). ` +
        "Move data into documents, or trim the page.",
    });
    return findings;
  }
  if (kind === "markdown") {
    let rendered: number;
    try {
      rendered = utf8Bytes(markdownPage(source, input.title ?? "")) + input.dataBytes + FRAME_OVERHEAD_BYTES;
    } catch (error) {
      if (!(error instanceof MarkdownNestingError)) throw error;
      findings.errors.push({ code: "E_NESTING", severity: "error", message: error.message });
      return findings;
    }
    if (rendered > limits.renderedBytes) {
      findings.errors.push({
        code: "E_TOO_LARGE",
        severity: "error",
        message:
          `The rendered page would be ${count(rendered)} bytes; the limit is ${count(limits.renderedBytes)} ` +
          `(${kib(limits.renderedBytes)}). Shorten the Markdown.`,
      });
    }
    checkMarkdownImages(source, findings);
    return findings;
  }
  const rendered = bytes + input.dataBytes + FRAME_OVERHEAD_BYTES;
  if (rendered > limits.renderedBytes) {
    findings.errors.push({
      code: "E_TOO_LARGE",
      severity: "error",
      message:
        `The page plus its documents would be ${count(rendered)} bytes; the limit is ` +
        `${count(limits.renderedBytes)} (${kib(limits.renderedBytes)}). Trim the page or its documents.`,
    });
  }
  checkHtml(input, context, findings);
  return findings;
}

function checkMarkdownImages(source: string, findings: Findings): void {
  const locate = lineLocator(source);
  const image = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = image.exec(source)) !== null) {
    const url = match[1] ?? "";
    if (/^data:image\//i.test(url)) continue;
    const { line } = locate(match.index);
    findings.warnings.push({
      code: "W_IMAGE",
      severity: "warning",
      line,
      message:
        `Line ${line}: the image ${quote(url)} will not load; pages have no network. ` +
        "Embed it as a data:image/png;base64,… URL.",
    });
  }
}

function checkHtml(input: ViewCheckInput, context: CheckContext, findings: Findings): void {
  const { source } = input;
  const { allowlist } = context;
  const tokens = scanHtml(source);
  const locate = lineLocator(source);
  const at = (offset: number) => locate(offset);
  const error = (code: string, offset: number | undefined, message: string) => {
    if (offset === undefined) {
      findings.errors.push({ code, severity: "error", message });
      return;
    }
    const { line, column } = at(offset);
    findings.errors.push({ code, severity: "error", line, column, message: `Line ${line}: ${message}` });
  };
  const warn = (code: string, offset: number | undefined, message: string) => {
    if (offset === undefined) {
      findings.warnings.push({ code, severity: "warning", message });
      return;
    }
    const { line, column } = at(offset);
    findings.warnings.push({ code, severity: "warning", line, column, message: `Line ${line}: ${message}` });
  };

  const roots: number[] = [];
  let sawDoctype = false;
  let sawElement = false;
  const externalLinks: number[] = [];
  const unpinned = new Set<string>();
  const missingNames = new Map<string, number>();
  let networkWarned = 0;

  const checkResourceUrl = (tag: string, attr: HtmlAttribute) => {
    const value = attr.value;
    const shown = `<${tag} ${attr.name}="${quote(value)}">`;
    const trimmed = normalizedUrl(value);
    if (!trimmed) {
      error("E_URL", attr.offset, `${shown} is empty. Remove the attribute or embed the content as a data: URL.`);
      return;
    }
    const scheme = schemeOf(trimmed);
    if (trimmed.startsWith("#") && (attr.name === "href" || attr.name === "xlink:href")) return;
    if (scheme === "data" || scheme === "blob") return;
    if (scheme === undefined) {
      error(
        "E_URL",
        attr.offset,
        `${shown} is relative; pages have no files beside them. Embed it as a data: URL.`,
      );
    } else if (scheme === "https" || scheme === "http") {
      error(
        "E_URL",
        attr.offset,
        `${shown} loads from the network, and pages have no network. Embed it as a data: URL.`,
      );
    } else {
      error("E_URL", attr.offset, `${shown} uses ${scheme}:, which pages cannot load. Embed it as a data: URL.`);
    }
  };

  const checkLinkUrl = (tag: string, attr: HtmlAttribute) => {
    const value = attr.value;
    const trimmed = normalizedUrl(value);
    if (!trimmed || trimmed.startsWith("#")) return;
    const shown = `<${tag} ${attr.name}="${quote(value)}">`;
    const scheme = schemeOf(trimmed);
    if (scheme === "https" || scheme === "mailto") {
      externalLinks.push(attr.offset);
      return;
    }
    if (scheme === undefined) {
      error(
        "E_URL",
        attr.offset,
        `${shown} is relative; pages have no files beside them. Link an https: URL or a #fragment.`,
      );
    } else if (scheme === "http") {
      error("E_URL", attr.offset, `${shown} uses http:. Link the https: URL instead.`);
    } else if (scheme === "javascript") {
      error(
        "E_URL",
        attr.offset,
        `${shown} uses javascript:. Attach a click handler from a <script> instead.`,
      );
    } else {
      error("E_URL", attr.offset, `${shown} uses ${scheme}:. Links may be https:, mailto:, or a #fragment.`);
    }
  };

  const checkCss = (css: string, offset: number, where: string) => {
    const urls = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
    // An @import is judged once, as an import; blank it (keeping offsets) so
    // its url() is not judged again as a resource.
    const resources = css.replace(/@import[^;]*;?/gi, (statement) => " ".repeat(statement.length));
    let match: RegExpExecArray | null;
    while ((match = urls.exec(resources)) !== null) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      const trimmed = normalizedUrl(value);
      if (trimmed.startsWith("#")) continue;
      const scheme = schemeOf(trimmed);
      if (scheme === "data" || scheme === "blob") continue;
      const https = httpsOrigin(trimmed);
      if (https && allowlist.fonts.includes(https.origin)) continue;
      const position = offset + match.index;
      error(
        "E_URL",
        position,
        scheme === undefined
          ? `${where} url(${quote(value)}) is relative; pages have no files beside them. Use a data: URL.`
          : `${where} url(${quote(value)}) loads from the network, and pages have no network. Use a data: URL.`,
      );
    }
    const imports = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi;
    while ((match = imports.exec(css)) !== null) {
      const value = match[1] ?? "";
      const https = httpsOrigin(value);
      if (https && !https.credentials && allowlist.styles.includes(https.origin)) continue;
      error(
        "E_STYLE_ORIGIN",
        offset + match.index,
        `${where} @import ${quote(value)} loads from outside the style allowlist (${allowlist.styles.join(", ")}). ` +
          "Inline the CSS, or import from one of those.",
      );
    }
  };

  const checkScriptSource = (text: string, offset: number) => {
    if (networkWarned < 3) {
      const network = NETWORK.exec(text);
      if (network) {
        networkWarned++;
        warn(
          "W_NETWORK",
          offset + network.index,
          `the script calls ${network[1]?.replace(/\s*\($/, "")}, but pages have no network. Read window.artifact.data instead.`,
        );
      }
    }
    for (const pattern of DATA_READS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1] ?? "";
        if (!input.documentNames.includes(name) && !missingNames.has(name)) {
          missingNames.set(name, offset + match.index);
        }
      }
    }
  };

  for (const token of tokens) {
    if (token.type === "doctype") {
      if (!sawElement) sawDoctype = true;
      continue;
    }
    if (token.type === "text") {
      if (token.rawOf === "style") {
        checkCss(source.slice(token.start, token.end), token.start, "<style>");
      } else if (token.rawOf === "script") {
        checkScriptSource(source.slice(token.start, token.end), token.start);
      }
      continue;
    }
    if (token.type !== "start") continue;
    sawElement = true;
    const tag = token.name;
    const attr = (name: string) => token.attrs.find((candidate) => candidate.name === name);

    const embedding = EMBEDDING[tag];
    if (embedding) {
      error("E_ELEMENT", token.start, `<${tag}> is not allowed; ${embedding}. Remove it.`);
    }
    if (tag === "meta" && attr("http-equiv")) {
      error(
        "E_ELEMENT",
        token.start,
        "<meta http-equiv> is not allowed; the viewer sets the page's headers. Remove it.",
      );
    }

    for (const attribute of token.attrs) {
      const name = attribute.name;
      if (name === "id" && attribute.value === "artifact-root") roots.push(token.start);
      // An element that is refused whole needs no second finding per URL.
      if (embedding) continue;
      const forbidden = FORBIDDEN_ATTRIBUTES[name];
      if (forbidden) {
        error("E_ATTRIBUTE", attribute.offset, `the ${name} attribute on <${tag}> is not allowed; ${forbidden}. Remove it.`);
        continue;
      }
      if (name === "style") checkCss(attribute.value, attribute.offset, `<${tag} style>`);
      if (name === "srcset" || name === "imagesrcset") {
        const bad = srcsetUrls(attribute.value).find((candidate) => {
          const scheme = schemeOf(candidate);
          return scheme !== "data" && scheme !== "blob";
        });
        if (bad !== undefined) {
          error(
            "E_ATTRIBUTE",
            attribute.offset,
            `<${tag} ${name}> names ${quote(bad)}, which cannot load; pages have no network. ` +
              "Use a single src with a data: URL.",
          );
        }
        continue;
      }
      if (tag === "script" || tag === "link") continue;
      if (name === "href" || name === "xlink:href") {
        if (tag === "a" || tag === "area") checkLinkUrl(tag, attribute);
        else checkResourceUrl(tag, attribute);
        continue;
      }
      if (RESOURCE_ATTRIBUTES.has(name)) checkResourceUrl(tag, attribute);
      else if (NAVIGATION_ATTRIBUTES.has(name)) checkLinkUrl(tag, attribute);
    }

    if (tag === "script") {
      const src = attr("src") ?? attr("href") ?? attr("xlink:href");
      if (src) {
        const https = httpsOrigin(src.value);
        const shown = `<script src="${quote(src.value)}">`;
        if (!https || https.credentials || !allowlist.scripts.includes(https.origin)) {
          error(
            "E_SCRIPT_ORIGIN",
            src.offset,
            `${shown} ${
              !https
                ? schemeOf(src.value) === undefined
                  ? "is relative, and pages have no files beside them"
                  : "is not an https: URL"
                : https.credentials
                  ? "carries credentials"
                  : "loads from outside the allowlist"
            } (${allowlist.scripts.join(", ")}). Load it from one of those, pinned, e.g. ${PINNED_EXAMPLE}.`,
          );
        } else if (!pinned(https.url) && !unpinned.has(https.url.href)) {
          unpinned.add(https.url.href);
          warn(
            "W_UNPINNED",
            src.offset,
            `${shown} names no exact version, so the page can change or break when the library does. Pin one, e.g. ${PINNED_EXAMPLE}.`,
          );
        }
      }
    }

    if (tag === "link") {
      const href = attr("href");
      const rels = (attr("rel")?.value ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!href) continue;
      const https = httpsOrigin(href.value);
      const shown = `<link rel="${quote(rels.join(" "))}" href="${quote(href.value)}">`;
      const stylesheet = rels.includes("stylesheet");
      const hint = rels.length > 0 && rels.every((rel) => rel === "preconnect" || rel === "dns-prefetch");
      if (!stylesheet && !hint) {
        error(
          "E_STYLE_ORIGIN",
          href.offset,
          `${shown} is not allowed; only rel="stylesheet" and rel="preconnect" links load. Remove it.`,
        );
        continue;
      }
      const allowed = stylesheet ? allowlist.styles : [...allowlist.styles, ...allowlist.fonts];
      if (!https || https.credentials || !allowed.includes(https.origin)) {
        error(
          "E_STYLE_ORIGIN",
          href.offset,
          `${shown} loads from outside the style allowlist (${allowlist.styles.join(", ")}). ` +
            "Inline the CSS in a <style> element, or load it from one of those.",
        );
      } else if (stylesheet && https.url.hostname !== "fonts.googleapis.com" && !pinned(https.url) && !unpinned.has(https.url.href)) {
        unpinned.add(https.url.href);
        warn(
          "W_UNPINNED",
          href.offset,
          `${shown} names no exact version, so the page can change when the library does. Pin one.`,
        );
      }
    }
  }

  if (roots.length === 0) {
    error(
      "E_ROOT",
      undefined,
      'No element has id="artifact-root". Wrap the page in <main id="artifact-root">…</main>.',
    );
  } else if (roots.length > 1) {
    const lines = roots.slice(0, 5).map((offset) => at(offset).line);
    error(
      "E_ROOT",
      roots[1],
      `id="artifact-root" appears ${roots.length} times (lines ${lines.join(", ")}${roots.length > 5 ? ", …" : ""}). ` +
        "Keep exactly one.",
    );
  }
  if (!sawDoctype) {
    warn(
      "W_NO_DOCTYPE",
      undefined,
      "The page has no <!doctype html>, so it renders in quirks mode. Start it with <!doctype html>.",
    );
  }
  for (const [name, offset] of missingNames) {
    const have = input.documentNames.length ? input.documentNames.join(", ") : "none";
    warn(
      "W_DATA_NAME",
      offset,
      `the script reads artifact.data.${quote(name)}, but the page gets no document named ${quote(name)} ` +
        `(it has: ${have}). Save it with artifacts.set_documents, or read a name that exists.`,
    );
  }
  const firstLink = externalLinks[0];
  if (firstLink !== undefined) {
    warn(
      "W_EXTERNAL_LINK",
      firstLink,
      `${externalLinks.length === 1 ? "a link leaves" : `${externalLinks.length} links leave`} the page when clicked: ` +
        "they navigate the artifact's own frame, and pages cannot open new windows. Show the URL as text if readers need it elsewhere.",
    );
  }
}

export interface DocumentCheck {
  /** The stored form: script-safe JSON. Absent when the document is refused. */
  text?: string;
  bytes: number;
  error?: ArtifactIssue;
}

/** Check one document's name and value, and serialize it the way it is stored. */
export function checkDocument(
  name: string,
  value: unknown,
  limits: ArtifactLimits,
): DocumentCheck {
  if (!validDocumentName(name)) {
    return {
      bytes: 0,
      error: {
        code: "E_DOCUMENT",
        severity: "error",
        message:
          `Document name ${quote(String(name))} is not allowed. Use letters, digits, and _, starting with a letter ` +
          "or _, at most 64 characters, and avoid reserved object property names, so a page can read it as artifact.data.<name>.",
      },
    };
  }
  const problem = jsonProblem(value, limits.jsonDepth);
  if (problem !== undefined) {
    return {
      bytes: 0,
      error: {
        code: "E_DOCUMENT",
        severity: "error",
        message: `Document '${name}' is not storable JSON: ${problem}.`,
      },
    };
  }
  const text = scriptSafeJson(value);
  const bytes = utf8Bytes(text);
  if (bytes > limits.documentBytes) {
    return {
      bytes,
      error: {
        code: "E_TOO_LARGE",
        severity: "error",
        message:
          `Document '${name}' is ${count(bytes)} bytes serialized; one document may be at most ` +
          `${count(limits.documentBytes)} (${kib(limits.documentBytes)}). Split it across documents or drop fields the page does not show.`,
      },
    };
  }
  return { text, bytes };
}

/** The collective document bounds: how many, and how large together. */
export function checkDocumentTotals(
  live: number,
  totalBytes: number,
  limits: ArtifactLimits,
): ArtifactIssue | undefined {
  if (live > limits.documents) {
    return {
      code: "E_TOO_LARGE",
      severity: "error",
      message:
        `The artifact would have ${live} documents; the limit is ${limits.documents}. ` +
        "Combine related data into fewer documents, or remove one by setting it to null.",
    };
  }
  if (totalBytes > limits.totalDocumentBytes) {
    return {
      code: "E_TOO_LARGE",
      severity: "error",
      message:
        `Its documents would total ${count(totalBytes)} bytes; the limit is ${count(limits.totalDocumentBytes)} ` +
        `(${kib(limits.totalDocumentBytes)}). Drop data the page does not show.`,
    };
  }
  return undefined;
}

/** Sort findings by position, cap errors at 20, and report what was cut. */
export function finish(findings: Findings): ArtifactValidation {
  const order = (a: ArtifactIssue, b: ArtifactIssue) =>
    (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);
  const errors = [...findings.errors].sort(order);
  const warnings = [...findings.warnings].sort(order).slice(0, MAX_REPORTED);
  const validation: ArtifactValidation = {
    ok: errors.length === 0,
    errors: errors.slice(0, MAX_REPORTED),
    warnings,
  };
  if (errors.length > MAX_REPORTED) validation.errorsOmitted = errors.length - MAX_REPORTED;
  return validation;
}

export interface ValidateArtifactInput {
  kind: ArtifactKind;
  source: string;
  /** Sample documents, as the page would receive them. */
  documents?: Record<string, unknown>;
  /** The title a Markdown page renders with. */
  title?: string;
}

export interface ValidateArtifactOptions {
  limits?: Partial<ArtifactLimits>;
  allowlist?: Partial<ArtifactAllowlist>;
}

/**
 * Validate a page and its documents without saving anything: the same static
 * checks every artifact write runs. `ok` is exactly "no errors"; warnings are
 * advice.
 */
export function validateArtifact(
  input: ValidateArtifactInput,
  options: ValidateArtifactOptions = {},
): ArtifactValidation {
  const context: CheckContext = {
    limits: resolveLimits(options.limits),
    allowlist: resolveAllowlist(options.allowlist),
  };
  return validateWithContext(input, context);
}

/** `validateArtifact` against an already-resolved context. */
export function validateWithContext(
  input: ValidateArtifactInput,
  context: CheckContext,
): ArtifactValidation {
  const findings: Findings = { errors: [], warnings: [] };
  if (input.kind !== "html" && input.kind !== "markdown") {
    findings.errors.push({
      code: "E_KIND",
      severity: "error",
      message: 'kind must be "html" or "markdown".',
    });
    return finish(findings);
  }
  const documents = input.documents ?? {};
  let dataBytes = 0;
  let live = 0;
  for (const [name, value] of Object.entries(documents)) {
    const checked = checkDocument(name, value, context.limits);
    if (checked.error) findings.errors.push(checked.error);
    dataBytes += checked.bytes;
    live++;
  }
  const totals = checkDocumentTotals(live, dataBytes, context.limits);
  if (totals) findings.errors.push(totals);
  const view = checkView(
    {
      kind: input.kind,
      source: input.source,
      ...(input.title === undefined ? {} : { title: input.title }),
      documentNames: Object.keys(documents),
      dataBytes,
    },
    context,
  );
  findings.errors.push(...view.errors);
  findings.warnings.push(...view.warnings);
  return finish(findings);
}
