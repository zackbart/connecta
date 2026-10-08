import { describe, expect, it, vi } from "vitest";
import { oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { classifyCallError } from "../src/errors.js";
import { oauthRefreshKeys, oauthRefreshSpentKeys } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { adapter, nativeOAuthServer, store, tokens } from "./fixtures/oauth-native-sdk.js";
import { storedGrant } from "./fixtures/oauth.js";

const required = (error: unknown) => classifyCallError(error).code === "downstream_oauth_required";
const refresh = { path: "token", grant: "refresh_token", credential: tokens.refresh_token };
const consent = { path: "token", grant: "authorization_code", credential: "native-code" };
const spentKey = async () => oauthRefreshSpentKeys.spent(await oauthStateDigest(tokens.refresh_token));
const spent = async (storage: KVStorage) =>
  JSON.parse((await storage.get(await spentKey()))!) as { state: string; epoch: string; resolvedAt?: number };

describe.each([
  ["memory", false],
  ["delayed", true],
] as const)("native SDK refresh resolution on %s storage", (_label, delayed) => {
  describe.each(["remoteMcp", "api"] as const)("%s", (kind) => {
    it("blocks a held refresh across Restart and identical-token consent, including after the earlier refresh resolves (INV-5) (INV-9)", async () => {
      const endpoint = await nativeOAuthServer("sdk-pending-first");
      const storage = store(delayed);
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

    it("allows identical-token consent after a committed refresh once, and refuses same-epoch reinsertion after lease removal (INV-5) (INV-9)", async () => {
      const endpoint = await nativeOAuthServer("sdk-success");
      const storage = store(delayed);
      const a = await adapter(kind, endpoint.issuer, storage);
      await a.read();
      const resolution = (await storage.get(await spentKey()))!;
      expect(await spent(storage)).toMatchObject({ state: "resolved", resolvedAt: expect.any(Number) });
      await a.exchange();
      const grant = (await storedGrant(storage))!;
      expect(grant.epoch).not.toBe("v3:seeded");
      expect(grant.body!.tokens).toMatchObject({ refresh_token: tokens.refresh_token });
      expect(JSON.parse((await storage.get("oauth:grant"))!).body.refreshConsent.resolution).toBe(resolution);
      const fresh = await adapter(kind, endpoint.issuer, storage, false);
      await fresh.read();
      expect(await spent(storage)).toMatchObject({ state: "resolved", epoch: grant.epoch });
      await storage.delete(oauthRefreshKeys.lease(grant.epoch, await oauthStateDigest(tokens.refresh_token)));
      await storage.set("oauth:grant", JSON.stringify(grant));
      const sameEpoch = await adapter(kind, endpoint.issuer, storage, false);
      await expect(sameEpoch.read()).rejects.toSatisfy(required);
      expect(await endpoint.sent()).toEqual([refresh, consent, refresh]);
    });

    it("keeps expiry ambiguous across Restart and a late definitive answer (INV-5) (INV-9)", async () => {
      const endpoint = await nativeOAuthServer("sdk-pending-first");
      const storage = store(delayed);
      const a = await adapter(kind, endpoint.issuer, storage);
      const first = a.read().catch((error: unknown) => error);
      await vi.waitFor(async () => expect(await endpoint.sent()).toEqual([refresh]));
      const outstanding = JSON.parse((await storage.get(await spentKey()))!) as { activeKey: string };
      await a.exchange();
      // Simulate storage-owned expiry after reset swept the epoch's lease.
      await storage.delete(outstanding.activeKey);
      const fresh = await adapter(kind, endpoint.issuer, storage, false);
      await expect(fresh.read()).rejects.toSatisfy(required);
      const ambiguous = await storage.get(await spentKey());
      expect(await spent(storage)).toMatchObject({ state: "ambiguous", epoch: "v3:seeded" });
      await endpoint.finish();
      await first;
      expect(await storage.get(await spentKey())).toBe(ambiguous);
      await a.exchange();
      const later = await adapter(kind, endpoint.issuer, storage, false);
      await expect(later.read()).rejects.toSatisfy(required);
      expect(await endpoint.sent()).toEqual([refresh, consent, consent]);
    });

    it("keeps an ambiguous fingerprint blocked after identical-token consent and recovers with a different token (INV-5) (INV-9)", async () => {
      const endpoint = await nativeOAuthServer("sdk-ambiguous-first");
      const storage = store(delayed);
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

    it.each(["before", "after"] as const)(
      "orders consent against the resolution storage write while its %s side is held (INV-5) (INV-9)",
      async (side) => {
        const endpoint = await nativeOAuthServer("sdk-success");
        const backing = store(delayed);
        let announce!: () => void;
        const held = new Promise<void>((resolve) => {
          announce = resolve;
        });
        let release!: () => void;
        const resume = new Promise<void>((resolve) => {
          release = resolve;
        });
        let holding = true;
        const storage: KVStorage = {
          ...backing,
          compareAndSet: async (key, expected, next, options) => {
            if (holding && key === (await spentKey()) && next !== null && JSON.parse(next).state === "resolved") {
              holding = false;
              if (side === "before") {
                announce();
                await resume;
              }
              const result = await backing.compareAndSet(key, expected, next, options);
              if (side === "after") {
                announce();
                await resume;
              }
              return result;
            }
            return backing.compareAndSet(key, expected, next, options);
          },
        };
        const a = await adapter(kind, endpoint.issuer, storage);
        const first = a.read().catch((error: unknown) => error);
        try {
          await held;
          expect(await spent(backing)).toMatchObject({ state: side === "before" ? "outstanding" : "resolved" });
          await a.exchange();
          const fresh = await adapter(kind, endpoint.issuer, storage, false);
          if (side === "before") await expect(fresh.read()).rejects.toSatisfy(required);
          else await fresh.read();
          expect(await endpoint.sent()).toEqual(side === "before" ? [refresh, consent] : [refresh, consent, refresh]);
        } finally {
          release();
          await first;
        }
      },
    );
  });
});
