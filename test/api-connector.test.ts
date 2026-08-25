import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import type { Logger } from "../src/types.js";
import { connectorContext as ctx } from "./fixtures/misc.js";
import { required, silentLogger } from "./helpers.js";

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
  it("kind is 'api' and description is preserved", () => {
    const c = makeApi();
    expect(c.id).toBe("resend");
    expect(c.kind).toBe("api");
    expect(c.description).toBe("Send email via Resend");
  });

  it("passes maxResultBytes through, and leaves it unset by default", () => {
    expect(makeApi().maxResultBytes).toBeUndefined();
    const capped = api("docs", {
      description: "Docs",
      maxResultBytes: 200_000,
      tools: [
        {
          name: "fetch",
          description: "Fetch a document",
          annotations: { readOnlyHint: true },
          handler: () => null,
        },
      ],
    });
    expect(capped.maxResultBytes).toBe(200_000);
  });

  it("passes callAdmission through, and leaves it unset by default", () => {
    expect(makeApi().callAdmission).toBeUndefined();
    const callAdmission = { rules: [{ maxConcurrency: 2 }] } as const;
    const limited = api("docs", {
      description: "Docs",
      callAdmission,
      tools: [
        {
          name: "fetch",
          description: "Fetch a document",
          annotations: { readOnlyHint: true },
          handler: () => null,
        },
      ],
    });
    expect(limited.callAdmission).toBe(callAdmission);
  });

  it("passes usageGuide through, and leaves it unset by default", () => {
    expect(makeApi().usageGuide).toBeUndefined();
    const guide = "# Resend usage\n\nAlways set a verified `from`.\n";
    const guided = api("resend", {
      description: "Send email via Resend",
      usageGuide: guide,
      tools: [
        {
          name: "noop",
          description: "Do nothing",
          annotations: { readOnlyHint: true },
          handler: () => null,
        },
      ],
    });
    expect(guided.usageGuide).toBe(guide);
    const structured = {
      content: guide,
      summary: "Verified sender requirements.",
      required: true,
    } as const;
    expect(
      api("structured", {
        usageGuide: structured,
        tools: [
          {
            name: "noop",
            description: "Do nothing",
            annotations: { readOnlyHint: true },
            handler: () => null,
          },
        ],
      }).usageGuide,
    ).toBe(structured);
  });

  it("listTools returns the declared tool defs (name/description/schema)", async () => {
    const c = makeApi();
    const tools = await c.listTools(ctx());
    expect(tools.map((t) => t.name)).toEqual([
      "send_email",
      "boom",
      "async_boom",
    ]);
    const send = tools.find((t) => t.name === "send_email")!;
    expect(send.description).toBe("Send an email");
    expect((send.inputSchema as any).properties.to.type).toBe("string");
    expect((send.outputSchema as any).properties.queued.type).toBe("boolean");
    expect(send.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
    });
  });

  it("callTool dispatches to the right handler with args + ctx", async () => {
    const c = makeApi();
    const result = await c.callTool("send_email", { to: "a@b.c" }, ctx());
    expect(result).toEqual({ queued: true, to: "a@b.c", base: BASE });
  });

  it("callTool defaults args to {} when omitted", async () => {
    let seen: unknown;
    const c = api("x", {
      tools: [
        {
          name: "peek",
          description: "Report the arguments it received",
          annotations: { readOnlyHint: true },
          handler: (args) => ((seen = args), null),
        },
      ],
    });
    await c.callTool("peek", undefined, ctx());
    expect(seen).toEqual({});
  });

  it("unknown tool name throws a clear error", async () => {
    const c = makeApi();
    await expect(c.callTool("nope", {}, ctx())).rejects.toThrow(
      /Unknown tool "nope" on connector "resend"/,
    );
  });

  it("handler throw surfaces to the caller (call_tool wraps it as isError)", async () => {
    const c = makeApi();
    await expect(c.callTool("boom", {}, ctx())).rejects.toThrow(
      /handler exploded/,
    );
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
    const thrown = await c
      .callTool("async_boom", {}, ctx())
      .then(() => null, (e: unknown) => e as Error);
    expect(thrown?.message).toContain("async handler exploded");
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
    expect(typed.message).toContain('resend.send_email');
    expect(typed.message).toContain("/to");
  });

  it("rejects omitted args when the schema has required fields", async () => {
    const c = makeApi();
    await expect(
      c.callTool("send_email", undefined, ctx()),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("valid args reach the handler unchanged", async () => {
    const c = makeApi();
    const result = await c.callTool("send_email", { to: "a@b.c" }, ctx());
    expect(result).toEqual({ queued: true, to: "a@b.c", base: BASE });
  });

  it("tools without an inputSchema stay pass-through", async () => {
    let seen: unknown;
    const c = api("x", {
      tools: [
        {
          name: "peek",
          description: "Report the arguments it received",
          annotations: { readOnlyHint: true },
          handler: (args) => ((seen = args), null),
        },
      ],
    });
    await c.callTool("peek", { anything: true }, ctx());
    expect(seen).toEqual({ anything: true });
  });

  it("validateArgs: false restores the pre-validation pass-through", async () => {
    const c = api("loose", {
      validateArgs: false,
      tools: [
        {
          name: "coerce",
          description: "Accept a loosely typed page number",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { page: { type: "integer" } },
            required: ["page"],
          },
          handler: (args: { page: unknown }) => ({ got: args.page }),
        },
      ],
    });
    expect(await c.callTool("coerce", { page: "3" }, ctx())).toEqual({
      got: "3",
    });
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
    expect(required(warn.mock.calls[0])[0]).toContain("refy.broken_schema");
  });
});

