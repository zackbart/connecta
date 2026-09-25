// A CommonMark subset for Markdown artifacts: ATX headings, paragraphs,
// nested lists, fenced code, block quotes, thematic breaks, GFM tables,
// emphasis, strong, strikethrough, code spans, links, autolinks, images, and
// hard breaks. Raw HTML is text: a Markdown page carries no markup of its own,
// so everything it renders is escaped here, and the only URLs that survive are
// ones a sandboxed page can use.
//
// Deliberately not a dependency. The subset is what documents and reports
// use; the viewer's CSP is the security boundary either way, and a full
// CommonMark implementation would outweigh the rest of this module.
//
// Every scan is bounded: brackets and parentheses are matched once per span
// of text, a delimiter that found no closer is never searched for again, and
// nesting stops at a fixed depth. A megabyte of `[[[[` or `**` renders in
// linear time, because this runs on every page view.

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");

const PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const MAX_INLINE_DEPTH = 8;
const MAX_BLOCK_DEPTH = 64;

export class MarkdownNestingError extends Error {
  constructor() {
    super(`Markdown blocks are nested more than ${MAX_BLOCK_DEPTH} levels deep. Flatten the block quotes or lists.`);
  }
}

/** A link target a sandboxed page can follow; anything else renders as text. */
function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return trimmed;
  return /^(?:https:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}

/** Only embedded raster or SVG images load: pages have no network. */
function safeImage(url: string): string | undefined {
  const trimmed = url.trim();
  return /^data:image\/(?:png|gif|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]*$/i.test(trimmed)
    ? trimmed
    : undefined;
}

/** Matching close for every open bracket, computed in one pass. */
function matchPairs(text: string, open: string, close: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === open) stack.push(i);
    else if (c === close) {
      const start = stack.pop();
      if (start !== undefined) pairs.set(start, i);
    }
  }
  return pairs;
}

interface Span {
  text: string;
  brackets: Map<number, number>;
  parens: Map<number, number>;
  /** Per delimiter: the earliest opener known to have no closer after it. */
  unclosed: Map<string, number>;
  depth: number;
}

function inline(text: string, depth = 0): string {
  return renderSpan({
    text,
    brackets: matchPairs(text, "[", "]"),
    parens: matchPairs(text, "(", ")"),
    unclosed: new Map(),
    depth,
  });
}

function renderSpan(span: Span): string {
  const { text } = span;
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] ?? "";
    if (c === "\\" && i + 1 < n) {
      const next = text[i + 1] ?? "";
      if (next === "\n") {
        out += "<br>\n";
        i += 2;
        continue;
      }
      if (PUNCTUATION.test(next)) {
        out += escapeHtml(next);
        i += 2;
        continue;
      }
    }
    if (c === "`") {
      const code = codeSpan(span, i);
      if (code) {
        out += code.html;
        i = code.end;
        continue;
      }
      let run = 0;
      while (text[i + run] === "`") run++;
      out += "`".repeat(run);
      i += run;
      continue;
    }
    if (c === "<") {
      const auto = /^<((?:https|mailto):[^\s<>]*)>/i.exec(text.slice(i, i + 2048));
      if (auto?.[1]) {
        const href = safeHref(auto[1]);
        out += href
          ? `<a href="${escapeHtml(href)}">${escapeHtml(auto[1])}</a>`
          : escapeHtml(auto[0]);
        i += auto[0].length;
        continue;
      }
    }
    if (c === "!" && text[i + 1] === "[") {
      const link = parseLink(span, i + 1);
      if (link) {
        const src = safeImage(link.url);
        out += src
          ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(link.label)}"${link.title ? ` title="${escapeHtml(link.title)}"` : ""}>`
          : escapeHtml(link.label);
        i = link.end;
        continue;
      }
    }
    if (c === "[") {
      const link = parseLink(span, i);
      if (link) {
        const href = safeHref(link.url);
        const label =
          span.depth < MAX_INLINE_DEPTH ? inline(link.label, span.depth + 1) : escapeHtml(link.label);
        out += href
          ? `<a href="${escapeHtml(href)}"${link.title ? ` title="${escapeHtml(link.title)}"` : ""}>${label}</a>`
          : label;
        i = link.end;
        continue;
      }
    }
    if ((c === "*" || c === "_" || c === "~") && span.depth < MAX_INLINE_DEPTH) {
      const emphasis = parseEmphasis(span, i);
      if (emphasis) {
        out += emphasis.html;
        i = emphasis.end;
        continue;
      }
    }
    if (c === "\n") {
      // Two trailing spaces make a hard break.
      if (out.endsWith("  ")) out = `${out.replace(/ +$/, "")}<br>`;
      out += "\n";
      i++;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

function codeSpan(span: Span, start: number): { html: string; end: number } | undefined {
  const { text } = span;
  let run = 0;
  while (text[start + run] === "`") run++;
  const key = `\`${run}`;
  const known = span.unclosed.get(key);
  if (known !== undefined && known <= start) return undefined;
  // The first run of exactly `run` backticks after this one closes it.
  let at = start + run;
  for (;;) {
    const found = text.indexOf("`", at);
    if (found < 0) {
      span.unclosed.set(key, start);
      return undefined;
    }
    let length = 0;
    while (text[found + length] === "`") length++;
    if (length === run) {
      let code = text.slice(start + run, found).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) {
        code = code.slice(1, -1);
      }
      return { html: `<code>${escapeHtml(code)}</code>`, end: found + run };
    }
    at = found + length;
  }
}

