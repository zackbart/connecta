/**
 * The YAML subset an Agent Skills `SKILL.md` frontmatter block may use: block
 * mappings, block and flow sequences of scalars, plain, quoted, literal and
 * folded scalars, and comments. Plain scalars resolve as the YAML 1.2 core
 * schema does. Anything outside the subset is refused rather than guessed, so
 * a value served in a manifest always equals what a YAML parser reads from the
 * same bytes. JSON is accepted as the YAML it is.
 */

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

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

/** The frontmatter as a plain object, or undefined when it is not a mapping in the supported subset. */
export function parseFrontmatter(source: string): Record<string, unknown> | undefined {
  try {
    if (source.trimStart().startsWith("{")) {
      const json: unknown = JSON.parse(source);
      return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
    }
    const lines = source.split(/\r?\n/).map((raw): Line => {
      const indent = raw.length - raw.replace(/^ +/, "").length;
      if (raw[indent] === "\t") fail();
      return { indent, text: raw };
    });
    const parser = new Parser(lines);
    const value = parser.mapping(0);
    if (parser.next() !== undefined) fail();
    return value;
  } catch {
    return undefined;
  }
}

const blank = (line: Line) => /^\s*(?:#.*)?$/.test(line.text);

class Parser {
  private index = 0;
  constructor(private readonly lines: Line[]) {}

  next(): Line | undefined {
    while (this.index < this.lines.length && blank(this.lines[this.index]!)) this.index++;
    return this.lines[this.index];
  }

  mapping(indent: number): { [key: string]: YamlValue } {
    const result: { [key: string]: YamlValue } = {};
    for (let line = this.next(); line && line.indent === indent; line = this.next()) {
      const content = line.text.slice(indent);
      if (content.startsWith("- ") || content === "-") break;
      const [key, rest] = splitKey(content);
      if (Object.hasOwn(result, key) || key === "<<" || key === "__proto__") fail();
      this.index++;
      result[key] = this.value(rest, indent);
    }
    const line = this.next();
    if (line && line.indent > indent) fail();
    return result;
  }

  private value(rest: string, indent: number): YamlValue {
    const trimmed = stripComment(rest);
    if (trimmed === "") {
      const line = this.next();
      if (!line) return null;
      const content = line.text.slice(line.indent);
      const isItem = content.startsWith("- ") || content === "-";
      if (isItem && line.indent >= indent) return this.sequence(line.indent);
      if (line.indent > indent) return this.mapping(line.indent);
      return null;
    }
    if (/^[|>]/.test(trimmed)) return this.block(trimmed, indent);
    const scalar = inlineValue(trimmed);
    const line = this.next();
    if (line && line.indent > indent) fail();
    return scalar;
  }

  private sequence(indent: number): YamlValue[] {
    const result: YamlValue[] = [];
    for (let line = this.next(); line && line.indent === indent; line = this.next()) {
      const content = line.text.slice(indent);
      if (!(content.startsWith("- ") || content === "-")) break;
      this.index++;
      const item = stripComment(content.slice(1));
      if (item === "" || /^[|>]/.test(item) || /^[^'"[{]*:(?:\s|$)/.test(item)) fail();
      result.push(inlineValue(item));
      const after = this.next();
      if (after && after.indent > indent) fail();
    }
    return result;
  }

  private block(header: string, indent: number): string {
    const match = /^([|>])([+-]?)$/.exec(header);
    if (!match) fail();
    const [, style, chomp] = match!;
    const raw: string[] = [];
    let contentIndent: number | undefined;
    let widestBlank = 0;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (line.text.trim() === "") {
        if (!/^ *$/.test(line.text)) fail();
        widestBlank = Math.max(widestBlank, line.text.length);
        raw.push("");
        this.index++;
        continue;
      }
      if (line.indent <= indent) break;
      contentIndent ??= line.indent;
      if (line.indent < contentIndent) fail();
      raw.push(line.text.slice(contentIndent));
      this.index++;
    }
    if (widestBlank > (contentIndent ?? indent)) fail();
    let trailing = 0;
    while (raw.length > 0 && raw[raw.length - 1] === "") {
      raw.pop();
      trailing++;
    }
    if (raw.length === 0) return chomp === "+" ? "\n".repeat(trailing) : "";
    let text: string;
    if (style === "|") text = raw.join("\n");
    else {
      if (raw.some((text) => text.startsWith(" "))) fail();
      text = "";
      let breaks = 0;
      let started = false;
      for (const part of raw) {
        if (part === "") {
          breaks++;
          continue;
        }
        if (started) text += breaks === 0 ? " " : "\n".repeat(breaks);
        else text += "\n".repeat(breaks);
        text += part;
        breaks = 0;
        started = true;
      }
    }
    return chomp === "-" ? text : chomp === "+" ? `${text}\n${"\n".repeat(trailing)}` : `${text}\n`;
  }
}

function splitKey(content: string): [string, string] {
  if (content[0] === '"' || content[0] === "'") {
    const [key, end] = quoted(content, 0);
    if (content[end] !== ":" || (end + 1 < content.length && content[end + 1] !== " ")) fail();
    return [key, content.slice(end + 1)];
  }
  const match = /^([^\s#'"{}[\],&*!|>%@`?:-][^:#]*?|-[^\s:#][^:#]*?)[ ]*:(?: (.*))?$/.exec(content);
  if (!match) fail();
  return [match![1]!, match![2] ?? ""];
}

function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inDouble) {
      if (char === "\\") i++;
      else if (char === '"') inDouble = false;
    } else if (inSingle) {
      if (char === "'") inSingle = false;
    } else if ((char === '"' || char === "'") && (i === 0 || /[\s[,]/.test(text[i - 1]!))) {
      if (char === '"') inDouble = true;
      else inSingle = true;
    } else if (char === "#" && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).trim();
  }
  return text.trim();
}

const ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: " ",
  P: " ",
};

/** A quoted scalar starting at `start`, and the index after its closing quote. */
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
      if (escape === undefined) fail();
      const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
      if (width > 0) {
        const hex = text.slice(i + 1, i + 1 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) fail();
        value += String.fromCodePoint(parseInt(hex, 16));
        i += width;
      } else if (Object.hasOwn(ESCAPES, escape!)) value += ESCAPES[escape!];
      else fail();
    }
  }
  return fail();
}

