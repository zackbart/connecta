import { afterEach, describe, expect, it } from "vitest";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import type { ConnectaConfigDescription } from "../src/describe-config.js";
import { createConnecta, customExecutor, type Connector, type InboundAuth } from "../src/index.js";
import { operatorUi, type OperatorUiContract } from "../src/ui.js";
import { SECRETS, VAULT_KEY, secretBearingDeployment } from "./fixtures/describe-config.js";

const BASE = "https://connecta.example";
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
const apps: Array<ReturnType<typeof createConnecta>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function deployment(config: Parameters<typeof createConnecta>[0]) {
  const app = createConnecta(config);
  apps.push(app);
  return app;
}
const human: InboundAuth = {
  kind: "human",
  interactiveOperator: true,
  activityActorNamespace: "directory",
  authorize: (request) => ({ ok: true, userId: request.headers.get("X-User") ?? "alice" }),
};
/** Operator routes serve maintainers only (#837); alice is one, in `human`'s namespace. */
const maintainers = ["alice"];
const tools = [
  { name: "read", description: "Read metadata", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "write" },
];
function connector(
  id: string,
  extra: Partial<Omit<Connector, "staticTools">> & { staticTools?: Connector["staticTools"] | null } = {},
): Connector {
  const { staticTools = tools, ...rest } = extra;
  return {
    id,
    ...(staticTools ? { staticTools } : {}),
    listTools: async () => tools,
    callTool: async () => null,
    ...rest,
  };
}
/** A maintainer's view, whose config and root are always present. */
type MaintainerView = OperatorUiContract & {
  config: ConnectaConfigDescription;
  root: NonNullable<OperatorUiContract["root"]>;
};
async function read(app: ReturnType<typeof createConnecta>, headers?: HeadersInit) {
  const response = await app.fetch(new Request(`${BASE}/ui/api/config`, headers ? { headers } : undefined));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = (await response.json()) as OperatorUiContract;
  expect(body).toMatchObject({ schemaVersion: 2, role: "maintainer" });
  return body as MaintainerView;
}

