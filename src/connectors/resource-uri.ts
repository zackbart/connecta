// Deterministic inverse RFC 6570 expansion for advertised resource templates.
// Each expression consumes up to the leftmost following literal. Ambiguous
// boundaries are refused rather than searched again with another capture.
const MAX_URI_LENGTH = 8192;
const MAX_MATCH_WORK = 262_144;
interface Variable { name: string; explode: boolean; prefix: number | undefined }
interface Expression { operator: string; variables: Variable[] }
type Part = string | Expression;
import type { ResourceTemplateRefusalCode } from "../types.js";
export type ResourceTemplateRefusal = ResourceTemplateRefusalCode;
interface MatchResult { matched: boolean; refusal?: ResourceTemplateRefusal }
interface ParsedTemplate { parts: Part[]; scheme: string; authority: string | undefined }

/** Bound parsing plus templates × URI length for the whole resource read. */
export function resourceUriMatchesTemplates(uri: string, templates: readonly { uriTemplate: string }[], note: (code: ResourceTemplateRefusal) => void = () => {}): MatchResult {
  let work = 0;
  for (const template of templates) {
    work += uri.length + template.uriTemplate.length;
    if (work > MAX_MATCH_WORK) {
      note("resource_match_budget_exceeded");
      return { matched: false, refusal: "resource_match_budget_exceeded" };
    }
  }
  let matched = false;
  let refusal: ResourceTemplateRefusal | undefined;
  for (const template of templates) {
    const parsed = parse(template.uriTemplate);
    if (parsed === "resource_template_ambiguous") {
      note(parsed);
      refusal = parsed;
    } else if (parsed && matches(uri, parsed)) matched = true;
  }
  return matched ? { matched } : { matched, ...(refusal ? { refusal } : {}) };
}

export function resourceUriMatchesTemplate(uri: string, template: string): boolean {
  const parsed = parse(template);
  return typeof parsed === "object" && matches(uri, parsed);
}

