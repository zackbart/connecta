import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { Validator } from "@cfworker/json-schema";
import { CATALOG_SEARCH_RESULT_SCHEMA, type CatalogSearchResult } from "./catalog-service.js";
import { z } from "zod";
import { advertisedSchema } from "./advertised-schema.js";

const error = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
}).passthrough();
const format = z.enum(["json", "text"]);
const counts = z.object({
  attempted: z.number().int().nonnegative(),
  admitted: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const EXECUTE_OUTPUT = advertisedSchema(z.object({
  result: z.unknown().optional(),
  error: error.optional(),
  hostCalls: counts,
  logs: z.string().optional(),
  emitted: z.number().int().nonnegative().optional(),
  emittedDiscarded: z.number().int().nonnegative().optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
}).passthrough());

export const SKILLS_OUTPUT = advertisedSchema(z.object({
  name: z.string().optional(),
  text: z.string().optional(),
  format: format.optional(),
  skills: z.array(z.object({ name: z.string(), uri: z.string(), description: z.string() })).optional(),
  error: error.optional(),
}).passthrough());

// Catalog publication, SDK advertisement and validation share one schema.
const searchValidator = new Validator(CATALOG_SEARCH_RESULT_SCHEMA as never, "2020-12", false);
export const SEARCH_OUTPUT: StandardSchemaWithJSON<CatalogSearchResult, CatalogSearchResult> = {
  "~standard": {
    version: 1,
    vendor: "connecta",
    validate: value => searchValidator.validate(value).valid
      ? { value: value as CatalogSearchResult }
      : { issues: [{ message: "Expected a CatalogSearchResult." }] },
    jsonSchema: {
      input: () => CATALOG_SEARCH_RESULT_SCHEMA,
      output: () => CATALOG_SEARCH_RESULT_SCHEMA,
    },
  },
};

export const CALL_OUTPUT = advertisedSchema(z.object({
  ok: z.boolean().optional(),
  data: z.unknown().optional(),
  format: format.optional(),
  error: error.optional(),
  durationMs: z.number().nonnegative().optional(),
  attempts: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  resultId: z.string().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  hint: z.string().optional(),
  nextAction: z.record(z.string(), z.unknown()).optional(),
}).passthrough());

export const AUTHORIZE_OUTPUT = advertisedSchema(z.object({
  connector: z.string().optional(),
  recovery: z.string().optional(),
  message: z.string().optional(),
  error: error.optional(),
}).passthrough());
