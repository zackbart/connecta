// Read-only admission for Cloudflare's GraphQL Analytics API. A document is
// tokenized by the GraphQL lexical grammar (strings, block strings, comments
// and commas are skipped as the spec skips them) and its top-level
// definitions are walked, so a `mutation` hidden in a string, a comment, or
// after an anonymous query is still found, and anything that is not a query
// or a fragment is refused. Nothing here does I/O.
import { ConnectorCallError } from "../../errors.js";

interface Token {
  readonly kind: "name" | "punct" | "string" | "number";
  readonly value: string;
}

const SCOPED_FIELDS = new Set(["accounts", "zones"]);

function refuse(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const length = source.length;
  while (at < length) {
    const character = source[at]!;
    if (character === " " || character === "\t" || character === "\n" || character === "\r" || character === ",") {
      at += 1;
      continue;
    }
    if (character === "﻿") {
      at += 1;
      continue;
    }
    if (character === "#") {
      while (at < length && source[at] !== "\n" && source[at] !== "\r") at += 1;
      continue;
    }
    if (source.startsWith("...", at)) {
      tokens.push({ kind: "punct", value: "..." });
      at += 3;
      continue;
    }
    if ("!$&()[]{}:=@|".includes(character)) {
      tokens.push({ kind: "punct", value: character });
      at += 1;
      continue;
    }
    if (/[_A-Za-z]/.test(character)) {
      const start = at;
      while (at < length && /[_0-9A-Za-z]/.test(source[at]!)) at += 1;
      tokens.push({ kind: "name", value: source.slice(start, at) });
      continue;
    }
    if (character === "-" || /[0-9]/.test(character)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
      if (!match) refuse("The GraphQL document has a malformed number.");
      tokens.push({ kind: "number", value: match[0] });
      at += match[0].length;
      continue;
    }
    if (source.startsWith('"""', at)) {
      let end = at + 3;
      let text = "";
      for (;;) {
        if (end >= length) refuse("The GraphQL document has an unterminated block string.");
        if (source.startsWith('\\"""', end)) {
          text += '"""';
          end += 4;
          continue;
        }
        if (source.startsWith('"""', end)) break;
        text += source[end];
        end += 1;
      }
      tokens.push({ kind: "string", value: text });
      at = end + 3;
      continue;
    }
    if (character === '"') {
      let end = at + 1;
      let text = "";
      for (;;) {
        const next = source[end];
        if (next === undefined || next === "\n" || next === "\r")
          refuse("The GraphQL document has an unterminated string.");
        if (next === '"') break;
        if (next === "\\") {
          const escape = source[end + 1];
          if (escape === "u") {
            const hex = source.slice(end + 2, end + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) refuse("The GraphQL document has a malformed string escape.");
            text += String.fromCharCode(parseInt(hex, 16));
            end += 6;
            continue;
          }
          const simple: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (escape === undefined || !(escape in simple))
            refuse("The GraphQL document has a malformed string escape.");
          text += simple[escape];
          end += 2;
          continue;
        }
        text += next;
        end += 1;
      }
      tokens.push({ kind: "string", value: text });
      at = end + 1;
      continue;
    }
    refuse(`The GraphQL document has an unexpected character at offset ${at}.`);
  }
  return tokens;
}

