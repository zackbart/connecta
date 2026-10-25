import { credentialAttempt } from "./fixtures/oauth-credential-attempts.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { onTestFinished } from "vitest";
import { beforeEach as beforeTransportTest } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";

// Stand in for the Node host while preserving this suite's fetch leaves.
beforeTransportTest(() => {
  installOwnedTransport();
});

import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { describe, expect, it } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator, oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { classifyCallError } from "../src/errors.js";
import { oauthRefreshSpentKeys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import { tokens, store, adapter, nativeOAuthServer } from "./fixtures/oauth-native-sdk.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";

const server = (status: number) => nativeOAuthServer(`sdk-redirect-${status}`);

// Redirect handling is independent of storage timing, and 307 and 308 share
// one refusal path, so each case runs once on memory storage.
describe("native SDK token redirects on memory storage", () => {
  describe.each(["remoteMcp", "api"] as const)("%s", (kind) => {
    it.each([307])(
      "requires re-consent after HTTP %s refresh with one send and no follow (INV-5) (INV-9)",
      WORKERS,
      async (status) => {
        const endpoint = await server(status);
        const storage = store(false);
        const a = await adapter(kind, endpoint.issuer, storage);
        const oldEpoch = (await storedGrant(storage))!.epoch;
        await expect(a.read()).rejects.toSatisfy(
          (error: unknown) => classifyCallError(error).code === "downstream_oauth_required",
        );
        expect((await storedGrant(storage))!.body?.tokens).toBeUndefined();
        const spentKey = oauthRefreshSpentKeys.spent(await oauthStateDigest(tokens.refresh_token));
        expect(await storage.get(spentKey)).not.toBeNull();
        for (let attempt = 0; attempt < 3; attempt++) {
          // Even after the lease is removed, a same-epoch stale grant cannot resend.
          if (attempt) await a.connector.disconnectAuth!(a.context());
          await seedGrant(
            storage,
            {
              issuer: kind === "remoteMcp" ? endpoint.issuer : `${endpoint.issuer}/token`,
              tokens,
              ...(kind === "remoteMcp"
                ? { client: { value: { client_id: "native-client", token_endpoint_auth_method: "none" } } }
                : {}),
            },
            oldEpoch,
          );
          const newcomer = await adapter(kind, endpoint.issuer, storage, false);
          await expect(newcomer.read()).rejects.toSatisfy(
            (error: unknown) => classifyCallError(error).code === "downstream_oauth_required",
          );
          expect(await storage.get(spentKey)).not.toBeNull();
        }
        expect(await endpoint.sent()).toEqual([{ path: "token", grant: "refresh_token", credential: "old-refresh" }]);
      },
    );

    it.each([308])(
      "refuses HTTP %s code exchange without following or retrying the form (INV-5) (INV-9)",
      WORKERS,
      async (status) => {
        const endpoint = await server(status);
        const storage = store(false);
        const a = await adapter(kind, endpoint.issuer, storage, false);
        await expect(a.exchange()).rejects.toBeInstanceOf(Error);
        expect((await storedGrant(storage))!.body?.tokens).toBeUndefined();
        expect(await endpoint.sent()).toEqual([
          { path: "token", grant: "authorization_code", credential: "native-code" },
        ]);
      },
    );
  });
});

describe("native SDK token redirects on memory storage, remoteMcp", () => {
  it.each([307])(
    "allows an identical refresh token after new-epoch re-consent following HTTP %s (INV-5)",
    NODE,
    async (status) => {
      const endpoint = await server(status);
      const storage = store(false);
      const a = await adapter("remoteMcp", endpoint.issuer, storage);
      const oldEpoch = (await storedGrant(storage))!.epoch;
      await expect(a.read()).rejects.toBeInstanceOf(Error);
      const oldKey = oauthRefreshSpentKeys.spent(await oauthStateDigest(tokens.refresh_token));
      const spent = await storage.get(oldKey);
      expect(spent).not.toBeNull();
      await endpoint.success();
      await a.exchange();
      const grant = (await storedGrant(storage))!;
      expect(grant.epoch).not.toBe(oldEpoch);
      expect(grant.body!.tokens!.refresh_token).toBe(tokens.refresh_token);
      const fresh = await adapter("remoteMcp", endpoint.issuer, storage, false);
      await fresh.read();
      expect((await storedGrant(storage))!.body!.tokens).toMatchObject({
        access_token: "new-access",
        refresh_token: "new-refresh",
      });
      expect(JSON.parse((await storage.get(oldKey))!)).toMatchObject({ state: "resolved", epoch: grant.epoch });
      expect(
        await storage.get(oauthRefreshSpentKeys.spent(await oauthStateDigest(tokens.refresh_token))),
      ).not.toBeNull();
      expect(await endpoint.sent()).toEqual([
        { path: "token", grant: "refresh_token", credential: "old-refresh" },
        { path: "token", grant: "authorization_code", credential: "native-code" },
        { path: "token", grant: "refresh_token", credential: "old-refresh" },
      ]);
    },
  );
});

it.each([307])(
  "never follows HTTP %s for client credentials or token revocation (INV-5) (INV-9)",
  WORKERS,
  async (status) => {
    for (const body of [
      new URLSearchParams({ grant_type: "client_credentials", client_secret: "client-secret" }),
      "token=revoked-token&token_type_hint=refresh_token",
    ]) {
      const endpoint = await server(status);
      const provider = new KvOAuthProvider("svc", memoryStorage(), "https://connecta.test/oauth/callback/svc");
      const resourceFetch = () => {
        throw new Error("credential request reached redirect-following resource path");
      };
      const response = await new OAuthRefreshCoordinator().coordinatedFetch(
        provider,
        fetch,
        undefined,
        undefined,
        resourceFetch,
      )(`${endpoint.issuer}/token`, { method: "POST", body, redirect: "follow" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
      expect((await endpoint.sent()).map((request) => request.path)).toEqual(["token"]);
    }
  },
);

// The matching Node suite installs the real owned sender. Here these cases
// run only with workerd's production native network leaf, without a fake slot.
if (typeof WebSocketPair !== "undefined") {
  for (const kind of ["remoteMcp", "api"] as const)
    for (const operation of [
      "refresh",
      "code",
      ...(kind === "remoteMcp" ? (["register", "revoke"] as const) : []),
    ] as const)
      for (const challenge of ["421", "reset", "503"] as const)
        it(
          `INV-5 INV-9: workerd ${kind} ${operation} sends one physical body after ${challenge}`,
          WORKERS,
          async () => {
            const previous = configureGuardedTransport(undefined);
            onTestFinished(() => {
              configureGuardedTransport(previous);
            });
            await credentialAttempt(kind, operation, challenge);
          },
        );
}

if (typeof WebSocketPair !== "undefined")
  it("INV-5 INV-9: workerd SDK registration refuses a 307 without repeating the JSON body", WORKERS, async () => {
    const previous = configureGuardedTransport(undefined);
    onTestFinished(() => {
      configureGuardedTransport(previous);
    });
    await credentialAttempt("remoteMcp", "register", "307");
  });
