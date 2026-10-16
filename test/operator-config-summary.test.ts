import { describe, expect, it } from "vitest";
import type { ConnectaConfigDescription, DescribedConnector } from "../src/describe-config.js";
import {
  configSummary,
  connectorSummary,
  exactBytes,
  formatValue,
  humanizeKey,
  inferFormat,
} from "../src/operator-ui/config-summary.js";
import { activityHistory } from "../src/activity.js";
import { accessTokens } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createConnecta } from "../src/index.js";
import { createTestConnecta } from "./helpers.js";
import { secretBearingDeployment } from "./fixtures/describe-config.js";
import { OPERATOR_V2_MAINTAINER } from "./fixtures/operator-contract-v2.js";

const snapshot = () => structuredClone(OPERATOR_V2_MAINTAINER.config) as ConnectaConfigDescription;
const tile = (tiles: Array<{ label: string }>, label: string) => tiles.find((item) => item.label === label);

describe("config summary formatting", () => {
  it("formats bytes, durations, counts and switches for a glance", () => {
    // Sizes use decimal units throughout; the exact count is the tooltip.
    expect(formatValue(1_000_000, "bytes")).toBe("1 MB");
    expect(formatValue(24_000, "bytes")).toBe("24 KB");
    expect(formatValue(8 * 1024 * 1024, "bytes")).toBe("8.4 MB");
    expect(formatValue(65_536, "bytes")).toBe("65.5 KB");
    expect(formatValue(512, "bytes")).toBe("512 B");
    expect(exactBytes(8 * 1024 * 1024)).toBe("8,388,608 bytes");
    expect(formatValue(60_000, "ms")).toBe("1 min");
    expect(formatValue(90_000, "ms")).toBe("90 s");
    expect(formatValue(5_400_000, "ms")).toBe("90 min");
    expect(formatValue(15_000, "ms")).toBe("15 s");
    expect(formatValue(250, "ms")).toBe("250 ms");
    expect(formatValue(86_400, "seconds")).toBe("1 day");
    expect(formatValue(300, "seconds")).toBe("5 min");
    expect(formatValue(30, "days")).toBe("30 days");
    expect(formatValue(1, "days")).toBe("1 day");
    expect(formatValue(1_234_567, "count")).toBe("1,234,567");
    expect(formatValue(true, "toggle")).toBe("On");
    expect(formatValue(false, "count")).toBe("Off");
    expect(formatValue(null, "ms")).toBe("None");
    expect(formatValue(["a", "b"], "text")).toBe("a, b");
  });

  it("infers a format from the key's unit and humanizes the key without it", () => {
    expect(inferFormat("probeTimeoutMs", 5)).toBe("ms");
    expect(inferFormat("catalogTtlSeconds", 5)).toBe("seconds");
    expect(inferFormat("maxStashBytes", 5)).toBe("bytes");
    expect(inferFormat("retentionDays", 5)).toBe("days");
    expect(inferFormat("maxWrites", 5)).toBe("count");
    expect(inferFormat("sealsOAuth", true)).toBe("toggle");
    expect(humanizeKey("maxStashEntries")).toBe("Max stash entries");
    expect(humanizeKey("probeTimeoutMs")).toBe("Probe timeout");
    expect(humanizeKey("sealsOAuth")).toBe("Seals OAuth");
    expect(humanizeKey("deployment_region")).toBe("Deployment region");
  });
});

