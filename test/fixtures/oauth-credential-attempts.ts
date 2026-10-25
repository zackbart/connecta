import { expect } from "vitest";
import { classifyCallError } from "../../src/errors.js";
import { oauthRefreshSpentKeys } from "../../src/storage/keys.js";
import { oauthStateDigest } from "../../src/auth/downstream-oauth.js";
import { adapter, nativeOAuthServer, tokens } from "./oauth-native-sdk.js";
import { storedGrant } from "./oauth.js";
import { memoryStorage } from "../../src/storage/memory.js";

export async function credentialAttempt(
  kind: "remoteMcp" | "api",
  operation: "refresh" | "code" | "register" | "revoke",
  challenge: "421" | "reset" | "503" | "307",
) {
  const target = operation === "refresh" || operation === "code" ? "token" : operation;
  const server = await nativeOAuthServer(`sdk-attempt-${target}-${challenge}`);
  const storage = memoryStorage();
  const a = await adapter(kind, server.issuer, storage, operation === "refresh");
  if (operation === "refresh") {
    await expect(a.read()).rejects.toSatisfy((error: unknown) => classifyCallError(error).code === "downstream_oauth_required");
    expect((await storedGrant(storage))?.body?.tokens).toBeUndefined();
    const spent = oauthRefreshSpentKeys.spent(await oauthStateDigest(tokens.refresh_token));
    expect(await storage.get(spent)).not.toBeNull();
    await expect(a.read()).rejects.toBeInstanceOf(Error);
    expect((await server.posts()).token).toBe(1);
    // A fresh consent remains usable; the uncertain old refresh is never redeemed again.
    await server.success();
    await a.exchange();
    expect((await storedGrant(storage))?.body?.tokens?.access_token).toBe("consent-access");
  } else if (operation === "code") {
    const state = await a.start();
    await expect(a.finish(state)).rejects.toBeInstanceOf(Error);
    await expect(a.finish(state)).rejects.toBeInstanceOf(Error);
    expect((await server.posts()).token).toBe(1);
  } else if (operation === "register") {
    await expect(a.start()).rejects.toBeInstanceOf(Error);
    expect((await server.posts()).register).toBe(1);
    expect((await server.posts())["register-final"]).toBeUndefined();
  } else {
    // Complete real discovery, SDK dynamic registration and a code exchange first.
    await a.exchange();
    await expect(a.connector.disconnectAuth!(a.context())).rejects.toMatchObject({ code: "oauth_revocation_failed" });
    await a.connector.disconnectAuth!(a.context());
    expect((await storedGrant(storage))?.body?.tokens).toBeUndefined();
    expect((await server.posts()).revoke).toBe(1);
  }
}
