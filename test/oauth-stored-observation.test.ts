import { describe, expect, it, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { storedAuthObservation } from "../src/auth/stored-observation.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { identityStorageKey } from "../src/identity.js";
import { oauthSealerFor, vaultOAuthSealer } from "../src/oauth-sealing.js";
import { oauthGrantKeys, oauthV2Keys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { seedGrant } from "./fixtures/oauth.js";

const issuer = "https://issuer.example";
const redirect = "https://connecta.test/oauth/callback/crm";
const tokens = { access_token: "private-access", token_type: "Bearer", refresh_token: "private-refresh" };
const discovery = { authorizationServerUrl: issuer, authorizationServerMetadata: { issuer } };

describe("stored OAuth observation", () => {
  it("reads only valid bound tokens, without migrating, sealing or mutating auth", async () => {
    const storage = memoryStorage();
    const set = vi.spyOn(storage, "set");
    const cas = vi.spyOn(storage, "compareAndSet");
    const remove = vi.spyOn(storage, "delete");
    const seal = vi.fn(async () => "ciphertext");
    const provider = new KvOAuthProvider("crm", storage, redirect, undefined, false, {
      seal,
      open: async () => {
        throw new Error("wrong key");
      },
      warn() {},
    });
    const check = async (expected: boolean) => {
      set.mockClear();
      cas.mockClear();
      remove.mockClear();
      seal.mockClear();
      expect(await provider.storedAuthorization(issuer)).toBe(expected);
      expect(set).not.toHaveBeenCalled();
      expect(cas).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(seal).not.toHaveBeenCalled();
    };
    await check(false);
    await seedGrant(storage, { issuer, tokens });
    await check(true);
    await seedGrant(storage, { issuer });
    await check(false);
    await seedGrant(storage, { issuer: "https://other.example", tokens });
    await check(false);
    await seedGrant(storage, { issuer, tokens }, "disconnected:epoch");
    await check(false);
    await storage.set(
      oauthGrantKeys.grant,
      JSON.stringify({ connectaOAuth: 3, epoch: "v3:sealed", sealed: "unreadable" }),
    );
    await check(false);
    await storage.set(oauthGrantKeys.grant, "malformed");
    await check(false);
    await storage.delete(oauthGrantKeys.grant);
    await storage.set(oauthV2Keys.field.tokens, JSON.stringify({ value: tokens, issuer }));
    await check(false);
    expect(await storage.get(oauthGrantKeys.grant)).toBeNull();
  });

  it("validates dynamic discovery issuer and reads sealed tokens without resealing", async () => {
    const storage = memoryStorage();
    const vault = encryptedCredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const sealer = vaultOAuthSealer(vault, "crm", "alice", silentLogger)!;
    const writer = new KvOAuthProvider("crm", storage, redirect, undefined, true, sealer);
    await writer.saveTokens(tokens, { issuer });
    const before = await storage.get(oauthGrantKeys.grant);
    const provider = new KvOAuthProvider("crm", storage, redirect, undefined, false, sealer);
    expect(await provider.storedAuthorization(issuer)).toBe(true);
    expect(await provider.storedAuthorization()).toBe(false); // No trusted discovery yet.
    const wrongOwner = new KvOAuthProvider(
      "crm",
      storage,
      redirect,
      undefined,
      false,
      vaultOAuthSealer(vault, "crm", "bob", silentLogger),
    );
    expect(await wrongOwner.storedAuthorization(issuer)).toBe(false);
    expect(await storage.get(oauthGrantKeys.grant)).toBe(before);
    expect(await new KvOAuthProvider("crm", storage, redirect).storedAuthorization(issuer)).toBe(false);
    await seedGrant(storage, { issuer, tokens, discovery });
    expect(await provider.storedAuthorization()).toBe(true);
    await seedGrant(storage, { issuer: "https://other.example", tokens, discovery });
    expect(await provider.storedAuthorization()).toBe(false);
  });

  it("wires both built-in connectors, partitions owners, and leaves custom connectors unconfirmed", async () => {
    const connectors = [
      api("crm", {
        authScope: "personal",
        oauth: {
          authorizationEndpoint: `${issuer}/authorize`,
          tokenEndpoint: `${issuer}/token`,
          clientId: "client",
          apiOrigins: ["https://api.example"],
        },
        tools: [],
      }),
      remoteMcp("tickets", { url: "https://tickets.example/mcp", auth: { type: "oauth" }, authScope: "personal" }),
    ];
    const storage = memoryStorage();
    const vault = encryptedCredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const app = createTestConnecta({ connectors, storage, vault });
    try {
      for (const connector of connectors) {
        const observe = storedAuthObservation(connector)!;
        expect(observe).toBeTypeOf("function");
        const owner = async (id: string) =>
          app.registry
            .scoped({
              connectorIds: [connector.id],
              principalKey: await identityStorageKey({ namespace: "https://people.example", id }),
            })
            .contextFor(connector.id, "https://connecta.test", {});
        const alice = await owner("alice");
        const bob = await owner("bob");
        const tokenIssuer = connector.id === "crm" ? `${issuer}/token` : issuer;
        const writer = new KvOAuthProvider(
          connector.id,
          alice.storage,
          redirect,
          undefined,
          true,
          oauthSealerFor(alice),
        );
        await writer.saveTokens(tokens, { issuer: tokenIssuer });
        if (connector.id === "tickets") {
          // Seed complete discovery through the provider's own edge.
          await writer.saveDiscoveryState(discovery as never);
        }
        expect(await observe(alice)).toBe(true);
        expect(await observe(bob)).toBe(false);
      }
      expect(storedAuthObservation({ status: async () => ({ state: "ok" }) })).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
