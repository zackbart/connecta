import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import type { ConnectorContext } from "../src/types.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

function ctx(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: BASE };
}

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
        handler: () => {
          throw new Error("handler exploded");
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

  it("listTools returns the declared tool defs (name/description/schema)", async () => {
    const c = makeApi();
    const tools = await c.listTools(ctx());
    expect(tools.map((t) => t.name)).toEqual(["send_email", "boom"]);
    const send = tools.find((t) => t.name === "send_email")!;
    expect(send.description).toBe("Send an email");
    expect((send.inputSchema as any).properties.to.type).toBe("string");
    expect((send.outputSchema as any).properties.queued.type).toBe("boolean");
    expect(send.annotations).toEqual({
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
      tools: [{ name: "peek", handler: (args) => ((seen = args), null) }],
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
});
