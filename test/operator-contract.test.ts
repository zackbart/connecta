import { afterEach, describe, expect, it } from "vitest";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { machineAuth } from "./helpers/machine-auth.js";
import { createConnecta, customExecutor, type Connector, type InboundAuth } from "../src/index.js";
import { operatorUi, type OperatorUiContract } from "../src/ui.js";
import { memoryStorage } from "../src/storage/memory.js";
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
async function read(app: ReturnType<typeof createConnecta>, headers?: HeadersInit) {
  const response = await app.fetch(new Request(`${BASE}/ui/api/config`, headers ? { headers } : undefined));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return (await response.json()) as OperatorUiContract;
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
  });

  it("INV-4: scopes config, live tools, grants, pools, trust, and management rights to each caller", async () => {
    const app = deployment({
      connectors: [connector("shared"), connector("personal", { authScope: "personal" }), connector("hidden")],
      executor,
      auth: human,
      ui: operatorUi(),
      logger: "silent",
      classification: { shared: { read: "read", write: "write" }, hidden: { read: "read" } },
      trust: "read-only",
      identity: {
        connectorAccess: (identity) => (identity.actor.id === "alice" ? ["shared.read", "personal"] : ["hidden"]),
        credentialAdministration: () => "all",
        personalConnection: () => ["personal"],
      },
      pools: {
        support: { tools: ["shared", "hidden"], trust: "trusted", grant: (identity) => identity.actor.id === "alice" },
        denied: { tools: ["hidden"], grant: () => false },
        throws: {
          tools: ["hidden"],
          grant: () => {
            throw new Error("SENTINEL-grant");
          },
        },
      },
    });
    const alice = await read(app);
    expect(alice.config.connectors.map((c) => c.id)).toEqual(["shared", "personal"]);
    expect(alice.config.connectors[0]?.tools?.map((t) => t.name)).toEqual(["read"]);
    expect(alice.config.classification).toEqual({ shared: { read: "read" } });
    expect(alice.config.pools).toEqual([
      { name: "support", path: "/mcp/support", trust: "trusted", hasGrant: true, tools: ["shared.read"] },
    ]);
    expect(alice.live.connectors[0]?.tools.map((t) => [t.address, t.classification])).toEqual([
      ["shared.read", "read"],
    ]);
    expect(alice.you).toMatchObject({
      trust: "read-only",
      pools: [
        {
          name: "support",
          trust: "trusted",
          grants: [{ connectorId: "shared", tools: [{ name: "read", requireReadOnly: false }] }],
        },
      ],
      permissions: {
        connectors: [
          { id: "shared", use: true, manageSharedAuth: true, connectPersonal: false },
          { id: "personal", use: true, manageSharedAuth: false, connectPersonal: true },
        ],
      },
    });
    expect(JSON.stringify(alice)).not.toMatch(/hidden|denied|throws|SENTINEL/);
    const bob = await read(app, { "X-User": "bob" });
    expect(bob.config.connectors.map((c) => c.id)).toEqual(["hidden"]);
    expect(bob.you.pools).toEqual([]);
    expect(bob.config.pools).toEqual([]);
    expect(app.describeConfig().connectors).toHaveLength(3);
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
      connectors: [
        connector("svc", {
          staticTools: null,
          listTools: async () => listing,
          status: async () => ({ state: "ok", message: "SENTINEL-status" }),
        }),
      ],
      executor,
      auth: human,
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

  it("INV-4 INV-1: guarded grants do not expose write metadata in the snapshot or live listing", async () => {
    const app = deployment({
      connectors: [connector("svc")],
      executor,
      auth: human,
      ui: operatorUi(),
      logger: "silent",
      identity: {
        connectorAccess: () => [
          { tool: "svc.write", requireReadOnly: true },
          { tool: "svc.read", requireReadOnly: true },
        ],
      },
    });
    const data = await read(app);
    expect(data.config.connectors[0]?.tools?.map((t) => t.name)).toEqual(["read"]);
    expect(data.live.connectors[0]?.tools.map((t) => t.name)).toEqual(["read"]);
    expect(data.you.grants[0]?.tools).toEqual([
      { name: "write", requireReadOnly: true },
      { name: "read", requireReadOnly: true },
    ]);
  });

  it("INV-10: catalog age reports completed observations and static catalogs have no age", async () => {
    const storage = memoryStorage();
    const app = deployment({
      connectors: [
        connector("things", { staticTools: null, status: async () => ({ state: "ok" }), listTools: async () => tools }),
        connector("static"),
      ],
      storage,
      executor,
      auth: human,
      ui: operatorUi(),
      logger: "silent",
    });
    const data = await read(app);
    expect(data.live.connectors[0]?.catalogAgeMs).toBeGreaterThanOrEqual(0);
    expect(data.live.connectors[1]?.catalogAgeMs).toBeNull();
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
      connectors: [connector("svc"), connector("personal", { authScope: "personal" })],
      executor,
      auth: human,
      ui: operatorUi(),
      logger: "silent",
      identity: { connectorAccess: () => ["svc.read", "personal"] },
      activity: activityHistory({
        store: {
          record() {},
          list: async () => ({
            events: [
              event("svc", "write", "2026-10-08T01:03:00.000Z"),
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
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
  });

  it.each(["forbidden", "gate_throws", "unavailable", "machine", "unconfigured"])(
    "INV-4 INV-6: handles %s activity without widening access or returning errors",
    async (mode) => {
      let calls = 0;
      const app = deployment({
        connectors: [connector("svc")],
        executor,
        auth: mode === "machine" ? machineAuth("token") : human,
        ui: operatorUi(),
        logger: "silent",
        ...(mode === "unconfigured"
          ? {}
          : {
              activity: activityHistory({
                readGate: () => {
                  if (mode === "gate_throws") throw new Error("SENTINEL-gate");
                  return mode !== "forbidden";
                },
                store: {
                  record() {},
                  list: async () => {
                    calls++;
                    throw new Error("SENTINEL-store");
                  },
                },
              }),
            }),
      });
      const data = await read(app, { Authorization: "Bearer token" });
      expect(data.live.activity).toBe(mode === "machine" || mode === "gate_throws" ? "forbidden" : mode);
      expect(data.live.connectors[0]?.lastCall).toBeNull();
      expect(data.you.permissions.activity).toBe(mode === "unavailable");
      expect(calls).toBe(mode === "unavailable" ? 1 : 0);
      expect(JSON.stringify(data)).not.toContain("SENTINEL");
    },
  );

  it("INV-4 INV-10: preserves the data-route auth challenge, rejects mutations, and requires the UI module", async () => {
    const app = deployment({
      connectors: [],
      executor,
      auth: machineAuth("token"),
      ui: operatorUi(),
      logger: "silent",
    });
    const response = await app.fetch(new Request(`${BASE}/ui/api/config`));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    for (const method of ["POST", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const refusal = await app.fetch(new Request(`${BASE}/ui/api/config`, { method }));
      expect(refusal.status).toBe(405);
    }
    const noUi = deployment({ connectors: [], executor, logger: "silent" });
    expect((await noUi.fetch(new Request(`${BASE}/ui/api/config`))).status).toBe(404);
  });

  it("INV-6: status and catalog failures are closed problem codes, and authorization hooks never run", async () => {
    let starts = 0;
    const app = deployment({
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

  it("INV-7: cancelling an activity read never starts its next page", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (value: { events: ToolCallActivityEvent[]; nextCursor: string }) => void;
    const page = new Promise<{ events: ToolCallActivityEvent[]; nextCursor: string }>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const app = deployment({
      connectors: [connector("svc")],
      executor,
      auth: human,
      ui: operatorUi(),
      logger: "silent",
      activity: activityHistory({
        store: {
          record() {},
          list: async () => {
            calls++;
            entered();
            return page;
          },
        },
      }),
    });
    const controller = new AbortController();
    const pending = app
      .fetch(new Request(`${BASE}/ui/api/config`, { signal: controller.signal }))
      .catch(() => undefined);
    await started;
    controller.abort();
    await pending;
    release({ events: [], nextCursor: "next" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
  });
});
