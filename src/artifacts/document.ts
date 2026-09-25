// The one document a page becomes: its source (or rendered Markdown) with the
// read-only `window.artifact` global injected, and the CSP it runs under.
//
// Built server-side, so a render check and the viewer see byte-for-byte the
// same page. The global goes in right after the doctype token — found by the
// tokenizer, never by a regex — so injecting it can never knock a page into
// quirks mode, and it runs before any script the author wrote.

import { scanHtml } from "./html-scan.js";
import { scriptSafeJson } from "./json.js";
import { markdownPage, MarkdownNestingError } from "./markdown.js";
import type { ArtifactAllowlist, ArtifactKind } from "./types.js";

/** What a page reads as `window.artifact`, besides `data`. */
export interface ArtifactGlobal {
  id: string;
  title: string;
  view: { version: number };
  documents: Record<string, { version: number; updatedAt: string }>;
  /** True when the page is a snapshot pinned to exact versions. */
  snapshot: boolean;
}

/**
 * The frame's Content-Security-Policy. `sandbox allow-scripts` without
 * `allow-same-origin` gives the page an opaque origin — no cookies, no
 * storage, nothing of the deployment's — and `connect-src 'none'` with every
 * other fetch directive shut leaves it no network beyond the allowlisted
 * script, style, and font origins. No `'unsafe-eval'`.
 */
export function frameCsp(allowlist: ArtifactAllowlist): string {
  const sources = (list: readonly string[]) => (list.length ? ` ${list.join(" ")}` : "");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline'${sources(allowlist.scripts)}`,
    `style-src 'unsafe-inline'${sources(allowlist.styles)}`,
    `font-src data:${sources(allowlist.fonts)}`,
    "img-src data: blob:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

// Deep-frozen and non-configurable: the page reads its data and cannot
// replace it for a script that runs later.
const DEFINE_GLOBAL =
  '(()=>{const f=(o)=>{if(o!==null&&typeof o==="object"){for(const k of Object.keys(o))f(o[k]);Object.freeze(o)}return o};' +
  'Object.defineProperty(window,"artifact",{value:f(%VALUE%),writable:false,configurable:false,enumerable:false})})()';

/**
 * The complete document a viewer or render check loads. `data` maps document
 * names to their stored, script-safe JSON text, which is spliced in as-is.
 */
export function buildFrameDocument(input: {
  kind: ArtifactKind;
  source: string;
  global: ArtifactGlobal;
  data: Readonly<Record<string, string>>;
}): string {
  let page = input.source;
  if (input.kind === "markdown") {
    try {
      page = markdownPage(input.source, input.global.title);
    } catch (error) {
      if (!(error instanceof MarkdownNestingError)) throw error;
      // Old or externally populated stores may hold a page that today's
      // validator would reject. Render fixed text instead of throwing here.
      page = markdownPage("This page has too many nested block quotes or lists to display.", input.global.title);
    }
  }
  const meta = scriptSafeJson(input.global);
  const data = Object.entries(input.data)
    .map(([name, text]) => `${JSON.stringify(name)}:${text}`)
    .join(",");
  const value = `${meta.slice(0, -1)},"data":{${data}}}`;
  const script = `<script>${DEFINE_GLOBAL.replace("%VALUE%", () => value)}</script>`;
  let at = 0;
  for (const token of scanHtml(page)) {
    if (token.type === "doctype") {
      at = token.end;
      break;
    }
    if (token.type === "start") break;
  }
  return `${page.slice(0, at)}${script}${page.slice(at)}`;
}
