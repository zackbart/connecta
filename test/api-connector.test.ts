import { describe, expect, it, vi } from "vitest";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { createMetaTools } from "../src/meta-tools.js";
import { api } from "../src/connectors/api.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import type { Logger } from "../src/types.js";
import { connectorContext as ctx } from "./fixtures/misc.js";
import { activitySink, makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

function makeApi() {
  return api("resend", {
    description: "Send email via Resend",
    tools: [
      {
        name: "send_email",
        description: "Send an email",
        inputSchema: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
        },
        outputSchema: {
          type: "object",
          properties: { queued: { type: "boolean" } },
          required: ["queued"],
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
          destructiveHint: true,
        },
        handler: async (args: { to: string }, c) => {
          return { queued: true, to: args.to, base: c.baseUrl };
        },
      },
      {
        name: "boom",
        description: "Always throws",
        annotations: { readOnlyHint: true },
        handler: () => {
          throw new Error("handler exploded");
        },
      },
      {
        name: "async_boom",
        description: "An async handler that throws before its first await",
        annotations: { readOnlyHint: true },
        handler: async () => {
          throw new Error("async handler exploded");
        },
      },
    ],
  });
}

describe("api() connector", () => {
  it("refuses duplicate names before discovery and dispatch can disagree about safety", () => {
    expect(() =>
      api("ambiguous", {
        tools: [
          { name: "same", description: "Read a value", annotations: { readOnlyHint: true }, handler: () => null },
          { name: "same", description: "Write a value", annotations: { readOnlyHint: false }, handler: () => null },
        ],
      }),
    ).toThrow('api() tool "ambiguous.same" is declared more than once');
  });

  it("handler throw surfaces to the caller in connecta's words (call_tool wraps it as isError)", async () => {
    // A plain Error may be a runtime's account of what the handler read, so
    // its text is withheld; a handler means its words with ConnectorCallError.
    const c = makeApi();
    const thrown = (await c.callTool("boom", {}, ctx()).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(thrown.message).toMatch(/Connector "resend" tool "boom" handler failed \(Error\)/);
    expect(thrown.message).not.toContain("handler exploded");
    expect(thrown.cause).toBeUndefined();
  });

  it("an async handler that throws immediately never goes briefly unhandled", async () => {
    // callTool awaits the handler rather than returning its promise. Returning
    // it leaves the rejection handler-less for the thenable-adoption
    // microtask, which workerd and vitest both report as an unhandled
    // rejection even though the caller catches it.
    //
    // .then(null, handler) attaches synchronously; expect(...).rejects
    // attaches a microtask later, which is the very gap under test — the same
    // guard test/credentials.test.ts uses for the same reason.
    const c = makeApi();
    const thrown = await c.callTool("async_boom", {}, ctx()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(thrown?.message).toContain('tool "async_boom" handler failed');
  });
});

describe("api() argument validation", () => {
  it("rejects args that miss the schema with a non-retryable invalid_args", async () => {
    const c = makeApi();
    const err = await c
      .callTool("send_email", { to: 42 }, ctx())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorCallError);
    const typed = err as ConnectorCallError;
    expect(typed.code).toBe("invalid_args");
    expect(typed.retryable).toBe(false);
    expect(typed.message).toContain("resend.send_email");
    expect(typed.message).toContain("/to");
  });

  it("a schema that only fails on first use rejects the call, never passes through", async () => {
    const warn = vi.fn();
    const logger: Logger = { ...silentLogger, warn };
    const c = api("refy", {
      tools: [
        {
          name: "broken_schema",
          description: "Carries an unresolvable $ref",
          annotations: { readOnlyHint: true },
          // Unresolvable $ref — @cfworker/json-schema resolves lazily, so this
          // compiles at construction and only blows up on the first
          // validate(). It fails the call rather than reaching the handler.
          inputSchema: {
            type: "object",
            properties: { x: { $ref: "#/definitions/missing" } },
          },
          handler: (args: { x: unknown }) => ({ got: args.x }),
        },
      ],
    });
    const err = await c
      .callTool("broken_schema", { x: 1 }, { ...ctx(), logger })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorCallError);
    const typed = err as ConnectorCallError;
    expect(typed.code).toBe("invalid_args");
    expect(typed.retryable).toBe(false);
    expect(typed.message).toContain("refy.broken_schema");
    expect(warn).toHaveBeenCalledTimes(1);
    // Named by its catalog entry, never the caller's address (INV-6).
    expect(required(warn.mock.calls[0])[1]).toMatchObject({ connector: "refy", tool: "broken_schema" });
  });
});