/** The scope a read-only document names: account and zone tags, by literal or variable. */
export interface GraphqlScope {
  readonly accountTags: readonly string[];
  readonly zoneTags: readonly string[];
  /** Filter keys other than tag equality or `_in` (such as `zoneTag_neq`), which select outside a set. */
  readonly openTags: readonly string[];
  /** `accounts` or `zones` fields whose filter is missing, unresolvable, or names no tag. */
  readonly unscopedFields: readonly string[];
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * Refuse anything but queries and fragments, and report the account and zone
 * tags the document names. `variables` resolves `$name` tag values.
 */
export function inspectGraphqlQuery(source: string, variables: Readonly<Record<string, unknown>>): GraphqlScope {
  const tokens = tokenize(source);
  if (tokens.length === 0) refuse("The GraphQL document is empty.");
  let index = 0;
  let operations = 0;
  // Skip one balanced group starting at `index` (an opener); returns the index after its closer.
  const skipGroup = (start: number): number => {
    const stack: string[] = [];
    for (let at = start; at < tokens.length; at += 1) {
      const token = tokens[at]!;
      if (token.kind !== "punct") continue;
      if (OPENERS[token.value]) stack.push(OPENERS[token.value]!);
      else if (token.value === ")" || token.value === "]" || token.value === "}") {
        if (stack.pop() !== token.value) refuse("The GraphQL document has unbalanced brackets.");
        if (stack.length === 0) return at + 1;
      }
    }
    return refuse("The GraphQL document has unbalanced brackets.");
  };
  // From a definition keyword, consume the header (name, variables,
  // directives) and its selection set.
  const skipDefinition = (start: number): number => {
    for (let at = start; at < tokens.length; at += 1) {
      const token = tokens[at]!;
      if (token.kind !== "punct") continue;
      if (token.value === "{") return skipGroup(at);
      if (token.value === "(" || token.value === "[") at = skipGroup(at) - 1;
      else if (token.value === "}" || token.value === ")" || token.value === "]") {
        refuse("The GraphQL document has unbalanced brackets.");
      }
    }
    return refuse("A GraphQL definition has no selection set.");
  };
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === "punct" && token.value === "{") {
      operations += 1;
      index = skipGroup(index);
      continue;
    }
    if (token.kind === "name" && token.value === "query") {
      operations += 1;
      index = skipDefinition(index + 1);
      continue;
    }
    if (token.kind === "name" && token.value === "fragment") {
      index = skipDefinition(index + 1);
      continue;
    }
    if (token.kind === "name" && (token.value === "mutation" || token.value === "subscription")) {
      refuse(`graphql_query runs read-only queries; this document contains a ${token.value}, which it never sends.`);
    }
    refuse("graphql_query accepts only query operations and fragments.");
  }
  if (operations === 0) refuse("The GraphQL document has no query operation.");

  const accountTags: string[] = [];
  const zoneTags: string[] = [];
  const openTags: string[] = [];
  const unscopedFields: string[] = [];
  const UNRESOLVED = Symbol("unresolved");

  // Variable declarations (`$zoneTag: String! = "…"`) are not filters; record
  // their defaults so a variable resolves as the server would resolve it.
  const defaults = new Map<string, unknown>();
  const declared = new Set<number>();
  const resolveVariable = (name: string): unknown =>
    Object.hasOwn(variables, name) ? variables[name] : defaults.has(name) ? defaults.get(name) : UNRESOLVED;

  /** Parse one GraphQL input value at `at`, resolving variables; returns the value and the index after it. */
  const parseValue = (at: number): { value: unknown; end: number } => {
    const token = tokens[at];
    if (token === undefined) return { value: UNRESOLVED, end: at };
    if (token.kind === "string") return { value: token.value, end: at + 1 };
    if (token.kind === "number") return { value: Number(token.value), end: at + 1 };
    if (token.kind === "name") {
      const literal: Record<string, unknown> = { true: true, false: false, null: null };
      return { value: Object.hasOwn(literal, token.value) ? literal[token.value] : { enum: token.value }, end: at + 1 };
    }
    if (token.value === "$" && tokens[at + 1]?.kind === "name") {
      return { value: resolveVariable(tokens[at + 1]!.value), end: at + 2 };
    }
    if (token.value === "[") {
      const items: unknown[] = [];
      let next = at + 1;
      while (next < tokens.length && tokens[next]!.value !== "]") {
        const item = parseValue(next);
        if (item.end === next) return { value: UNRESOLVED, end: skipGroup(at) };
        items.push(item.value);
        next = item.end;
      }
      return { value: items, end: next + 1 };
    }
    if (token.value === "{") {
      const object: Record<string, unknown> = {};
      let next = at + 1;
      while (next < tokens.length && tokens[next]!.value !== "}") {
        const key = tokens[next];
        if (key?.kind !== "name" || tokens[next + 1]?.value !== ":") return { value: UNRESOLVED, end: skipGroup(at) };
        const item = parseValue(next + 2);
        if (item.end === next + 2) return { value: UNRESOLVED, end: skipGroup(at) };
        object[key.value] = item.value;
        next = item.end;
      }
      return { value: object, end: next + 1 };
    }
    return { value: UNRESOLVED, end: at };
  };

  for (let at = 0; at + 2 < tokens.length; at += 1) {
    const [dollar, name, colon] = [tokens[at]!, tokens[at + 1]!, tokens[at + 2]!];
    if (dollar.value !== "$" || name.kind !== "name" || colon.value !== ":") continue;
    declared.add(at + 1);
    for (let scan = at + 3; scan < tokens.length; scan += 1) {
      const token = tokens[scan]!;
      if (token.kind === "punct" && (token.value === "$" || token.value === ")")) break;
      if (token.kind === "punct" && token.value === "=") {
        const parsed = parseValue(scan + 1);
        if (parsed.value !== UNRESOLVED) defaults.set(name.value, parsed.value);
        break;
      }
    }
  }

  /**
   * Validate one `zones` or `accounts` field's resolved `filter`: an object
   * whose only keys are the tag equality or `_in`, with string values. Each
   * field is checked on its own, so a valid alias cannot carry an unpinned one.
   */
  const checkField = (field: string, filter: unknown): void => {
    const prefix = field === "zones" ? "zone" : "account";
    if (filter === UNRESOLVED || typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      unscopedFields.push(field);
      return;
    }
    const target = prefix === "zone" ? zoneTags : accountTags;
    let tagged = false;
    for (const [key, value] of Object.entries(filter)) {
      if (key === `${prefix}Tag` && typeof value === "string") {
        target.push(value);
        tagged = true;
      } else if (
        key === `${prefix}Tag_in` &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === "string")
      ) {
        target.push(...(value as string[]));
        tagged = true;
      } else {
        openTags.push(`${field}.${key}`);
      }
    }
    if (!tagged) unscopedFields.push(field);
  };

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!;
    if (token.kind !== "name" || !SCOPED_FIELDS.has(token.value) || declared.has(at)) continue;
    const previous = tokens[at - 1]?.value;
    const next = tokens[at + 1];
    if (previous === "$" || previous === "on" || previous === "...") continue;
    // `zones: accounts(…)` aliases, and object keys inside arguments.
    if (next?.kind === "punct" && next.value === ":") continue;
    if (next?.kind !== "punct" || next.value !== "(") {
      unscopedFields.push(token.value);
      continue;
    }
    let filter: unknown = UNRESOLVED;
    let cursor = at + 2;
    while (cursor < tokens.length && tokens[cursor]!.value !== ")") {
      const key = tokens[cursor];
      if (key?.kind !== "name" || tokens[cursor + 1]?.value !== ":") {
        filter = UNRESOLVED;
        break;
      }
      const parsed = parseValue(cursor + 2);
      if (parsed.end === cursor + 2) break;
      if (key.value === "filter") filter = parsed.value;
      cursor = parsed.end;
    }
    checkField(token.value, filter);
  }
  return { accountTags, zoneTags, openTags, unscopedFields };
}