describe("config summary", () => {
  it("labels every limit and tells a value set in code from a default", () => {
    const config = snapshot();
    config.limits.calls.maxResultBytes = { value: 1_000_000, source: "config" };
    config.limits.discovery.probeTimeoutMs = { value: 5_000, source: "config" };
    const summary = configSummary(config, { "config.limits.calls.maxResultBytes": "config" });
    // A null tool timeout falls back to the host-call timeout, a default.
    expect(config.limits.calls.defaultTimeoutMs.value).toBeNull();
    expect(summary.limits.slice(0, 4).map(({ label, value, set }) => [label, value, set])).toEqual([
      ["Tool timeout", "15 s", false],
      ["Result cap", "1 MB", true],
      ["Program timeout", "2 min", false],
      ["Catalog refresh", "5 min", false],
    ]);
    expect(tile(summary.limits, "Result cap")).toMatchObject({ title: "1,000,000 bytes" });
    // A non-headline limit set in code joins the large tiles; the rest fold into group cards.
    expect(tile(summary.limits, "Probe timeout")).toMatchObject({ value: "5 s", set: true });
    const defaults = summary.defaults.flatMap((group) => group.tiles);
    expect(tile(defaults, "Probe timeout")).toBeUndefined();
    expect(defaults.every((item) => !item.set)).toBe(true);
    expect(summary.defaults.map((group) => [group.title, group.tiles.map((item) => item.label)])).toEqual([
      ["Discovery", ["Concurrency", "Min refresh", "Max refresh"]],
      ["Results", ["Stash size", "Stash entries"]],
      ["Programs", ["Output", "Output blocks", "Call timeout", "Concurrency", "Queue", "Queue wait", "Retry after"]],
      ["Requests", ["Queue", "Queue wait", "Retry after", "Lifetime"]],
    ]);
    expect(summary.defaults[1]!.tiles[0]).toMatchObject({ value: "8.4 MB", title: "8,388,608 bytes" });
    expect([...summary.limits, ...defaults].every((item) => !/^(true|false)$/.test(item.value))).toBe(true);
  });

  it("reads a tool timeout set in code as set, and keeps every limit somewhere", () => {
    const config = snapshot();
    config.limits.calls.defaultTimeoutMs = { value: 30_000, source: "config" };
    const summary = configSummary(config);
    expect(tile(summary.limits, "Tool timeout")).toMatchObject({ value: "30 s", set: true });
    const drawn = summary.limits.length + summary.defaults.reduce((total, group) => total + group.tiles.length, 0);
    const limits = Object.values(config.limits).flatMap((group) => Object.keys(group)).length;
    const admission = config.executor.admission === "executor" ? 0 : Object.keys(config.executor.admission).length;
    const retention = config.modules.activity.store?.retentionDays === undefined ? 0 : 1;
    expect(drawn).toBe(limits + admission + retention);
  });

  it("maps sign-in, features, overrides and deployment facts", () => {
    const config = snapshot();
    config.auth = [
      { kind: "cloudflare-access", interactive: true, ui: "cloudflare-access" },
      { kind: "access_token", interactive: false },
      { kind: "magic-link", interactive: true },
    ];
    config.classification = { github: { search_code: "read", merge: "write" } };
    config.modules.activity = {
      enabled: true,
      readable: true,
      deploymentId: "prod-1",
      store: { kind: "d1", retentionDays: 30 },
    };
    config.modules.vault = { enabled: true, sealsOAuth: true };
    config.agents = ["claude-desktop", "triage", "nightly"];
    const summary = configSummary(config);
    expect(summary.signIn.map(({ label, mark, interactive, count }) => [label, mark, interactive, count])).toEqual([
      ["Cloudflare Access", "access", true, undefined],
      ["Agent tokens", "tokens", false, "3 agents"],
      ["Magic link", "other", true, undefined],
    ]);
    // The UI module is on whenever Settings draws; read-only is a deployment mode.
    expect(summary.features.map(({ label, on, detail }) => [label, on, detail])).toEqual([
      ["Vault", true, "Seals OAuth"],
      ["Activity", true, undefined],
      ["Agent tokens", config.modules.accessTokens.enabled, undefined],
    ]);
    expect(summary.overrides).toEqual([
      { address: "github.search_code", classification: "read" },
      { address: "github.merge", classification: "write" },
    ]);
    // Retention is a default unless the store reports code set it.
    expect(tile(summary.limits, "Activity kept")).toMatchObject({ value: "30 days", set: false });
    expect(
      tile(configSummary(config, { "config.modules.activity.store.retentionDays": "config" }).limits, "Activity kept"),
    ).toMatchObject({ set: true });
    expect(summary.deployment.map((fact) => [fact.label, fact.value])).toEqual(
      expect.arrayContaining([
        ["Name", "Production · v1"],
        ["Mode", "Writes allowed"],
        ["Connecta", "0.33.0"],
        ["URL", "connecta.example"],
        ["Origins", "Default"],
        ["Sandbox", "quickjs"],
        ["History", "D1"],
        ["Deployment ID", "prod-1"],
      ]),
    );
    expect(summary.deployment.map((fact) => fact.label)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(Version|Connectors|Pools|ID)$/)]),
    );
    config.readOnly = true;
    expect(configSummary(config).deployment.find((fact) => fact.id === "mode")?.value).toBe("Read-only");
    expect(summary.other).toEqual([]);
  });

  it("warns on unconfigured memory storage, which a restart empties", () => {
    const config = snapshot();
    config.storage = { configured: false, kind: "memory" };
    expect(configSummary(config).deployment.find((fact) => fact.id === "storage")).toMatchObject({
      value: "Memory · default",
      tone: "warn",
    });
    config.storage = { configured: true, kind: "memory" };
    expect(configSummary(config).deployment.find((fact) => fact.id === "storage")).toMatchObject({ value: "Memory" });
    expect(configSummary(config).deployment.find((fact) => fact.id === "storage")).not.toHaveProperty("tone");
  });

  it("keeps a key it does not know as a humanized tile, never dropping it", () => {
    const config = snapshot() as ConnectaConfigDescription & Record<string, unknown>;
    config.region = "eu-west";
    (config.server as Record<string, unknown>).maxIconBytes = 2048;
    (config.modules as Record<string, unknown>).audit = { enabled: true, mode: "strict" };
    (config.limits.calls as Record<string, unknown>).maxRetries = { value: 3, source: "config" };
    // The server reports an unknown path as "config", so that alone sets nothing.
    const summary = configSummary(config, { "config.region": "config", "config.server.maxIconBytes": "config" });
    expect(summary.other.map(({ label, value, set }) => [label, value, set])).toEqual([
      ["Max icon", "2 KB", false],
      ["Audit mode", "strict", false],
      ["Region", "eu-west", false],
    ]);
    expect(tile(summary.features, "Audit")).toMatchObject({ on: true, icon: "box" });
    expect(tile(summary.limits, "Max retries")).toMatchObject({ value: "3", set: true });
  });

  it("draws an empty deployment without inventing anything", () => {
    const config = snapshot();
    config.auth = [];
    config.connectors = [];
    config.pools = [];
    config.agents = [];
    const summary = configSummary(config);
    expect(summary.signIn).toEqual([]);
    expect(summary.overrides).toEqual([]);
    expect(summary.other).toEqual([]);
    expect(summary.deployment.map((fact) => fact.id)).toEqual(expect.arrayContaining(["name", "mode", "connecta"]));
  });

  it("maps every key a real deployment's snapshot carries today", async () => {
    const storage = memoryStorage();
    const app = createTestConnecta({
      connectors: [],
      storage,
      logger: "silent",
      accessTokens: accessTokens(storage),
      activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }),
      classification: {},
    });
    try {
      expect(configSummary(app.describeConfig()).other).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("connector summary", () => {
  const connector = (): DescribedConnector => ({
    id: "crm",
    title: "CRM",
    authScope: "personal",
    source: { kind: "remote-mcp", provider: "crm" },
    endpoint: { origin: "https://crm.example", path: "/mcp" },
    auth: { mode: "oauth" },
    transport: { redirects: "none", requireHttps: true },
    maxResultBytes: { value: 24_000, source: "deployment" },
    callAdmission: { rules: [{ maxConcurrency: 4, budget: { maxCalls: 100, windowMs: 60_000 }, partitioned: true }] },
  });

  it("reads what the connector is as badges and its limits as tiles", () => {
    const summary = connectorSummary(connector(), { "config.connectors.crm.transport.requireHttps": "config" });
    expect(summary.badges.map((badge) => badge.label)).toEqual(["Remote MCP", "crm", "Per person", "crm.example/mcp"]);
    expect(summary.auth.map((badge) => badge.label)).toEqual(["OAuth"]);
    expect(summary.tiles.map(({ label, value, set }) => [label, value, set])).toEqual([
      ["Result cap", "24 KB", false],
      ["Concurrency", "4", true],
      ["Call budget", "100 / 1 min", true],
      ["Per caller", "On", true],
      ["Redirects", "None", false],
      ["HTTPS only", "On", true],
    ]);
  });

  it("names a credential connector's auth and keeps unknown connector keys", () => {
    const { auth: _, ...rest } = connector();
    const value = {
      ...rest,
      authScope: "shared",
      source: { kind: "api" },
      credential: { label: "API key" },
      maxResultBytes: { value: 65_536, source: "connector" },
      region: "eu",
    } as DescribedConnector;
    const summary = connectorSummary(value);
    expect(summary.badges.map((badge) => badge.label).slice(0, 2)).toEqual(["HTTP API", "Shared account"]);
    expect(summary.auth.map((badge) => badge.label)).toEqual(["API key"]);
    expect(tile(summary.tiles, "Result cap")).toMatchObject({ value: "65.5 KB", set: true, title: "65,536 bytes" });
    expect(tile(summary.tiles, "Region")).toMatchObject({ value: "eu", set: false });
  });

  it("draws a connector's auth details as compact badges", () => {
    const summary = connectorSummary({
      ...connector(),
      auth: {
        mode: "oauth",
        scope: "read write",
        apiOrigins: ["https://api.crm.example"],
        authorizationEndpoint: { origin: "https://auth.crm.example", path: "/authorize" },
        tokenEndpoint: { origin: "https://auth.crm.example", path: "/token" },
        tokenEndpointAuthMethod: "client_secret_basic",
        confidentialClient: true,
        pkce: true,
        authorizationParamNames: ["access_type"],
        tokenRequestHeaderNames: ["X-Token-Auth"],
      },
    });
    expect(summary.auth.map(({ prefix, label }) => (prefix ? `${prefix} ${label}` : label))).toEqual([
      "OAuth",
      "Scope read write",
      "→ api.crm.example",
      "Authorize auth.crm.example/authorize",
      "Token auth.crm.example/token",
      "client_secret_basic",
      "Client secret",
      "PKCE",
      "?access_type",
      "X-Token-Auth",
    ]);
    const headers = connectorSummary({
      ...connector(),
      auth: { mode: "credential", header: "Authorization", scheme: "Bearer" },
      credential: {
        label: "Token",
        fields: [
          { name: "token", label: "Token" },
          { name: "subdomain", label: "Subdomain" },
        ],
      },
    });
    expect(headers.auth.map((badge) => badge.label)).toEqual(["Token", "token", "subdomain", "Authorization: Bearer"]);
    const static_ = connectorSummary({ ...connector(), auth: { mode: "headers", headerNames: ["X-Api-Key"] } });
    expect(static_.auth.map((badge) => [badge.label, badge.mono ?? false])).toEqual([
      ["Headers", false],
      ["X-Api-Key", true],
    ]);
  });

  it("maps every key the built-in connectors describe today", async () => {
    const { config } = secretBearingDeployment();
    const app = createConnecta(config);
    try {
      for (const described of app.describeConfig().connectors) {
        const base = `config.connectors.${described.id}.`;
        const drawn = /^(maxResultBytes|callAdmission\.|transport\.)/;
        const other = connectorSummary(described).tiles.filter((item) => !drawn.test(item.id.slice(base.length)));
        expect(other, described.id).toEqual([]);
      }
    } finally {
      await app.close();
    }
  });
});
