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
  skills: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
  error: error.optional(),
}).passthrough());

export const SEARCH_OUTPUT = advertisedSchema(z.object({
  connectors: z.array(z.object({ id: z.string(), tools: z.array(z.record(z.string(), z.unknown())) }).passthrough()).optional(),
  total: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  hasMore: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
  error: error.optional(),
}).passthrough());

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
