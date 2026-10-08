import { describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import { compileValidator, validateToolInput } from "../src/validate.js";
import type { JsonSchema } from "../src/types.js";
import { spyLogger } from "./fixtures/misc.js";
import { silentLogger } from "./helpers.js";

const OPTS = { address: "acme.create_note", logger: silentLogger };

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
      properties: Object.fromEntries(["a", "b", "c", "d"].map((name) => [name, { type: "string" }])),
      required: ["a", "b", "c", "d"],
    };
    const validation = validateToolInput(schema, {}, OPTS)?.validation;
    expect(validation?.issues).toHaveLength(3);
    expect(validation?.truncated).toBe(true);
  });

  it("preserves the finding bound after removing duplicate keyword branches", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: Object.fromEntries(["a", "b", "c", "d"].map((name) => [name, { type: "string", enum: ["allowed"] }])),
      additionalProperties: false,
    };
    const validation = validateToolInput(schema, { a: "bad", b: "bad", c: "bad", d: "bad" }, OPTS)?.validation;
    expect(validation?.issues).toHaveLength(3);
    expect(validation?.issues.every((issue) => issue.code === "enum")).toBe(true);
    expect(validation?.truncated).toBe(true);
  });

  it("returns rather than throws, so the caller owns the failure", () => {
    const schema: JsonSchema = { type: "object", required: ["id"] };
    expect(() => validateToolInput(schema, {}, OPTS)).not.toThrow();
    expect(validateToolInput(schema, {}, OPTS)).toBeInstanceOf(ConnectorCallError);
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
    // The validator's sentence quotes the schema's enum; the message is told
    // from the reviewed finding instead (#695).
    expect(err?.message).toContain("/type: expected one of the declared values (enum)");
    expect(err?.message).not.toContain('["A","TXT"]');
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
    expect(err?.message).toContain("/: expected one of the declared values (enum)");
    expect(err?.message).not.toContain('["ok"]');
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
    const err = validateToolInput(schema, { settings: { mode: "invalid" } }, OPTS);
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
      allOf: [{ properties: { x: { enum: ["A"] } } }, { properties: { x: false } }],
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
    expect(err?.message).toContain("/x: expected one of the declared values (enum)");
    expect(err?.message).not.toContain('["A"]');
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
      'Invalid arguments for "acme.create_note": /banned: expected no additional properties (additionalProperties)',
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
    const err = validateToolInput(schema, { settings: { extra: "value" } }, OPTS);
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
      'Invalid arguments for "acme.create_note": /settings/extra: expected no additional properties (additionalProperties)',
    );
  });

  it.each([
    [
      "a schema the validator cannot compile warns once and passes through",
      { $id: "urn:connecta-test:dup", type: "object", $defs: { clash: { $id: "urn:connecta-test:dup" } } },
      [{ anything: true }, { anything: true }],
      "acme.dup_id",
      false,
    ],
    [
      "a schema that only fails on first validate warns once and passes through",
      { type: "object", properties: { x: { $ref: "#/definitions/missing" } } },
      [{ x: 1 }, { x: 2 }],
      "acme.broken_ref",
      false,
    ],
    [
      "fail-closed: a schema that cannot compile yields invalid_args",
      {
        $id: "urn:connecta-test:failclosed-compile",
        type: "object",
        $defs: { clash: { $id: "urn:connecta-test:failclosed-compile" } },
      },
      [{ anything: true }],
      "acme.dup_id_strict",
      true,
    ],
    [
      "fail-closed: a schema that only fails on first validate yields invalid_args",
      { type: "object", properties: { x: { $ref: "#/definitions/missing" } } },
      [{ x: 1 }],
      "acme.broken_ref_strict",
      true,
    ],
  ] as const)("%s", (_name, schema, inputs, address, failClosed) => {
    const { logger, warn } = spyLogger();
    const results = inputs.map((input) =>
      validateToolInput(schema as JsonSchema, input, { address, logger, failClosed }),
    );
    if (!failClosed) {
      for (const result of results) expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      // The caller's address is its own text, not a catalog entry connecta
      // resolved, so the record names only the error's class (INV-6).
      expect(warn.mock.calls[0]).toEqual([
        "[connecta] input schema unusable; arguments are not validated",
        { errorClass: "Error" },
      ]);
      return;
    }
    const err = results[0]!;
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err.code).toBe("invalid_args");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(address);
    if (address === "acme.dup_id_strict") {
      expect(err.message).toContain("could not be evaluated");
    }
  });

  it("caches the compiled validator per schema object", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    };
    // Same object, repeated use: still validating, not silently disabled.
    expect(validateToolInput(schema, { n: 1 }, OPTS)).toBeNull();
    expect(validateToolInput(schema, { n: "1" }, OPTS)?.code).toBe("invalid_args");
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
    expect(validateToolInput(schema, { mode: "token", apiKey: "secret" }, OPTS)).toBeNull();
    expect(validateToolInput(schema, { mode: "basic", apiKey: "wrong-mode" }, OPTS)?.code).toBe("invalid_args");
    expect(validateToolInput(schema, { mode: "basic", surprise: true }, OPTS)?.code).toBe("invalid_args");
  });

  it("fail-closed still returns null for input that matches a good schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    expect(validateToolInput(schema, { title: "hi" }, { ...OPTS, failClosed: true })).toBeNull();
  });

  it("defaults the logger when opts omits one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const schema: JsonSchema = {
        type: "object",
        properties: { x: { $ref: "#/definitions/nope" } },
      };
      expect(validateToolInput(schema, { x: 1 }, { address: "acme.no_logger" })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("compileValidator", () => {
  it("throws on a schema the validator cannot compile, naming the address", () => {
    const schema: JsonSchema = {
      $id: "urn:connecta-test:compile-bad",
      type: "object",
      $defs: { clash: { $id: "urn:connecta-test:compile-bad" } },
    };
    expect(() => compileValidator(schema, { address: "acme.compile_bad" })).toThrow(/acme\.compile_bad/);
    expect(() => compileValidator(schema, { address: "acme.compile_bad" })).toThrow(/cannot use/);
  });

  it("refuses a schema an earlier call already found unusable", () => {
    const { logger, warn } = spyLogger();
    // Unresolvable $ref: it compiles, then blows up on first validate, which
    // is where the fail-open proxy path disables it.
    const schema: JsonSchema = {
      type: "object",
      properties: { x: { $ref: "#/definitions/missing" } },
    };
    expect(validateToolInput(schema, { x: 1 }, { address: "acme.late", logger })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => compileValidator(schema, { address: "acme.late" })).toThrow(/acme\.late/);
  });

  it("silently caches a good schema so the runtime path hits the cache", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    };
    expect(() => compileValidator(schema, { address: "acme.compile_ok" })).not.toThrow();
    expect(validateToolInput(schema, { n: 1 }, OPTS)).toBeNull();
    expect(validateToolInput(schema, { n: "1" }, OPTS)?.code).toBe("invalid_args");
  });
});