/** `[label](url "title")` whose `[` is at `start`. */
function parseLink(
  span: Span,
  start: number,
): { label: string; url: string; title?: string; end: number } | undefined {
  const { text } = span;
  const close = span.brackets.get(start);
  if (close === undefined || text[close + 1] !== "(") return undefined;
  const end = span.parens.get(close + 1);
  if (end === undefined) return undefined;
  const inner = text.slice(close + 2, end).trim();
  const titled = /^(\S+)\s+(?:"([^"]*)"|'([^']*)')$/.exec(inner);
  const rawUrl = titled?.[1] ?? inner;
  const url = rawUrl.startsWith("<") && rawUrl.endsWith(">") ? rawUrl.slice(1, -1) : rawUrl;
  if (/\s/.test(url)) return undefined;
  const label = text.slice(start + 1, close);
  const title = titled?.[2] ?? titled?.[3];
  return title === undefined
    ? { label, url, end: end + 1 }
    : { label, url, title, end: end + 1 };
}

/** `**strong**`, `__strong__`, `*em*`, `_em_`, `~~del~~` opening at `start`. */
function parseEmphasis(span: Span, start: number): { html: string; end: number } | undefined {
  const { text } = span;
  const c = text[start] ?? "";
  let run = 0;
  while (text[start + run] === c) run++;
  if (c === "~" && run !== 2) return undefined;
  const width = c === "~" ? 2 : Math.min(run, 2);
  const delimiter = c.repeat(width);
  const after = text[start + width];
  if (after === undefined || /\s/.test(after)) return undefined;
  // `_` never opens inside a word.
  if (c === "_" && start > 0 && /[A-Za-z0-9]/.test(text[start - 1] ?? "")) return undefined;
  // Whether a position closes depends only on that position, so an opener
  // that found no closer proves every later opener finds none either.
  const known = span.unclosed.get(delimiter);
  if (known !== undefined && known <= start) return undefined;
  let search = start + width + 1;
  for (;;) {
    const close = text.indexOf(delimiter, search);
    if (close < 0) {
      span.unclosed.set(delimiter, start);
      return undefined;
    }
    const before = text[close - 1] ?? "";
    const next = text[close + width] ?? "";
    const closes =
      !/\s/.test(before) &&
      !(c === "_" && /[A-Za-z0-9]/.test(next)) &&
      // A single delimiter must not be half of a double.
      (width === 2 || next !== c);
    if (closes) {
      const inner = inline(text.slice(start + width, close), span.depth + 1);
      const tag = c === "~" ? "del" : width === 2 ? "strong" : "em";
      return { html: `<${tag}>${inner}</${tag}>`, end: close + width };
    }
    search = close + 1;
  }
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (row[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += row[i];
  }
  cells.push(cell.trim());
  return cells;
}

const startsBlock = (line: string) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/.test(line);

const leadingSpaces = (line: string) => /^ */.exec(line)?.[0].length ?? 0;
const dedent = (line: string, width: number) =>
  line.slice(Math.min(width, leadingSpaces(line)));

/** Render block-level Markdown. `tight` renders paragraphs bare, as in a tight list. */
function blocks(lines: string[], tight = false, depth = 0): string {
  if (depth > MAX_BLOCK_DEPTH) throw new MarkdownNestingError();
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]?.length ?? 0;
      const marker = fence[2] ?? "```";
      const lang = fence[3] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i] ?? "";
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(candidate)?.[1];
        i++;
        if (closing && closing[0] === marker[0] && closing.length >= marker.length) break;
        body.push(dedent(candidate, indent));
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}${body.length ? "\n" : ""}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inline((heading[2] ?? "").trim())}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(QUOTE, ""));
        i++;
      }
      out.push(`<blockquote>\n${blocks(inner, false, depth + 1)}\n</blockquote>`);
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && next.includes("-") && TABLE_DELIMITER.test(next)) {
      const header = splitRow(line);
      const aligns = splitRow(next).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":")
          ? "center"
          : cell.endsWith(":")
            ? "right"
            : cell.startsWith(":")
              ? "left"
              : "");
      const cell = (tag: string, text: string, index: number) => {
        const align = aligns[index];
        return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inline(text)}</${tag}>`;
      };
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim() && (lines[i] ?? "").includes("|")) {
        const cells = splitRow(lines[i] ?? "");
        rows.push(`<tr>${header.map((_, index) => cell("td", cells[index] ?? "", index)).join("")}</tr>`);
        i++;
      }
      out.push(
        `<table>\n<thead><tr>${header.map((text, index) => cell("th", text, index)).join("")}</tr></thead>` +
          (rows.length ? `\n<tbody>\n${rows.join("\n")}\n</tbody>` : "") +
          "\n</table>",
      );
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2] ?? "");
      const bullet = (item[2] ?? "").slice(-1);
      const items: string[][] = [];
      let loose = false;
      let sawBlank = false;
      while (i < lines.length) {
        const match = ITEM.exec(lines[i] ?? "");
        if (
          !match ||
          /\d/.test(match[2] ?? "") !== ordered ||
          (match[2] ?? "").slice(-1) !== bullet
        ) break;
        if (sawBlank) loose = true;
        const contentIndent = (match[1]?.length ?? 0) + (match[2]?.length ?? 0) + 1;
        const body = [match[3] ?? ""];
        i++;
        sawBlank = false;
        while (i < lines.length) {
          const continuation = lines[i] ?? "";
          if (!continuation.trim()) {
            sawBlank = true;
            body.push("");
            i++;
            continue;
          }
          const nested = leadingSpaces(continuation) >= Math.min(contentIndent, 4);
          const lazy = !sawBlank && !startsBlock(continuation) && !ITEM.test(continuation);
          if (!nested && !lazy) break;
          if (sawBlank) loose = true;
          body.push(dedent(continuation, contentIndent));
          sawBlank = false;
          i++;
        }
        while (body.length && !(body.at(-1) ?? "").trim()) body.pop();
        items.push(body);
      }
      const start = ordered ? Number.parseInt(item[2] ?? "1", 10) : 1;
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>\n` +
          items.map((body) => `<li>${blocks(body, !loose, depth + 1)}</li>`).join("\n") +
          `\n</${tag}>`,
      );
      continue;
    }
    const paragraph: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const candidate = lines[i] ?? "";
      if (!candidate.trim() || startsBlock(candidate)) break;
      paragraph.push(candidate.replace(/^ +/, ""));
      i++;
    }
    const html = inline(paragraph.join("\n"));
    out.push(tight ? html : `<p>${html}</p>`);
  }
  return out.join("\n");
}