describe("api() construction contract", () => {
  it("refuses a tool with no description", () => {
    expect(() =>
      api("acme", {
        tools: [
          {
            name: "nameless",
            description: "",
            annotations: { readOnlyHint: true },
            handler: () => null,
          },
        ],
      }),
    ).toThrow(/acme\.nameless.*non-empty description/s);
  });

  it("refuses a tool whose description is only whitespace", () => {
    expect(() =>
      api("acme", {
        tools: [
          {
            name: "blank",
            description: "   \n",
            annotations: { readOnlyHint: true },
            handler: () => null,
          },
        ],
      }),
    ).toThrow(/acme\.blank/);
  });

  it("refuses a tool with no explicit readOnlyHint", () => {
    expect(() =>
      api("acme", {
        tools: [
          {
            name: "unclassified",
            description: "Do something of unknown safety",
            // A JS deployment can reach this; TypeScript refuses it outright.
            annotations: { destructiveHint: true } as never,
            handler: () => null,
          },
        ],
      }),
    ).toThrow(/acme\.unclassified.*annotations\.readOnlyHint/s);
  });

  it("never infers a classification from the tool name or description", () => {
    expect(() =>
      api("acme", {
        tools: [
          {
            name: "list_things",
            description: "List things. Reads only, honest.",
            annotations: {} as never,
            handler: () => [],
          },
        ],
      }),
    ).toThrow(/annotations\.readOnlyHint/);
  });

  it("refuses a schema the validator cannot compile", () => {
    expect(() =>
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
    ).toThrow(/acme\.clashing_ids.*validator cannot use/s);
  });

  it("checks the schema even when validateArgs is off", () => {
    // Opting out of enforcement is not opting out of the schema being real:
    // the catalog still publishes it, and an agent still writes against it.
    expect(() =>
      api("acme", {
        validateArgs: false,
        tools: [
          {
            name: "clashing_ids",
            description: "Declares the same $id twice",
            annotations: { readOnlyHint: true },
            inputSchema: {
              $id: "urn:connecta-test:api-clash-loose",
              type: "object",
              $defs: { clash: { $id: "urn:connecta-test:api-clash-loose" } },
            },
            handler: () => null,
          },
        ],
      }),
    ).toThrow(/acme\.clashing_ids/);
  });

  it("accepts an explicit readOnlyHint: false as the destructive declaration", () => {
    const c = api("acme", {
      tools: [
        {
          name: "delete_thing",
          description: "Delete a thing",
          annotations: { readOnlyHint: false, destructiveHint: true },
          handler: () => ({ deleted: true }),
        },
      ],
    });
    expect(required(c.staticTools?.[0]).annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});