it("never quotes a schema's enum, and bounds detail to 256 UTF-8 bytes plus its marker", () => {
  const prefix = `Invalid arguments for "${OPTS.address}": `;
  const enumSchema = { enum: Array.from({ length: 10_000 }, (_, i) => `選択${i}`) };
  const enumError = validateToolInput(enumSchema, "absent", OPTS)!;
  expect(enumError.code).toBe("invalid_args");
  expect(enumError.message).toBe(`${prefix}/: expected one of the declared values (enum)`);
  // A required property's name is part of the path the agent must supply.
  const longName = "選択".repeat(200);
  const error = validateToolInput({ type: "object", required: [longName] }, {}, OPTS)!;
  expect(error.message.startsWith(prefix)).toBe(true);
  const detail = error.message.slice(prefix.length);
  expect(new TextEncoder().encode(detail).length).toBeLessThanOrEqual(259);
  expect(detail.endsWith("…")).toBe(true);
  expect(detail).not.toContain("\uFFFD");
});

it("INV-6: agent repair includes schema keys, enum values, bounds and received types without caller values", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["fast", "safe"] },
      count: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["mode", "count"],
  };
  const error = validateToolInput(schema, { mode: "caller-secret", count: 20, typo: "another-secret" }, OPTS);
  expect(error?.repair).toMatchObject({
    acceptedKeys: ["mode", "count"],
    issues: expect.arrayContaining([
      { path: "/mode", receivedType: "string", enumValues: ["fast", "safe"] },
      { path: "/count", receivedType: "number", bounds: { minimum: 1, maximum: 10 } },
      { path: "/typo", receivedType: "string", acceptedKeys: ["mode", "count"] },
    ]),
    example: { mode: "fast", count: 1 },
  });
  expect(validateToolInput(schema, error?.repair?.example, OPTS)).toBeNull();
  expect(JSON.stringify(error?.repair)).not.toContain("caller-secret");
  expect(JSON.stringify(error?.repair)).not.toContain("another-secret");
});

