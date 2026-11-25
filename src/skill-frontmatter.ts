/**
 * The YAML subset an Agent Skills `SKILL.md` frontmatter block may use: block
 * mappings with identifier keys, block and flow sequences of scalars, plain,
 * quoted, literal and folded scalars, and comments. Plain scalars resolve as
 * the YAML 1.2 core schema does. Anything outside the subset is refused rather
 * than guessed, so a value served in a manifest always equals what a YAML
 * parser reads from the same bytes. Every path is linear in the block's size,
 * which is capped at {@link MAX_FRONTMATTER_BYTES} of UTF-8.
 */

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

const MAX_FRONTMATTER_BYTES = 32 * 1024;
const MAX_DEPTH = 8;

class Unsupported extends Error {}

const fail = (): never => {
  throw new Unsupported();
};

interface Line {
  indent: number;
  text: string;
}

/** Splits a document into its frontmatter source and the body after the closing delimiter, or undefined without one. */
export function splitFrontmatter(document: string): { yaml: string; body: string } | undefined {
  const open = /^---[ \t]*\r?\n/.exec(document);
  if (!open) return undefined;
  const rest = document.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return undefined;
  const yaml = rest.slice(0, close.index).replace(/\r?\n$/, "");
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "");
  return { yaml, body };
}

/** Anything but printable text, space, and line breaks: tabs, controls, Unicode spaces, BOMs and unpaired surrogates. */
function hasRefusedCharacter(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 0x0a) continue;
    if (code === 0x0d) {
      if (source.charCodeAt(index + 1) !== 0x0a) return true;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0xa0) || code === 0xad) return true;
    if (code === 0x1680 || (code >= 0x2000 && code <= 0x200f) || (code >= 0x2028 && code <= 0x202f)) return true;
    if (code === 0x205f || code === 0x3000 || code === 0xfeff || code === 0xfffe || code === 0xffff) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** The frontmatter as a plain object, or undefined when it is not a mapping in the supported subset. */
export function parseFrontmatter(source: string): Record<string, unknown> | undefined {
  if (
    source.length > MAX_FRONTMATTER_BYTES ||
    hasRefusedCharacter(source) ||
    new TextEncoder().encode(source).byteLength > MAX_FRONTMATTER_BYTES
  )
    return undefined;
  try {
    const lines = source.split(/\r?\n/).map((raw): Line => {
      let indent = 0;
      while (raw.charCodeAt(indent) === 0x20) indent++;
      return { indent, text: raw };
    });
    const parser = new Parser(lines);
    const value = parser.mapping(0, 0);
    if (parser.next() !== undefined) fail();
    return value;
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
}

function blank(line: Line): boolean {
  const rest = line.text.slice(line.indent);
  return rest === "" || rest.startsWith("#");
}

const isItem = (content: string) => content === "-" || content.startsWith("- ");

class Parser {
  private index = 0;
  constructor(private readonly lines: Line[]) {}

  next(): Line | undefined {
    while (this.index < this.lines.length && blank(this.lines[this.index]!)) this.index++;
    return this.lines[this.index];
  }

  mapping(indent: number, depth: number): { [key: string]: YamlValue } {
    if (depth > MAX_DEPTH) fail();
    const result: { [key: string]: YamlValue } = {};
    for (let line = this.next(); line && line.indent === indent; line = this.next()) {
      const content = line.text.slice(indent);
      if (isItem(content)) break;
      const [key, rest] = splitKey(content);
      if (Object.hasOwn(result, key)) fail();
      this.index++;
      result[key] = this.value(rest, indent, depth);
    }
    const line = this.next();
    if (line && line.indent > indent) fail();
    return result;
  }

  private value(rest: string, indent: number, depth: number): YamlValue {
    const trimmed = stripComment(rest);
    if (trimmed === "") {
      const line = this.next();
      if (!line) return null;
      const content = line.text.slice(line.indent);
      if (isItem(content) && line.indent >= indent) return this.sequence(line.indent);
      if (line.indent > indent) return this.mapping(line.indent, depth + 1);
      return null;
    }
    if (trimmed[0] === "|" || trimmed[0] === ">") return this.block(trimmed, indent);
    const scalar = inlineValue(trimmed);
    const line = this.next();
    if (line && line.indent > indent) fail();
    return scalar;
  }

  private sequence(indent: number): YamlValue[] {
    const result: YamlValue[] = [];
    for (let line = this.next(); line && line.indent === indent; line = this.next()) {
      const content = line.text.slice(indent);
      if (!isItem(content)) break;
      this.index++;
      const item = stripComment(content.slice(1));
      if (item === "" || item[0] === "|" || item[0] === ">" || item[0] === "-") fail();
      if (item[0] !== '"' && item[0] !== "'" && item[0] !== "[" && (item.includes(": ") || item.endsWith(":"))) fail();
      result.push(inlineValue(item));
      const after = this.next();
      if (after && after.indent > indent) fail();
    }
    return result;
  }

  private block(header: string, indent: number): string {
    if (header !== "|" && header !== "|-" && header !== ">" && header !== ">-") fail();
    const raw: string[] = [];
    let contentIndent: number | undefined;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (line.indent === line.text.length) {
        if (line.text.length > 0) fail();
        raw.push("");
        this.index++;
        continue;
      }
      if (line.indent <= indent) break;
      contentIndent ??= line.indent;
      if (line.indent !== contentIndent) fail();
      const text = line.text.slice(contentIndent);
      if (text.endsWith(" ")) fail();
      raw.push(text);
      this.index++;
    }
    while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
    if (raw.length === 0 || raw[0] === "") fail();
    let text = "";
    if (header[0] === "|") text = raw.join("\n");
    else {
      let breaks = 0;
      for (const part of raw) {
        if (part === "") {
          breaks++;
          continue;
        }
        if (text !== "") text += breaks === 0 ? " " : "\n".repeat(breaks);
        text += part;
        breaks = 0;
      }
    }
    return header.endsWith("-") ? text : `${text}\n`;
  }
}