describe("api() construction contract", () => {
  it.each([
    [
      "refuses a tool with no description",
      () =>
        api("acme", {
          tools: [{ name: "nameless", description: "", annotations: { readOnlyHint: true }, handler: () => null }],
        }),
      /acme\.nameless.*non-empty description/s,
    ],
    // A JS deployment can reach these; TypeScript refuses them outright.
    [
      "refuses a tool with no explicit readOnlyHint",
      () =>
        api("acme", {
          tools: [
            {
              name: "unclassified",
              description: "Do something of unknown safety",
              annotations: { destructiveHint: true } as never,
              handler: () => null,
            },
          ],
        }),
      /acme\.unclassified.*annotations\.readOnlyHint/s,
    ],
    [
      "refuses a schema the validator cannot compile",
      () =>
        api("acme", {
          tools: [
            {
              name: "clashing_ids",
              description: "Declares the same $id twice",
              annotations: { readOnlyHint: true },
              inputSchema: {
                $id: "urn:connecta-test:api-clash",
                type: "object",
                $defs: { clash: { $id: "urn:connecta-test:api-clash" } },
              },
              handler: () => null,
            },
          ],
        }),
      /acme\.clashing_ids.*validator cannot use/s,
    ],
  ] as const)("%s", (_name, construct, message) => {
    expect(construct).toThrow(message);
  });
});

describe("api() transport diagnostics", () => {
  it.each(["ECONNREFUSED", "AbortError"])(
    "classifies structured %s without inventing a downstream host",
    async (code) => {
      const connector = api("down", {
        tools: [
          {
            name: "read",
            description: "Read downstream",
            annotations: { readOnlyHint: true },
            handler: async () => {
              throw code === "AbortError"
                ? new DOMException("deadline", "AbortError")
                : new TypeError("fetch failed", { cause: { code, hostname: "private.example" } });
            },
          },
        ],
      });
      const error = await connector.callTool("read", {}, ctx()).catch((error) => error);
      expect(classifyCallError(error)).toMatchObject({
        code: "unavailable",
        retryable: true,
        details: { code: code === "AbortError" ? "timeout" : code },
      });
      expect(classifyCallError(error).details).not.toHaveProperty("host");
    },
  );

  it("INV-9: a write handler's network failure is an unknown outcome, never retryable, and a read's stays unavailable", async () => {
    const failing = (code: string) => async () => {
      throw code === "AbortError"
        ? new DOMException("deadline", "AbortError")
        : new TypeError("fetch failed", { cause: { code } });
    };
    for (const code of ["ECONNREFUSED", "ECONNRESET", "AbortError"]) {
      const connector = api("crm", {
        tools: [
          { name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: failing(code) },
          { name: "write", description: "Write", annotations: { readOnlyHint: false }, handler: failing(code) },
        ],
      });
      const read = await connector.callTool("read", {}, ctx()).catch((error: unknown) => error);
      expect(classifyCallError(read)).toMatchObject({ code: "unavailable", retryable: true });
      const write = await connector.callTool("write", {}, ctx()).catch((error: unknown) => error);
      // A handler may have sent its write before any fetch failed, so even a
      // refused connection proves nothing; a deadline stays a timeout, which
      // the invocation layer reports as write_outcome_unknown.
      expect(classifyCallError(write)).toMatchObject(
        code === "AbortError"
          ? { code: "unavailable", details: { code: "timeout" } }
          : {
              code: "connector_call_failed",
              retryable: false,
              message: expect.stringContaining("Whether the write took effect at crm is unknown"),
            },
      );
    }
  });

});

it("serves guarded API diagnostics in value-mode tool results while activity stays payload-free", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new TypeError("https://user:secret@api.example/private?secret", { cause: { code: "ECONNREFUSED" } }),
    );
  const send = guardedFetch({
    provider: "Example",
    baseUrl: "https://api.example/v1",
    maxResponseBytes: 1024,
    authenticate: () => ({}),
  });
  const connector = api("example", {
    tools: [
      {
        name: "read",
        description: "Read example",
        annotations: { readOnlyHint: true },
        handler: (_args, context) => send({ method: "GET", path: "/private" }, context, (response) => response.json()),
      },
    ],
  });
  const sink = activitySink();
  const registry = makeRegistry([connector]);
  try {
    const result = await createMetaTools(registry, BASE, { activity: sink.activity }).callTool({
      address: "example.read",
      resultMode: "value",
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: true,
        details: { host: "https://api.example", code: "ECONNREFUSED" },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|user/);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ errorCode: "unavailable" });
    expect(JSON.stringify(sink.events)).not.toMatch(/api\.example|ECONNREFUSED|details|secret/);
  } finally {
    fetch.mockRestore();
  }
});