it("INV-6: agent repair states dependent and conditional date requirements from the schema", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      distinct_id: { type: "string", minLength: 1 },
      from_date: { type: "string", format: "date" },
      to_date: { type: "string", format: "date" },
    },
    required: ["distinct_id"],
    dependentRequired: { distinct_id: ["from_date", "to_date"] },
    ...JSON.parse('{"if":{"required":["distinct_id"]},"then":{"required":["from_date","to_date"]}}'),
  };
  const error = validateToolInput(schema, { distinct_id: "caller-secret" }, OPTS);
  expect(error?.repair?.conditionalRequirements).toContainEqual({
    path: "/",
    condition: { required: ["distinct_id"] },
    required: ["from_date", "to_date"],
  });
  expect(error?.repair?.example).toEqual({ distinct_id: "x", from_date: "2000-01-01", to_date: "2000-01-01" });
  expect(validateToolInput(schema, error?.repair?.example, OPTS)).toBeNull();
});

it("INV-6: examples are verified and oversized schema detail is bounded", () => {
  const unsupported: JsonSchema = {
    type: "object",
    properties: { code: { type: "string", pattern: "^CUSTOM-[0-9]{5}$" } },
    required: ["code"],
  };
  const error = validateToolInput(unsupported, {}, OPTS);
  expect(error?.repair).not.toHaveProperty("example");
  expect(error?.repair?.exampleUnavailable).toContain("No valid example");
  const large: JsonSchema = { type: "string", enum: ["e".repeat(10000)] };
  const repair = validateToolInput(large, 1, OPTS)?.repair;
  expect(repair?.truncated).toBe(true);
  expect(JSON.stringify(repair).length).toBeLessThan(4096);
});

it("INV-6: recursive schema examples stop before expanding beyond a shared synthesis budget", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, { $ref: "#" }])),
    required: Array.from({ length: 30 }, (_, index) => `p${index}`),
  };
  const error = validateToolInput(schema, {}, OPTS);
  expect(error?.code).toBe("invalid_args");
  expect(error?.repair).not.toHaveProperty("example");
  expect(error?.repair?.exampleUnavailable).toContain("No valid example");
});

it("INV-6: minimization restores a field when removing it makes validation throw", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { selector: { type: "string" } },
    examples: [{ selector: "keep" }],
    ...JSON.parse('{"if":{"required":["selector"]},"else":{"$ref":"#/$defs/missing"}}'),
  };
  const error = validateToolInput(schema, { selector: 1 }, OPTS);
  expect(error?.repair?.example).toEqual({ selector: "keep" });
  expect(validateToolInput(schema, error?.repair?.example, OPTS)).toBeNull();
});

it("INV-6: conditional advice does not assert dependencies from an unselected alternative", () => {
  const schema: JsonSchema = {
    type: "object",
    oneOf: [
      {
        properties: { kind: { const: "a" }, trigger: { type: "string" }, extra: { type: "string" } },
        required: ["kind"],
        dependentRequired: { trigger: ["extra"] },
      },
      {
        properties: { kind: { const: "b" }, trigger: { type: "string" }, count: { type: "integer", minimum: 1 } },
        required: ["kind"],
      },
    ],
  };
  expect(validateToolInput(schema, { kind: "b", trigger: "v" }, OPTS)).toBeNull();
  const error = validateToolInput(schema, { kind: "b", trigger: "v", count: 0 }, OPTS);
  expect(error?.repair).not.toHaveProperty("conditionalRequirements");
});