describe("operator config contract", () => {
  it("INV-5 INV-6: reuses the config sentinel set and excludes secrets, raw status, and credential metadata", async () => {
    const { config, vault, storage } = secretBearingDeployment();
    await vault.set("vaulted_mcp", SECRETS.storedCredential, "operator");
    await storage.set("access-token:sentinel", SECRETS.storedAccessToken);
    // Preserve every secret-bearing config position. A local status seam
    // avoids outbound calls while also trying to publish a secret in status.
    for (const c of config.connectors)
      c.status = async () => ({
        state: "error",
        message: SECRETS.headerValue,
        authorizationUrl: SECRETS.storedAccessToken,
      });
    const app = deployment(config);
    const data = await read(app, { Authorization: `Bearer ${SECRETS.machineToken}` });
    const json = JSON.stringify(data);
    for (const [position, secret] of Object.entries(SECRETS)) expect(json, position).not.toContain(secret);
    expect(json).not.toContain(VAULT_KEY);
    expect(json).not.toContain("lastFour");
    expect(json).not.toContain("SENTINEL");
    expect(data.config).toEqual(app.describeConfig());
    expect(data.you.interactive).toBe(false);
    // The machine operator is a maintainer: plain /mcp serves every connector whole, and every pool is listed.
    const root = data.matrix.filter((cell) => cell.pool === null);
    expect(root.every((cell) => cell.tools === "all")).toBe(true);
    expect(root.map((cell) => cell.connectorId)).toEqual(app.describeConfig().connectors.map((c) => c.id));
    expect(data.pools).toMatchObject([
      {
        name: "support",
        humanPath: "/mcp/support",
        agentPath: "/agent/support",
        readOnly: false,
        tools: [{ connectorId: "static_api", tools: "all" }],
      },
      {
        name: "support-agents",
        humanPath: "/mcp/support-agents",
        agentPath: "/agent/support-agents",
        readOnly: false,
        tools: [{ connectorId: "static_api", tools: "all" }],
      },
    ]);
  });

  it("INV-5: serves pool owner addresses only to an authenticated maintainer, never to an open deployment's anonymous caller", async () => {
    const pools = {
      mine: { tools: ["shared"], owner: "alice@example.com", members: [{ namespace: "directory", id: "alice" }] },
      group: {
        surface: "native" as const,
        executeCode: false as const,
        tools: ["shared"],
        members: [{ namespace: "directory", id: "bob" }],
      },
    };
    const open = deployment({
      connectors: [connector("shared")],
      executor,
      ui: operatorUi(),
      logger: "silent",
      readOnly: true,
      pools,
    });
    const anonymous = await read(open);
    expect(anonymous.config.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", null],
      ["group", null],
    ]);
    expect(anonymous.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", null],
      ["group", null],
    ]);
    expect(JSON.stringify(anonymous)).not.toContain("alice@example.com");
    expect(anonymous.config.pools.map((pool) => [pool.surface, pool.executeCode])).toEqual([
      ["meta", true],
      ["native", false],
    ]);
    expect(anonymous.pools.map((pool) => [pool.surface, pool.executeCode])).toEqual([
      ["meta", true],
      ["native", false],
    ]);
    // The local snapshot is the deployment's own and stays whole.
    expect(open.describeConfig().pools[0]?.owner).toBe("alice@example.com");

    const authenticated = deployment({
      connectors: [connector("shared")],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      readOnly: true,
      pools,
    });
    const maintainer = await read(authenticated);
    expect(maintainer.config.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", "alice@example.com"],
      ["group", null],
    ]);
    expect(maintainer.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", "alice@example.com"],
      ["group", null],
    ]);
  });

  it("INV-1 INV-6: allows catalog descriptions and schemas, withholds invalid names, and uses registry classification", async () => {
    const listing = [
      {
        name: "safe",
        description: "Authenticated catalog text",
        inputSchema: { type: "object", description: "schema text" },
        outputSchema: { type: "string" },
        annotations: { readOnlyHint: true },
        arbitrarySecret: "SENTINEL-extra",
      },
      { name: "space SENTINEL-name", description: "Allowed description", inputSchema: { type: "object" } },
      { name: "SENTINEL\ncontrol", description: "Dropped at intake" },
      { name: "contradiction", annotations: { readOnlyHint: true, destructiveHint: true } },
    ];
    const app = deployment({
      readOnly: false,
      connectors: [
        connector("svc", {
          staticTools: null,
          listTools: async () => listing,
          status: async () => ({ state: "ok", message: "SENTINEL-status" }),
        }),
      ],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      classification: { svc: { safe: "write" } },
    });
    const data = await read(app);
    expect(data.live.connectors[0]?.tools).toEqual([
      {
        name: "safe",
        address: "svc.safe",
        description: "Authenticated catalog text",
        inputSchema: { type: "object", description: "schema text" },
        outputSchema: { type: "string" },
        annotations: { readOnlyHint: false, destructiveHint: true },
        classification: "write",
      },
      {
        name: "<withheld>",
        address: "svc.<withheld>",
        description: "Allowed description",
        inputSchema: { type: "object" },
        classification: "write",
      },
      {
        name: "contradiction",
        address: "svc.contradiction",
        annotations: { readOnlyHint: true, destructiveHint: true },
        classification: "write",
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
    expect(data.live.connectors[0]?.catalogAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("INV-6 INV-4: last call includes only validated time/outcome from visible tools and the personal owner", async () => {
    const event = (connectorId: string, toolName: string, occurredAt: string, extra: Record<string, unknown> = {}) =>
      ({
        connectorId,
        toolName,
        occurredAt,
        outcome: "success",
        actor: { kind: "human", id: "alice", namespace: "directory" },
        ...extra,
      }) as unknown as ToolCallActivityEvent;
    const app = deployment({
      readOnly: false,
      connectors: [connector("svc"), connector("personal", { authScope: "personal" })],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      pools: { reader: { tools: ["svc.read"], members: ["alice"] } },
      activity: activityHistory({
        store: {
          record() {},
          list: async () => ({
            events: [
              // Outside the tools the pool it was recorded in declares.
              event("svc", "write", "2026-10-08T01:03:00.000Z", { pool: "reader" }),
              // Recorded in a pool that is no longer declared.
              event("svc", "read", "2026-10-08T01:04:00.000Z", { pool: "retired" }),
              event("svc", "read", "SENTINEL-time"),
              event("svc", "read", "2026-10-08T01:02:00.000Z", { outcome: "SENTINEL-outcome" }),
              event("svc", "read", "2026-10-08T01:01:00.000Z", {
                arguments: "SENTINEL-args",
                result: "SENTINEL-result",
                errorCode: "SENTINEL-error",
                outcome: "timeout",
              }),
              event("personal", "read", "2026-10-08T01:02:00.000Z", {
                actorBasis: "principal",
                actor: { kind: "human", id: "bob", namespace: "directory" },
              }),
              event("personal", "read", "2026-10-08T01:01:00.000Z"), // Legacy subject actor does not prove ownership.
              event("personal", "read", "2026-10-08T01:00:00.000Z", { actorBasis: "principal" }),
            ],
          }),
        },
      }),
    });
    const data = await read(app);
    expect(data.live.connectors.map((c) => c.lastCall)).toEqual([
      { at: "2026-10-08T01:01:00.000Z", outcome: "timeout" },
      { at: "2026-10-08T01:00:00.000Z", outcome: "success" },
    ]);
    expect(data.live.activity).toBe("available");
    for (const row of data.live.connectors) {
      const response = await app.fetch(new Request(`${BASE}/ui/connectors/${row.id}`));
      const detail = (await response.json()) as { overlay: { lastCall: unknown } };
      expect(detail.overlay.lastCall).toEqual(row.lastCall);
      expect(JSON.stringify(detail)).not.toContain("SENTINEL");
    }
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
  });

  it("INV-6: status and catalog failures are closed problem codes, and authorization hooks never run", async () => {
    let starts = 0;
    const app = deployment({
      readOnly: false,
      connectors: [
        connector("oauth", {
          status: async () => ({ state: "auth_required", message: "SENTINEL-status" }),
          startAuth: async () => {
            starts++;
            return { state: "error" };
          },
        }),
        connector("broken", {
          status: async () => {
            throw new Error("SENTINEL-status");
          },
        }),
        connector("catalog", {
          staticTools: null,
          status: async () => ({ state: "ok" }),
          listTools: async () => {
            throw new Error("SENTINEL-catalog");
          },
        }),
      ],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
    });
    const data = await read(app);
    expect(data.live.connectors.map((c) => c.problem)).toEqual([
      "oauth_required",
      "connector_unavailable",
      "catalog_failed",
    ]);
    expect(starts).toBe(0);
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
  });
  it("INV-7: a probe deadline produces a typed failure and closes every connector scope", async () => {
    const closed: string[] = [];
    let aborted = false;
    const app = deployment({
      readOnly: false,
      connectors: [
        connector("slow", {
          status: (ctx) =>
            new Promise((_resolve, reject) =>
              ctx.signal!.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("SENTINEL-abort"));
                },
                { once: true },
              ),
            ),
          closeScope: async () => {
            closed.push("slow");
          },
        }),
        connector("fast", {
          closeScope: async () => {
            closed.push("fast");
          },
        }),
      ],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      discovery: { probeTimeoutMs: 20, concurrency: 2 },
    });
    const data = await read(app);
    expect(data.live.connectors[0]).toMatchObject({ status: "error", problem: "connector_unavailable", tools: [] });
    expect(data.live.connectors[1]?.status).toBe("ok");
    expect(closed.sort()).toEqual(["fast", "slow"]);
    expect(aborted).toBe(true);
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
  });
});
