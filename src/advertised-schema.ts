import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";

type JsonSchemaOptions = Parameters<
  StandardSchemaWithJSON["~standard"]["jsonSchema"]["input"]
>[0];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * A meta-tool input schema whose JSON Schema rendering is derived once per
 * process, not once per request.
 *
 * Every `/mcp` request builds a fresh `McpServer` (stateless per request), and
 * the SDK renders each registered tool's input schema through
 * `~standard.jsonSchema` at registration and again for `tools/list`. Zod
 * re-walks the whole schema on every one of those calls, which made the
 * rendering most of a `tools/list` request's CPU. The schemas themselves are
 * module constants — no deployment option, identity, or scoped view reaches
 * them; what does vary (descriptions) is a string computed per registration
 * and never passes through here — so the rendering is immutable data that can
 * outlive a request without being request-bound.
 *
 * This is the SDK's own `StandardSchemaWithJSON` contract, not a patch of it:
 * validation delegates to zod unchanged, so a tool call is checked exactly as
 * before, and the JSON Schema is zod's own output for the same target,
 * memoized and deep-frozen so no request can alter what the next one sees.
 * Conversions with library options are passed through uncached; nothing in
 * the SDK sends them.
 */
export function advertisedSchema<T extends z.ZodType>(
  schema: T,
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const standard = schema["~standard"];
  const rendered = new Map<string, Record<string, unknown>>();
  const convert =
    (io: "input" | "output") =>
    (options: JsonSchemaOptions): Record<string, unknown> => {
      if (options.libraryOptions !== undefined) {
        return standard.jsonSchema[io](options);
      }
      const key = `${io}:${options.target}`;
      let json = rendered.get(key);
      if (json === undefined) {
        json = deepFreeze(standard.jsonSchema[io](options));
        rendered.set(key, json);
      }
      return json;
    };
  return {
    "~standard": {
      version: 1,
      vendor: standard.vendor,
      validate: (value) => standard.validate(value),
      jsonSchema: { input: convert("input"), output: convert("output") },
    },
  };
}
