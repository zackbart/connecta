import { describe, expect, it, vi } from "vitest";
import { oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { classifyCallError } from "../src/errors.js";
import { oauthRefreshSpentKeys } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { adapter, nativeOAuthServer, store, tokens } from "./fixtures/oauth-native-sdk.js";
import { storedGrant } from "./fixtures/oauth.js";

const required = (error: unknown) => classifyCallError(error).code === "downstream_oauth_required";
const refresh = { path: "token", grant: "refresh_token", credential: tokens.refresh_token };
const consent = { path: "token", grant: "authorization_code", credential: "native-code" };
const spentKey = async () => oauthRefreshSpentKeys.spent(await oauthStateDigest(tokens.refresh_token));
const spent = async (storage: KVStorage) =>
  JSON.parse((await storage.get(await spentKey()))!) as { state: string; epoch: string; resolvedAt?: number };

describe("native SDK refresh resolution on delayed storage", () => {
  describe.each(["remoteMcp", "api"] as const)("%s", (kind) => {
    it("blocks a held refresh across Restart and identical-token consent, including after the earlier refresh resolves (INV-5) (INV-9)", async () => {
      const endpoint = await nativeOAuthServer("sdk-pending-first");
      const storage = store(true);
      const a = await adapter(kind, endpoint.issuer, storage);
      let completed = false;
      const first = a.read().then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        },
      );
      await vi.waitFor(async () => expect(await endpoint.sent()).toEqual([refresh]));
      expect(completed).toBe(false);
      expect(await spent(storage)).toMatchObject({ state: "outstanding", epoch: "v3:seeded" });
      const state = await a.start();
      const beforeConsent = await adapter(kind, endpoint.issuer, storage, false);
      await expect(beforeConsent.read()).rejects.toSatisfy(required);
      expect(await endpoint.sent()).toEqual([refresh]);
      await a.finish(state);
      const consentGrant = (await storage.get("oauth:grant"))!;
      const grant = (await storedGrant(storage))!;
      expect(grant.epoch).not.toBe("v3:seeded");
      expect(grant.body!.tokens).toMatchObject({ access_token: "consent-access", refresh_token: tokens.refresh_token });
      expect(completed).toBe(false);
      const newcomer = await adapter(kind, endpoint.issuer, storage, false);
      await expect(newcomer.read()).rejects.toSatisfy(required);
      expect(completed).toBe(false);
      expect(await endpoint.sent()).toEqual([refresh, consent]);
      expect(await spent(storage)).toMatchObject({ state: "outstanding", epoch: "v3:seeded" });
      await endpoint.finish();
      await first;
      expect(await spent(storage)).toMatchObject({
        state: "resolved",
        epoch: "v3:seeded",
        resolvedAt: expect.any(Number),
      });
      // This consent completed before resolution. Resolution alone cannot
      // retroactively authorize it, even after Restart swept the old lease.
      await storage.set("oauth:grant", consentGrant);
      const afterResolution = await adapter(kind, endpoint.issuer, storage, false);
      await expect(afterResolution.read()).rejects.toSatisfy(required);
      expect(await endpoint.sent()).toEqual([refresh, consent]);
    });

    it("keeps an ambiguous fingerprint blocked after identical-token consent and recovers with a different token (INV-5) (INV-9)", async () => {
      const endpoint = await nativeOAuthServer("sdk-ambiguous-first");
      const storage = store(true);
      const a = await adapter(kind, endpoint.issuer, storage);
      await expect(a.read()).rejects.toSatisfy(required);
      expect(await spent(storage)).toMatchObject({ state: "ambiguous", epoch: "v3:seeded" });
      const ambiguous = await storage.get(await spentKey());
      await endpoint.success();
      await a.exchange();
      const fresh = await adapter(kind, endpoint.issuer, storage, false);
      await expect(fresh.read()).rejects.toSatisfy(required);
      expect(await storage.get(await spentKey())).toBe(ambiguous);
      expect(await endpoint.sent()).toEqual([refresh, consent]);
      await endpoint.mode("sdk-consent-different");
      await a.exchange();
      const recovered = await adapter(kind, endpoint.issuer, storage, false);
      await recovered.read();
      expect(await storage.get(await spentKey())).toBe(ambiguous);
      expect(await endpoint.sent()).toEqual([
        refresh,
        consent,
        consent,
        { ...refresh, credential: "different-refresh" },
      ]);
    });
  });
});