function parse(template: string): ParsedTemplate | "resource_template_ambiguous" | undefined {
  if (template.length > MAX_URI_LENGTH) return;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(template)?.[0];
  if (!scheme) return;
  const authority = literalAuthority(template.slice(scheme.length));
  if (authority !== undefined && /[{}]/.test(authority)) return;
  const parts: Part[] = [];
  let offset = 0;
  let count = 0;
  while (offset < template.length) {
    const start = template.indexOf("{", offset);
    if (start < 0) break;
    const literal = template.slice(offset, start);
    const end = template.indexOf("}", start + 1);
    if (literal.includes("}") || end < 0 || ++count > 16) return;
    const body = template.slice(start + 1, end);
    const operator = /^[+#./;?&]/.test(body) ? body[0]! : "";
    const specs = body.slice(operator.length).split(",");
    if (specs.length > 16) return;
    const variables: Variable[] = [];
    for (const spec of specs) {
      const value = /^((?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+)*)(\*|:[1-9][0-9]{0,3})?$/.exec(spec);
      if (!value) return;
      variables.push({ name: value[1]!, explode: value[2] === "*", prefix: value[2]?.startsWith(":") ? Number(value[2].slice(1)) : undefined });
    }
    if (new Set(variables.map(value => value.name)).size !== variables.length ||
        variables.length > 1 && variables.some(value => value.explode)) return;
    parts.push(literal, { operator, variables });
    offset = end + 1;
  }
  const tail = template.slice(offset);
  if (/[{}]/.test(tail)) return;
  parts.push(tail);
  for (let index = 1; index < parts.length; index += 2) {
    const expression = parts[index] as Expression;
    const literal = parts[index + 1] as string;
    if (!literal && index + 2 < parts.length || literal && Array.from(literal).every(character => expressionCharacter(expression, character))) {
      return "resource_template_ambiguous";
    }
  }
  return { parts, scheme, authority };
}

function literalAuthority(rest: string): string | undefined {
  if (!rest.startsWith("//")) return;
  const value = rest.slice(2);
  const end = value.search(/[/?#]|\{[/?#]/);
  return end < 0 ? value : value.slice(0, end);
}

function expressionCharacter({ operator, variables }: Expression, character: string): boolean {
  const base = operator === "+" || operator === "#" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.~!$'()*+@-/,%" :
    operator === "." ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_~-%" : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.~-%";
  const syntax = operator === ";" ? ";=," : operator === "?" || operator === "&" ? operator + "&=," : operator === "/" || operator === "." ? operator + "," : ",";
  return base.includes(character) || syntax.includes(character) || variables.some(value => value.name.includes(character));
}

// KMP gives a single forward scan even when a literal has repeated prefixes.
function findLiteral(uri: string, literal: string, offset: number): number {
  const failure = Array.from({ length: literal.length }, () => 0);
  for (let index = 1, prefix = 0; index < literal.length; index++) {
    while (prefix && literal[index] !== literal[prefix]) prefix = failure[prefix - 1]!;
    if (literal[index] === literal[prefix]) prefix++;
    failure[index] = prefix;
  }
  for (let index = offset, prefix = 0; index < uri.length; index++) {
    while (prefix && uri[index] !== literal[prefix]) prefix = failure[prefix - 1]!;
    if (uri[index] === literal[prefix]) prefix++;
    if (prefix === literal.length) return index + 1 - prefix;
  }
  return -1;
}

function matches(uri: string, { parts, scheme, authority }: ParsedTemplate): boolean {
  if (uri.length > MAX_URI_LENGTH || !uri.startsWith(scheme) || authority === undefined && uri.slice(scheme.length).startsWith("//")) return false;
  const values = new Map<string, Array<{ parts: string[]; prefix: number | undefined }>>();
  const capture = (variable: Variable, raw: string[], path: boolean): boolean => {
    const decoded = raw.map(value => safeValue(value, variable.prefix, path));
    if (decoded.some(value => value === undefined)) return false;
    const prior = values.get(variable.name) ?? [];
    prior.push({ parts: decoded as string[], prefix: variable.prefix });
    values.set(variable.name, prior);
    return true;
  };
  let offset = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (typeof part === "string") {
      if (!uri.startsWith(part, offset)) return false;
      offset += part.length;
      continue;
    }
    const literal = parts[index + 1] as string;
    const end = literal ? findLiteral(uri, literal, offset) : uri.length;
    if (end < 0) return false;
    const raw = uri.slice(offset, end);
    offset = end;
    if (!raw) continue;
    const { operator, variables } = part;
    const prefix = operator === "+" ? "" : operator;
    if (!raw.startsWith(prefix)) return false;
    const body = raw.slice(prefix.length);
    if (operator === "?" || operator === "&" || operator === ";") {
      const tokens = body.split(operator === ";" ? ";" : "&");
      let last = -1;
      for (const token of tokens) {
        const equal = token.indexOf("=");
        const name = equal < 0 ? token : token.slice(0, equal);
        const next = variables.findIndex(value => value.name === name);
        if (next <= last || next < 0 || equal < 0 && operator !== ";") return false;
        last = next;
        const variable = variables[next]!;
        const value = equal < 0 ? "" : token.slice(equal + 1);
        if (!capture(variable, variable.prefix === undefined ? value.split(",") : [value], false)) return false;
      }
    } else {
      const separator = operator === "/" || operator === "." ? operator : ",";
      if (operator === "." && body.includes("..")) return false;
      const tokens = body.split(separator);
      if (operator === "/" && tokens.length > 1 && tokens.some(value => !value)) return false;
      if (variables.length === 1) {
        const variable = variables[0]!;
        const list = variable.prefix === undefined && (variable.explode || operator !== "/" && operator !== ".");
        if (!list && tokens.length > 1 || !capture(variable, list ? tokens : [body], operator === "+" || operator === "#")) return false;
      } else {
        if (tokens.length > variables.length) return false;
        for (const [i, value] of tokens.entries()) if (!capture(variables[i]!, [value], operator === "+" || operator === "#")) return false;
      }
    }
  }
  if (offset !== uri.length) return false;
  const candidates = new Map<string, string[]>();
  for (const [name, occurrences] of values) {
    const candidate = occurrences.find(value => value.prefix === undefined || Array.from(value.parts[0]!).length < value.prefix)
      ?? occurrences.reduce((a, b) => a.parts[0]!.length >= b.parts[0]!.length ? a : b);
    if (!occurrences.every(value => value.prefix === undefined
      ? JSON.stringify(value.parts) === JSON.stringify(candidate.parts)
      : value.parts.length === 1 && value.parts[0] === Array.from(candidate.parts[0]!).slice(0, value.prefix).join(""))) return false;
    candidates.set(name, candidate.parts);
  }
  const expanded = parts.map(part => typeof part === "string" ? part : expand(part, candidates)).join("");
  const canonical = (text: string) => text.replace(/%[0-9a-f]{2}/gi, value => value.toUpperCase());
  // Empty expressions can join literals into an authority the template did
  // not advertise. Compare the final RFC 3986 authority after re-expansion.
  return canonical(expanded) === canonical(uri) && literalAuthority(uri.slice(scheme.length)) === authority && sameHost(uri, scheme, authority);
}

function sameHost(uri: string, scheme: string, authority: string | undefined): boolean {
  // WHATWG special schemes can turn an RFC 3986 path into a host. A literal
  // authority supplies the expected host, including normal port/IDNA handling;
  // without one, WHATWG must also find no host. Parser errors stay local.
  if (authority !== undefined && /[\\\p{Cc}\p{Cf}]/u.test(authority)) return false;
  try {
    const host = authority === undefined ? "" : new URL(`${scheme}//${authority}/`).host;
    return new URL(uri).host === host;
  } catch { return false; }
}

function expand({ operator, variables }: Expression, values: Map<string, string[]>): string {
  const named = operator === ";" || operator === "?" || operator === "&";
  const prefix = operator === "+" ? "" : operator;
  const separator = operator === "/" || operator === "." || operator === ";" ? operator : named ? "&" : ",";
  const encode = (value: string) => operator === "+" || operator === "#" ? value.split(/(%[0-9a-f]{2})/gi).map(part => /^%[0-9a-f]{2}$/i.test(part) ? part : encodeURI(part)).join("")
    : encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const nameValue = (name: string, value: string) => named ? name + (value || operator !== ";" ? `=${value}` : "") : value;
  const expansions: string[] = [];
  for (const variable of variables) {
    const parts = values.get(variable.name);
    if (!parts) continue;
    const encoded = parts.map(value => encode(variable.prefix === undefined ? value : Array.from(value).slice(0, variable.prefix).join("")));
    expansions.push(variable.explode && parts.length > 1
      ? encoded.map(value => nameValue(variable.name, value)).join(separator)
      : nameValue(variable.name, encoded.join(",")));
  }
  return expansions.length ? prefix + expansions.join(separator) : "";
}

function safeValue(raw: string, prefix: number | undefined, path: boolean): string | undefined {
  let expanded: string;
  try { expanded = decodeURIComponent(raw); } catch { return undefined; }
  let value = expanded;
  // Check each decoding layer. Reserved paths may contain slashes, but cannot
  // introduce URI syntax, a network path, traversal, controls or format marks.
  for (let depth = 0; depth < 8; depth++) {
    if (/[\\:?#&;=\p{Cc}\p{Cf}]/u.test(value) || unsafeUnicode(value) || (!path && value.includes("/")) ||
        value.startsWith("/") || value.split("/").some(segment => segment === "." || segment === "..")) return undefined;
    if (!value.includes("%")) return prefix === undefined || Array.from(expanded).length <= prefix ? expanded : undefined;
    try { value = decodeURIComponent(value); } catch { return undefined; }
  }
  return undefined;
}

function unsafeUnicode(value: string): boolean {
  // Refuse non-ASCII separators and compatibility lookalikes of URI syntax,
  // rather than all non-ASCII. Ordinary percent-encoded UTF-8 path segments
  // and ASCII spaces remain valid. Inspect every decoding layer without
  // normalizing the value used for expansion.
  for (const character of value) {
    if (character <= "\x7f") continue;
    if (/\p{Z}/u.test(character) || /[\\/:?#&;=.%@]/.test(character.normalize("NFKC"))) return true;
  }
  return false;
}
