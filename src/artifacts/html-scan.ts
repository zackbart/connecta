// A small HTML tokenizer: exactly the HTML5 tokenizer states validation and
// the viewer need, and none of tree construction.
//
// It is a lint's tokenizer, not a sanitizer's. The viewer's CSP and sandbox are
// the security boundary; this finds the tags, attributes, and raw text a page
// author most plausibly got wrong, with a line and column for each, so an
// agent can fix a page from the message alone. Where it approximates the
// standard — foreign content, the rarer script escapes — the failure mode is a
// finding that is missing or extra, never a page that escapes its frame.

export interface HtmlAttribute {
  /** Lowercased. */
  name: string;
  /** Entity-decoded. Empty for a bare attribute. */
  value: string;
  /** Offset of the attribute name in the source. */
  offset: number;
}

export type HtmlToken =
  | { type: "doctype"; start: number; end: number }
  | { type: "comment"; start: number; end: number }
  | {
      type: "start";
      /** Lowercased. */
      name: string;
      attrs: HtmlAttribute[];
      selfClosing: boolean;
      start: number;
      end: number;
    }
  | { type: "end"; name: string; start: number; end: number }
  | {
      type: "text";
      start: number;
      end: number;
      /** The element whose raw text this is (`script`, `style`, …), if any. */
      rawOf?: string;
    };

const RAW_TEXT = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "title",
  "textarea",
]);

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isAlpha = (c: string | undefined) =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  Tab: "\t",
  NewLine: "\n",
  colon: ":",
  sol: "/",
  lpar: "(",
  rpar: ")",
  period: ".",
  comma: ",",
};

/**
 * Decode the character references a URL check has to see through: numeric
 * ones, and the named ones that spell a scheme (`&colon;`, `&Tab;`, …).
 */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z]+));?/g,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED[name] ?? match;
      const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return "�";
      if (code >= 0xd800 && code <= 0xdfff) return "�";
      return String.fromCodePoint(code);
    },
  );
}

/** Tokenize `source`. Never throws; malformed markup tokenizes the way a browser would, approximately. */
export function scanHtml(source: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  // ASCII-only lowercasing keeps every offset valid; `toLowerCase` can change
  // a string's length.
  const lower = source.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  const n = source.length;
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) tokens.push({ type: "text", start: textStart, end });
  };
  const until = (from: number, needle: string): number => {
    const at = source.indexOf(needle, from);
    return at < 0 ? n : at + needle.length;
  };

  while (i < n) {
    if (source[i] !== "<") {
      i++;
      continue;
    }
    const next = source[i + 1];
    if (next === "!") {
      flush(i);
      const start = i;
      if (source.startsWith("<!--", i)) {
        if (source.startsWith("<!-->", i)) i += 5;
        else if (source.startsWith("<!--->", i)) i += 6;
        else i = until(i + 4, "-->");
        tokens.push({ type: "comment", start, end: i });
      } else if (source.slice(i + 2, i + 9).toLowerCase() === "doctype") {
        i = until(i, ">");
        tokens.push({ type: "doctype", start, end: i });
      } else if (source.startsWith("<![CDATA[", i)) {
        i = until(i + 9, "]]>");
        tokens.push({ type: "comment", start, end: i });
      } else {
        i = until(i, ">");
        tokens.push({ type: "comment", start, end: i });
      }
      textStart = i;
      continue;
    }
    if (next === "?") {
      flush(i);
      const start = i;
      i = until(i, ">");
      tokens.push({ type: "comment", start, end: i });
      textStart = i;
      continue;
    }
    if (next === "/") {
      const after = source[i + 2];
      if (after === ">") {
        // `</>` is dropped entirely.
        flush(i);
        i += 3;
        textStart = i;
        continue;
      }
      if (!isAlpha(after)) {
        flush(i);
        const start = i;
        i = until(i, ">");
        tokens.push({ type: "comment", start, end: i });
        textStart = i;
        continue;
      }
      const tag = readTag(source, i + 2);
      if (!tag) {
        // End of input inside a tag: the tag is never emitted.
        flush(i);
        i = n;
        textStart = n;
        break;
      }
      flush(i);
      tokens.push({ type: "end", name: tag.name, start: i, end: tag.end });
      i = tag.end;
      textStart = i;
      continue;
    }
    if (!isAlpha(next)) {
      i++;
      continue;
    }
    const tag = readTag(source, i + 1);
    if (!tag) {
      flush(i);
      i = n;
      textStart = n;
      break;
    }
    flush(i);
    tokens.push({
      type: "start",
      name: tag.name,
      attrs: tag.attrs,
      selfClosing: tag.selfClosing,
      start: i,
      end: tag.end,
    });
    i = tag.end;
    textStart = i;
    if (tag.name === "plaintext") {
      if (n > i) tokens.push({ type: "text", start: i, end: n, rawOf: "plaintext" });
      i = n;
      textStart = n;
      break;
    }
    if (RAW_TEXT.has(tag.name)) {
      const close =
        tag.name === "script"
          ? scriptEnd(source, lower, i)
          : rawTextEnd(source, lower, i, tag.name);
      if (close > i) {
        tokens.push({ type: "text", start: i, end: close, rawOf: tag.name });
      }
      i = close;
      textStart = i;
    }
  }
  flush(n);
  return tokens;
}

