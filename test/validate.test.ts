import { describe, expect, it } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import type { JsonSchema } from "../src/types.js";
import { normalizeToolInput, validateToolInput } from "../src/validate.js";
import { spyLogger } from "./fixtures/misc.js";
import { silentLogger } from "./helpers.js";

const OPTS = { address: "acme.create_note", logger: silentLogger };

describe("validateToolInput", () => {
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
    // Optional in-process properties behave like omitted JSON properties,
    // including inside arrays. A bad instance must not disable this schema.
    const optional: JsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        cursor: { type: "string" },
        rows: { type: "array", items: schema },
      },
      required: ["title"],
    };
    const valid = Object.freeze({
      title: "Minutes",
      cursor: undefined,
      extra: undefined,
      rows: [Object.freeze({ mode: "basic", apiKey: undefined, surprise: undefined })],
    });
    const throwing = {
      get title(): string {
        throw new Error("Input getter failed.");
      },
    };
    for (const [input, accepted] of [
      [valid, true],
      [{ title: undefined }, false],
      [{ title: 1n }, false],
      [valid, true],
      [throwing, false],
      [valid, true],
      [{ title: 42 }, false],
      [valid, true],
    ] as const) {
      const result = validateToolInput(optional, input, { ...OPTS, failClosed: true });
      if (accepted) expect(result).toBeNull();
      else expect(result?.code).toBe("invalid_args");
    }
    expect(Object.hasOwn(valid, "cursor")).toBe(true);
    class Instance {
      optional = undefined;
      get value(): never {
        throw new Error("Do not traverse class instances.");
      }
    }
    for (const value of [new Uint8Array([1, 2, 3]), new Date(0), new Instance()]) {
      expect(normalizeToolInput(value)).toBe(value);
      const input = { value, rows: [{ value, optional: undefined }], optional: undefined };
      const normalized = normalizeToolInput(input);
      expect(normalized).not.toBe(input);
      expect(normalized.value).toBe(value);
      expect(normalized.rows[0]?.value).toBe(value);
      expect(normalized).not.toHaveProperty("optional");
      expect(normalized.rows[0]).not.toHaveProperty("optional");
      expect(Object.hasOwn(input, "optional")).toBe(true);
    }
    const plain = Object.assign(Object.create(null), { value: "kept", optional: undefined });
    const normalized = normalizeToolInput({ rows: [plain, undefined] });
    expect(normalized.rows).toHaveLength(2);
    expect(normalized.rows[1]).toBeUndefined();
    expect(Object.getPrototypeOf(normalized.rows[0])).toBeNull();
    expect(Object.keys(normalized.rows[0])).toEqual(["value"]);
  });
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
