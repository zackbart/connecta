const CALL_KEYS = new Set([
  "data",
  "format",
  "content",
  "contentResult",
  "valueFormat",
  "resultId",
  "totalBytes",
  "truncated",
  "hint",
]);
const CATALOG_KEYS = new Set([
  "tools",
  "catalogErrors",
  "absence",
  "total",
  "offset",
  "limit",
  "hasMore",
  "nextOffset",
  "matchMode",
  "queryAnalysis",
  "readyCalls",
  "connectors",
]);
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const MEMBER = String.raw`\s*(?:\?\.|\.)\s*`;
const AWAITED_WRAPPER = new RegExp(String.raw`\bawait\s+connecta${MEMBER}(call|search|describe)\s*\(`, "g");
const USES_WRAPPER = new RegExp(String.raw`\bconnecta${MEMBER}(?:search|describe|call)\b`);
const PROPERTY_READ = /\bcannot read propert(?:y|ies)\b.*\bof (?:undefined|null)\b/i;

type Kind = "call" | "catalog";

/** Source with comments, string and template literal contents blanked to spaces. */
function codeOnly(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - index);
      index = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let stop = index + 1;
      while (stop < source.length && source[stop] !== char && (char === "`" || source[stop] !== "\n")) {
        stop += source[stop] === "\\" ? 2 : 1;
      }
      stop = Math.min(stop, source.length - 1);
      out += char + source.slice(index + 1, stop).replace(/[^\n]/g, " ") + source[stop];
      index = stop + 1;
    } else {
      out += char;
      index++;
    }
  }
  return out;
}

function closingParen(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === "(") depth++;
    else if (code[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function kindOf(name: string): Kind {
  return name === "call" ? "call" : "catalog";
}

function keysOf(kind: Kind) {
  return kind === "call" ? CALL_KEYS : CATALOG_KEYS;
}

function escape(name: string) {
  return name.replace(/\$/g, "\\$");
}

/** A name rebound by a parameter, catch clause, loop or destructuring is not one result. */
function shadowed(code: string, name: string): boolean {
  const word = new RegExp(String.raw`(?:^|[^\w$.])${escape(name)}(?![\w$])`);
  const lists = [
    ...code.matchAll(/\(([^()]*)\)\s*=>/g),
    ...code.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g),
    ...code.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g),
  ].map((match) => ` ${match[1]}`);
  return (
    lists.some((list) => word.test(list)) ||
    new RegExp(String.raw`(?:^|[^\w$.])${escape(name)}\s*=>`).test(code) ||
    new RegExp(String.raw`\bcatch\s*\(\s*${escape(name)}\b`).test(code) ||
    new RegExp(String.raw`\bfor\s*\(\s*(?:const|let|var)\s+${escape(name)}\b`).test(code)
  );
}

/** Every assignment to the name stores an awaited wrapper result of one kind. */
function onlyBoundTo(code: string, name: string, kind: Kind): boolean {
  const assignment = new RegExp(String.raw`(?:^|[^\w$.])${escape(name)}\s*=(?![=>])`, "g");
  for (const match of code.matchAll(assignment)) {
    const after = code.slice(match.index + match[0].length);
    const bound = new RegExp(String.raw`^\s*await\s+connecta${MEMBER}(call|search|describe)\b`).exec(after);
    if (!bound || kindOf(bound[1]!) !== kind) return false;
  }
  return !shadowed(code, name);
}

/** The failing read follows `at`: the engine's property, an index, or iteration. */
function failsHere(code: string, at: number, property: string | undefined): boolean {
  if (property === undefined || property === "Symbol.iterator") return true;
  const rest = code.slice(at);
  return new RegExp(String.raw`^${MEMBER}${escape(property)}(?![\w$])|^\s*(?:\?\.\s*)?\[`).test(rest);
}

function readsMissingMember(code: string, local: string, keys: Set<string>, property: string | undefined) {
  const member = new RegExp(String.raw`(?:^|[^\w$.])${escape(local)}${MEMBER}(${IDENT})`, "g");
  for (const match of code.matchAll(member)) {
    if (!keys.has(match[1]!) && failsHere(code, match.index + match[0].length, property)) return true;
  }
  return false;
}

function usesLocal(code: string, local: string, property: string | undefined) {
  if (property === undefined || property === "Symbol.iterator") return true;
  return new RegExp(
    String.raw`(?:^|[^\w$.])${escape(local)}(?:${MEMBER}${escape(property)}(?![\w$])|\s*(?:\?\.\s*)?\[)`,
  ).test(code);
}

/**
 * Whether a TypeError reading a property of undefined or null comes from a
 * program that treats an awaited search, describe or call result as its
 * payload: a member the wrapper lacks read off the result, a name bound to it,
 * or a destructured key, at the property the engine reports.
 */
function readsPayloadOffWrapper(code: string, message: string): boolean {
  const property = (/\(reading '([^']*)'\)/.exec(message) ?? /\bpropert(?:y|ies) '([^']*)'/.exec(message))?.[1];
  for (const match of code.matchAll(AWAITED_WRAPPER)) {
    const kind = kindOf(match[1]!);
    const keys = keysOf(kind);
    const before = code.slice(0, match.index);
    const close = closingParen(code, match.index + match[0].length - 1);
    if (close === -1) continue;
    const bound = new RegExp(String.raw`(?:^|[^\w$.])(${IDENT})\s*=\s*$`).exec(before);
    if (bound && !["const", "let", "var"].includes(bound[1]!)) {
      const local = bound[1]!;
      if (onlyBoundTo(code, local, kind) && readsMissingMember(code, local, keys, property)) return true;
      continue;
    }
    const pattern = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*$/.exec(before);
    if (pattern) {
      for (const part of pattern[1]!.split(",")) {
        const entry = new RegExp(String.raw`^\s*(${IDENT})\s*(?::\s*(${IDENT}))?\s*$`).exec(part);
        if (!entry || keys.has(entry[1]!)) continue;
        const local = entry[2] ?? entry[1]!;
        if (!shadowed(code.replace(pattern[0], ""), local) && usesLocal(code, local, property)) return true;
      }
      continue;
    }
    if (/\(\s*$/.test(before)) {
      const chained = new RegExp(String.raw`^\)${MEMBER}(${IDENT})`).exec(code.slice(close + 1));
      if (chained && !keys.has(chained[1]!) && failsHere(code, close + 1 + chained[0].length, property)) return true;
    }
  }
  return false;
}

/** Whether a TypeError should carry the fixed search/describe/call result-shape hint. */
export function misreadsResultShape(message: string, source: string): boolean {
  const code = codeOnly(source);
  if (!USES_WRAPPER.test(code)) return false;
  if (/not a function|not iterable/.test(message)) return true;
  return PROPERTY_READ.test(message) && readsPayloadOffWrapper(code, message);
}
