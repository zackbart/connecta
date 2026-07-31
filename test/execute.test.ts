import { describe, expect, it, vi } from "vitest";
import {
  buildSandboxProviders,
  createExecuteTool,
  EXECUTE_MAX_BATCH_CALLS,
  sanitizeIdentifier,
} from "../src/execute.js";
import { ConnectorCallError } from "../src/errors.js";
import { AdmissionController } from "../src/executor-admission.js";
import {
  MAX_DESCRIBE_ADDRESSES,
  MAX_DISCOVERY_RESULT_BYTES,
  MAX_SEARCH_LIMIT,
  createMetaTools,
} from "../src/meta-tools.js";
import { InvocationFailure } from "../src/invocation.js";
import { unwrapMcpResult } from "../src/mcp-result.js";
import type {
  ActivityRequestContext,
  ToolCallActivityEvent,
} from "../src/activity.js";
import type {
  AdmittingExecutor,
  Connector,
  Executor,
  ExecutorProvider,
} from "../src/types.js";
import { required,
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
  silentLogger,
} from "./helpers.js";

const BASE = "https://connecta.test";

function activityRecorder(requestId: string): {
  activity: ActivityRequestContext;
  events: ToolCallActivityEvent[];
} {
  const events: ToolCallActivityEvent[] = [];
  return {
    events,
    activity: {
      sink: {
        record: (event) => {
          events.push(event);
        },
      },
      actor: { kind: "test" },
      requestId,
      serverInfo: { name: "connecta-test", version: "0" },
      logger: silentLogger,
    },
  };
}

/** Records the providers it was handed; returns a canned outcome. */
function fakeExecutor(
  outcome: { result?: unknown; error?: string; logs?: string[] } = {},
): Executor & { seen: { code: string; providers: ExecutorProvider[] }[] } {
  const seen: { code: string; providers: ExecutorProvider[] }[] = [];
  return {
    seen,
    async execute(code, providers) {
      seen.push({ code, providers });
      return {
        result: outcome.result,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.logs !== undefined ? { logs: outcome.logs } : {}),
      };
    },
  };
}

function connectaProvider(providers: ExecutorProvider[]): ExecutorProvider {
  return providers.find((provider) => provider.name === "connecta")!;
}

function callNamespace(
  providers: ExecutorProvider[],
  connectorId: string,
  toolAlias: string,
  args: unknown = {},
): Promise<unknown> {
  return required(connectaProvider(providers).fns.__callNamespace)(
    connectorId,
    toolAlias,
    args,
  );
}

describe("sanitizeIdentifier", () => {
  it("maps names onto valid JS identifiers", () => {
    expect(sanitizeIdentifier("my-tool")).toBe("my_tool");
    expect(sanitizeIdentifier("get.thing")).toBe("get_thing");
    expect(sanitizeIdentifier("3d-render")).toBe("_3d_render");
    expect(sanitizeIdentifier("delete")).toBe("delete_");
    expect(sanitizeIdentifier("plain_ok")).toBe("plain_ok");
  });
});

describe("unwrapMcpResult", () => {
  it("passes non-mcp results through untouched", () => {
    expect(unwrapMcpResult("api", { sum: 3 })).toEqual({ sum: 3 });
  });

  it("JSON-parses all-text MCP content when possible", () => {
    const r = unwrapMcpResult("mcp", {
      content: [{ type: "text", text: '{"a":1}' }],
    });
    expect(r).toEqual({ a: 1 });
    const s = unwrapMcpResult("mcp", {
      content: [{ type: "text", text: "not json" }],
    });
    expect(s).toBe("not json");
  });

  it("unwraps a toolResult-carrying MCP result to that value", () => {
    expect(
      unwrapMcpResult("mcp", {
        toolResult: { rows: [1, 2, 3] },
        content: [{ type: "text", text: "ignored" }],
      }),
    ).toEqual({ rows: [1, 2, 3] });
    // toolResult wins even when it is a falsy-but-present value.
    expect(unwrapMcpResult("mcp", { toolResult: null })).toBeNull();
  });

  it("prefers structuredContent and throws on isError", () => {
    expect(
      unwrapMcpResult("mcp", {
        content: [{ type: "text", text: "x" }],
        structuredContent: { b: 2 },
      }),
    ).toEqual({ b: 2 });
    expect(() =>
      unwrapMcpResult("mcp", {
        isError: true,
        content: [{ type: "text", text: "downstream sad" }],
      }),
    ).toThrow("downstream sad");
  });
});

