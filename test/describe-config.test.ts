// Connecta.describeConfig(): the secret-free configuration snapshot the
// operator UI and `connecta doctor --config` read.
//
// The sentinel suite plants a distinct secret in every position that can
// carry one — header values, machine and Clerk secrets, vault keys, OAuth
// client secrets, URL userinfo and queries, stored credentials and access
// tokens, function bodies — and asserts none survives serialization. The
// snapshot is an allowlist serializer, so a secret added to a config object
// later stays out by construction; this suite is what notices if it does not.

import { describe, expect, it } from "vitest";
import { activityHistory } from "../src/activity.js";
import { d1ActivityStore, d1Storage } from "../src/d1.js";
import { createConnecta, customExecutor, remoteMcp, type Connector } from "../src/index.js";
import { describedEndpoint, describedHref, describedOrigin, describedUrl } from "../src/described.js";
import { memoryStorage } from "../src/storage/memory.js";
import { operatorUi } from "../src/ui.js";
import { CONNECTA_VERSION } from "../src/version.js";
import { SECRETS, VAULT_KEY, secretBearingDeployment } from "./fixtures/describe-config.js";

const BASE = "https://connecta.example";
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });

describe("describeConfig", () => {
  it("INV-5: plants a secret in every secret-bearing position and serializes none of them", async () => {
    const { config, storage, vault } = secretBearingDeployment();
    // Stored material exists before construction: a stored credential and a
    // managed client token. The snapshot reads configuration, never storage.
    await vault.set("vaulted_mcp", SECRETS.storedCredential, "operator");
    await storage.set("access-token:sentinel", SECRETS.storedAccessToken);
    const app = createConnecta(config);
    try {
      const json = JSON.stringify(app.describeConfig());
      for (const [position, secret] of Object.entries(SECRETS)) {
        expect(json.includes(secret), `${position} leaked`).toBe(false);
      }
      expect(json.includes(VAULT_KEY), "vault key leaked").toBe(false);
      expect(json).not.toContain("SENTINEL");
      // Functions became facts, not source.
      expect(json).not.toContain("=>");
      expect(json).not.toContain("function");
    } finally {
      await app.close();
    }
  });

  it("INV-5: every built-in describe() is secret-free on its own, before describeConfig re-validates it", async () => {
    const { config } = secretBearingDeployment();
    // The published contract holds for a direct call: an operator tool may
    // read connector.describe() without going through describeConfig().
    const builtIn = config.connectors.filter((connector) => connector.id !== "custom_conn");
    const outputs = [
      ...builtIn.map((connector) => [connector.id, connector.describe?.()] as const),
      ["accessTokens module", config.accessTokens.describe?.()] as const,
    ];
    for (const [where, described] of outputs) {
      expect(described, `${where} describes itself`).toBeDefined();
      const json = JSON.stringify(described);
      for (const [position, secret] of Object.entries(SECRETS)) {
        expect(json.includes(secret), `${where}: ${position} leaked`).toBe(false);
      }
      expect(json, where).not.toContain("SENTINEL");
    }
    const byId = Object.fromEntries(builtIn.map((connector) => [connector.id, connector.describe?.()]));
    expect(byId.oauth_mcp?.auth?.clientMetadataUrl).toBe("https://client.example/cimd.json");
    expect(byId.studio?.auth?.clientMetadataUrl).toBe("https://client.example/basecamp-client");
  });

  it("INV-5: reduces every branding URL to origin and path, and a relative favicon to its path", async () => {
    const { config } = secretBearingDeployment();
    const app = createConnecta(config);
    try {
      expect(app.describeConfig().branding).toMatchObject({
        productUrl: "https://brand.example/product",
        ownerUrl: "https://owner.example/",
        faviconHref: "https://cdn.example/icon.svg",
      });
    } finally {
      await app.close();
    }
    const relative = createConnecta({
      connectors: [],
      executor,
      logger: "silent",
      ui: operatorUi({
        branding: { favicon: { href: `/brand/icon.svg?sig=${SECRETS.faviconQuery}#${SECRETS.faviconFragment}` } },
      }),
    });
    try {
      const json = JSON.stringify(relative.describeConfig());
      expect(relative.describeConfig().branding.faviconHref).toBe("/brand/icon.svg");
      expect(json).not.toContain("SENTINEL");
    } finally {
      await relative.close();
    }
  });

  it("describes connectors by source, endpoint, auth mode, and static tools", async () => {
    const { config } = secretBearingDeployment();
    const app = createConnecta(config);
    try {
      const snapshot = app.describeConfig();
      const byId = Object.fromEntries(snapshot.connectors.map((connector) => [connector.id, connector]));
      expect(byId.static_mcp).toMatchObject({
        source: { kind: "remote-mcp" },
        endpoint: { origin: "https://mcp.example.com", path: "/mcp" },
        auth: { mode: "headers", headerNames: ["Authorization", "X-Api-Key"] },
        transport: { versionNegotiation: "auto", redirects: "none", requireHttps: false },
        maxResultBytes: { value: 24_000, source: "deployment" },
      });
      expect(byId.oauth_mcp?.auth).toEqual({
        mode: "oauth",
        scope: "read",
        clientMetadataUrl: "https://client.example/cimd.json",
      });
      expect(byId.vaulted_mcp).toMatchObject({
        auth: { mode: "credential", header: "X-Key", scheme: null },
        credential: { label: "API key" },
      });
      expect(byId.static_api).toMatchObject({
        source: { kind: "api" },
        auth: {
          mode: "oauth",
          authorizationEndpoint: { origin: "https://auth.example", path: "/authorize" },
          tokenEndpoint: { origin: "https://auth.example", path: "/token" },
          apiOrigins: ["https://api.example"],
          tokenEndpointAuthMethod: "client_secret_basic",
          confidentialClient: true,
          pkce: true,
          authorizationParamNames: ["access_type"],
          tokenRequestHeaderNames: ["X-Token-Auth"],
        },
        callAdmission: {
          rules: [{ maxConcurrency: 2, budget: { maxCalls: 10, windowMs: 1_000 }, partitioned: true }],
        },
      });
      expect(byId.static_api?.tools?.map(({ name, classification }) => [name, classification])).toEqual([
        ["read", "read"],
        ["write", "write"],
      ]);
      expect(byId.static_api?.tools?.[0]?.inputSchema).toEqual({
        type: "object",
        properties: { id: { type: "string" } },
      });
      expect(byId.church?.source).toEqual({ kind: "api", provider: "ccb" });
      expect(byId.billing?.source).toEqual({ kind: "remote-mcp", provider: "stripe" });
      expect(byId.billing?.usageGuide?.summary).toEqual(expect.any(String));
      expect(byId.tracker?.source).toEqual({ kind: "remote-mcp", provider: "linear" });
      // A custom describe() is re-validated: unknown fields are dropped and
      // endpoints are re-parsed down to origin and path.
      expect(byId.custom_conn).toEqual({
        id: "custom_conn",
        authScope: "shared",
        source: { kind: "custom" },
        endpoint: { origin: "https://custom.example", path: "/p" },
        auth: { mode: "headers", headerNames: ["X-Key"] },
        maxResultBytes: { value: 24_000, source: "deployment" },
      });
    } finally {
      await app.close();
    }
  });

  it("describes a connector without describe() as custom", async () => {
    const app = createConnecta({
      connectors: [{ id: "bare", listTools: async () => [], callTool: async () => null }],
      executor,
      logger: "silent",
    });
    expect(app.describeConfig().connectors).toEqual([
      {
        id: "bare",
        authScope: "shared",
        source: { kind: "custom" },
        maxResultBytes: { value: 24_000, source: "deployment" },
      },
    ]);
    await app.close();
  });

  it("reports deployment facts, limits with their sources, and modules", async () => {
    const { config } = secretBearingDeployment();
    const app = createConnecta({
      ...config,
      discovery: { concurrency: 2 },
      calls: { defaultTimeoutMs: 9_000 },
      execute: { maxHostCalls: 7 },
      classification: { static_api: { read: "write" } },
      trust: "trusted",
      admission: { requests: { concurrency: 4 } },
    });
    try {
      const snapshot = app.describeConfig();
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        connectaVersion: CONNECTA_VERSION,
        server: {
          name: "connecta",
          version: CONNECTA_VERSION,
          websiteUrl: { origin: "https://about.example", path: "/connecta" },
          icons: 1,
        },
        urls: { publicUrl: { origin: BASE, path: "/" }, mcpPath: "/mcp", allowedOrigins: "default" },
        executor: { admission: { concurrency: { value: 2, source: "default" } } },
        trust: "trusted",
        classification: { static_api: { read: "write" } },
        auth: [
          { kind: "access_token", interactive: false },
          { kind: "access_token", interactive: false },
          { kind: "clerk", interactive: true, ui: "clerk" },
        ],
        identity: {
          connectorAccess: "custom",
          activityAccess: "default",
          credentialAdministration: "custom",
          accessTokenManagement: "default",
          personalConnection: "default",
        },
        pools: [{ name: "support", path: "/mcp/support", tools: ["static_api"], hasGrant: true }],
        modules: {
          ui: { enabled: true },
          vault: { enabled: true, sealsOAuth: true },
          activity: { enabled: true, readable: false, deploymentId: "production", store: { kind: "custom" } },
          accessTokens: { enabled: true, maxActive: 100 },
        },
        storage: { configured: true, kind: "memory" },
        branding: { productName: "Connecta" },
        deploymentInfo: ["token"],
      });
      expect(snapshot.limits.discovery.concurrency).toEqual({ value: 2, source: "config" });
      expect(snapshot.limits.discovery.probeTimeoutMs).toEqual({ value: 30_000, source: "default" });
      expect(snapshot.limits.calls.defaultTimeoutMs).toEqual({ value: 9_000, source: "config" });
      expect(snapshot.limits.calls.maxResultBytes).toEqual({ value: 24_000, source: "default" });
      expect(snapshot.limits.execute.maxHostCalls).toEqual({ value: 7, source: "config" });
      expect(snapshot.limits.execute.watchdogMs).toEqual({ value: 120_000, source: "default" });
      expect(snapshot.limits.results.maxStashEntries).toEqual({ value: 64, source: "default" });
      expect(snapshot.limits.requests.concurrency).toEqual({ value: 4, source: "config" });
      expect(snapshot.limits.requests.maxDurationMs).toEqual({ value: 300_000, source: "default" });
      // Built once and frozen: every call returns the same snapshot.
      expect(app.describeConfig()).toBe(snapshot);
      expect(Object.isFrozen(snapshot.connectors[0])).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("INV-5: describes a store by its shipped kind and retention, and any other store as custom", async () => {
    // Construction and describeConfig() run no statement, so a binding that
    // answers nothing stands in for D1.
    const db = { prepare: () => ({ bind: () => ({}) }), batch: async () => [] } as never;
    const shipped = createConnecta({
      connectors: [],
      executor,
      logger: "silent",
      storage: d1Storage(db),
      activity: activityHistory({ store: d1ActivityStore(db, { retentionDays: 30 }) }),
    });
    expect(shipped.describeConfig().storage).toEqual({ configured: true, kind: "d1" });
    expect(shipped.describeConfig().modules.activity.store).toEqual({ kind: "d1", retentionDays: 30 });
    await shipped.close();
    const smuggling = { ...memoryStorage(), describe: () => ({ kind: SECRETS.storeDescribe }) };
    const custom = createConnecta({ connectors: [], executor, logger: "silent", storage: smuggling });
    expect(custom.describeConfig().storage).toEqual({ configured: true, kind: "custom" });
    expect(JSON.stringify(custom.describeConfig())).not.toContain("SENTINEL");
    await custom.close();
  });

  it("reports an unset default timeout as null and an executor-owned code pool", async () => {
    const admitting = customExecutor(
      {
        execute: async () => ({ result: null }),
        acquire: async () => ({ execute: async () => ({ result: null }), release() {} }),
      } as never,
      { lifecycle: "self-managed" },
    );
    const app = createConnecta({ connectors: [], executor: admitting, logger: "silent" });
    const snapshot = app.describeConfig();
    expect(snapshot.limits.calls.defaultTimeoutMs).toEqual({ value: null, source: "default" });
    expect(snapshot.executor.admission).toBe("executor");
    expect(snapshot.storage).toEqual({ configured: false, kind: "memory" });
    expect(snapshot.modules).toEqual({
      ui: { enabled: false },
      vault: { enabled: false },
      activity: { enabled: false },
      accessTokens: { enabled: false },
    });
    await app.close();
  });
});

describe("non-web URL schemes", () => {
  const SENTINEL = "SENTINEL-scheme-secret";
  // `blob:`-style schemes wrap a URL: the parser reports the inner origin
  // while `pathname` is the whole inner URL, userinfo included. The rest carry
  // their payload in the path. None is a web URL, so each is omitted.
  const URLS = [
    ["blob:", `blob:https://u:${SENTINEL}@example.com/id`],
    ["blob: over http", `blob:http://u:${SENTINEL}@example.com/id`],
    ["data:", `data:text/plain,${SENTINEL}`],
    ["javascript:", `javascript:alert("${SENTINEL}")`],
    ["file:", `file:///home/u/${SENTINEL}`],
    ["a nested filesystem: URL", `filesystem:https://u:${SENTINEL}@example.com/temporary/x`],
    ["a nested view-source: URL", `view-source:https://u:${SENTINEL}@example.com/x`],
    ["a nested jar: URL", `jar:https://u:${SENTINEL}@example.com/a.jar!/x`],
    ["ftp:", `ftp://u:${SENTINEL}@example.com/x`],
  ] as const;

  it.each(URLS)("INV-5: the described-URL helpers omit %s", (_, url) => {
    expect(describedEndpoint(url)).toBeUndefined();
    expect(describedEndpoint(new URL(url))).toBeUndefined();
    expect(describedUrl(url)).toBeUndefined();
    expect(describedOrigin(url)).toBeUndefined();
    expect(describedHref(url)).toBeUndefined();
  });

  it.each(URLS)("INV-11: serverInfo.websiteUrl refuses %s without echoing it", (_, url) => {
    let error: unknown;
    try {
      createConnecta({ connectors: [], executor, logger: "silent", serverInfo: { websiteUrl: url } });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain(
      "ConnectaConfig.serverInfo.websiteUrl must be an absolute http(s) URL without credentials.",
    );
    expect(String(error)).not.toContain(SENTINEL);
  });

  it.each(URLS)("INV-11: remoteMcp() refuses a %s url without echoing it", (_, url) => {
    let error: unknown;
    try {
      remoteMcp("docs", { url });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('connector "docs" url must be an http(s) URL.');
    expect(String(error)).not.toContain(SENTINEL);
  });

  it("INV-5: omits a non-web endpoint a custom describe() reports, and a non-web branding URL", async () => {
    const connectors: Connector[] = URLS.flatMap(([, url], index) => [
      {
        id: `string_${index}`,
        listTools: async () => [],
        callTool: async () => null,
        describe: () => ({ source: { kind: "custom" }, endpoint: url }) as never,
      },
      {
        id: `pair_${index}`,
        listTools: async () => [],
        callTool: async () => null,
        describe: () =>
          ({
            source: { kind: "custom" },
            endpoint: { origin: url, path: "/p" },
            auth: { mode: "oauth", authorizationEndpoint: url, tokenEndpoint: url, clientMetadataUrl: url },
          }) as never,
      },
    ]);
    const [, blob] = URLS[0];
    const app = createConnecta({
      connectors,
      executor,
      logger: "silent",
      ui: operatorUi({ branding: { productUrl: blob, ownerUrl: blob, favicon: { href: blob } } }),
    });
    try {
      const described = app.describeConfig();
      expect(JSON.stringify(described)).not.toContain(SENTINEL);
      for (const connector of described.connectors) expect(connector.endpoint, connector.id).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
