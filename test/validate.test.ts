import { describe, expect, it } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import type { JsonSchema } from "../src/types.js";
import { exampleWith, normalizeToolInput, validateToolInput } from "../src/validate.js";
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
    expect(err?.validation?.issues).toEqual([
      { path: "/title", expected: "string (required)", received: "missing" },
      { path: "/settings/enabled", expected: "boolean", received: "string" },
      { path: "/settings/retries", expected: "integer", received: "string" },
    ]);
    // Every finding is in the message, so a text-only reader repairs the call in one turn.
    expect(err?.message).toBe(
      'Invalid arguments for "acme.create_note": /title: expected string (required), received missing; ' +
        "/settings/enabled: expected boolean, received string; /settings/retries: expected integer, received string",
    );
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
    expect(err?.validation?.issues).toEqual([
      { path: "/x", expected: 'one of "A"', received: "string" },
      { path: "/x", expected: "absent: the inputSchema forbids this value" },
    ]);
    expect(err?.message).toContain('/x: expected one of "A", received string');
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

it("INV-6: one envelope states every bound, allowed value and accepted key without caller strings", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["fast", "safe"] },
      count: { type: "integer", minimum: 1, maximum: 10 },
      limit: { type: "integer", minimum: 5 },
      pin: { type: "integer", minimum: 1000, writeOnly: true },
    },
    required: ["mode", "count"],
  };
  const error = validateToolInput(
    schema,
    { mode: "caller-secret", count: 20, limit: 4, pin: 7, typo: "another-secret" },
    OPTS,
  );
  expect(error?.validation).toEqual({
    issues: [
      { path: "/mode", expected: 'one of "fast", "safe"', received: "string" },
      // A finding states every constraint its schema position declares, not just the one that failed.
      { path: "/count", expected: "at most 10, at least 1", received: "20" },
      { path: "/limit", expected: "at least 5", received: "4" },
      // A writeOnly position states its type, never the submitted number.
      { path: "/pin", expected: "at least 1000", received: "number" },
      { path: "/typo", expected: "one of the accepted keys: mode, count, limit, pin" },
    ],
    acceptedKeys: ["mode", "count", "limit", "pin"],
    example: { mode: "fast", count: 1 },
  });
  expect(error?.message).toContain("/limit: expected at least 5, received 4");
  expect(error).not.toHaveProperty("repair");
  expect(validateToolInput(schema, error?.validation?.example, OPTS)).toBeNull();
  for (const text of [JSON.stringify(error?.validation), error?.message])
    for (const value of ["caller-secret", "another-secret", ": 7", "received 7"]) expect(text).not.toContain(value);
});

it("INV-6: a legacy repair passed by a custom connector folds into the one envelope", () => {
  const error = new ConnectorCallError("invalid_args", "Bad mode.", {
    validation: { issues: [{ path: "/mode", code: "enum", expected: "fast or safe" }] },
    repair: {
      acceptedKeys: ["mode"],
      issues: [
        { path: "/mode", receivedType: "string", enumValues: ["fast", "safe"] },
        { path: "/size", receivedType: "number", bounds: { maximum: 3 } },
      ],
      example: { mode: "fast" },
    },
  });
  // Its received types and schema facts join the findings; the findings themselves come from validation.
  expect(error.validation).toEqual({
    issues: [{ path: "/mode", expected: "fast or safe", received: "string" }],
    acceptedKeys: ["mode"],
    example: { mode: "fast" },
  });
});

it("INV-6: examples are verified and oversized schema detail is bounded", () => {
  const unsupported: JsonSchema = {
    type: "object",
    properties: { code: { type: "string", pattern: "^CUSTOM-[0-9]{5}$" } },
    required: ["code"],
  };
  const error = validateToolInput(unsupported, {}, OPTS);
  expect(error?.validation).not.toHaveProperty("example");
  expect(error?.validation?.exampleUnavailable).toContain("No valid example");
  const large: JsonSchema = { type: "string", enum: ["e".repeat(10000)] };
  const validation = validateToolInput(large, 1, OPTS)?.validation;
  expect(validation?.truncated).toBe(true);
  expect(JSON.stringify(validation).length).toBeLessThan(4096);
  const wide = new ConnectorCallError("invalid_args", "Wide.", {
    validation: {
      issues: Array.from({ length: 12 }, (_, index) => ({ path: `/p${index}`, expected: "x".repeat(300) })),
      example: { text: "y".repeat(5000) },
    },
  }).validation;
  // Eight findings at most; an example that would break the 4 KiB budget is withheld whole.
  expect(wide?.issues).toHaveLength(8);
  expect(wide).toMatchObject({ truncated: true, exampleUnavailable: expect.stringContaining("budget") });
  expect(new TextEncoder().encode(JSON.stringify(wide)).length).toBeLessThanOrEqual(4096);
});