const RESERVED_KEYS = /^(?:null|Null|NULL|true|True|TRUE|false|False|FALSE|__proto__)$/;

/** An identifier key, `-` allowed after the first character, then `:` and a space or the end. */
function splitKey(content: string): [string, string] {
  let end = 0;
  const first = content.charCodeAt(0);
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a) || first === 0x5f)) fail();
  while (end < content.length && /[A-Za-z0-9_-]/.test(content[end]!)) end++;
  const key = content.slice(0, end);
  if (RESERVED_KEYS.test(key) || content[end] !== ":") fail();
  const after = content.slice(end + 1);
  if (after !== "" && after[0] !== " ") fail();
  return [key, after];
}

/**
 * The value text before a ` #` comment, with surrounding spaces removed. A quote opens a quoted scalar only where a
 * scalar starts: at the head of the value, or after `[` or `,` in a flow sequence. Inside a plain scalar it is text.
 */
function stripComment(text: string): string {
  let flow = false;
  let scalarStart = true;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") i++;
      else if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = undefined;
      }
    } else if (char === "#" && (i === 0 || text[i - 1] === " ")) return trimSpaces(text.slice(0, i));
    else if (char === " ") continue;
    else if (scalarStart && (char === '"' || char === "'")) {
      quote = char;
      scalarStart = false;
    } else {
      if (scalarStart && char === "[") flow = true;
      scalarStart = flow && (char === "[" || char === ",");
    }
  }
  return trimSpaces(text);
}

function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === " ") start++;
  while (end > start && text[end - 1] === " ") end--;
  return text.slice(start, end);
}

const ESCAPES: Record<string, string> = {
  "0": "\0",
  b: "\b",
  t: "\t",
  n: "\n",
  r: "\r",
  '"': '"',
  "/": "/",
  "\\": "\\",
};

/** A one-line quoted scalar starting at `start`, and the index after its closing quote. */
function quoted(text: string, start: number): [string, number] {
  const quote = text[start];
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]!;
    if (quote === "'") {
      if (char !== "'") value += char;
      else if (text[i + 1] === "'") {
        value += "'";
        i++;
      } else return [value, i + 1];
    } else if (char === '"') return [value, i + 1];
    else if (char !== "\\") value += char;
    else {
      const escape = text[++i];
      if (escape === "u") {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
        const code = parseInt(hex, 16);
        if (code >= 0xd800 && code <= 0xdfff) fail();
        value += String.fromCharCode(code);
        i += 4;
      } else if (escape !== undefined && Object.hasOwn(ESCAPES, escape)) value += ESCAPES[escape];
      else fail();
    }
  }
  return fail();
}

function inlineValue(text: string): YamlValue {
  if (text[0] === '"' || text[0] === "'") {
    const [value, end] = quoted(text, 0);
    if (end !== text.length) fail();
    return value;
  }
  if (text[0] === "[") return flowSequence(text);
  return plain(text);
}

function flowSequence(text: string): YamlValue[] {
  if (!text.endsWith("]")) fail();
  const inner = trimSpaces(text.slice(1, -1));
  if (inner === "") return [];
  const items: YamlValue[] = [];
  let i = 0;
  for (;;) {
    while (inner[i] === " ") i++;
    if (inner[i] === '"' || inner[i] === "'") {
      const [value, end] = quoted(inner, i);
      items.push(value);
      i = end;
      while (inner[i] === " ") i++;
    } else {
      const comma = inner.indexOf(",", i);
      const end = comma === -1 ? inner.length : comma;
      const raw = trimSpaces(inner.slice(i, end));
      if (raw === "" || /[[\]{}:#'"]/.test(raw)) fail();
      items.push(plain(raw));
      i = end;
    }
    if (i >= inner.length) return items;
    if (inner[i] !== ",") fail();
    i++;
    while (inner[i] === " ") i++;
    if (i >= inner.length) fail();
  }
}

function plain(text: string): YamlValue {
  if (/^[[\]{}&*!|>%@`#,'"]/.test(text) || /^[-?:](?: |$)/.test(text) || text.includes(": ") || text.endsWith(":"))
    fail();
  if (text.startsWith("---") || text.startsWith("...")) fail();
  if (/^(?:null|Null|NULL|~)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?(?:[0-9]+|(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?)$/.test(text)) {
    const value = Number(text);
    if (!Number.isFinite(value) || Object.is(value, -0) || (/^[-+]?[0-9]+$/.test(text) && !Number.isSafeInteger(value)))
      fail();
    return value;
  }
  if (/^[-+]?(?:0o|0x)|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/.test(text)) fail();
  return text;
}