describe("buildSandboxProviders", () => {
  it("keeps connector guide identifiers on every flat search shape", async () => {
    const connector = (
      id: string,
      usageGuide?: string,
    ): Connector => ({
      id,
      kind: "api",
      ...(usageGuide ? { usageGuide } : {}),
      async listTools() {
        return [
          {
            name: "find_alpha",
            description: "Find alpha records",
            annotations: { readOnlyHint: true },
          },
          {
            name: "list_beta",
            description: "List beta records",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return {};
      },
    });
    const providers = await buildSandboxProviders(
      makeRegistry([
        connector("guided", "# Guided usage"),
        connector("plain"),
      ]),
      BASE,
      silentLogger,
    );
    const search = required(connectaProvider(providers).fns.search);

    const browse = (await search({ limit: 100 })) as {
      tools: Array<{ address: string; guide?: string }>;
    };
    expect(
      browse.tools
        .filter((tool) => tool.address.startsWith("guided."))
        .map((tool) => tool.guide),
    ).toEqual(["connector:guided", "connector:guided"]);
    expect(
      browse.tools
        .filter((tool) => tool.address.startsWith("plain."))
        .every((tool) => !Object.hasOwn(tool, "guide")),
    ).toBe(true);

    const firstPage = (await search({
      connector: "guided",
      limit: 1,
    })) as {
      tools: Array<{ guide?: string }>;
      hasMore: boolean;
      nextOffset?: number;
    };
    const secondPage = (await search({
      connector: "guided",
      limit: 1,
      offset: firstPage.nextOffset,
    })) as { tools: Array<{ guide?: string }>; hasMore: boolean };
    expect(firstPage.tools[0]?.guide).toBe("connector:guided");
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.tools[0]?.guide).toBe("connector:guided");
    expect(secondPage.hasMore).toBe(false);

    const partial = (await search({
      query: "alpha unmatched",
      connector: "guided",
    })) as {
      tools: Array<{ guide?: string }>;
      matchMode?: string;
    };
    expect(partial.matchMode).toBe("partial");
    expect(partial.tools[0]?.guide).toBe("connector:guided");

    const noMatch = (await search({
      query: "unfindable",
      connector: "guided",
    })) as { tools: unknown[] };
    expect(noMatch.tools).toEqual([]);

    const searchBytes = async (usageGuide?: string) => {
      const sized = await buildSandboxProviders(
        makeRegistry([connector("sized", usageGuide)]),
        BASE,
        silentLogger,
      );
      return JSON.stringify(
        await required(connectaProvider(sized).fns.search)({
          connector: "sized",
          limit: 100,
        }),
      ).length;
    };
    const guidedBytes = await searchBytes("# Sized usage");
    const plainBytes = await searchBytes();
    expect(guidedBytes - plainBytes).toBe(
      2 * ',"guide":"connector:sized"'.length,
    );
    expect(guidedBytes).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
  });

  it("touches no catalog at setup and only the requested connector at call time", async () => {
    const catalogCalls = new Map<string, number>();
    const counted = (connector: Connector): Connector => ({
      ...connector,
      async listTools(ctx) {
        catalogCalls.set(
          connector.id,
          (catalogCalls.get(connector.id) ?? 0) + 1,
        );
        return connector.listTools(ctx);
      },
    });
    const registry = makeRegistry(
      [calcConnector, remoteConnector, brokenConnector].map(counted),
    );
    const providers = await buildSandboxProviders(registry, BASE, silentLogger);
    expect(providers.map((provider) => provider.name)).toEqual(["connecta"]);
    expect(catalogCalls.size).toBe(0);
    expect(required(providers[0]).prelude).toContain('globalThis["calc"]');
    expect(required(providers[0]).prelude).toContain('globalThis["broken"]');

    expect(await callNamespace(providers, "calc", "add", { a: 2, b: 3 })).toEqual(
      { sum: 5 },
    );
    expect(catalogCalls).toEqual(new Map([["calc", 1]]));
    expect(registry.healthFor("broken")).toBeUndefined();

    // MCP results are still unwrapped to plain values for sandbox code.
    expect(
      await callNamespace(providers, "remote", "echo", { text: "hi" }),
    ).toBe("echo:hi");
    expect(catalogCalls).toEqual(
      new Map([
        ["calc", 1],
        ["remote", 1],
      ]),
    );

    const connecta = connectaProvider(providers);
    expect(await required(connecta.fns.call)("calc.add", { a: 1, b: 1 })).toEqual({
      sum: 2,
    });
    await expect(required(connecta.fns.call)("nope.add", {})).rejects.toThrow(
      'Unknown address "nope.add"',
    );
  });

  it("records health only after a broken connector is exercised", async () => {
    const registry = makeRegistry([calcConnector, brokenConnector]);
    const providers = await buildSandboxProviders(registry, BASE, silentLogger);
    expect(registry.healthFor("broken")).toBeUndefined();
    await expect(
      callNamespace(providers, "broken", "anything"),
    ).rejects.toThrow("boom");
    expect(registry.healthFor("broken")).toMatchObject({
      consecutiveFailures: 1,
      lastError: "boom",
    });
    // A catalog that loaded is not a success signal of its own.
    expect(registry.healthFor("calc")).toBeUndefined();
  });

  it("keeps a typed auth_required's code when the lazy namespace is used", async () => {
    const expired: Connector = {
      id: "expired",
      kind: "mcp",
      async listTools() {
        throw new ConnectorCallError(
          "auth_required",
          'Connector "expired" requires authorization',
        );
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([expired]);
    const providers = await buildSandboxProviders(
      registry,
      BASE,
      silentLogger,
    );
    const error = await callNamespace(providers, "expired", "read").then(
      () => undefined,
      (cause: unknown) => cause as InvocationFailure,
    );
    expect(error).toMatchObject({
      code: "auth_required",
      message: 'Connector "expired" requires authorization',
    });
    expect(registry.healthFor("expired")?.consecutiveFailures).toBe(1);
  });

  it("does not expose or execute tools annotated destructive", async () => {
    let calls = 0;
    const dangerous: Connector = {
      id: "danger",
      kind: "api",
      async listTools() {
        return [
          {
            name: "erase",
            annotations: {
              destructiveHint: true,
              readOnlyHint: false,
            },
          },
        ];
      },
      async callTool() {
        calls++;
        return { erased: true };
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([dangerous]),
      BASE,
      silentLogger,
    );
    const connecta = connectaProvider(providers);
    const directError = await required(connecta.fns.call)("danger.erase", {}).then(
      () => undefined,
      (error: unknown) => error as InvocationFailure,
    );
    const lazyError = await callNamespace(providers, "danger", "erase").then(
      () => undefined,
      (error: unknown) => error as InvocationFailure,
    );
    expect(lazyError).toMatchObject({
      code: "destructive_tool_requires_approval",
      message: directError?.message,
    });
    expect(lazyError?.message).toContain("call_destructive_tool");
    expect(calls).toBe(0);
  });

  it("fails closed for unannotated and contradictory tool definitions", async () => {
    let calls = 0;
    const ambiguous: Connector = {
      id: "ambiguous",
      kind: "api",
      async listTools() {
        return [
          { name: "missing_annotations" },
          {
            name: "contradictory",
            annotations: {
              readOnlyHint: true,
              destructiveHint: true,
            },
          },
        ];
      },
      async callTool() {
        calls++;
        return "unsafe";
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([ambiguous]),
      BASE,
      silentLogger,
    );
    const connecta = connectaProvider(providers);
    await expect(
      required(connecta.fns.call)("ambiguous.missing_annotations", {}),
    ).rejects.toThrow("not explicitly read-only");
    await expect(
      required(connecta.fns.call)("ambiguous.contradictory", {}),
    ).rejects.toThrow("not explicitly read-only");
    expect(calls).toBe(0);
  });

  it("sanitizes connector ids and tool names into identifiers", async () => {
    const weird: Connector = {
      id: "my-service",
      kind: "api",
      description: "Weird names",
      async listTools() {
        return [
          {
            name: "get.thing",
            description: "d",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool(name) {
        return { called: name };
      },
    };
    const registry = makeRegistry([weird]);
    const providers = await buildSandboxProviders(registry, BASE, silentLogger);
    // The sanitized fn key still dispatches to the original tool name.
    expect(
      await callNamespace(providers, "my-service", "get_thing"),
    ).toEqual({ called: "get.thing" });
  });

  it("fails a colliding tool alias and leaves exact addresses callable", async () => {
    const colliding: Connector = {
      id: "colliding",
      kind: "api",
      async listTools() {
        return [
          {
            name: "get.thing",
            annotations: { readOnlyHint: true },
          },
          {
            name: "get-thing",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool(name) {
        return { called: name };
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([colliding]),
      BASE,
      silentLogger,
    );
    await expect(
      callNamespace(providers, "colliding", "get_thing"),
    ).rejects.toMatchObject({
      code: "ambiguous_tool_alias",
      message: expect.stringContaining(
        "Use connecta.call with an exact address",
      ),
      nextAction: {
        function: "connecta.call",
        addresses: ["colliding.get.thing", "colliding.get-thing"],
      },
    });
    await expect(
      required(connectaProvider(providers).fns.call)("colliding.get.thing", {}),
    ).resolves.toEqual({ called: "get.thing" });
  });

  it("fails unknown lazy connector and tool lookups canonically", async () => {
    const providers = await buildSandboxProviders(
      makeRegistry([calcConnector]),
      BASE,
      silentLogger,
    );
    await expect(
      callNamespace(providers, "missing", "read"),
    ).rejects.toMatchObject({ code: "unknown_address" });
    await expect(
      callNamespace(providers, "calc", "missing"),
    ).rejects.toMatchObject({ code: "unknown_tool" });
  });

  it("surfaces connector namespace collisions after sanitization", async () => {
    const connector = (id: string): Connector => ({
      id,
      kind: "api",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    });
    await expect(
      buildSandboxProviders(
        makeRegistry([connector("my-service"), connector("my_service")]),
        BASE,
        silentLogger,
      ),
    ).rejects.toThrow(
      'Connector ids "my-service" and "my_service" both sanitize to execute_code namespace "my_service"',
    );
  });

  it.each(["console", "arguments", "result", "undefined"])(
    "surfaces connector id %s when it collides with sandbox state",
    async (id) => {
      const evil: Connector = {
        id,
        kind: "api",
        async listTools() {
          return [{ name: "log" }];
        },
        async callTool() {
          return "hijacked";
        },
      };
      const warnings: string[] = [];
      const logger = {
        ...silentLogger,
        warn: (...a: unknown[]) => warnings.push(a.map(String).join(" ")),
      };
      const registry = makeRegistry([evil]);
      await expect(
        buildSandboxProviders(registry, BASE, logger),
      ).rejects.toThrow(
        `Connector "${id}" sanitizes to reserved execute_code namespace "${id}"`,
      );
      expect(warnings.some((warning) => warning.includes(id))).toBe(true);
    },
  );

  it("surfaces a connector that collides with the reserved connecta namespace", async () => {
    const impostor: Connector = {
      id: "connecta",
      kind: "api",
      async listTools() {
        return [{ name: "call" }];
      },
      async callTool() {
        return "hijacked";
      },
    };
    const warnings: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (...a: unknown[]) => warnings.push(a.map(String).join(" ")),
    };
    const registry = makeRegistry([impostor]);
    await expect(
      buildSandboxProviders(registry, BASE, logger),
    ).rejects.toThrow(
      'Connector "connecta" sanitizes to reserved execute_code namespace "connecta"',
    );
    expect(warnings.some((w) => w.includes("connecta"))).toBe(true);
  });

  it("keeps tools named like Object.prototype members", async () => {
    const proto: Connector = {
      id: "proto",
      kind: "api",
      async listTools() {
        return [
          { name: "hasOwnProperty", annotations: { readOnlyHint: true } },
          { name: "toString", annotations: { readOnlyHint: true } },
        ];
      },
      async callTool(name) {
        return { called: name };
      },
    };
    const registry = makeRegistry([proto]);
    const providers = await buildSandboxProviders(registry, BASE, silentLogger);
    expect(
      await callNamespace(providers, "proto", "hasOwnProperty"),
    ).toEqual({ called: "hasOwnProperty" });
    expect(await callNamespace(providers, "proto", "toString")).toEqual({
      called: "toString",
    });
  });

  it("exposes tool-agnostic search, describe, and batch catalog helpers", async () => {
    const providers = await buildSandboxProviders(
      makeRegistry([calcConnector, remoteConnector]),
      BASE,
      silentLogger,
    );
    const connecta = providers.find((p) => p.name === "connecta")!;
    const search = (await required(connecta.fns.search)({
      query: "add",
      includeSchemas: "compact",
    })) as {
      tools: Array<{ address: string; inputSchema: string }>;
    };
    expect(search.tools[0]).toMatchObject({
      address: "calc.add",
      inputSchema: "{ a: number, b: number }",
      inputKeys: ["a", "b"],
      requiredInputKeys: ["a", "b"],
    });

    const partial = (await required(connecta.fns.search)({
      query: "add numbers operands result metadata",
    })) as {
      matchMode?: string;
      queryAnalysis?: {
        representedTerms: string[];
        unmatchedTerms: string[];
      };
      tools: Array<{ address: string }>;
    };
    expect(partial.matchMode).toBe("partial");
    expect(required(partial.tools[0]).address).toBe("calc.add");
    expect(partial.queryAnalysis).toMatchObject({
      representedTerms: ["add", "numbers"],
      unmatchedTerms: ["operands", "result", "metadata"],
    });
    // Key metadata accompanies schemas; a search that asked for neither pays
    // for neither.
    expect(required(partial.tools[0])).not.toHaveProperty("inputKeys");

    const described = (await required(connecta.fns.describe)({
      addresses: ["calc.add", "remote.echo"],
    })) as { tools: Array<{ address: string }> };
    expect(described.tools.map((tool) => tool.address)).toEqual([
      "calc.add",
      "remote.echo",
    ]);
    const describedOne = (await required(connecta.fns.describe)({
      address: "calc.add",
    })) as { tools: Array<{ address: string }> };
    expect(describedOne.tools.map((tool) => tool.address)).toEqual([
      "calc.add",
    ]);
    await expect(
      required(connecta.fns.describe)({
        address: "calc.add",
        addresses: ["remote.echo"],
      }),
    ).rejects.toThrow("either address or addresses, not both");

    const batch = (await required(connecta.fns.batch)([
      { address: "calc.add", args: { a: 1, b: 2 } },
      { address: "remote.echo", args: { text: "hello" } },
    ])) as Array<{ ok: boolean; data: unknown }>;
    expect(batch).toEqual([
      { address: "calc.add", ok: true, data: { sum: 3 } },
      { address: "remote.echo", ok: true, data: "echo:hello" },
    ]);
  });

  it("lets programs discover only calls the sandbox can execute", async () => {
    const mixed: Connector = {
      id: "mixed",
      kind: "api",
      staticTools: [
        { name: "read", annotations: { readOnlyHint: true } },
        { name: "write", annotations: { readOnlyHint: false } },
        { name: "missing" },
        {
          name: "contradictory",
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
      async listTools() {
        return [];
      },
      async callTool(name) {
        return name;
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([mixed]),
      BASE,
      silentLogger,
    );
    const connecta = connectaProvider(providers);
    const page = (await required(connecta.fns.search)({
      safety: "readOnly",
      limit: 10,
    })) as { tools: Array<{ address: string }> };

    expect(page.tools.map((tool) => tool.address)).toEqual(["mixed.read"]);
    expect(
      await required(connecta.fns.call)(required(page.tools[0]).address, {}),
    ).toBe("read");
  });

  it("resolves schema key metadata the way the compact schema renders", async () => {
    // A top-level $ref and an "extend this base" allOf are what OpenAPI- and
    // pydantic-derived connectors actually emit. Reading `properties` off the
    // schema root sees nothing there, which would advertise a field-less tool
    // beside a compact schema that plainly lists fields.
    const shapes: Connector = {
      id: "shapes",
      kind: "api",
      description: "Schema shapes",
      async listTools() {
        return [
          {
            name: "referenced",
            description: "Input behind a $ref",
            annotations: { readOnlyHint: true },
            inputSchema: {
              $defs: {
                GetRun: {
                  type: "object",
                  properties: { runId: { type: "integer" } },
                  required: ["runId"],
                },
              },
              $ref: "#/$defs/GetRun",
            },
            outputSchema: {
              allOf: [
                {
                  type: "object",
                  properties: { runId: { type: "integer" } },
                  required: ["runId"],
                },
                {
                  type: "object",
                  properties: { failedJobId: { type: "integer" } },
                },
              ],
            },
          },
          {
            name: "union",
            description: "Input that is a union, not an object",
            annotations: { readOnlyHint: true },
            inputSchema: {
              oneOf: [
                { type: "object", properties: { a: { type: "string" } } },
                { type: "object", properties: { b: { type: "string" } } },
              ],
            },
          },
          {
            name: "argless",
            description: "A tool that genuinely takes no fields",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object" },
          },
        ];
      },
      async callTool() {
        return {};
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([shapes]),
      BASE,
      silentLogger,
    );
    const connecta = connectaProvider(providers);
    const byName = async (query: string, args: Record<string, unknown> = {}) => {
      const page = (await required(connecta.fns.search)({
        query,
        includeSchemas: "compact",
        ...args,
      })) as { tools: Array<Record<string, unknown>> };
      return Object.fromEntries(
        page.tools.map((tool) => [tool.name as string, tool]),
      );
    };

    const tools = await byName("referenced union argless");
    const referenced = required(tools.referenced);
    expect(referenced.inputSchema).toBe("{ runId: integer }");
    expect(referenced.inputKeys).toEqual(["runId"]);
    expect(referenced.requiredInputKeys).toEqual(["runId"]);
    expect(referenced.outputSchema).toBe(
      "{ runId: integer } & { failedJobId?: integer }",
    );
    expect(referenced.outputKeys).toEqual(["runId", "failedJobId"]);

    // A union has no single key list. Absent says "read the schema"; [] would
    // say "this tool takes nothing".
    const union = required(tools.union);
    expect(union).not.toHaveProperty("inputKeys");
    expect(union).not.toHaveProperty("requiredInputKeys");

    // An object with no properties is the one case where empty is the truth.
    const argless = required(tools.argless);
    expect(argless.inputKeys).toEqual([]);
    expect(argless.requiredInputKeys).toEqual([]);
    expect(argless).not.toHaveProperty("outputKeys");

    const optedOut = await byName("referenced", { includeSchemaKeys: false });
    expect(required(optedOut.referenced).inputSchema).toBe("{ runId: integer }");
    expect(required(optedOut.referenced)).not.toHaveProperty("inputKeys");
  });

  it("bounds in-sandbox discovery fan-out", async () => {
    let active = 0;
    let maxActive = 0;
    const connectors = Array.from(
      { length: 7 },
      (_, index): Connector => ({
        id: `sandbox_${index}`,
        kind: "mcp",
        async listTools() {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return [{ name: `read_${index}`, description: "Read sandbox data" }];
        },
        async callTool() {
          return null;
        },
      }),
    );
    const providers = await buildSandboxProviders(
      makeRegistry(connectors),
      BASE,
      silentLogger,
      undefined,
      { discoveryConcurrency: 2 },
    );
    const result = (await required(connectaProvider(providers).fns.search)({
      query: "sandbox",
      limit: 20,
    })) as { total: number };
    expect(result.total).toBe(7);
    expect(maxActive).toBe(2);
  });

  it("applies the ordinary discovery count limits inside code mode", async () => {
    const verbose: Connector = {
      id: "verbose",
      staticTools: [
        {
          name: "read",
          description: "界".repeat(MAX_DISCOVERY_RESULT_BYTES),
          annotations: { readOnlyHint: true },
        },
      ],
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([calcConnector, verbose]),
      BASE,
      silentLogger,
    );
    const connecta = providers.find((p) => p.name === "connecta")!;

    await expect(
      required(connecta.fns.search)({ limit: MAX_SEARCH_LIMIT + 1 }),
    ).rejects.toThrow(`through ${MAX_SEARCH_LIMIT}`);
    await expect(
      required(connecta.fns.describe)({
        addresses: Array.from(
          { length: MAX_DESCRIBE_ADDRESSES + 1 },
          () => "calc.add",
        ),
      }),
    ).rejects.toThrow(
      `at most ${MAX_DESCRIBE_ADDRESSES} entries. Split a larger list across connecta.describe calls.`,
    );
    await expect(
      required(connecta.fns.search)({
        connector: "verbose",
        fullDescriptions: true,
      }),
    ).rejects.toMatchObject({ code: "result_too_large" });
  });

  it("honors the configured probe deadline and names connecta.describe when a catalog probe times out", async () => {
    const hanging: Connector = {
      id: "hang",
      kind: "mcp",
      async listTools() {
        return new Promise<never>(() => {});
      },
      async callTool() {
        return null;
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([hanging]),
      BASE,
      silentLogger,
      undefined,
      { probeTimeoutMs: 25 },
    );
    const started = Date.now();
    const result = (await required(connectaProvider(providers).fns.describe)({
      addresses: ["hang.read"],
    })) as { tools: Array<{ address: string; error?: string }> };

    // The deadline reached the sandbox: without the plumbing this hangs to the
    // 30s default instead of resolving in milliseconds.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(required(result.tools[0]).address).toBe("hang.read");
    expect(required(result.tools[0]).error).toContain(
      'connecta.describe probe of "hang" timed out',
    );
    expect(required(result.tools[0]).error).not.toContain("describe_tools");
  });

  it("bounds total host calls and connecta.batch size", async () => {
    let calls = 0;
    const safe: Connector = {
      id: "safe",
      kind: "api",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        calls++;
        return calls;
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([safe]),
      BASE,
      silentLogger,
      undefined,
      { maxHostCalls: 2 },
    );
    await expect(callNamespace(providers, "safe", "read")).resolves.toBe(1);
    await expect(callNamespace(providers, "safe", "read")).resolves.toBe(2);
    // Synchronous rejection-handler attach — expect(...).rejects attaches a
    // microtask later, which workerd reports as an unhandled rejection.
    const exceeded = await callNamespace(providers, "safe", "read")
      .then(() => null, (e: unknown) => e as Error);
    expect(exceeded?.message).toContain("budget exceeded");
    expect(calls).toBe(2);

    const connecta = providers.find(
      (provider) => provider.name === "connecta",
    )!;
    await expect(
      required(connecta.fns.batch)(
        Array.from({ length: EXECUTE_MAX_BATCH_CALLS + 1 }, () => ({
          address: "safe.read",
        })),
      ),
    ).rejects.toThrow(`at most ${EXECUTE_MAX_BATCH_CALLS}`);
    expect(calls).toBe(2);
  });

  it("times out a host call even when the connector ignores cancellation", async () => {
    const never = new Promise<never>(() => {});
    const slow: Connector = {
      id: "slow",
      kind: "api",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        return never;
      },
    };
    const providers = await buildSandboxProviders(
      makeRegistry([slow]),
      BASE,
      silentLogger,
      undefined,
      { hostCallTimeoutMs: 10 },
    );
    await expect(
      callNamespace(providers, "slow", "read"),
    ).rejects.toThrow("timed out after 10ms");
  });
});

describe("MCP and code-mode invocation parity", () => {
  async function failuresFor(
    connector: Connector,
    address: string,
    options: { timeoutMs?: number } = {},
  ) {
    const mcpRegistry = makeRegistry([connector]);
    const mcpActivity = activityRecorder("mcp-request");
    const mcpResult = await createMetaTools(mcpRegistry, BASE, {
      activity: mcpActivity.activity,
    }).callTool({
      address,
      args: {},
      resultMode: "value",
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const mcpError = (
      mcpResult.structuredContent as {
        error: { code: string; message: string; retryable: boolean };
      }
    ).error;

    const codeRegistry = makeRegistry([connector]);
    const codeActivity = activityRecorder("code-request");
    const providers = await buildSandboxProviders(
      codeRegistry,
      BASE,
      silentLogger,
      codeActivity.activity,
      options.timeoutMs
        ? { hostCallTimeoutMs: options.timeoutMs }
        : undefined,
    );
    const connecta = providers.find((provider) => provider.name === "connecta")!;
    const codeError = await required(connecta.fns
      .call)(address, {})
      .then(() => undefined, (error: unknown) => error);
    expect(codeError).toBeInstanceOf(InvocationFailure);
    return {
      mcpError,
      codeError: codeError as InvocationFailure,
      mcpRegistry,
      codeRegistry,
      mcpEvents: mcpActivity.events,
      codeEvents: codeActivity.events,
    };
  }

  it.each([
    {
      label: "unknown address",
      address: "missing.read",
      expectedCode: "unknown_address",
    },
    {
      label: "unknown tool",
      address: "parity.missing",
      expectedCode: "unknown_tool",
    },
    {
      label: "non-read-only refusal",
      address: "parity.write",
      expectedCode: "destructive_tool_requires_approval",
    },
  ])(
    "uses the same code and wording for $label",
    async ({ address, expectedCode }) => {
      const connector: Connector = {
        id: "parity",
        kind: "api",
        async listTools() {
          return [
            {
              name: "read",
              annotations: { readOnlyHint: true },
            },
            { name: "write" },
          ];
        },
        async callTool() {
          throw new Error("should not dispatch");
        },
      };
      const { mcpError, codeError } = await failuresFor(connector, address);
      expect(codeError.code).toBe(expectedCode);
      expect(codeError.message).toBe(mcpError.message);
      expect(codeError.retryable).toBe(mcpError.retryable);
    },
  );

  it("classifies timeouts and records matching health and activity fields", async () => {
    const connector: Connector = {
      id: "parity",
      kind: "api",
      async listTools() {
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return await new Promise<never>(() => {});
      },
    };
    const result = await failuresFor(connector, "parity.read", {
      timeoutMs: 10,
    });
    expect(result.codeError).toMatchObject({
      code: "timeout",
      message: result.mcpError.message,
      retryable: result.mcpError.retryable,
    });
    expect(result.mcpRegistry.healthFor("parity")).toMatchObject({
      consecutiveFailures: 1,
      lastError: result.mcpError.message,
    });
    expect(result.codeRegistry.healthFor("parity")).toMatchObject({
      consecutiveFailures: 1,
      lastError: result.mcpError.message,
    });
    const sharedFields = {
      connectorId: "parity",
      toolName: "read",
      address: "parity.read",
      outcome: "timeout",
      attempts: 1,
      errorCode: "timeout",
    };
    expect(result.mcpEvents).toHaveLength(1);
    expect(result.codeEvents).toHaveLength(1);
    expect(result.mcpEvents[0]).toMatchObject({
      ...sharedFields,
      source: "call_tool",
    });
    expect(result.codeEvents[0]).toMatchObject({
      ...sharedFields,
      source: "execute_code",
    });
  });

  it("reports downstream isError failures with one wording in both adapters", async () => {
    const connector: Connector = {
      id: "parity",
      kind: "mcp",
      async listTools() {
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return { content: [], isError: true };
      },
    };
    const { mcpError, codeError } = await failuresFor(connector, "parity.read");
    expect(mcpError.message).toBe("Downstream tool call failed");
    expect(codeError.message).toBe(mcpError.message);
    expect(codeError.retryable).toBe(mcpError.retryable);
  });
});

describe("execute_code handler", () => {
  it("admits before provider construction and executes on the lease", async () => {
    const registry = makeRegistry([calcConnector]);
    const getTools = vi.spyOn(registry, "getTools");
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 1_000,
    });
    let finishFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let executions = 0;
    const executor: AdmittingExecutor = {
      async execute() {
        throw new Error("already-admitted path reacquired the executor");
      },
      async acquire(options = {}) {
        const token = await admission.acquire(options);
        return {
          async execute() {
            executions++;
            if (executions === 1) await firstMayFinish;
            return { result: executions };
          },
          release: () => token.release(),
        };
      },
    };
    const handler = createExecuteTool(registry, BASE, executor, silentLogger);
    const first = handler({ code: "async () => 1" });
    await vi.waitFor(() => expect(executions).toBe(1));
    const second = handler({ code: "async () => 2" });
    await Promise.resolve();

    // The second request is queued with only its signal/resolver. Neither
    // request touches a connector catalog merely to build its lazy namespaces.
    expect(getTools).not.toHaveBeenCalled();
    finishFirst();
    expect((await first).isError).toBeUndefined();
    expect((await second).isError).toBeUndefined();
    expect(getTools).not.toHaveBeenCalled();
    expect(executions).toBe(2);
  });

  it("returns stable retryable overload details before building providers", async () => {
    const registry = makeRegistry([calcConnector]);
    const getTools = vi.spyOn(registry, "getTools");
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 0,
      queueTimeoutMs: 321,
      retryAfterMs: 321,
    });
    const held = await admission.acquire();
    const executor: AdmittingExecutor = {
      async execute() {
        return { result: null };
      },
      async acquire(options = {}) {
        const token = await admission.acquire(options);
        return {
          execute: async () => ({ result: null }),
          release: () => token.release(),
        };
      },
    };
    const out = await createExecuteTool(
      registry,
      BASE,
      executor,
      silentLogger,
    )({ code: "async () => null" });
    const parsed = JSON.parse(required(out.content[0]).text) as {
      error: {
        code: string;
        retryable: boolean;
        retryAfterMs: number;
      };
    };
    expect(out.isError).toBe(true);
    expect(parsed.error).toEqual({
      code: "executor_overloaded",
      message: "Executor queue is full.",
      retryable: true,
      retryAfterMs: 321,
    });
    expect(getTools).not.toHaveBeenCalled();
    held.release();
  });

  it("removes a cancelled request from the admission queue", async () => {
    const registry = makeRegistry([calcConnector]);
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 1_000,
    });
    const held = await admission.acquire();
    const executor: AdmittingExecutor = {
      async execute() {
        return { result: null };
      },
      async acquire(options = {}) {
        const token = await admission.acquire(options);
        return {
          execute: async () => ({ result: null }),
          release: () => token.release(),
        };
      },
    };
    const controller = new AbortController();
    const result = createExecuteTool(
      registry,
      BASE,
      executor,
      silentLogger,
    )({ code: "async () => null" }, { signal: controller.signal });
    controller.abort();
    const out = await result;
    const parsed = JSON.parse(required(out.content[0]).text) as {
      error: { code: string; retryable: boolean };
    };
    expect(parsed.error).toMatchObject({
      code: "executor_cancelled",
      retryable: false,
    });
    expect(admission.queuedCount).toBe(0);
    held.release();
  });

  it("cancels an exercised lazy catalog and releases its admitted lease", async () => {
    let catalogStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      catalogStarted = resolve;
    });
    let catalogSignal: AbortSignal | undefined;
    const connector: Connector = {
      id: "catalog",
      kind: "api",
      listTools(ctx) {
        catalogSignal = ctx.signal;
        catalogStarted();
        return new Promise((_, reject) => {
          ctx.signal?.addEventListener(
            "abort",
            () => reject(ctx.signal?.reason),
            { once: true },
          );
        });
      },
      async callTool() {
        return null;
      },
    };
    const release = vi.fn();
    const execute = vi.fn(async (_code, providers: ExecutorProvider[]) => {
      await callNamespace(providers, "catalog", "read");
      return { result: null };
    });
    const executor: AdmittingExecutor = {
      execute,
      async acquire() {
        return { execute, release };
      },
    };
    const controller = new AbortController();
    const registry = makeRegistry([connector]);
    const pending = createExecuteTool(
      registry,
      BASE,
      executor,
      silentLogger,
    )(
      { code: "async () => null" },
      { signal: controller.signal },
    );
    await started;
    controller.abort(new Error("request disconnected"));
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(catalogSignal?.aborted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(registry.healthFor("catalog")).toBeUndefined();
  });

  it("passes code + providers to the executor and wraps the result", async () => {
    const registry = makeRegistry([calcConnector]);
    const executor = fakeExecutor({ result: { picked: [1, 2] }, logs: ["hi"] });
    const handler = createExecuteTool(registry, BASE, executor, silentLogger);
    const out = await handler({ code: "async () => 1" });
    expect(out.isError).toBeUndefined();
    const parsed = JSON.parse(required(out.content[0]).text) as {
      result: { picked: number[] };
      logs?: string;
    };
    expect(parsed.result).toEqual({ picked: [1, 2] });
    expect(out.structuredContent).toEqual(parsed);
    expect(required(out.content[0]).text).toBe(
      JSON.stringify(out.structuredContent),
    );
    expect(parsed.logs).toBe("hi");
    expect(required(executor.seen[0]).code).toBe("async () => 1");
    expect(required(executor.seen[0]).providers.map((p) => p.name)).toEqual([
      "connecta",
    ]);
    expect(required(required(executor.seen[0]).providers[0]).prelude).toContain(
      'globalThis["calc"]',
    );
  });

  it("reports compact payload-free diagnostics for every guest operation", async () => {
    const executor: Executor = {
      async execute(_code, providers) {
        const connecta = connectaProvider(providers).fns;
        await required(connecta.search)({
          query: "add numbers",
          includeSchemas: "compact",
        });
        await required(connecta.describe)({
          addresses: ["calc.add"],
          format: "compact",
        });
        await required(connecta.call)("calc.add", {
          a: 7,
          b: 9,
          credential: "argument-secret",
        });
        try {
          await required(connecta.call)("calc.missing", {
            raw: "failure-secret",
          });
        } catch {
          // A caught failure must still be counted.
        }
        await required(connecta.batch)([
          {
            address: "calc.add",
            args: { a: 1, b: 2, token: "batch-secret" },
          },
          {
            address: "calc.missing",
            args: { raw: "batch-failure-secret" },
          },
        ]);
        return { result: { done: true } };
      },
    };
    const out = await createExecuteTool(
      makeRegistry([calcConnector]),
      BASE,
      executor,
      silentLogger,
    )({
      code: 'async () => "source-secret"',
      diagnostics: true,
    });
    const parsed = JSON.parse(required(out.content[0]).text) as {
      result: { done: boolean };
      diagnostics: {
        timing: Record<string, number>;
        operations: Array<{
          operation: string;
          count: number;
          calls?: number;
          failures: number;
          resultBytes: number;
          catalogMs: number;
          connectorMs: number;
        }>;
      };
    };

    expect(parsed.result).toEqual({ done: true });
    expect(parsed.diagnostics.timing).toEqual({
      totalMs: expect.any(Number),
      admissionMs: 0,
      setupMs: expect.any(Number),
      executorWallMs: expect.any(Number),
      catalogMs: expect.any(Number),
      connectorMs: expect.any(Number),
    });
    const operation = (name: string) =>
      required(
        parsed.diagnostics.operations.find((item) => item.operation === name),
      );
    expect(operation("search")).toMatchObject({
      count: 1,
      failures: 0,
      resultBytes: expect.any(Number),
    });
    expect(operation("describe")).toMatchObject({
      count: 1,
      failures: 0,
      resultBytes: expect.any(Number),
    });
    expect(operation("call")).toMatchObject({
      count: 2,
      failures: 1,
      resultBytes: expect.any(Number),
    });
    expect(operation("batch")).toMatchObject({
      count: 1,
      calls: 2,
      failures: 1,
      resultBytes: expect.any(Number),
    });
    expect(operation("call").resultBytes).toBeGreaterThan(0);
    expect(operation("batch").resultBytes).toBeGreaterThan(0);

    const diagnosticsText = JSON.stringify(parsed.diagnostics);
    for (const forbidden of [
      "source-secret",
      "argument-secret",
      "failure-secret",
      "batch-secret",
      "batch-failure-secret",
      "calc.add",
      "calc.missing",
      "Unknown tool",
    ]) {
      expect(diagnosticsText).not.toContain(forbidden);
    }
  });

  it("adds no response context when diagnostics are disabled or omitted", async () => {
    const handler = createExecuteTool(
      makeRegistry([calcConnector]),
      BASE,
      fakeExecutor({ result: { ok: true } }),
      silentLogger,
    );
    const omitted = await handler({ code: "async () => null" });
    const disabled = await handler({
      code: "async () => null",
      diagnostics: false,
    });
    expect(required(omitted.content[0]).text).toBe('{"result":{"ok":true}}');
    expect(disabled).toEqual(omitted);
  });

  it("keeps diagnostics on discovery, batch, and executor failures", async () => {
    const guestFailures: Executor = {
      async execute(_code, providers) {
        const connecta = connectaProvider(providers).fns;
        try {
          await required(connecta.batch)("private batch payload");
        } catch {
          // Exercise a caught batch shape error before an uncaught discovery
          // policy failure ends the program.
        }
        try {
          await required(connecta.search)({ limit: 101 });
          return { result: null };
        } catch (error) {
          return {
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
    const discovery = await createExecuteTool(
      makeRegistry([calcConnector]),
      BASE,
      guestFailures,
      silentLogger,
    )({
      code: 'async () => "private source"',
      diagnostics: true,
    });
    const parsedDiscovery = JSON.parse(
      required(discovery.content[0]).text,
    ) as {
      error: { code: string };
      diagnostics: {
        operations: Array<{
          operation: string;
          count: number;
          failures: number;
        }>;
      };
    };
    expect(discovery.isError).toBe(true);
    expect(parsedDiscovery.error.code).toBe("invalid_args");
    expect(parsedDiscovery.diagnostics.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "batch",
          count: 1,
          failures: 1,
        }),
        expect.objectContaining({
          operation: "search",
          count: 1,
          failures: 1,
        }),
      ]),
    );
    expect(JSON.stringify(parsedDiscovery.diagnostics)).not.toContain(
      "private",
    );

    const executorFailure = await createExecuteTool(
      makeRegistry([calcConnector]),
      BASE,
      {
        async execute() {
          throw new Error("raw executor secret");
        },
      },
      silentLogger,
    )({
      code: "async () => null",
      diagnostics: true,
    });
    const parsedExecutor = JSON.parse(
      required(executorFailure.content[0]).text,
    ) as {
      error: { code: string; message: string };
      diagnostics: { timing: Record<string, number>; operations: unknown[] };
    };
    expect(executorFailure.isError).toBe(true);
    expect(parsedExecutor.error.code).toBe("executor_failed");
    expect(parsedExecutor.error.message).toContain("raw executor secret");
    expect(JSON.stringify(parsedExecutor.diagnostics)).not.toContain("secret");
    expect(parsedExecutor.diagnostics.operations).toEqual([]);
  });

  it("reports sandbox errors as isError with logs attached", async () => {
    const registry = makeRegistry([calcConnector]);
    const executor = fakeExecutor({ error: "kaboom", logs: ["step 1"] });
    const handler = createExecuteTool(registry, BASE, executor, silentLogger);
    const out = await handler({ code: "async () => 1" });
    expect(out.isError).toBe(true);
    expect(required(out.content[0]).text).toContain("kaboom");
    expect(required(out.content[0]).text).toContain("step 1");
  });

  it("turns an unserializable result into a structured error, keeping logs", async () => {
    const registry = makeRegistry([calcConnector]);
    const executor = fakeExecutor({ result: 1000n, logs: ["computed"] });
    const handler = createExecuteTool(registry, BASE, executor, silentLogger);
    const out = await handler({ code: "async () => 1" });
    expect(out.isError).toBe(true);
    expect(required(out.content[0]).text).toContain("not JSON-serializable");
    expect(required(out.content[0]).text).toContain("computed");
  });

  it("keeps a program that returns nothing well-formed", async () => {
    // The third guard path over the same question as issue #42: `undefined`
    // (and the other returns JSON renders as `undefined`) is serialized for
    // measurement, and the envelope simply carries no `result` key, since JSON
    // has no undefined. `null` is carried as null.
    const registry = makeRegistry([calcConnector]);
    const handler = createExecuteTool(
      registry,
      BASE,
      fakeExecutor({}),
      silentLogger,
    );
    const out = await handler({ code: "async () => {}" });
    expect(out.isError).toBeUndefined();
    const parsed = JSON.parse(required(out.content[0]).text) as Record<string, unknown>;
    expect("result" in parsed).toBe(false);

    const nulled = await createExecuteTool(
      registry,
      BASE,
      fakeExecutor({ result: null }),
      silentLogger,
    )({ code: "async () => null" });
    expect(JSON.parse(required(nulled.content[0]).text)).toEqual({ result: null });
  });

  it("truncates oversized results", async () => {
    const registry = makeRegistry([calcConnector]);
    const executor = fakeExecutor({ result: "x".repeat(100_000) });
    const handler = createExecuteTool(registry, BASE, executor, silentLogger);
    const out = await handler({ code: "async () => 1" });
    const parsed = JSON.parse(required(out.content[0]).text) as {
      result: { truncated: boolean; preview: string; totalChars: number };
    };
    expect(parsed.result.truncated).toBe(true);
    expect(parsed.result.preview.length).toBeLessThan(30_000);
    expect(parsed.result.totalChars).toBeGreaterThan(100_000);
  });

  it("cancels outstanding host calls when sandbox execution ends", async () => {
    let pending: Promise<unknown> | undefined;
    const hanging: Connector = {
      id: "hanging",
      kind: "api",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        return new Promise<never>(() => {});
      },
    };
    const executor: Executor = {
      async execute(_code, providers) {
        pending = callNamespace(providers, "hanging", "read");
        return { result: "finished" };
      },
    };
    const handler = createExecuteTool(
      makeRegistry([hanging]),
      BASE,
      executor,
      silentLogger,
    );
    const result = await handler({ code: "async () => 'finished'" });
    expect(result.isError).toBeFalsy();
    await expect(pending).rejects.toThrow();
  });
});
