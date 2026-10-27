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
import { memoryStorage } from "../src/storage/memory.js";
import { operatorUi } from "../src/ui.js";
import { SECRETS, VAULT_KEY, secretBearingDeployment } from "./fixtures/describe-config.js";

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
      readOnly: false,
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

  it("INV-5: describes a store by its shipped kind and retention, and any other store as custom", async () => {
    // Construction and describeConfig() run no statement, so a binding that
    // answers nothing stands in for D1.
    const db = { prepare: () => ({ bind: () => ({}) }), batch: async () => [] } as never;
    const shipped = createConnecta({
      readOnly: false,
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
    const custom = createConnecta({ readOnly: false, connectors: [], executor, logger: "silent", storage: smuggling });
    expect(custom.describeConfig().storage).toEqual({ configured: true, kind: "custom" });
    expect(JSON.stringify(custom.describeConfig())).not.toContain("SENTINEL");
    await custom.close();
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

  it.each(URLS)("INV-11: serverInfo.websiteUrl refuses %s without echoing it", (_, url) => {
    let error: unknown;
    try {
      createConnecta({ readOnly: false, connectors: [], executor, logger: "silent", serverInfo: { websiteUrl: url } });
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
      readOnly: false,
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
