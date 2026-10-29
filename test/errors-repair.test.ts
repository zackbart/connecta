import { describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { connectorWith } from "./fixtures/connectors.js";
import { activitySink, createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";
import { machineAuth } from "./helpers/machine-auth.js";

const BASE = "https://connecta.test";

describe("repairing error envelopes", () => {
  it("INV-5: unresolved catalog recovery requires original arguments without echoing them", async () => {
    const call = vi.fn();
    const registry = makeRegistry([
      connectorWith({
        id: "private",
        kind: "api",
        tools: async () => {
          throw new ConnectorCallError("input_required_unsupported", "Use a direct call.");
        },
        call,
      }),
    ]);
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "private.submit",
      { password: "private-catalog-marker-12345" },
      { source: "execute_code", readOnly: false },
    );
    expect(outcome).toMatchObject({
      ok: false,
      dispatched: false,
      attempts: 0,
      error: {
        code: "input_required_unsupported",
        nextAction: {
          tool: "call_destructive_tool",
          arguments: { address: "private.submit" },
          purpose: expect.stringContaining("original arguments"),
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("private-catalog-marker-12345");
    expect(call).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "INV-5 INV-9: input-required retry hints omit writeOnly arguments, and a write gets none, on read=%s",
    async (readOnlyHint) => {
      const call = vi.fn(async () => {
        throw new ConnectorCallError("input_required_unsupported", "Use a direct call.");
      });
      const registry = makeRegistry([
        connectorWith({
          id: "private",
          kind: "api",
          tools: [
            {
              name: "submit",
              annotations: { readOnlyHint },
              inputSchema: {
                type: "object",
                properties: { target: { type: "string" }, password: { type: "string", writeOnly: true } },
              },
            },
          ],
          call,
        }),
      ]);
      const result = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
        "private.submit",
        { target: "p1", password: "private-password-marker" },
        { source: "execute_code", readOnly: false },
      );
      if (result.ok) throw new Error("Expected input-required failure");
      expect(call).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("private-password-marker");
      if (!readOnlyHint) {
        // The connector was entered and nothing proves the write unapplied.
        expect(result.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
        expect(result.error.nextAction).toBeUndefined();
        expect(result.error.retry).toMatch(/^Do not resend this write\. Re-read its target/);
        return;
      }
      expect(result).toMatchObject({
        ok: false,
        error: {
          nextAction: {
            tool: "call_tool",
            arguments: { address: "private.submit", args: { target: "p1" }, argsRedacted: true },
          },
        },
      });
      const action = result.error.nextAction;
      if (!action || !("tool" in action) || action.tool !== "call_tool")
        throw new Error("Expected direct-call recovery");
      expect(action.arguments["args"]).not.toHaveProperty("password");
      expect(action.purpose).toContain("original arguments");
    },
  );
  describe.each([undefined] as const)("direct-call result mode %s", (resultMode) => {
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
            validation: {
              acceptedKeys: ["mode", "count"],
              example: { mode: "fast", count: 1 },
              issues: [
                { path: "/mode", expected: 'one of "fast", "slow"', received: "string" },
                { path: "/count", expected: "integer, at least 1", received: "string" },
              ],
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

  it("INV-5 INV-6: a connector refusal's example comes only from the published schema", async () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        fields: { type: "array", items: { type: "string" } },
        token: { type: "string", writeOnly: true },
      },
      required: ["query"],
      additionalProperties: false,
    };
    const invoke = async (validation: Record<string, unknown>, args: Record<string, unknown>) => {
      const registry = makeRegistry([
        connectorWith({
          id: "notes",
          kind: "api",
          tools: [{ name: "find", annotations: { readOnlyHint: true }, inputSchema: schema }],
          call: async () => {
            throw new ConnectorCallError("invalid_args", "Bad.", {
              validation: { issues: [{ path: "/fields/0", expected: "a declared path" }], ...validation },
            });
          },
        }),
      ]);
      const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
        "notes.find",
        args,
        { source: "call_tool", readOnly: false },
      );
      if (outcome.ok) throw new Error("Expected refusal");
      return outcome.error;
    };
    const args = { query: "query-sentinel", fields: ["field-sentinel"], token: "token-sentinel" };
    // A connector's own copy of the call is replaced by the schema's synthesized example.
    for (const supplied of [{}, { example: args }]) {
      const error = await invoke(supplied, args);
      expect(error.validation).toMatchObject({ example: { query: "x" } });
      expect(error.retry).toContain("notes.find");
      expect(JSON.stringify(error)).not.toMatch(/sentinel/);
    }
    // A stated reason stands, and no example rides beside it.
    const withheld = await invoke({ exampleUnavailable: "Read notes_api_details." }, args);
    expect(withheld.validation).not.toHaveProperty("example");
    expect(withheld.validation?.exampleUnavailable).toBe("Read notes_api_details.");
    expect(JSON.stringify(withheld)).not.toMatch(/sentinel/);
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
