// Lossless identifying content for bulk reservations. In particular, never
// turn wire parameters or JSON properties into an Object: vendors disagree
// about first/last-value semantics, so duplicate keys require an explicit
// per-key contract and their value order always remains significant.
import { parseExpressionAt, type Expression } from "acorn";

export type Parameters = Readonly<Record<string, string>> | ReadonlyArray<readonly [string, string]>;

export interface WriteRequest {
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly template: string;
  readonly query?: Parameters;
  readonly form?: Parameters;
  /** Serialized JSON, retained verbatim so duplicate property names cannot disappear. */
  readonly json?: string;
  /** Reviewed multi-value semantics. JSON keys are RFC 6901 pointers. */
  readonly multiValue?: {
    readonly query?: readonly string[];
    readonly form?: readonly string[];
    readonly json?: readonly string[];
  };
}

export function parameterPairs(parameters: Parameters | undefined): Array<[string, string]> {
  return Array.isArray(parameters) ? parameters.map(([key, value]) => [key, value]) : Object.entries(parameters ?? {});
}

/** Sort distinct names only; stable sorting preserves every repeated value's order. */
function ordered(pairs: Array<[string, unknown]>, allowed: readonly string[] = []): Array<[string, unknown]> {
  const seen = new Set<string>();
  for (const [key] of pairs) {
    if (seen.has(key) && !allowed.includes(key))
      throw new Error("Duplicate identifying keys need declared multi-value semantics.");
    seen.add(key);
  }
  return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function jsonContent(text: string, allowed: readonly string[] = []): unknown {
  // Validate the JSON grammar first. Acorn retains every property, including
  // escaped duplicate names; JSON.parse alone would silently discard them.
  JSON.parse(text);
  const visit = (node: Expression, path: string): unknown => {
    switch (node.type) {
      case "ObjectExpression": {
        const pairs = node.properties.map((property): [string, unknown] => {
          if (property.type !== "Property" || property.key.type !== "Literal")
            throw new Error("Invalid JSON property.");
          const key = String(property.key.value);
          const pointer = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
          return [key, visit(property.value as Expression, pointer)];
        });
        return [
          "object",
          ordered(
            pairs,
            pairs.flatMap(([key]) => {
              const pointer = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
              return allowed.includes(pointer) ? [key] : [];
            }),
          ),
        ];
      }
      case "ArrayExpression":
        return ["array", node.elements.map((element, index) => visit(element as Expression, `${path}/${index}`))];
      default: {
        const raw = text.slice(node.start, node.end);
        // Never round large identifiers, coerce -0, or collapse overflow to
        // null while making the key. Retain numeric lexemes losslessly.
        return /^[-0-9]/.test(raw) ? ["number", raw] : ["value", JSON.parse(raw)];
      }
    }
  };
  return visit(parseExpressionAt(text, 0, { ecmaVersion: "latest" }), "");
}

/** Canonical ordered multimaps, including JSON structure and paths; no credentials. */
export function writeRequestKey(request: WriteRequest): string {
  if ("rawBody" in request && request.rawBody !== undefined)
    throw new Error("A bulk write item cannot declare a raw body.");
  if (request.form !== undefined && request.json !== undefined)
    throw new Error("A write item declares one body encoding.");
  return JSON.stringify([
    request.method,
    new URL(`https://request.example${request.path}`).pathname,
    ordered(parameterPairs(request.query), request.multiValue?.query),
    ordered(parameterPairs(request.form), request.multiValue?.form),
    request.json === undefined ? null : jsonContent(request.json, request.multiValue?.json),
  ]);
}
