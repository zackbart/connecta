import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { activitySink, makeRegistry, silentLogger } from "./helpers.js";
import type { JsonSchema } from "../src/types.js";

const BASE = "https://connecta.test";
const SECRET = 'private/+"value-782';
const schema = {
  type: "object" as const,
  properties: {
    config: { type: "object" as const, properties: { password: { type: "string" as const, writeOnly: true } } },
  },
};
const forms = (value: string) => [
  value,
  encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
  new URLSearchParams({ value }).toString().slice(6),
  btoa(value),
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  [...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(kind: "mcp" | "api", privateSchema: JsonSchema = schema) {
  let error = false;
  let padding = "";
  const received: unknown[] = [];
  const echo = (args: unknown) => {
    received.push(structuredClone(args));
    const value = (args as { config: { password: string } }).config.password;
    return `Downstream quoted ${forms(value).join("; ")}${padding}`;
  };
  const tools = [true, false].map((readOnlyHint) => ({
    name: readOnlyHint ? "read" : "write",
    description: "Echo arguments",
    annotations: { readOnlyHint },
    inputSchema: privateSchema,
  }));
  const downstream = httpDownstream((server) => {
    server.registerTool("placeholder", { description: "Advertise tools" }, async () => ({ content: [] }));
  });
  if (kind === "mcp")
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const rpc =
        request.method === "POST"
          ? ((await request.clone().json()) as { id: number; method: string; params?: { arguments?: unknown } })
          : undefined;
      if (rpc?.method === "tools/list")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { resultType: "complete", ttlMs: 60_000, cacheScope: "private", tools },
        });
      if (rpc?.method === "tools/call") {
        const args = rpc.params!.arguments;
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: echo(args) }],
            structuredContent: { echo: forms((args as { config: { password: string } }).config.password), padding },
            ...(error ? { isError: true } : {}),
          },
        });
      }
      return downstream.fetch(request.url, init);
    });
  const connector =
    kind === "mcp"
      ? remoteMcp("echo", { url: downstream.url })
      : api("echo", {
          tools: tools.map((tool) => ({
            ...tool,
            handler: async (args: unknown) => {
              const text = echo(args);
              if (error)
                throw new ConnectorCallError("invalid_args", text, {
                  cause: new Error(text),
                  retryAfterMs: 100,
                });
              return { text, echo: forms((args as { config: { password: string } }).config.password), padding };
            },
          })),
        });
  return {
    connector,
    received,
    fail: (value: boolean) => {
      error = value;
    },
    pad: () => {
      padding = "x".repeat(8_000);
    },
  };
}

it.each(["mcp", "api"] as const)(
  "INV-5 INV-6: %s nested writeOnly echoes are redacted on direct and execute_code result/error exits",
  async (kind) => {
    const source = fixture(kind);
    const record = vi.fn();
    const activity = activitySink();
    const registry = makeRegistry([source.connector], {
      logger: { debug: record, info: record, warn: record, error: record },
    });
    const meta = createMetaTools(registry, BASE, { trust: "trusted", activity: activity.activity });
    for (const value of [SECRET, "q"]) {
      const args = { config: { password: value } };
      for (const failed of [false, true]) {
        source.fail(failed);
        const check = (result: unknown) => {
          const text = JSON.stringify(result);
          if (value === SECRET) for (const form of forms(value)) expect(text).not.toContain(form);
          else {
            expect(text).not.toContain("Downstream quoted");
            expect(text).not.toContain(btoa(value));
          }
          expect(text).toContain(value === "q" && failed ? "detail withheld" : "[redacted]");
        };
        for (const resultMode of ["mcp", "value"] as const) {
          const read = await meta.callTool({ address: "echo.read", args, resultMode });
          const write = await meta.callDestructiveTool({
            address: "echo.write",
            args,
            reason: "Redaction regression",
            resultMode,
          });
          expect(read.isError === true, JSON.stringify(read)).toBe(failed);
          expect(write.isError === true).toBe(failed);
          if (failed) {
            expect(read.structuredContent!.error).toMatchObject({
              code: kind === "api" ? "invalid_args" : "connector_call_failed",
              retryable: false,
            });
            expect(write.structuredContent!.error).toMatchObject({
              code: kind === "api" ? "invalid_args" : "connector_call_failed",
              retryable: false,
            });
            if (kind === "api") expect(read.structuredContent!.error).toMatchObject({ retryAfterMs: 100 });
          }
          check(read);
          check(write);
        }
        for (const tool of ["read", "write"]) {
          const run = createExecuteTool(
            registry,
            BASE,
            {
              execute: async (_code, providers) => {
                try {
                  const result = await providers[0]!.fns.call!(`echo.${tool}`, args);
                  return { result, logs: [JSON.stringify(result)] };
                } catch (error) {
                  const failure = error as Error;
                  return { result: undefined, error: failure.message, logs: [JSON.stringify(error)] };
                }
              },
            },
            silentLogger,
            activity.activity,
            { trust: "trusted" },
          );
          const result = await run({ code: "async () => {}" });
          expect(result.isError === true).toBe(failed);
          check(result);
        }
      }
    }
    expect(source.received).toHaveLength(24);
    expect(source.received.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => ({ config: { password: SECRET } })));
    expect(source.received.slice(12)).toEqual(Array.from({ length: 12 }, () => ({ config: { password: "q" } })));
    expect(JSON.stringify([record.mock.calls, activity.events])).not.toContain(SECRET);
    expect(JSON.stringify([record.mock.calls, activity.events])).not.toContain("Downstream quoted");
  },
);

