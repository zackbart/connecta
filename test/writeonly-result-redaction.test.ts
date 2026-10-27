import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { JsonSchema } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { makeRegistry, silentLogger } from "./helpers.js";

beforeEach(() => {
  installOwnedTransport();
});

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

function fixture(
  kind: "mcp" | "api",
  privateSchema: JsonSchema = schema,
  privateValue = (args: unknown) => (args as { config: { password: string } }).config.password,
) {
  let error = false;
  let boundary = false;
  const received: unknown[] = [];
  const echo = (args: unknown) => {
    received.push(structuredClone(args));
    const value = privateValue(args);
    if (boundary) return "x".repeat(1016) + value + "x".repeat(8_000);
    return `Downstream quoted ${forms(value).join("; ")}`;
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
            ...(!boundary ? { structuredContent: { echo: forms(privateValue(args)) } } : {}),
            ...(error ? { isError: true } : {}),
          },
        });
      }
      return downstream.fetch(request.url, init);
    });
  const connector =
    kind === "mcp"
      ? remoteMcp("echo", { url: downstream.url })
      : // No I/O at all, so its ledger sees every request: a refusal it throws
        // stays a known failure, and the program's error keeps its echo.
        tracksEveryRequest(
          api("echo", {
            tools: tools.map((tool) => ({
              ...tool,
              handler: async (args: unknown) => {
                const text = echo(args);
                if (error)
                  throw new ConnectorCallError("invalid_args", text, {
                    cause: new Error(text),
                    retryAfterMs: 100,
                  });
                return boundary ? text : { text, echo: forms(privateValue(args)) };
              },
            })),
          }),
        );
  return {
    connector,
    received,
    fail: (value: boolean) => {
      error = value;
    },
    boundary: () => {
      boundary = true;
    },
  };
}

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
    secrets.arguments({ config: { password: "q" } }, inputSchema);
    expect(secrets.text("q")).toBe("q");
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
  expect(request.redactCredentials(SECRET)).toBe(SECRET);
  secrets.add(SECRET);
  expect(request.redactCredentials(SECRET)).toBe("[redacted]");
});

it("INV-5: short private strings protect exact leaves and matching prose while empty strings preserve usable metadata", async () => {
  let reply: unknown;
  const connector = api("short", {
    tools: [
      {
        name: "write",
        description: "Write private data",
        annotations: { readOnlyHint: false },
        inputSchema: { type: "object", properties: { value: { type: "string", writeOnly: true } } },
        handler: async () => reply,
      },
    ],
  });
  const meta = createMetaTools(makeRegistry([connector]), BASE);
  const metadata = { id: "folder-prod-793", status: "ok", echo: "prod", forms: forms("prod"), label: "production" };
  for (const value of ["text", "json", "data", "result", "structuredContent"]) {
    reply = { id: "needed-id", echo: value };
    for (const resultMode of ["mcp", "value"] as const) {
      const result = await meta.callDestructiveTool({ address: "short.write", args: { value }, resultMode });
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text, `${value}/${resultMode}`).not.toBe("[redacted]");
      const parsed = JSON.parse(result.content[0]!.text);
      expect(resultMode === "value" ? parsed.data : parsed).toEqual({ id: "needed-id", echo: "[redacted]" });
      if (resultMode === "value") expect(parsed).toMatchObject({ ok: true, format: "json" });
    }
  }
  for (const resultMode of ["mcp", "value"] as const) {
    reply = metadata;
    const result = await meta.callDestructiveTool({ address: "short.write", args: { value: "prod" }, resultMode });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(resultMode === "value" ? parsed.data : parsed).toEqual({
      ...metadata,
      id: "folder-[redacted]-793",
      label: "[redacted]uction",
      echo: "[redacted]",
      forms: forms("prod").map(() => "[redacted]"),
    });
  }
  for (const text of ["quoted prod", `quoted ${btoa("prod")}`, `quoted ${forms("prod").at(-1)}`]) {
    reply = text;
    const result = await meta.callDestructiveTool({
      address: "short.write",
      args: { value: "prod" },
      resultMode: "value",
    });
    expect(result.structuredContent).toMatchObject({ ok: true, data: "quoted [redacted]", format: "text" });
  }
  reply = { id: "folder-prod-793", status: "ok", echo: "", text: "ordinary prose" };
  const empty = await meta.callDestructiveTool({ address: "short.write", args: { value: "" }, resultMode: "value" });
  expect(empty.structuredContent).toMatchObject({ ok: true, data: reply, format: "json" });
});

