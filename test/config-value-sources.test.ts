import { describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { activityHistory } from "../src/activity.js";
import { d1ActivityStore } from "../src/d1.js";
import { describeConfigSources } from "../src/config-value-sources.js";
import { customExecutor, remoteMcp } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { KVStorage } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";
import { TEST_MACHINE_NAMESPACE, machineAuth } from "./helpers/machine-auth.js";

const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });

describe("factory configuration provenance", () => {
  it.each([undefined, [], ["simon", "ci"]])(
    "INV-10: distinguishes omitted and declared agents without writing: %j",
    async (agents) => {
      const base = memoryStorage();
      const writes: string[] = [];
      const storage: KVStorage = {
        ...base,
        set: (key, ...rest) => (writes.push(key), base.set(key, ...rest)),
        delete: (key) => (writes.push(key), base.delete(key)),
        compareAndSet: (key, ...rest) => (writes.push(key), base.compareAndSet(key, ...rest)),
      };
      const raw = {
        readOnly: false,
        executor,
        publicUrl: "https://connecta.example",
        logger: "silent" as const,
        connectors: [],
        storage,
        accessTokens: accessTokens(storage),
        ...(agents === undefined ? {} : { agents }),
      };
      const app = createTestConnecta(raw);
      try {
        expect(app.describeConfig().agents).toEqual(agents ?? []);
        const sources = describeConfigSources(app.describeConfig(), raw);
        const agentSources = Object.entries(sources).filter(([path]) => path.startsWith("config.agents"));
        expect(agentSources.length).toBeGreaterThan(0);
        for (const [, source] of agentSources) expect(source).toBe(agents === undefined ? "default" : "config");
        expect(sources["config.modules.accessTokens.enabled"]).toBe("config");
        // Describing the agents and their provenance reads configuration only.
        expect(writes).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  it("INV-10: reports declared maintainers as configuration", async () => {
    const raw = {
      readOnly: false,
      executor,
      publicUrl: "https://connecta.example",
      logger: "silent" as const,
      connectors: [],
      auth: machineAuth("provenance-token"),
      maintainers: [{ namespace: TEST_MACHINE_NAMESPACE, id: "machine" }],
    };
    const app = createTestConnecta(raw);
    try {
      expect(app.describeConfig().maintainers).toEqual([{ namespace: TEST_MACHINE_NAMESPACE, id: "machine" }]);
      const sources = Object.entries(describeConfigSources(app.describeConfig(), raw)).filter(([path]) =>
        path.startsWith("config.maintainers"),
      );
      expect(sources.length).toBeGreaterThan(0);
      for (const [, source] of sources) expect(source).toBe("config");
    } finally {
      await app.close();
    }
  });

  it.each([{}, { versionNegotiation: "auto" as const, redirects: "none" as const, requireHttps: false }])(
    "INV-10: distinguishes omitted and explicit remoteMcp transport defaults: %j",
    async (transport) => {
      const connector = remoteMcp("remote", { url: "https://remote.example/mcp", ...transport });
      const raw = {
        readOnly: false,
        executor,
        publicUrl: "https://connecta.example",
        logger: "silent" as const,
        connectors: [connector],
      };
      const app = createTestConnecta(raw);
      try {
        const snapshot = app.describeConfig();
        expect(snapshot.connectors[0]!.transport).toEqual({
          versionNegotiation: "auto",
          redirects: "none",
          requireHttps: false,
        });
        const sources = describeConfigSources(snapshot, raw);
        for (const key of ["versionNegotiation", "redirects", "requireHttps"]) {
          expect(sources[`config.connectors.remote.transport.${key}`]).toBe(
            Object.hasOwn(transport, key) ? "config" : "default",
          );
        }
        expect(sources["config.connectors.remote.endpoint.origin"]).toBe("config");
        expect(sources["config.connectors.remote.auth.mode"]).toBe("default");
        expect(snapshot.connectors[0]).not.toHaveProperty("optionSources");
      } finally {
        await app.close();
      }
    },
  );

  it("INV-10: keeps mixed transport options independent and captures presence at construction", async () => {
    const options: { url: string; redirects: "none"; requireHttps?: boolean } = {
      url: "https://remote.example/mcp",
      redirects: "none",
    };
    const connector = remoteMcp("remote", options);
    options.requireHttps = true;
    const raw = {
      readOnly: false,
      executor,
      publicUrl: "https://connecta.example",
      logger: "silent" as const,
      connectors: [connector],
    };
    const app = createTestConnecta(raw);
    try {
      const sources = describeConfigSources(app.describeConfig(), raw);
      expect(sources["config.connectors.remote.transport.requireHttps"]).toBe("default");
      expect(sources["config.connectors.remote.transport.redirects"]).toBe("config");
      expect(sources["config.connectors.remote.transport.versionNegotiation"]).toBe("default");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["store default", () => d1ActivityStore(D1), "default"],
    ["set in code", () => d1ActivityStore(D1, { retentionDays: 30 }), "config"],
    ["unreported", () => ({ record() {}, describe: () => ({ kind: "custom", retentionDays: 7 }) }), "default"],
  ] as const)(
    "INV-10: reads activity retention as set only when the store reports it: %s",
    async (_, store, source) => {
      const raw = {
        readOnly: false,
        executor,
        publicUrl: "https://connecta.example",
        logger: "silent" as const,
        connectors: [],
        activity: activityHistory({ store: store() }),
      };
      const app = createTestConnecta(raw);
      try {
        const sources = describeConfigSources(app.describeConfig(), raw);
        expect(sources["config.modules.activity.store.retentionDays"]).toBe(source);
        expect(sources["config.modules.activity.store.kind"]).toBe("config");
        expect(app.describeConfig().modules.activity.store).not.toHaveProperty("optionSources");
      } finally {
        await app.close();
      }
    },
  );
});

const D1 = { prepare: () => ({ bind: () => ({}) }), batch: async () => [] } as never;
