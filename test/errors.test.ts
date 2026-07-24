import { describe, expect, it } from "vitest";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";

describe("ConnectorCallError", () => {
  it("defaults retryable per code", () => {
    expect(new ConnectorCallError("timeout", "x").retryable).toBe(true);
    expect(new ConnectorCallError("rate_limited", "x").retryable).toBe(true);
    expect(new ConnectorCallError("unavailable", "x").retryable).toBe(true);
    expect(new ConnectorCallError("auth_required", "x").retryable).toBe(false);
    expect(new ConnectorCallError("invalid_args", "x").retryable).toBe(false);
    expect(new ConnectorCallError("connector_call_failed", "x").retryable).toBe(
      false,
    );
  });

  it("honors an explicit retryable override and keeps the cause", () => {
    const cause = new Error("underlying");
    const err = new ConnectorCallError("timeout", "x", {
      retryable: false,
      cause,
    });
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("ConnectorCallError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("classifyCallError", () => {
  it("treats a typed error as authoritative — no message sniffing", () => {
    // The motivating bug: legitimate error text mentioning "timeout" must not
    // be reclassified as a retryable timeout when the connector typed it.
    const details = classifyCallError(
      new ConnectorCallError("invalid_args", 'invalid field: "timeout"'),
    );
    expect(details).toEqual({
      code: "invalid_args",
      message: 'invalid field: "timeout"',
      retryable: false,
    });
  });

  it("falls back to the message heuristic for plain errors", () => {
    expect(classifyCallError(new Error("request timed out"))).toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(classifyCallError(new Error("HTTP 503"))).toMatchObject({
      code: "connector_call_failed",
      retryable: true,
    });
    expect(classifyCallError(new Error("no such record"))).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
  });

  it("uses the given fallback code and stringifies non-Error values", () => {
    expect(classifyCallError("boom", "catalog_lookup_failed")).toEqual({
      code: "catalog_lookup_failed",
      message: "boom",
      retryable: false,
    });
  });
});
