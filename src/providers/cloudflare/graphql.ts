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

const TAG = /^(account|zone)Tag(_[A-Za-z]+)?$/;
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
  /** Tag arguments other than equality or `_in`, such as `zoneTag_neq`, which select outside a set. */
  readonly openTags: readonly string[];
  /** `accounts` or `zones` fields with no tag argument. */
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
  const collect = (name: string, value: unknown): void => {
    const match = TAG.exec(name);
    if (!match) return;
    if (match[2] !== undefined && match[2] !== "_in") {
      openTags.push(name);
      return;
    }
    const target = match[1] === "account" ? accountTags : zoneTags;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") target.push(item);
      else openTags.push(name);
    }
  };
  const resolveVariable = (name: string): unknown => variables[name];
  const scanValue = (value: unknown, depth = 0): boolean => {
    // True when a variable's value carries a tag key anywhere inside it.
    if (depth > 8 || typeof value !== "object" || value === null) return false;
    let found = false;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (TAG.test(key)) {
        collect(key, item);
        found = true;
      } else if (scanValue(item, depth + 1)) found = true;
    }
    return found;
  };
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!;
    if (token.kind !== "name") continue;
    const next = tokens[at + 1];
    if (TAG.test(token.value) && next?.kind === "punct" && next.value === ":") {
      const value = tokens[at + 2];
      if (value?.kind === "string") collect(token.value, value.value);
      else if (value?.kind === "punct" && value.value === "$" && tokens[at + 3]?.kind === "name") {
        collect(token.value, resolveVariable(tokens[at + 3]!.value));
      } else if (value?.kind === "punct" && value.value === "[") {
        const end = skipGroup(at + 2);
        const items = tokens.slice(at + 3, end - 1);
        if (items.every((item) => item.kind === "string"))
          collect(
            token.value,
            items.map((item) => item.value),
          );
        else openTags.push(token.value);
      } else openTags.push(token.value);
      continue;
    }
    if (SCOPED_FIELDS.has(token.value) && tokens[at - 1]?.value !== "$" && tokens[at - 1]?.value !== "on") {
      if (next?.kind !== "punct" || next.value !== "(") {
        unscopedFields.push(token.value);
        continue;
      }
      const end = skipGroup(at + 1);
      const args = tokens.slice(at + 2, end - 1);
      const tagged =
        args.some((arg) => arg.kind === "name" && TAG.test(arg.value)) ||
        args.some(
          (arg, position) =>
            arg.kind === "punct" &&
            arg.value === "$" &&
            args[position + 1]?.kind === "name" &&
            scanValue(resolveVariable(args[position + 1]!.value)),
        );
      if (!tagged) unscopedFields.push(token.value);
    }
  }
  return { accountTags, zoneTags, openTags, unscopedFields };
}
