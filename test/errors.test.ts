import { describe, expect, it } from "vitest";
import {
  classifyCallError,
  ConnectorCallError,
  framingError,
} from "../src/errors.js";

describe("ConnectorCallError", () => {
  it("defaults retryable per code", () => {
    expect(new ConnectorCallError("timeout", "x").retryable).toBe(true);
    expect(new ConnectorCallError("rate_limited", "x").retryable).toBe(true);
    expect(new ConnectorCallError("unavailable", "x").retryable).toBe(true);
    expect(new ConnectorCallError("auth_required", "x").retryable).toBe(false);
    expect(new ConnectorCallError("invalid_args", "x").retryable).toBe(false);
    expect(new ConnectorCallError("not_found", "x").retryable).toBe(false);
    expect(new ConnectorCallError("connector_call_failed", "x").retryable).toBe(
      false,
    );
  });

  it("carries not_found through classification without a recovery envelope", () => {
    // The point of the code is that a program can branch on it: it survives
    // classification as itself, non-retryable, with nothing for a caller to
    // recover — the next move is re-addressing, which only the caller can do.
    expect(
      classifyCallError(
        new ConnectorCallError("not_found", "Zone 4 does not exist."),
      ),
    ).toEqual({
      code: "not_found",
      message: "Zone 4 does not exist.",
      retryable: false,
    });
    // And it is not something the message heuristic can mint by accident: an
    // untyped throw whose prose says "not found" is still the generic failure,
    // because provider prose is never parsed to invent a classification.
    expect(classifyCallError(new Error("404 not found"))).toEqual({
      code: "connector_call_failed",
      message: "404 not found",
      retryable: false,
    });
  });

  it("carries an optional retryAfterMs and ignores nonsense values", () => {
    expect(
      new ConnectorCallError("rate_limited", "x", { retryAfterMs: 2_500 })
        .retryAfterMs,
    ).toBe(2_500);
    expect(new ConnectorCallError("rate_limited", "x").retryAfterMs).toBe(
      undefined,
    );
    expect(
      new ConnectorCallError("rate_limited", "x", { retryAfterMs: -1 })
        .retryAfterMs,
    ).toBe(undefined);
    expect(
      new ConnectorCallError("rate_limited", "x", { retryAfterMs: Number.NaN })
        .retryAfterMs,
    ).toBe(undefined);
    expect(
      new ConnectorCallError("rate_limited", "x", { retryAfterMs: 1_200.7 })
        .retryAfterMs,
    ).toBe(1_200);
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

  it("preserves structured validation findings", () => {
    const validation = {
      issues: [{ path: "/title", code: "type", expected: "string" }],
    };
    expect(
      classifyCallError(
        new ConnectorCallError("invalid_args", "invalid title", {
          validation,
        }),
      ),
    ).toEqual({
      code: "invalid_args",
      message: "invalid title",
      retryable: false,
      validation,
    });
  });

  it("bounds validation issue count and fields in the typed constructor", () => {
    const details = classifyCallError(
      new ConnectorCallError("invalid_args", "invalid", {
        validation: {
          issues: Array.from({ length: 5 }, (_, index) => ({
            path: `/${"p".repeat(300)}${index}`,
            code: "c".repeat(100),
            expected: "e".repeat(200),
          })),
        },
      }),
    );
    expect(details.validation?.issues).toHaveLength(3);
    expect(details.validation?.truncated).toBe(true);
    expect(details.validation?.issues[0]?.path.length).toBeLessThanOrEqual(256);
    expect(details.validation?.issues[0]?.code.length).toBeLessThanOrEqual(64);
    expect(
      details.validation?.issues[0]?.expected.length,
    ).toBeLessThanOrEqual(128);
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

  it("round-trips retryAfterMs into the error details, omitting it when unset", () => {
    expect(
      classifyCallError(
        new ConnectorCallError("rate_limited", "slow down", {
          retryAfterMs: 30_000,
        }),
      ),
    ).toEqual({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(
      classifyCallError(new ConnectorCallError("rate_limited", "slow down")),
    ).toEqual({ code: "rate_limited", message: "slow down", retryable: true });
    // The heuristic path has no window to report.
    expect(classifyCallError(new Error("HTTP 429"))).not.toHaveProperty(
      "retryAfterMs",
    );
  });

  it("classifies an aborted call as a retryable timeout", () => {
    // An aborted fetch rejects with a DOMException named AbortError whose text
    // matches neither message heuristic — without the name check it would read
    // as a non-retryable connector_call_failed.
    const aborted = new DOMException("The operation was aborted", "AbortError");
    expect(aborted).toBeInstanceOf(Error);
    expect(classifyCallError(aborted)).toEqual({
      code: "timeout",
      message: "The operation was aborted",
      retryable: true,
    });
    // Runtimes word it differently; the name is what's stable.
    expect(
      classifyCallError(
        new DOMException("This operation was aborted", "AbortError"),
      ),
    ).toMatchObject({ code: "timeout", retryable: true });
    // Same for the reason an AbortController hands its listeners.
    const controller = new AbortController();
    controller.abort();
    expect(classifyCallError(controller.signal.reason)).toMatchObject({
      code: "timeout",
      retryable: true,
    });
    // A connector that typed the failure still wins over the name check.
    expect(
      classifyCallError(
        Object.assign(
          new ConnectorCallError("invalid_args", "bad field", {
            retryable: false,
          }),
          { name: "AbortError" },
        ),
      ),
    ).toMatchObject({ code: "invalid_args", retryable: false });
  });

  it("uses the given fallback code and stringifies non-Error values", () => {
    expect(classifyCallError("boom", "catalog_lookup_failed")).toEqual({
      code: "catalog_lookup_failed",
      message: "boom",
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
    ]) {
      expect(
        framingError(code, `Unknown address "temporary-503-service.read"`),
      ).toEqual({
        code,
        message: 'Unknown address "temporary-503-service.read"',
        retryable: false,
      });
    }
  });

  it("still reads the message for codes it does not frame itself", () => {
    expect(
      framingError("result_processing_failed", "upstream 503 while paging"),
    ).toMatchObject({ retryable: true });
    expect(
      framingError("result_processing_failed", "field shape mismatch"),
    ).toMatchObject({ retryable: false });
  });
});