/** Where `</name` followed by whitespace, `/`, or `>` starts, from `from`; the end of input when absent. */
function rawTextEnd(
  source: string,
  lower: string,
  from: number,
  name: string,
): number {
  let at = from;
  for (;;) {
    at = lower.indexOf(`</${name}`, at);
    if (at < 0) return source.length;
    const c = source[at + 2 + name.length];
    if (c === undefined || c === "/" || c === ">" || isSpace(c)) return at;
    at += 2;
  }
}

/**
 * Script data, with its escaped and double-escaped states: inside `<!--`, a
 * `<script` means the next `</script>` does not end the element.
 */
function scriptEnd(source: string, lower: string, from: number): number {
  const tagAt = (at: number, prefix: string) => {
    if (!lower.startsWith(prefix, at)) return false;
    const c = source[at + prefix.length];
    return c === undefined || c === "/" || c === ">" || isSpace(c);
  };
  let state: "data" | "escaped" | "double" = "data";
  for (let i = from; i < source.length; i++) {
    if (state === "data") {
      if (tagAt(i, "</script")) return i;
      if (lower.startsWith("<!--", i)) {
        state = "escaped";
        i += 3;
      }
    } else if (state === "escaped") {
      if (tagAt(i, "</script")) return i;
      if (lower.startsWith("-->", i)) {
        state = "data";
        i += 2;
      } else if (tagAt(i, "<script")) {
        state = "double";
        i += 6;
      }
    } else {
      if (tagAt(i, "</script")) {
        state = "escaped";
        i += 7;
      } else if (lower.startsWith("-->", i)) {
        state = "data";
        i += 2;
      }
    }
  }
  return source.length;
}

interface RawTag {
  name: string;
  attrs: HtmlAttribute[];
  selfClosing: boolean;
  end: number;
}

/** Read a tag name and its attributes, from just after `<` or `</`. Null at end of input. */
function readTag(source: string, from: number): RawTag | null {
  const n = source.length;
  let i = from;
  while (i < n && !isSpace(source[i]) && source[i] !== "/" && source[i] !== ">") i++;
  const name = source.slice(from, i).toLowerCase();
  const attrs: HtmlAttribute[] = [];
  const seen = new Set<string>();
  let selfClosing = false;
  for (;;) {
    while (i < n && (isSpace(source[i]) || (source[i] === "/" && source[i + 1] !== ">"))) i++;
    if (i >= n) return null;
    if (source[i] === ">") return { name, attrs, selfClosing, end: i + 1 };
    if (source[i] === "/") {
      // "/>"
      selfClosing = true;
      return { name, attrs, selfClosing, end: i + 2 };
    }
    const nameStart = i;
    // A leading "=" belongs to the name.
    i++;
    while (
      i < n &&
      !isSpace(source[i]) &&
      source[i] !== "/" &&
      source[i] !== ">" &&
      source[i] !== "="
    ) i++;
    const attrName = source.slice(nameStart, i).toLowerCase();
    let value = "";
    let j = i;
    while (j < n && isSpace(source[j])) j++;
    if (source[j] === "=") {
      i = j + 1;
      while (i < n && isSpace(source[i])) i++;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, i + 1);
        if (close < 0) return null;
        value = source.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(source[i]) && source[i] !== ">") i++;
        value = source.slice(valueStart, i);
      }
    }
    // A repeated attribute is dropped; the first one wins.
    if (!seen.has(attrName)) {
      seen.add(attrName);
      attrs.push({ name: attrName, value: decodeEntities(value), offset: nameStart });
    }
  }
}

/** Map a source offset to a 1-based line and column. */
export function lineLocator(source: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
  };
}
