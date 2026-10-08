import { describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { describeConfigSources } from "../src/config-value-sources.js";
import { customExecutor, remoteMcp } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";

const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });

describe("factory configuration provenance", () => {
  it.each([undefined, {}, { maxActive: 100 }])(
    "INV-10: distinguishes omitted and explicit accessTokens maxActive: %j",
    async (options) => {
      const storage = memoryStorage();
      const module = accessTokens(storage, options);
      const raw = {
        executor,
        publicUrl: "https://connecta.example",
        logger: "silent" as const,
        connectors: [],
        storage,
        accessTokens: module,
      };
      const app = createTestConnecta(raw);
      try {
        expect(app.describeConfig().modules.accessTokens.maxActive).toBe(100);
        expect(describeConfigSources(app.describeConfig(), raw)["config.modules.accessTokens.maxActive"]).toBe(
          options?.maxActive === undefined ? "default" : "config",
        );
        expect(module.describe?.().optionSources?.maxActive).toBe(
          options?.maxActive === undefined ? "default" : "config",
        );
      } finally {
        await app.close();
      }
    },
  );

  it.each([{}, { versionNegotiation: "auto" as const, redirects: "none" as const, requireHttps: false }])(
    "INV-10: distinguishes omitted and explicit remoteMcp transport defaults: %j",
    async (transport) => {
      const connector = remoteMcp("remote", { url: "https://remote.example/mcp", ...transport });
      const raw = {
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
    const raw = { executor, publicUrl: "https://connecta.example", logger: "silent" as const, connectors: [connector] };
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
});
