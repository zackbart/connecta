import { describe, expect, it } from "vitest";
import type { ConnectaConfigDescription, DescribedConnector } from "../src/describe-config.js";
import { configSummary, connectorSummary } from "../src/operator-ui/config-summary.js";
import { activityHistory } from "../src/activity.js";
import { accessTokens } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";
import { OPERATOR_V2_MAINTAINER } from "./fixtures/operator-contract-v2.js";

const snapshot = () => structuredClone(OPERATOR_V2_MAINTAINER.config) as ConnectaConfigDescription;
const tile = (tiles: Array<{ label: string }>, label: string) => tiles.find((item) => item.label === label);

describe("config summary", () => {
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
});