it.each(["mcp", "api"] as const)(
  "INV-5: %s oversized writeOnly results are redacted before stash persistence and later paging",
  async (kind) => {
    const source = fixture(kind);
    source.pad();
    const storage = memoryStorage();
    const registry = makeRegistry([source.connector], { storage, maxResultBytes: 1_024 });
    const stash = vi.spyOn(registry, "stashResult");
    const result = await createMetaTools(registry, BASE).callTool({
      address: "echo.read",
      args: { config: { password: SECRET } },
      resultMode: "value",
    });
    const notice = result.structuredContent!.data as { resultId: string };
    expect(notice.resultId).toBeTypeOf("string");
    expect(stash).toHaveBeenCalledOnce();
    const chunks = stash.mock.calls[0]![1];
    const persisted = chunks
      .map((chunk, index) => atob(index === 0 ? chunk.slice(chunk.lastIndexOf(":") + 1) : chunk))
      .join("");
    for (const form of forms(SECRET)) expect(persisted).not.toContain(form);
    expect(persisted).toContain("[redacted]");
    let body = "";
    let offset = 0;
    for (;;) {
      // A new request has no private argument matcher. The stored bytes must be safe.
      const page = await createMetaTools(registry, BASE).readResult({ id: notice.resultId, offset, maxBytes: 1_024 });
      const [header, ...text] = page.content[0]!.text.split("\n");
      body += text.join("\n");
      const paging = JSON.parse(header!) as { hasMore: boolean; nextOffset: number };
      if (!paging.hasMore) break;
      offset = paging.nextOffset;
    }
    expect(body).toBe(persisted);
  },
);

it("INV-5: private argument collection follows references, array items and conservative sensitivity without changing public schemas", () => {
  for (const inputSchema of [
    {
      type: "object",
      $defs: { private: { writeOnly: true } },
      properties: { config: { properties: { password: { $ref: "#/$defs/private" } } } },
    },
    { type: "object", properties: { config: { writeOnly: true } } },
    {
      type: "object",
      oneOf: [
        { properties: { config: { properties: { password: { writeOnly: true } } } } },
        { properties: { config: {} } },
      ],
    },
    { type: "object", additionalProperties: { properties: { password: { writeOnly: true } } } },
    { type: "object", properties: { configs: { items: { properties: { password: { writeOnly: true } } } } } },
  ]) {
    const secrets = new SentSecrets();
    secrets.arguments({ config: { password: SECRET }, configs: [{ password: SECRET }] }, inputSchema);
    expect(secrets.text(SECRET)).toBe("[redacted]");
  }
  for (const inputSchema of [
    undefined,
    {},
    { $ref: "https://schemas.test/public" },
    { properties: { config: { properties: { password: { writeOnly: false } } } } },
  ]) {
    const secrets = new SentSecrets();
    expect(secrets.arguments({ config: { password: "q" } }, inputSchema)).toBe(false);
    expect(secrets.text(SECRET)).toBe(SECRET);
  }
});

it("INV-5: writeOnly output protection keeps subsequent submitted arguments intact and still blocks credential exfiltration", async () => {
  const received: unknown[] = [];
  const connector = api("sequence", {
    tools: [
      {
        name: "echo",
        description: "Echo private arguments",
        inputSchema: schema,
        annotations: { readOnlyHint: true },
        handler: async (args: unknown) => {
          received.push(args);
          return args;
        },
      },
    ],
  });
  const registry = makeRegistry([connector]);
  const run = createExecuteTool(
    registry,
    BASE,
    {
      execute: async (_code, providers) => {
        const call = providers[0]!.fns.call!;
        const args = { config: { password: SECRET } };
        await call("sequence.echo", args);
        return { result: await call("sequence.echo", args) };
      },
    },
    silentLogger,
  );
  const result = await run({ code: "async () => {}" });
  expect(received).toEqual(Array.from({ length: 2 }, () => ({ config: { password: SECRET } })));
  expect(JSON.stringify(result)).not.toContain(SECRET);
  const secrets = new SentSecrets();
  secrets.arguments({ config: { password: SECRET } }, schema);
  const request = new SentSecrets();
  request.include(secrets);
  expect(request.redactInput(SECRET)).toBe(SECRET);
  secrets.add(SECRET);
  expect(request.redactInput(SECRET)).toBe("[redacted]");
});

it.each(["mcp", "api"] as const)(
  "INV-5: %s tools without writeOnly fields preserve ordinary downstream diagnostics and results",
  async (kind) => {
    const source = fixture(kind, { type: "object" });
    const registry = makeRegistry([source.connector]);
    const meta = createMetaTools(registry, BASE);
    for (const failed of [false, true]) {
      source.fail(failed);
      const args = { config: { password: "q" } };
      const result = await meta.callTool({ address: "echo.read", args, resultMode: "value" });
      expect(result.isError === true).toBe(failed);
      if (failed || kind === "api") expect(JSON.stringify(result)).toContain("Downstream quoted q");
      else expect(result.structuredContent!.data).toEqual({ echo: forms("q"), padding: "" });
      expect(JSON.stringify(result)).not.toContain("[redacted]");
    }
  },
);
