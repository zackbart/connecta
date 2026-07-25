import { describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import { validateToolInput } from "../src/validate.js";
import type { JsonSchema, Logger } from "../src/types.js";
import { silentLogger } from "./helpers.js";

const OPTS = { address: "acme.create_note", logger: silentLogger };

function loggerSpy(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { ...silentLogger, warn }, warn };
}

describe("validateToolInput", () => {
  it("returns null for input that matches the schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    expect(validateToolInput(schema, { title: "hi" }, OPTS)).toBeNull();
  });

  it("returns a non-retryable invalid_args error naming the address and path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    const err = validateToolInput(schema, { title: 42 }, OPTS);
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err!.code).toBe("invalid_args");
    expect(err!.retryable).toBe(false);
    expect(err!.message).toContain("acme.create_note");
    expect(err!.message).toContain("/title");
  });

  it("returns rather than throws, so the caller owns the failure", () => {
    const schema: JsonSchema = { type: "object", required: ["id"] };
    expect(() => validateToolInput(schema, {}, OPTS)).not.toThrow();
    expect(validateToolInput(schema, {}, OPTS)).toBeInstanceOf(
      ConnectorCallError,
    );
  });

  it("catches the unknown key a manifest's additionalProperties: false declares", () => {
    // The false-success bug this closes: an unknown arg key silently dropped,
    // an empty body sent upstream, and a 200 reported back as a write.
    const schema: JsonSchema = {
      type: "object",
      properties: { note_id: { type: "string" } },
      additionalProperties: false,
    };
    const err = validateToolInput(schema, { noteId: "n_1" }, OPTS);
    expect(err?.code).toBe("invalid_args");
    expect(err?.message).toContain("noteId");
  });

  it("a schema the validator cannot compile warns once and passes through", () => {
    const { logger, warn } = loggerSpy();
    const schema: JsonSchema = {
      $id: "urn:connecta-test:dup",
      type: "object",
      $defs: { clash: { $id: "urn:connecta-test:dup" } },
    };
    const opts = { address: "acme.dup_id", logger };
    expect(validateToolInput(schema, { anything: true }, opts)).toBeNull();
    expect(validateToolInput(schema, { anything: true }, opts)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("acme.dup_id");
  });

  it("a schema that only fails on first validate warns once and passes through", () => {
    const { logger, warn } = loggerSpy();
    // Unresolvable $ref — @cfworker/json-schema surfaces this on the first
    // validate() call, not at construction.
    const schema: JsonSchema = {
      type: "object",
      properties: { x: { $ref: "#/definitions/missing" } },
    };
    const opts = { address: "acme.broken_ref", logger };
    expect(validateToolInput(schema, { x: 1 }, opts)).toBeNull();
    expect(validateToolInput(schema, { x: 2 }, opts)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("acme.broken_ref");
  });

  it("caches the compiled validator per schema object", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    };
    // Same object, repeated use: still validating, not silently disabled.
    expect(validateToolInput(schema, { n: 1 }, OPTS)).toBeNull();
    expect(validateToolInput(schema, { n: "1" }, OPTS)?.code).toBe(
      "invalid_args",
    );
    expect(validateToolInput(schema, { n: 2 }, OPTS)).toBeNull();
  });

  it("defaults the logger when opts omits one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const schema: JsonSchema = {
        type: "object",
        properties: { x: { $ref: "#/definitions/nope" } },
      };
      expect(
        validateToolInput(schema, { x: 1 }, { address: "acme.no_logger" }),
      ).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
