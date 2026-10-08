import { describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { InvocationService } from "../src/invocation.js";
import { machineAuth } from "./helpers/machine-auth.js";
import { connectorWith } from "./fixtures/connectors.js";
import { activitySink, createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

describe("repairing error envelopes", () => {
  describe.each([undefined, "mcp", "value"] as const)("direct-call result mode %s", (resultMode) => {
    it("INV-4 INV-6 INV-9: preserves every repair envelope in structured content and agent text", async () => {
      const warn = vi.fn();
      const target = activitySink();
      const create = vi.fn(async () => {
        throw new ConnectorCallError("timeout", "downstream-text-sentinel");
      });
      const registry = makeRegistry(
        [
          connectorWith({
            id: "args",
            kind: "mcp",
            tools: [
              {
                name: "read",
                annotations: { readOnlyHint: true },
                inputSchema: {
                  type: "object",
                  properties: {
                    mode: { type: "string", enum: ["fast", "slow"] },
                    count: { type: "integer", minimum: 1 },
                  },
                  required: ["mode", "count"],
                  additionalProperties: false,
                },
              },
            ],
          }),
          ...(["credential", "oauth", "permission"] as const).map((id) =>
            connectorWith({
              id,
              kind: id === "oauth" ? "mcp" : "api",
              tools: [{ name: "read", annotations: { readOnlyHint: true } }],
              ...(id === "oauth" ? { startAuth: async () => ({ state: "auth_required" as const }) } : {}),
              call: async () => {
                throw new ConnectorCallError(
                  id === "permission" ? "provider_permission_denied" : "auth_required",
                  "downstream-text-sentinel",
                );
              },
            }),
          ),
          connectorWith({
            id: "notes",
            kind: "api",
            tools: [{ name: "create", annotations: { readOnlyHint: false } }],
            call: create,
          }),
        ],
        { logger: { ...silentLogger, warn } },
      );
      const mt = createMetaTools(registry, BASE, { activity: target.activity });
      const mode = resultMode === undefined ? {} : { resultMode };
      const cases = [
        [
          await mt.callTool({ address: "args.read", args: { mode: "wrong", count: "argument-sentinel" }, ...mode }),
          {
            code: "invalid_args",
            retryable: false,
            repair: {
              acceptedKeys: ["mode", "count"],
              example: { mode: "fast", count: 1 },
              issues: expect.arrayContaining([
                expect.objectContaining({ enumValues: ["fast", "slow"] }),
                expect.objectContaining({ receivedType: "string", bounds: { minimum: 1 } }),
              ]),
            },
          },
        ],
        [
          await mt.callTool({ address: "credential.read", ...mode }),
          {
            code: "auth_required",
            retryable: false,
            recovery: "unavailable",
            nextAction: { tool: "authorize_connector", arguments: { connector: "credential" } },
          },
        ],
        [
          await mt.callTool({ address: "oauth.read", ...mode }),
          {
            code: "downstream_oauth_required",
            retryable: false,
            recovery: "oauth",
            nextAction: { tool: "authorize_connector", arguments: { connector: "oauth" } },
          },
        ],
        [
          await mt.callTool({ address: "permission.read", ...mode }),
          { code: "provider_permission_denied", retryable: false, retry: expect.stringContaining("administrator") },
        ],
        [
          await mt.callTool({ address: "missing.read", ...mode }),
          {
            code: "unknown_address",
            retryable: false,
            configuredConnectors: ["args", "credential", "oauth", "permission", "notes"],
          },
        ],
        [
          await mt.callDestructiveTool({ address: "notes.create", args: { title: "argument-sentinel" }, ...mode }),
          {
            code: "write_outcome_unknown",
            retryable: false,
            uncertainCall: { address: "notes.create", args: { title: "argument-sentinel" } },
            retry: expect.stringContaining("Do not retry automatically"),
          },
        ],
      ] as const;
      for (const [result, error] of cases) {
        expect(result.isError, error.code).toBe(true);
        const text = JSON.parse(result.content[0]!.text);
        expect(text).toEqual(result.structuredContent);
        expect(text).toMatchObject({ ok: false, error, attempts: expect.any(Number), durationMs: expect.any(Number) });
      }
      expect(create).toHaveBeenCalledTimes(1);
      const records = JSON.stringify([warn.mock.calls, target.events]);
      expect(records).not.toContain("argument-sentinel");
      expect(records).not.toContain("downstream-text-sentinel");
      expect(records).not.toContain("acceptedKeys");
      expect(records).not.toContain("uncertainCall");
    });
  });

  it("INV-4: an unknown connector lists only connectors in this endpoint's registry view", async () => {
    const registry = makeRegistry(["visible", "private"].map((id) => connectorWith({ id, kind: "api" })));
    const scoped = registry.scoped({ connectorIds: ["visible"] });
    const catalog = new CatalogService(scoped, BASE);
    const outcome = await new InvocationService(scoped, catalog).invoke("missing.read", {}, { source: "call_tool" });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unknown_address", configuredConnectors: ["visible"] } });
    expect(JSON.stringify(outcome)).not.toContain("private");
    const descriptions = await catalog.describe({ addresses: ["missing.read"] });
    expect(descriptions[0]?.errorDetails?.configuredConnectors).toEqual(["visible"]);
    const search = await catalog.search({ query: "read", connector: "private" });
    expect(search.queryAnalysis).toMatchObject({ unknownConnector: true, configuredConnectors: ["visible"] });
    expect(search.queryAnalysis?.guidance).toContain("Configured connectors for this endpoint: visible");
  });

  it("INV-6 INV-9: a dispatched write timeout echoes the uncertain call only to the agent and is never repeated", async () => {
    const warn = vi.fn();
    const call = vi.fn(async (_name: string, args: unknown) => {
      (args as { title: string }).title = "mutated-by-connector";
      throw new ConnectorCallError("timeout", "upstream deadline");
    });
    const registry = makeRegistry(
      [
        connectorWith({
          id: "notes",
          kind: "api",
          tools: [{ name: "create", annotations: { readOnlyHint: false } }],
          call,
        }),
      ],
      { logger: { ...silentLogger, warn } },
    );
    const target = activitySink();
    const invocation = new InvocationService(registry, new CatalogService(registry, BASE), target.activity);
    const args = { title: "argument-sentinel" };
    const outcome = await invocation.invoke("notes.create", args, { source: "call_destructive_tool" });
    expect(outcome).toMatchObject({
      ok: false,
      dispatched: true,
      attempts: 1,
      error: {
        code: "write_outcome_unknown",
        retryable: false,
        uncertainCall: { address: "notes.create", args: { title: "argument-sentinel" } },
      },
    });
    if (outcome.ok) throw new Error("Expected failure");
    expect(outcome.error.message).toContain("outcome is unknown");
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("argument-sentinel");
    expect(JSON.stringify(target.events)).not.toContain("argument-sentinel");
    const oversized = await invocation.invoke(
      "notes.create",
      { title: "x".repeat(2000) },
      { source: "call_destructive_tool" },
    );
    expect(oversized).toMatchObject({
      ok: false,
      error: { uncertainCall: { address: "notes.create", argsOmitted: true } },
    });
    if (!oversized.ok) expect(oversized.error.uncertainCall).not.toHaveProperty("args");
  });

  it("INV-9: a write that times out before dispatch has no uncertain call", async () => {
    const call = vi.fn();
    const registry = makeRegistry([
      connectorWith({
        id: "notes",
        kind: "api",
        tools: async () => {
          throw new ConnectorCallError("timeout", "catalog deadline");
        },
        call,
      }),
    ]);
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "notes.create",
      {},
      { source: "call_destructive_tool" },
    );
    expect(outcome).toMatchObject({ ok: false, dispatched: false, error: { code: "timeout" } });
    if (!outcome.ok) expect(outcome.error).not.toHaveProperty("uncertainCall");
    expect(call).not.toHaveBeenCalled();
  });

  it("INV-6: OAuth and provider permissions have different recovery actions", async () => {
    const registry = makeRegistry([
      connectorWith({
        id: "oauth",
        kind: "mcp",
        tools: [{ name: "read", annotations: { readOnlyHint: true } }],
        startAuth: async () => ({ state: "auth_required" }),
        call: async () => {
          throw new ConnectorCallError("auth_required", "missing grant");
        },
      }),
      connectorWith({
        id: "permission",
        kind: "api",
        tools: [{ name: "read", annotations: { readOnlyHint: true } }],
        call: async () => {
          throw new ConnectorCallError("provider_permission_denied", "scope denied");
        },
      }),
    ]);
    const invocation = new InvocationService(registry, new CatalogService(registry, BASE));
    const oauth = await invocation.invoke("oauth.read", {}, { source: "call_tool" });
    expect(oauth).toMatchObject({
      ok: false,
      error: {
        code: "downstream_oauth_required",
        recovery: "oauth",
        nextAction: { tool: "authorize_connector", arguments: { connector: "oauth" } },
      },
    });
    const permission = await invocation.invoke("permission.read", {}, { source: "call_tool" });
    expect(permission).toMatchObject({
      ok: false,
      error: { code: "provider_permission_denied", retryable: false, retry: expect.stringContaining("administrator") },
    });
    if (!permission.ok) expect(permission.error).not.toHaveProperty("nextAction");
  });

  it("INV-4: host authentication carries its own code and preserves the HTTP challenge", async () => {
    const connecta = createTestConnecta({
      connectors: [],
      auth: machineAuth("test-token"),
      publicUrl: BASE,
      logger: silentLogger,
    });
    const response = await connecta.fetch(new Request(`${BASE}/mcp`));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({
      error: {
        code: "host_auth_required",
        message: expect.stringContaining("host"),
        retryable: false,
        recovery: "host_connection",
      },
    });
    await connecta.close();
  });
});