it("INV-6: recursive schema examples stop before expanding beyond a shared synthesis budget", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, { $ref: "#" }])),
    required: Array.from({ length: 30 }, (_, index) => `p${index}`),
  };
  const error = validateToolInput(schema, {}, OPTS);
  expect(error?.code).toBe("invalid_args");
  expect(error?.validation).not.toHaveProperty("example");
  expect(error?.validation?.exampleUnavailable).toContain("No valid example");
});

it("INV-6: every constraint the repair envelope carried survives in the findings", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      attrs: { type: "object", minProperties: 3, maxProperties: 9 },
      tags: { type: "array", uniqueItems: true, minItems: 3 },
      step: { type: "integer", multipleOf: 5, minimum: 10 },
      code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3 },
      day: { type: "string", format: "date" },
      mode: { type: "string", enum: ["fast", "safe"] },
      kind: { const: "note" },
      size: { type: "integer", minimum: 1, maximum: 4 },
      region: { type: "string" },
    },
    dependentRequired: { tags: ["region"] },
  };
  const findings = [
    { attrs: { a: 1 }, tags: [1, 1], step: 7, code: "ab", day: "never" },
    { mode: 1, kind: "page", size: "big" },
  ].flatMap((args) => validateToolInput(schema, args, OPTS)?.validation?.issues ?? []);
  // One finding per position, stating every constraint it declares.
  expect(findings.map((issue) => issue.path)).toEqual([
    "/region",
    "/attrs",
    "/tags",
    "/step",
    "/code",
    "/day",
    "/mode",
    "/kind",
    "/size",
  ]);
  expect(Object.fromEntries(findings.map((issue) => [issue.path, issue.expected]))).toEqual({
    "/attrs": "at least 3 properties, at most 9 properties",
    "/tags": "at least 3 items, unique items",
    "/step": "at least 10, a multiple of 5",
    "/code": "at least 3 characters, matching ^[A-Z]{3}$",
    "/day": "a date string",
    "/mode": 'string, one of "fast", "safe"',
    "/kind": 'the constant "note"',
    // A type failure still states the position's bounds, as repair's bounds did.
    "/size": "integer, at least 1, at most 4",
    "/region": "string (required with tags)",
  });
  // Without other findings, a property-count bound is never reduced to the generic schema text.
  expect(validateToolInput(schema, { attrs: {} }, OPTS)?.message).toContain(
    "/attrs: expected at least 3 properties, at most 9 properties, received object",
  );
});

it("INV-5 INV-6: a derived example copies no sent value the schema cannot prove safe", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      note: { type: "string" },
      mode: { type: "string", enum: ["fast", "safe"] },
      count: { type: "integer" },
      draft: { type: "boolean" },
      pin: { type: "integer", writeOnly: true },
      body: { type: "object" },
      fields: { type: "array", items: { type: "string" } },
    },
    required: ["note"],
  };
  const args = {
    note: "note-sentinel",
    mode: "fast",
    count: 3,
    draft: true,
    pin: 4242,
    body: { value: "body-sentinel", n: 5 },
    fields: ["bad", "ok"],
  };
  expect(exampleWith(schema, args, [["/fields/0", "omit"]])).toEqual({
    example: {
      note: "<as sent at /note>",
      mode: "fast",
      count: 3,
      draft: true,
      pin: "<as sent at /pin>",
      body: { value: "<as sent at /body/value>", n: "<as sent at /body/n>" },
      fields: ["<as sent at /fields/1>"],
    },
  });
  // Tuple positions resolve through prefixItems; references and alternatives prove nothing.
  const tuple: JsonSchema = {
    type: "object",
    $defs: { mode: { enum: ["fast"] } },
    properties: {
      pair: { type: "array", prefixItems: [{ enum: ["a"] }, { type: "string" }] },
      ref: { $ref: "#/$defs/mode" },
      either: { anyOf: [{ enum: ["x"] }, { type: "string" }] },
      fields: { type: "array" },
    },
  };
  expect(
    exampleWith(tuple, { pair: ["a", "b"], ref: "fast", either: "x", fields: ["bad"] }, [["/fields/0", "omit"]]),
  ).toEqual({
    example: { pair: ["a", "<as sent at /pair/1>"], ref: "fast", either: "<as sent at /either>", fields: [] },
  });
  // A provider's own fix value appears as given.
  expect(exampleWith(schema, { note: "x" }, [["/note", { value: "<note>" }]])).toEqual({ example: { note: "<note>" } });
  // Removing a value that was never sent would repeat the refused call, so there is no example.
  expect(exampleWith(schema, { note: "x" }, [["/mode", "omit"]])).toBeUndefined();
  expect(exampleWith(schema, { note: "x", fields: [] }, [["/fields/0", "omit"]])).toBeUndefined();
  // A corrected call that still fails the schema gives none either.
  expect(exampleWith(schema, { note: "x" }, [["/note", "omit"]])).toBeUndefined();
});