/** Render Markdown source to an HTML fragment. */
export function renderMarkdown(source: string): string {
  const lines = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length)));
  return blocks(lines);
}

const MARKDOWN_STYLE =
  ":root{color-scheme:light dark}body{margin:0;font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;" +
  "color:#1f2328;background:#fff}main{max-width:820px;margin:0 auto;padding:40px 24px}" +
  "h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:2em}h2{font-size:1.5em}" +
  "a{color:#0969da}code{font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f4f6;padding:.1em .3em;border-radius:4px}" +
  "pre{overflow:auto;padding:16px;background:#f3f4f6;border-radius:8px}pre code{background:none;padding:0}" +
  "blockquote{margin:0;padding:0 1em;color:#59636e;border-left:4px solid #d1d9e0}" +
  "table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:6px 12px;border:1px solid #d1d9e0}" +
  "img{max-width:100%}hr{border:0;border-top:1px solid #d1d9e0}" +
  "@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#4493f8}" +
  "code,pre{background:#161b22}blockquote{color:#9198a1;border-color:#3d444d}th,td,hr{border-color:#3d444d}}";

/** A complete page for a Markdown artifact: the rendered body in `<main id="artifact-root">`. */
export function markdownPage(source: string, title: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${MARKDOWN_STYLE}</style></head>` +
    `<body><main id="artifact-root">\n${renderMarkdown(source)}\n</main></body></html>`
  );
}