it("INV-5 INV-6: private object names and encodings stay redacted through direct calls, programs and split stash pages", async () => {
  const key = "private-object-key/+793";
  const args = { config: { [key]: "public-leaf-793" } };
  for (const kind of ["mcp", "api"] as const) {
    const source = fixture(
      kind,
      { type: "object", properties: { config: { type: "object", writeOnly: true } } },
      () => key,
    );
    const storage = memoryStorage();
    const registry = makeRegistry([source.connector], { storage, maxResultBytes: 1_024 });
    const meta = createMetaTools(registry, BASE, { readOnly: false });
    const check = (value: unknown) => {
      for (const form of forms(key)) expect(JSON.stringify(value)).not.toContain(form);
      expect(JSON.stringify(value)).toContain("[redacted]");
    };
    for (const failed of [false, true]) {
      source.fail(failed);
      for (const resultMode of ["mcp", "value"] as const) {
        const result = await meta.callDestructiveTool({ address: "echo.write", args, resultMode });
        expect(result.isError === true).toBe(failed);
        check(result);
      }
    }
    source.fail(false);
    const run = createExecuteTool(
      registry,
      BASE,
      {
        execute: async (_code, providers) => {
          const host = providers[0]!.fns;
          const result = await host.call!("echo.write", args);
          await host.emit!({ type: "text", text: forms(key).join("; ") });
          return { result, logs: [forms(key).join("; ")] };
        },
      },
      silentLogger,
      undefined,
      { readOnly: false },
    );
    check(await run({ code: "async () => {}" }));
    source.boundary();
    const result = await meta.callDestructiveTool({ address: "echo.write", args, resultMode: "value" });
    const notice = result.structuredContent!.data as { resultId: string };
    expect(notice.resultId).toBeTypeOf("string");
    let body = "";
    let offset = 0;
    for (;;) {
      const page = await createMetaTools(registry, BASE, { readOnly: false }).readResult({
        id: notice.resultId,
        offset,
        maxBytes: 1_024,
      });
      const [header, ...text] = page.content[0]!.text.split("\n");
      body += text.join("\n");
      const paging = JSON.parse(header!) as { hasMore: boolean; nextOffset: number };
      if (!paging.hasMore) break;
      offset = paging.nextOffset;
    }
    expect(JSON.parse(body)).toBe("x".repeat(1016) + "[redacted]" + "x".repeat(8_000));
    check(body);
  }
});

it("INV-5 INV-9: large private strings preserve typed write success and safe identifiers", async () => {
  const value = "s".repeat(32760) + "793/last";
  const secrets = new SentSecrets();
  secrets.arguments({ value }, { type: "object", properties: { value: { writeOnly: true } } });
  expect(secrets.redact({ id: "needed-id", status: "ok", echo: value })).toEqual({
    id: "needed-id",
    status: "ok",
    echo: "[redacted]",
  });
  const escaped = [...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  expect(JSON.parse(secrets.text(JSON.stringify({ id: "needed-id", status: "ok", echo: escaped })))).toEqual({
    id: "needed-id",
    status: "ok",
    echo: "[redacted]",
  });
  const many = Array.from({ length: 20 }, (_, index) => `private-value-${index}-793`);
  let dispatched = 0;
  const connector = api("large", {
    tools: [
      {
        name: "write",
        description: "Write large private values",
        annotations: { readOnlyHint: false },
        inputSchema: { type: "object", properties: { values: { writeOnly: true } } },
        handler: async () => {
          dispatched++;
          return { id: "needed-id", status: "ok", prose: "x".repeat(2_000) + value };
        },
      },
    ],
  });
  const result = await createMetaTools(makeRegistry([connector]), BASE).callDestructiveTool({
    address: "large.write",
    args: { values: [value, ...many] },
    resultMode: "value",
  });
  expect(dispatched).toBe(1);
  expect(result.structuredContent).toMatchObject({
    ok: true,
    data: { id: "needed-id", status: "ok", prose: "x".repeat(2_000) + "[redacted]" },
    format: "json",
  });
});

it("INV-5: nested JSON strings decode through a bounded number of layers, and deeper nesting is withheld", () => {
  const secret = "private-secret-793";
  const secrets = new SentSecrets();
  secrets.arguments({ value: secret }, { type: "object", properties: { value: { type: "string", writeOnly: true } } });
  const wrapped = (count: number) => {
    let text = `"${[...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;
    for (let index = 0; index < count; index++) text = JSON.stringify({ nested: text });
    return text;
  };
  // Decode as a guest would: parse each layer and follow `nested` until a string stops parsing.
  const innermost = (text: string): unknown => {
    let value: unknown = text;
    while (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return value;
      }
      if (value !== null && typeof value === "object") value = (value as { nested: unknown }).nested;
    }
    return value;
  };
  for (const count of [3, 12]) {
    const text = wrapped(count);
    expect(innermost(text)).toBe(secret);
    const reply = secrets.redact({ content: [{ type: "text", text }] });
    expect(innermost(reply.content[0]!.text)).toBe("[redacted]");
    expect(innermost(secrets.text(text))).toBe("[redacted]");
  }
});
