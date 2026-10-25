// Node-only: real SDK credential POSTs under a hostile buffering global dispatcher.
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { createNodeGuardedTransport } from "../src/http/node-transport.js";
import { credentialAttempt } from "./fixtures/oauth-credential-attempts.js";
import { installHostRetries } from "./fixtures/host-retries.js";
import { connectProxy } from "./fixtures/connect-proxy.js";
import { adapter, nativeOAuthServer } from "./fixtures/oauth-native-sdk.js";
import { memoryStorage } from "../src/storage/memory.js";
import { storedGrant } from "./fixtures/oauth.js";

beforeEach(() => {
  installHostRetries();
  const old = configureGuardedTransport(createNodeGuardedTransport());
  onTestFinished(() => {
    configureGuardedTransport(old);
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    expect(JSON.stringify([...error.mock.calls, ...warn.mock.calls])).not.toMatch(
      /old-refresh|native-code|CREDENTIAL_RESPONSE_SENTINEL|grant_type=/,
    );
    error.mockRestore();
    warn.mockRestore();
  });
});

for (const kind of ["remoteMcp", "api"] as const)
  for (const operation of [
    "refresh",
    "code",
    ...(kind === "remoteMcp" ? (["register", "revoke"] as const) : []),
  ] as const)
    for (const challenge of ["421", "reset", "503"] as const)
      it(`INV-5 INV-9: ${kind} ${operation} sends one physical body after ${challenge}`, async () => {
        await credentialAttempt(kind, operation, challenge);
      });

it("INV-5 INV-9: SDK credential POSTs use the explicit proxy policy", async () => {
  const proxy = await connectProxy();
  configureGuardedTransport(createNodeGuardedTransport(proxy.url));
  for (const operation of ["refresh", "code", "register", "revoke"] as const)
    await credentialAttempt("remoteMcp", operation, "421");
  expect(proxy.tunnels.length).toBeGreaterThanOrEqual(4);
  await expect.poll(() => proxy.sockets.size).toBe(0);
});

it("INV-9 INV-11: a Node host without the owned policy refuses before claiming a refresh", async () => {
  configureGuardedTransport(undefined);
  const server = await nativeOAuthServer("sdk-success");
  const storage = memoryStorage();
  const a = await adapter("api", server.issuer, storage);
  await expect(a.read()).rejects.toBeInstanceOf(Error);
  expect(await server.posts()).toEqual({});
  expect((await storedGrant(storage))?.body?.tokens?.refresh_token).toBe("old-refresh");
});

it("INV-9: native fetch is a duplicate credential POST control under buffering RetryAgent", async () => {
  const server = await nativeOAuthServer("sdk-attempt-token-503");
  const response = await fetch(`${server.issuer}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "control-refresh" }),
    redirect: "manual",
  });
  await response.text();
  expect((await server.posts()).token).toBe(2);
});

it("INV-5 INV-9: SDK registration never follows a 307 under same-origin resource redirect policy", async () => {
  await credentialAttempt("remoteMcp", "register", "307");
});
