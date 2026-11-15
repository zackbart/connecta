import { Validator } from "@cfworker/json-schema";
import { CATALOG_SEARCH_RESULT_SCHEMA, type CatalogSearchResult } from "./catalog-service.js";
import * as z from "zod";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { advertisedSchema, openOutputSchema } from "./advertised-schema.js";

const error = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  })
  .passthrough();
const counts = z.object({
  attempted: z.number().int().nonnegative(),
  admitted: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

const advertisedValidators = new WeakMap<object, Validator>();

function declaredOutput<Input, Output>(
  validator: StandardSchemaWithJSON<Input, Output>,
  advertised: Record<string, unknown>,
): StandardSchemaWithJSON<Input, Output> {
  const schema = openOutputSchema(validator, advertised);
  advertisedValidators.set(schema, new Validator(structuredClone(advertised) as never, "2020-12"));
  return schema;
}

/**
 * Cursor validates `structuredContent` against `outputSchema` even when `isError` is true
 * (https://forum.cursor.com/t/160503). An error whose structured form the advertised schema
 * rejects therefore travels in its text copy alone.
 */
export function withinOutputSchema<R>(schema: StandardSchemaWithJSON, result: R): R {
  const response = result as { isError?: boolean; structuredContent?: unknown } | null | undefined;
  if (response?.isError !== true || response.structuredContent === undefined) return result;
  if (advertisedValidators.get(schema)!.validate(response.structuredContent).valid) return result;
  const { structuredContent: _omitted, ...textOnly } = response;
  return textOnly as R;
}

export const EXECUTE_OUTPUT = declaredOutput(
  advertisedSchema(
    z
      .object({
        result: z.unknown().optional(),
        error: error.optional(),
        hostCalls: counts,
        logs: z.string().optional(),
        emitted: z.number().int().nonnegative().optional(),
        emittedDiscarded: z.number().int().nonnegative().optional(),
        diagnostics: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  ),
  {
    type: "object",
    required: ["hostCalls"],
    properties: { result: {}, error: { type: "object" }, hostCalls: { type: "object" }, logs: { type: "string" } },
  },
);

// The server validates every page against the full catalog contract; clients get the open summary.
const searchValidator = new Validator(CATALOG_SEARCH_RESULT_SCHEMA as never, "2020-12", false);
export const SEARCH_OUTPUT = declaredOutput<CatalogSearchResult, CatalogSearchResult>(
  {
    "~standard": {
      version: 1,
      vendor: "connecta",
      validate: (value) =>
        searchValidator.validate(value).valid
          ? { value: value as CatalogSearchResult }
          : { issues: [{ message: "Expected a CatalogSearchResult." }] },
      jsonSchema: {
        input: () => CATALOG_SEARCH_RESULT_SCHEMA,
        output: () => CATALOG_SEARCH_RESULT_SCHEMA,
      },
    },
  },
  {
    type: "object",
    required: ["catalogErrors", "tools", "total", "offset", "limit", "hasMore"],
    properties: {
      catalogErrors: { type: "array" },
      tools: { type: "array", items: { type: "object", required: ["name", "address"] } },
      total: { type: "integer" },
      offset: { type: "integer" },
      limit: { type: "integer" },
      hasMore: { type: "boolean" },
      nextOffset: { type: "integer" },
    },
  },
);

export const AUTHORIZE_OUTPUT = declaredOutput(
  advertisedSchema(
    z
      .object({
        connector: z.string().optional(),
        recovery: z.string().optional(),
        message: z.string().optional(),
        error: error.optional(),
      })
      .passthrough(),
  ),
  { type: "object", properties: { connector: { type: "string" }, message: { type: "string" } } },
);
