import { describe, expect, it } from "vitest";
import {
  classifyCallError,
  ConnectorCallError,
  echoedCallArgs,
  framingError,
  networkErrorCode,
  unavailableCallError,
} from "../src/errors.js";
import type { JsonSchema } from "../src/types.js";
import { PRIVATE_MARKER } from "./fixtures/private-arguments.js";

describe("sensitive argument echoes", () => {
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

  it("keeps public-only alternative and dynamic-property schemas intact (INV-5)", () => {
    const schema = {
      oneOf: [{ properties: { mode: { const: "one" } } }, { properties: { mode: { const: "two" } } }],
      patternProperties: { ".*": { type: "string" } },
      additionalProperties: { type: "string" },
    };
    const args = { mode: "one", public: "value" };
    expect(echoedCallArgs(args, schema)).toEqual({ args });
  });
  it("preserves JSON serialization of public values in partial snapshots (INV-5)", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(echoedCallArgs({ date }, {})).toEqual({ args: { date: date.toJSON() } });
    expect(
      echoedCallArgs(
        { config: { date, password: "private" } },
        { properties: { config: { properties: { password: { writeOnly: true } } } } },
      ),
    ).toEqual({ args: { config: { date: date.toJSON() } }, argsRedacted: true });
  });

  it("keeps complete public echoes and snapshots partial echoes (INV-5, INV-9)", () => {
    const schema = { properties: { public: { writeOnly: false }, private: { writeOnly: true } } };
    expect(echoedCallArgs({ public: "original" }, schema)).toEqual({ args: { public: "original" } });
    const args = { public: "original", private: "secret" };
    const echoed = echoedCallArgs(args, schema);
    args.public = "mutated";
    expect(echoed).toEqual({ args: { public: "original" }, argsRedacted: true });
    expect(echoedCallArgs({ ...args, public: "x".repeat(600) }, schema)).toEqual({ argsRedacted: true });
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

  it("keeps only the request's own abort reason as cause", () => {
    const controller = new AbortController();
    const reason = new Error("owner left");
    controller.abort(reason);
    expect(unavailableCallError(reason, undefined, undefined, controller.signal).cause).toBe(reason);
    expect(unavailableCallError(new Error("other"), undefined, undefined, controller.signal).cause).toBeUndefined();
    expect(unavailableCallError(reason).cause).toBeUndefined();
  });
});

describe("classifyCallError", () => {
  it("treats a typed error as authoritative — no message sniffing", () => {
    // The motivating bug: legitimate error text mentioning "timeout" must not
    // be reclassified as a retryable timeout when the connector typed it.
    const details = classifyCallError(new ConnectorCallError("invalid_args", 'invalid field: "timeout"'));
    expect(details).toEqual({
      code: "invalid_args",
      message: 'invalid field: "timeout"',
      retryable: false,
    });
  });

  it("bounds validation issue count and fields in the typed constructor", () => {
    const details = classifyCallError(
      new ConnectorCallError("invalid_args", "invalid", {
        validation: {
          issues: Array.from({ length: 10 }, (_, index) => ({
            path: `/${"p".repeat(300)}${index}`,
            code: "c".repeat(100),
            expected: "e".repeat(300),
            received: "r".repeat(100),
          })),
        },
      }),
    );
    expect(details.validation?.truncated).toBe(true);
    expect(details.validation?.issues.length).toBeLessThanOrEqual(8);
    expect(new TextEncoder().encode(JSON.stringify(details.validation)).length).toBeLessThanOrEqual(4096);
    expect(details.validation?.issues[0]?.path.length).toBeLessThanOrEqual(256);
    expect(details.validation?.issues[0]?.expected.length).toBeLessThanOrEqual(256);
    expect(details.validation?.issues[0]?.received?.length).toBeLessThanOrEqual(64);
    // The keyword is accepted from custom connectors but no longer returned.
    expect(details.validation?.issues[0]).not.toHaveProperty("code");
    expect(details).not.toHaveProperty("repair");
  });

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

  it("drops oversized and opaque origins instead of clipping them", () => {
    for (const host of ["https://" + "a".repeat(254) + ".test/private", "data:text/plain,secret", "file:///private"]) {
      expect(
        classifyCallError(
          new ConnectorCallError("unavailable", "x", {
            details: { host, code: "timeout" },
          }),
        ),
      ).toHaveProperty("details", { code: "timeout" });
    }
  });
});

it("reads runtime codes without consulting messages or unstructured causes", () => {
  expect(networkErrorCode(Object.assign(new Error("private"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
  expect(networkErrorCode(new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }))).toBe(
    "UND_ERR_CONNECT_TIMEOUT",
  );
  expect(networkErrorCode(new DOMException("deadline", "TimeoutError"))).toBe("timeout");
  for (const error of [
    new Error("ECONNREFUSED timeout"),
    new Error("fetch failed", { cause: "ENOTFOUND" }),
    { code: "https://secret/private" },
  ]) {
    expect(networkErrorCode(error)).toBeUndefined();
  }
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
