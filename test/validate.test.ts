import { describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import { precompileValidator, validateToolInput } from "../src/validate.js";
import type { JsonSchema, Logger } from "../src/types.js";
import { required, silentLogger } from "./helpers.js";

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
    expect(err!.validation).toEqual({
      issues: [{ path: "/title", code: "type", expected: "string" }],
    });
  });

  it("returns structured missing, nested, and multiple findings without values", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        settings: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            retries: { type: "integer" },
          },
          required: ["enabled", "retries"],
        },
      },
      required: ["title", "settings"],
    };
    const err = validateToolInput(
      schema,
      {
        settings: {
          enabled: "submitted-secret",
          retries: "also-secret",
        },
      },
      OPTS,
    );
    expect(err?.validation).toEqual({
      issues: [
        { path: "/title", code: "required", expected: "string" },
        { path: "/settings/enabled", code: "type", expected: "boolean" },
        { path: "/settings/retries", code: "type", expected: "integer" },
      ],
    });
    expect(JSON.stringify(err?.validation)).not.toContain("submitted-secret");
    expect(JSON.stringify(err?.validation)).not.toContain("also-secret");
  });

  it("bounds multiple validation findings", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: Object.fromEntries(
        ["a", "b", "c", "d"].map((name) => [name, { type: "string" }]),
      ),
      required: ["a", "b", "c", "d"],
    };
    const validation = validateToolInput(schema, {}, OPTS)?.validation;
    expect(validation?.issues).toHaveLength(3);
    expect(validation?.truncated).toBe(true);
  });

  it("preserves the finding bound after removing duplicate keyword branches", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: Object.fromEntries(
        ["a", "b", "c", "d"].map((name) => [
          name,
          { type: "string", enum: ["allowed"] },
        ]),
      ),
      additionalProperties: false,
    };
    const validation = validateToolInput(
      schema,
      { a: "bad", b: "bad", c: "bad", d: "bad" },
      OPTS,
    )?.validation;
    expect(validation?.issues).toHaveLength(3);
    expect(validation?.issues.every((issue) => issue.code === "enum")).toBe(
      true,
    );
    expect(validation?.truncated).toBe(true);
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
    expect(err?.validation).toEqual({
      issues: [
        {
          path: "/noteId",
          code: "additionalProperties",
          expected: "no additional properties",
        },
      ],
    });
    expect(err?.message).not.toContain("False boolean schema");
  });

  it("reports only enum for an invalid declared property in a closed schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        type: { type: "string", enum: ["A", "TXT"] },
      },
      additionalProperties: false,
    };
    const err = validateToolInput(schema, { type: "SPF" }, OPTS);
    expect(err?.validation).toEqual({
      issues: [
        {
          path: "/type",
          code: "enum",
          expected: "one of the declared values",
        },
      ],
    });
    expect(err?.message).toContain('["A","TXT"]');
    expect(err?.message).not.toContain("False boolean schema");
    expect(err?.message).not.toContain("additional properties");
  });

  it("recognizes an empty declared property name in a closed schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        "": { type: "string", enum: ["ok"] },
      },
      additionalProperties: false,
    };
    const err = validateToolInput(schema, { "": "bad" }, OPTS);
    expect(err?.validation).toEqual({
      issues: [
        {
          path: "/",
          code: "enum",
          expected: "one of the declared values",
        },
      ],
    });
    expect(err?.message).toContain('["ok"]');
    expect(err?.message).not.toContain("False boolean schema");
    expect(err?.message).not.toContain("additional properties");
  });

  it("does not misclassify an invalid nested declared property as additional", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["basic", "advanced"] },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const err = validateToolInput(
      schema,
      { settings: { mode: "invalid" } },
      OPTS,
    );
    expect(err?.validation).toEqual({
      issues: [
        {
          path: "/settings/mode",
          code: "enum",
          expected: "one of the declared values",
        },
      ],
    });
    expect(err?.message).not.toContain("False boolean schema");
    expect(err?.message).not.toContain("additional properties");
  });

  it("preserves independent enum and false-schema failures across allOf", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { x: true },
      allOf: [
        { properties: { x: { enum: ["A"] } } },
        { properties: { x: false } },
      ],
    };
    const err = validateToolInput(schema, { x: "B" }, OPTS);
    expect(err?.validation).toEqual({
      issues: [
        {
          path: "/x",
          code: "enum",
          expected: "one of the declared values",
        },
        {
          path: "/x",
          code: "additionalProperties",
          expected: "no additional properties",
        },
      ],
    });
    expect(err?.message).toContain('["A"]');
    expect(err?.message).not.toContain("False boolean schema");
  });

  it("renders one message clause for a declared false-schema property", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { banned: false },
      additionalProperties: false,
    };
    const err = validateToolInput(schema, { banned: "value" }, OPTS);
    expect(err?.validation).toEqual({
      issues: [
        {
          path: "/banned",
          code: "additionalProperties",
          expected: "no additional properties",
        },
      ],
    });
    expect(err?.message).toBe(
      'Invalid arguments for "acme.create_note": #/banned: Value is not allowed by the declared schema.',
    );
  });

  it("renders one message clause for a nested undeclared property", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: { known: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const err = validateToolInput(
      schema,
      { settings: { extra: "value" } },
      OPTS,
    );
    expect(err?.validation).toEqual({
      issues: [
        {
          path: "/settings/extra",
          code: "additionalProperties",
          expected: "no additional properties",
        },
      ],
    });
    expect(err?.message).toBe(
      'Invalid arguments for "acme.create_note": #/settings/extra: Value is not allowed by the declared schema.',
    );
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
    expect(required(warn.mock.calls[0])[0]).toContain("acme.dup_id");
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
    expect(required(warn.mock.calls[0])[0]).toContain("acme.broken_ref");
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

  it("evaluates dependentSchemas and unevaluatedProperties from 2020-12 schemas", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["basic", "token"] },
        apiKey: { type: "string" },
      },
      required: ["mode"],
      dependentSchemas: {
        apiKey: {
          properties: { mode: { const: "token" } },
        },
      },
      unevaluatedProperties: false,
    };

    expect(validateToolInput(schema, { mode: "basic" }, OPTS)).toBeNull();
    expect(
      validateToolInput(
        schema,
        { mode: "token", apiKey: "secret" },
        OPTS,
      ),
    ).toBeNull();
    expect(
      validateToolInput(
        schema,
        { mode: "basic", apiKey: "wrong-mode" },
        OPTS,
      )?.code,
    ).toBe("invalid_args");
    expect(
      validateToolInput(schema, { mode: "basic", surprise: true }, OPTS)
        ?.code,
    ).toBe("invalid_args");
  });

  it("fail-closed: a schema that cannot compile yields invalid_args", () => {
    const { logger } = loggerSpy();
    const schema: JsonSchema = {
      $id: "urn:connecta-test:failclosed-compile",
      type: "object",
      $defs: { clash: { $id: "urn:connecta-test:failclosed-compile" } },
    };
    const err = validateToolInput(schema, { anything: true }, {
      address: "acme.dup_id_strict",
      logger,
      failClosed: true,
    });
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err!.code).toBe("invalid_args");
    expect(err!.retryable).toBe(false);
    expect(err!.message).toContain("acme.dup_id_strict");
    expect(err!.message).toContain("could not be evaluated");
  });

  it("fail-closed: a schema that only fails on first validate yields invalid_args", () => {
    const { logger } = loggerSpy();
    const schema: JsonSchema = {
      type: "object",
      properties: { x: { $ref: "#/definitions/missing" } },
    };
    const err = validateToolInput(schema, { x: 1 }, {
      address: "acme.broken_ref_strict",
      logger,
      failClosed: true,
    });
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err!.code).toBe("invalid_args");
    expect(err!.message).toContain("acme.broken_ref_strict");
  });

  it("fail-closed still returns null for input that matches a good schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    expect(
      validateToolInput(schema, { title: "hi" }, { ...OPTS, failClosed: true }),
    ).toBeNull();
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

describe("precompileValidator", () => {
  it("warns and disables a schema the validator cannot compile, without throwing", () => {
    const { logger, warn } = loggerSpy();
    const schema: JsonSchema = {
      $id: "urn:connecta-test:precompile-bad",
      type: "object",
      $defs: { clash: { $id: "urn:connecta-test:precompile-bad" } },
    };
    expect(() =>
      precompileValidator(schema, { address: "acme.precompile_bad", logger }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(required(warn.mock.calls[0])[0]).toContain("acme.precompile_bad");
    // The disabled schema is cached: the runtime path passes through (default)
    // rather than recompiling and warning a second time.
    expect(
      validateToolInput(schema, { anything: true }, {
        address: "acme.precompile_bad",
        logger,
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("silently caches a good schema so the runtime path hits the cache", () => {
    const { logger, warn } = loggerSpy();
    const schema: JsonSchema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    };
    precompileValidator(schema, { address: "acme.precompile_ok", logger });
    expect(warn).not.toHaveBeenCalled();
    expect(validateToolInput(schema, { n: 1 }, OPTS)).toBeNull();
    expect(validateToolInput(schema, { n: "1" }, OPTS)?.code).toBe(
      "invalid_args",
    );
  });
});
