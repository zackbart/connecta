import { describe, expect, it } from "vitest";
import { privateArgumentCases, PRIVATE_MARKER } from "./fixtures/private-arguments.js";
import type { JsonSchema } from "../src/types.js";
import {
  classifyCallError,
  ConnectorCallError,
  framingError,
  unavailableCallError,
  WithheldTextError,
  echoedCallArgs,
} from "../src/errors.js";

describe("sensitive argument echoes", () => {
  it.each(privateArgumentCases)("filters or withholds $name echoes (INV-5)", ({ schema, args, echo }) => {
    const before = JSON.stringify(args);
    const echoed = echoedCallArgs(args, schema);
    expect(echoed).toEqual(echo);
    expect(JSON.stringify(echoed)).not.toContain(PRIVATE_MARKER);
    expect(JSON.stringify(args)).toBe(before);
  });

  it("fails closed on schema traversal limits (INV-5)", () => {
    let schema: JsonSchema = { writeOnly: true };
    let args: unknown = PRIVATE_MARKER;
    for (let i = 0; i < 40; i++) {
      schema = { properties: { child: schema } };
      args = { child: args };
    }
    expect(echoedCallArgs(args, schema)).toEqual({ argsRedacted: true });
    const wide = { properties: Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [String(i), {}])) };
    expect(echoedCallArgs({ secret: PRIVATE_MARKER }, wide)).toEqual({ argsRedacted: true });
  });

  it.each([["over-budget", "large-secret-value".repeat(100)]])("omits %s writeOnly input fields before budgeting, independent of value length (INV-5)", (_label, secretValue) => {
    const args = { project: "p1", secretValue };
    const schema = { properties: { project: { type: "string" }, secretValue: { type: "string", writeOnly: true } } };
    const echoed = echoedCallArgs(args, schema);
    expect(echoed).toEqual({ args: { project: "p1" }, argsRedacted: true });
    expect(args.secretValue).toBe(secretValue);
  });

});

describe("WithheldTextError", () => {
  it.each([
    ["Dynamic Client Registration rejected (HTTP 503): secret", "fallback", false],
  ] as const)("classifies %j as the original would have been", (text, code, retryable) => {
    const original = new Error(text);
    const withheld = new WithheldTextError("connecta's words", original);
    for (const fallback of ["connector_call_failed", "catalog_lookup_failed"] as const) {
      expect(classifyCallError(withheld, fallback)).toEqual({
        code: code === "fallback" ? fallback : code,
        message: "connecta's words",
        retryable,
      });
      expect(classifyCallError(withheld, fallback)).toEqual({
        ...classifyCallError(original, fallback),
        message: "connecta's words",
      });
    }
    expect(withheld.cause).toBeUndefined();
    expect(JSON.stringify({ ...withheld })).not.toContain("secret");
  });
});

describe("unavailableCallError", () => {
  it("keeps the errno and origin and drops the runtime's error (#695)", () => {
    const runtime = new TypeError("fetch failed https://h.example/p?token=secret", {
      cause: { code: "ECONNRESET", message: "secret" },
    });
    const error = unavailableCallError(runtime, "https://h.example/p?token=secret");
    expect(error.cause).toBeUndefined();
    expect(error.details).toEqual({ host: "https://h.example", code: "ECONNRESET" });
    expect(JSON.stringify(classifyCallError(error))).not.toContain("secret");
  });

});

describe("ConnectorCallError", () => {
  it("defaults retryable per code", () => {
    expect(new ConnectorCallError("timeout", "x").retryable).toBe(true);
    expect(new ConnectorCallError("rate_limited", "x").retryable).toBe(true);
    expect(new ConnectorCallError("unavailable", "x").retryable).toBe(true);
    expect(new ConnectorCallError("auth_required", "x").retryable).toBe(false);
    expect(new ConnectorCallError("invalid_args", "x").retryable).toBe(false);
    expect(new ConnectorCallError("not_found", "x").retryable).toBe(false);
    expect(new ConnectorCallError("connector_call_failed", "x").retryable).toBe(false);
  });

});

describe("classifyCallError", () => {
  it("INV-6: untyped prose never decides code or retryability", () => {
    expect(classifyCallError(new Error("request timed out"))).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(classifyCallError(new Error("HTTP 503"))).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(classifyCallError(new Error("no such record"))).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
  });

});

describe("framingError", () => {
  it("pins the policy codes non-retryable however the address reads", () => {
    // The message embeds the address, and the heuristic matches 503/429/
    // temporar — a connector named for a transient failure must not turn a
    // refusal that can never succeed into one a caller is told to retry.
    for (const code of [
      "unknown_address",
      "unknown_tool",
      "ambiguous_tool_alias",
      "destructive_tool_requires_approval",
      "result_processing_failed",
    ] as const) {
      expect(framingError(code, `Unknown address "temporary-503-service.read"`)).toEqual({
        code,
        message: 'Unknown address "temporary-503-service.read"',
        retryable: false,
      });
    }
  });

});

describe("unavailable diagnostics", () => {
  it("sanitizes and forwards only bounded origin and runtime code fields", () => {
    const error = new ConnectorCallError("unavailable", "unreachable", {
      details: { host: "https://user:password@example.com:8443/private?q=secret#fragment", code: "ECONNREFUSED" },
    });
    expect(classifyCallError(error)).toEqual({
      code: "unavailable",
      message: "unreachable",
      retryable: true,
      details: { host: "https://example.com:8443", code: "ECONNREFUSED" },
    });
  });

  it.each(["ECONNREFUSED secret"])(
    "drops invalid diagnostic code %s",
    (code) => {
      expect(
        classifyCallError(
          new ConnectorCallError("unavailable", "x", {
            details: { host: "not a URL", code },
          }),
        ),
      ).not.toHaveProperty("details");
    },
  );

});

it("INV-6: runtime facts classify transport errors independently of prose", () => {
  for (const message of ["safe", "timeout temporarily rate limit 429 503"]) {
    expect(classifyCallError(Object.assign(new Error(message), { code: "ECONNRESET" }))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(classifyCallError(Object.assign(new Error(message), { code: "ETIMEDOUT" }))).toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(classifyCallError(new Error(message))).toMatchObject({ code: "connector_call_failed", retryable: false });
  }
});
