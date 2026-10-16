import { describe, expect, it } from "vitest";
import type { ConnectaConfigDescription, DescribedConnector } from "../src/describe-config.js";
import {
  configSummary,
  connectorSummary,
  formatValue,
  humanizeKey,
  inferFormat,
} from "../src/operator-ui/config-summary.js";
import { activityHistory } from "../src/activity.js";
import { accessTokens } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";
import { OPERATOR_V2_MAINTAINER } from "./fixtures/operator-contract-v2.js";

const snapshot = () => structuredClone(OPERATOR_V2_MAINTAINER.config) as ConnectaConfigDescription;
const tile = (tiles: Array<{ label: string }>, label: string) => tiles.find((item) => item.label === label);

describe("config summary formatting", () => {
  it("formats bytes, durations, counts and switches for a glance", () => {
    expect(formatValue(1_000_000, "bytes")).toBe("1 MB");
    expect(formatValue(24_000, "bytes")).toBe("24 KB");
    expect(formatValue(8 * 1024 * 1024, "bytes")).toBe("8 MB");
    expect(formatValue(512, "bytes")).toBe("512 B");
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
    expect(summary.limits.slice(0, 4).map(({ label, value, set }) => [label, value, set])).toEqual([
      ["Tool timeout", "No limit", false],
      ["Result cap", "1 MB", true],
      ["Program timeout", "2 min", false],
      ["Catalog refresh", "5 min", false],
    ]);
    // A non-headline limit set in code joins the large tiles; the rest stay small.
    expect(tile(summary.limits, "Probe timeout")).toMatchObject({ value: "5 s", set: true });
    expect(tile(summary.moreLimits, "Probe timeout")).toBeUndefined();
    expect(summary.moreLimits.every((item) => !item.set)).toBe(true);
    expect(tile(summary.moreLimits, "Concurrent programs")).toMatchObject({ value: "2" });
    expect([...summary.limits, ...summary.moreLimits].every((item) => !/^(true|false)$/.test(item.value))).toBe(true);
  });

  it("maps sign-in, features, overrides and deployment facts", () => {
    const config = snapshot();
    config.auth = [
      { kind: "cloudflare-access", interactive: true, ui: "cloudflare-access" },
      { kind: "access_token", interactive: false },
      { kind: "magic-link", interactive: true },
    ];
    config.classification = { github: { search_code: "read", merge: "write" } };
    config.modules.activity = { enabled: true, readable: true, store: { kind: "d1", retentionDays: 30 } };
    const summary = configSummary(config);
    expect(summary.signIn.map(({ label, mark, interactive }) => [label, mark, interactive])).toEqual([
      ["Cloudflare Access", "access", true],
      ["Agent tokens", "tokens", false],
      ["Magic link", "other", true],
    ]);
    expect(summary.features.map(({ label, on }) => [label, on])).toEqual([
      ["Operator UI", config.modules.ui.enabled],
      ["Vault", config.modules.vault.enabled],
      ["Activity", true],
      ["Agent tokens", config.modules.accessTokens.enabled],
      ["Read-only", false],
    ]);
    expect(summary.overrides).toEqual([
      { address: "github.search_code", classification: "read" },
      { address: "github.merge", classification: "write" },
    ]);
    expect(tile(summary.limits, "Activity kept")).toMatchObject({ value: "30 days" });
    expect(Object.fromEntries(summary.deployment.map((fact) => [fact.label, fact.value]))).toMatchObject({
      Name: "Production",
      Version: "1",
      Connecta: "0.33.0",
      URL: "connecta.example",
      Origins: "Default",
      Sandbox: "quickjs",
      History: "D1",
    });
    expect(summary.other).toEqual([]);
  });

  it("keeps a key it does not know as a humanized tile, never dropping it", () => {
    const config = snapshot() as ConnectaConfigDescription & Record<string, unknown>;
    config.region = "eu-west";
    (config.server as Record<string, unknown>).maxIconBytes = 2048;
    (config.modules as Record<string, unknown>).audit = { enabled: true, mode: "strict" };
    (config.limits.calls as Record<string, unknown>).maxRetries = { value: 3, source: "config" };
    const summary = configSummary(config, { "config.region": "config" });
    expect(summary.other.map(({ label, value, set }) => [label, value, set])).toEqual([
      ["Max icon", "2 KB", false],
      ["Audit mode", "strict", false],
      ["Region", "eu-west", true],
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
    expect(summary.agents).toEqual([]);
    expect(Object.fromEntries(summary.deployment.map((fact) => [fact.label, fact.value]))).toMatchObject({
      Connectors: "0",
      Pools: "0",
    });
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
    expect(summary.badges.map((badge) => badge.label)).toEqual([
      "Remote MCP",
      "crm",
      "Per person",
      "OAuth",
      "crm.example/mcp",
    ]);
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
    expect(summary.badges.map((badge) => badge.label).slice(0, 3)).toEqual(["HTTP API", "Shared account", "API key"]);
    expect(tile(summary.tiles, "Result cap")).toMatchObject({ value: "64 KB", set: true });
    expect(tile(summary.tiles, "Region")).toMatchObject({ value: "eu" });
  });
});