function inlineValue(text: string): YamlValue {
  if (text[0] === '"' || text[0] === "'") {
    const [value, end] = quoted(text, 0);
    if (text.slice(end).trim() !== "") fail();
    return value;
  }
  if (text[0] === "[") return flowSequence(text);
  if (text === "{}") return {};
  return plain(text);
}

function flowSequence(text: string): YamlValue[] {
  if (!text.endsWith("]")) fail();
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const items: YamlValue[] = [];
  let i = 0;
  while (i <= inner.length) {
    while (inner[i] === " ") i++;
    let item: YamlValue;
    if (inner[i] === '"' || inner[i] === "'") {
      const [value, end] = quoted(inner, i);
      item = value;
      i = end;
      while (inner[i] === " ") i++;
    } else {
      const end = inner.indexOf(",", i);
      const raw = inner.slice(i, end === -1 ? inner.length : end).trim();
      if (raw === "" || /[[\]{}]|: |#/.test(raw)) fail();
      item = plain(raw);
      i = end === -1 ? inner.length : end;
    }
    items.push(item);
    if (i >= inner.length) break;
    if (inner[i] !== ",") fail();
    i++;
    if (inner.slice(i).trim() === "") break;
  }
  return items;
}

function plain(text: string): YamlValue {
  if (/^[[\]{}&*!|>%@`#,]/.test(text) || /^[-?:](?:\s|$)/.test(text) || /:(?:\s|$)/.test(text)) fail();
  if (/^(?:null|Null|NULL|~)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) fail();
    return value;
  }
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) {
    const value = Number(text);
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (/^(?:0o|0x)|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/.test(text)) fail();
  return text;
}
