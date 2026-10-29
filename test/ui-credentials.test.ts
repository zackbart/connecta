import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR } from "../src/credential-rules.js";
import { CredentialVault, encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError, unavailableCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import { buildUiData } from "../src/ui.js";
import type { ConnectorContext } from "../src/types.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import {
  BASE,
  CLERK_OPTIONS,
  CREDENTIAL_KEY,
  credentialConnector,
  credentialRequest,
  makeCredentialConnecta,
  makeMultiCredentialConnecta,
  makeShapeDriftConnecta,
  TOKEN,
} from "./fixtures/ui.js";
import { createTestConnecta, fetchTestUiDetails } from "./helpers.js";
import { machineAuth } from "./helpers/machine-auth.js";

describe("status UI credential management", () => {
  it("keeps a stored superset usable, testable, and flagged as leftover", async () => {
    // The redeploy issue #79's review probed: the connector used to declare
    // { email, apiKey } and now declares only { apiKey }. The stored secret
    // still answers every read the connector makes, so nothing may break —
    // but the operator is told the vault is carrying a passenger.
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).setAll(
      "superset",
      { email: "operator@example.com", apiKey: "live-key-secret" },
      "user_123",
    );
    const testCredentials = vi.fn(async () => ({ ok: true }));
    const connecta = createTestConnecta({
      connectors: [
        api("superset", {
          description: "Dropped a field",
          credential: {
            label: "Service credentials",
            fields: [{ name: "apiKey", label: "API key" }],
          },
          testCredentials,
          tools: [],
        }),
      ],
      auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage,
      publicUrl: BASE,
      vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
    });

    const data = await fetchTestUiDetails(
      connecta,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const credential = ((await data.json()) as any).connectors[0].credential;
    expect(credential).toMatchObject({
      configured: true,
      removable: true,
      testable: true,
      fields: [{ name: "apiKey", configured: true }],
    });
    expect(credential).not.toHaveProperty("error");
    expect(credential.notice).toContain("email");
    // Non-blocking: it names the leftover, it does not demand a replacement.
    expect(credential.notice).toContain("keeps working");

    const html = await (
      await connecta.fetch(
        new Request(`${BASE}/`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).text();
    expect(html).not.toContain("live-key-secret");
    // Credentials is rendered from /ui/data, so the page ships both branches:
    // the notice prints as muted copy, not the `.msg` block an error gets.
    expect(html).toMatch(/src="\/ui\/assets\/[^" ]+\.js"/);

    const test = await credentialRequest(connecta, "/ui/credentials/superset/test", { method: "POST" });
    expect(test.status).toBe(200);
    await expect(test.json()).resolves.toEqual({ ok: true });
    // The hook sees what the vault holds, exactly as a real call would.
    expect(testCredentials).toHaveBeenCalledWith(
      { email: "operator@example.com", apiKey: "live-key-secret" },
      expect.anything(),
    );
  });

  it("detects named-to-single storage drift and recovers after replacement", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).setAll(
      "drift",
      { email: "operator@example.com", apiKey: "old-key-secret" },
      "user_123",
    );
    const { connecta, testCredential } = makeShapeDriftConnecta(storage, "single");

    const data = await fetchTestUiDetails(
      connecta,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: false,
      removable: true,
      testable: false,
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    // Drift is the connector's /ui/data status, not just a credential sidecar.
    // The connector carries it as a classified problem; the explanatory text
    // rides only on the credential card above.
    expect(payload.connectors[0]).toMatchObject({
      status: "auth_required",
      problem: "credential_mismatch",
    });
    expect(payload.connectors[0]).not.toHaveProperty("message");

    const driftedTest = await credentialRequest(connecta, "/ui/credentials/drift/test", { method: "POST" });
    expect(driftedTest.status).toBe(409);
    await expect(driftedTest.json()).resolves.toEqual({
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      problem: "credential_mismatch",
    });
    expect(testCredential).not.toHaveBeenCalled();

    const replacement = await credentialRequest(connecta, "/ui/credentials/drift", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "replacement-secret" }),
    });
    expect(replacement.status).toBe(200);
    const recoveredData = await fetchTestUiDetails(
      connecta,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const recoveredPayload = (await recoveredData.json()) as any;
    expect(recoveredPayload.connectors[0].credential).toMatchObject({
      configured: true,
      removable: true,
      testable: true,
    });
    expect(recoveredPayload.connectors[0].credential).not.toHaveProperty("error");
    expect(recoveredPayload.connectors[0].status).not.toBe("auth_required");
    const recoveredTest = await credentialRequest(connecta, "/ui/credentials/drift/test", { method: "POST" });
    expect(recoveredTest.status).toBe(200);
    expect(testCredential).toHaveBeenCalledWith("replacement-secret", expect.anything());
  });

  it("stores, renders, tests, and exposes named credential fields", async () => {
    const { connecta, storage } = makeMultiCredentialConnecta();
    const values = {
      email: "operator@example.com",
      apiKey: "api-key-secret-1234",
    };

    const save = await credentialRequest(connecta, "/ui/credentials/multi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      credential: {
        configured: true,
        fields: {
          email: { lastFour: ".com" },
          apiKey: { lastFour: "1234" },
        },
      },
    });
    expect(await storage.get("conn:multi:credential:v1")).not.toContain("operator@example.com");

    const data = await fetchTestUiDetails(
      connecta,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential.fields).toMatchObject([
      { name: "email", inputType: "email", configured: true },
      { name: "apiKey", inputType: "password", configured: true },
    ]);
    expect(JSON.stringify(payload)).not.toContain("operator@example.com");

    const configured = connecta.registry.getConnector("multi")!;
    await expect(configured.callTool("credentials", {}, connecta.registry.contextFor("multi", BASE))).resolves.toEqual({
      email: "[redacted]",
      apiKey: "[redacted]",
    });

    const test = await credentialRequest(connecta, "/ui/credentials/multi/test", { method: "POST" });
    await expect(test.json()).resolves.toEqual({ ok: true });
  });

  it("requires the Clerk provider, its user identity, and the same origin", async () => {
    const { connecta } = makeCredentialConnecta();
    const body = JSON.stringify({ value: "secret" });

    const bearerOnly = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: BASE,
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(bearerOnly.status).toBe(403);

    const crossOrigin = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer clerk-token",
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const noOrigin = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer clerk-token",
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(noOrigin.status).toBe(403);

    const bearerData = await fetchTestUiDetails(
      connecta,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const bearerPayload = (await bearerData.json()) as any;
    expect(bearerPayload.connectors[0].credential).toBeUndefined();
  });
});

it.each([false, true])("closes the credential test scope when the hook throws=%s", async (throws) => {
  const storage = memoryStorage();
  await new CredentialVault(storage, CREDENTIAL_KEY).set("key", "test-secret", "operator");
  let active = 0;
  const testCredential = vi.fn(async (_value: string, _ctx: ConnectorContext) => {
    active++;
    if (throws) throw new Error("test failed");
    return { ok: true };
  });
  const closeScope = vi.fn(async () => {
    active--;
    throw new Error("cleanup failed");
  });
  const connector = { ...credentialConnector(), id: "key", testCredential, closeScope };
  const connecta = createTestConnecta({
    connectors: [connector],
    auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
    storage,
    publicUrl: BASE,
    vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
  });
  const response = await credentialRequest(connecta, "/ui/credentials/key/test", { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(throws ? { ok: false, failure: "failed" } : { ok: true });
  expect(closeScope).toHaveBeenCalledTimes(1);
  expect(closeScope).toHaveBeenCalledWith(testCredential.mock.calls[0]?.[1]);
  expect(active).toBe(0);
});

/** The connector's operator detail row: its shown status and last verification. */
async function detailRow(registry: Parameters<typeof buildUiData>[0], id: string, vault?: CredentialVault) {
  const data = await buildUiData(registry, BASE, { name: "test", version: "0" }, vault);
  return data.connectors.find((connector) => connector.id === id)!;
}

describe("test then save", () => {
  const STORED = "stored-secret-value-1234";
  const CANDIDATE = "candidate-secret-value-5678";

  /**
   * An api() bearer connector whose test answers `outcome` for the
   * candidate, the way a real hook meets a vendor, and passes the stored value.
   */
  async function bearer(
    outcome: (value: string, ctx: ConnectorContext) => Promise<{ ok: boolean; message?: string; failure?: any }>,
  ) {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).set("key", STORED, "operator");
    const logged: unknown[] = [];
    const logger = {
      debug: () => {},
      info: (...args: unknown[]) => logged.push(args),
      warn: (...args: unknown[]) => logged.push(args),
      error: (...args: unknown[]) => logged.push(args),
    };
    const testCredential = vi.fn(async (value: string, ctx: ConnectorContext) =>
      value === STORED ? { ok: true } : outcome(value, ctx),
    );
    const connecta = createTestConnecta({
      connectors: [
        api("key", {
          credential: { label: "API token" },
          testCredential,
          tools: [],
        }),
      ],
      auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage,
      publicUrl: BASE,
      logger,
      discovery: { probeTimeoutMs: 100 },
      vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
    });
    const put = async (body: unknown) => {
      const response = await credentialRequest(connecta, "/ui/credentials/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    };
    const vault = () => new CredentialVault(storage, CREDENTIAL_KEY);
    const stored = () => vault().getAll("key");
    const everything = async () =>
      JSON.stringify([
        await Promise.all((await storage.list("")).map(async (key) => [key, await storage.get(key)])),
        logged,
      ]);
    return { connecta, storage, put, stored, vault, everything, testCredential, logged };
  }

  it.each([
    ["rejected", async () => Promise.reject(new ConnectorCallError("auth_required", `refused ${CANDIDATE}`))],
    ["scope", async () => Promise.reject(new ConnectorCallError("provider_permission_denied", `scope ${CANDIDATE}`))],
    ["unreachable", async () => Promise.reject(unavailableCallError(new Error(CANDIDATE)))],
    ["unreachable", async () => Promise.reject(new ConnectorCallError("rate_limited", "slow down"))],
    ["timeout", async () => Promise.reject(new ConnectorCallError("timeout", "slow"))],
    // A hook that never answers ends at the deployment's probe deadline.
    ["timeout", (_value: string, ctx: ConnectorContext) => new Promise<never>(() => void ctx)],
    // A hook that turns the deadline's abort into a result still timed out.
    [
      "timeout",
      (_value: string, ctx: ConnectorContext) =>
        new Promise<{ ok: boolean }>((resolve) =>
          ctx.signal?.addEventListener("abort", () => resolve({ ok: false }), { once: true }),
        ),
    ],
    ["failed", async () => ({ ok: false, message: `vendor said ${CANDIDATE}` })],
    ["scope", async () => ({ ok: false, message: `vendor said ${CANDIDATE}`, failure: "scope" })],
    ["failed", async () => ({ ok: false, failure: "not-a-class" })],
    ["failed", async () => Promise.reject(new Error(`boom ${CANDIDATE}`))],
  ] as const)("a %s candidate is never stored or echoed", async (failure, outcome) => {
    const { connecta, put, stored, vault, everything } = await bearer(outcome as any);
    const result = await put({ value: CANDIDATE, verify: "test" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ saved: false, failure });
    expect(result.text).not.toContain(CANDIDATE);
    await expect(stored()).resolves.toEqual({ value: STORED });
    expect(await everything()).not.toContain(CANDIDATE);
    expect((await detailRow(connecta.registry, "key", vault())).verification).toBeUndefined();
  });

  it("saves anyway unverified, and a passing candidate verified", async () => {
    const { connecta, put, stored, vault, testCredential, logged } = await bearer(async (value) => ({
      ok: value === "passing-secret-value-0000",
    }));
    const failed = await put({ value: CANDIDATE, verify: "test" });
    expect(failed.body).toEqual({ saved: false, failure: "failed" });
    expect(logged.some((line) => JSON.stringify(line).includes("credential test failed"))).toBe(true);

    const anyway = await put({ value: CANDIDATE, verify: "skip" });
    expect(anyway.body).toMatchObject({ saved: true, credential: { configured: true, lastFour: "5678" } });
    expect(anyway.body.verification).toEqual({ outcome: "unverified", observedAt: expect.any(String) });
    await expect(stored()).resolves.toEqual({ value: CANDIDATE });
    expect(await detailRow(connecta.registry, "key", vault())).toMatchObject({
      status: "ok",
      verification: anyway.body.verification,
    });

    const passing = await put({ value: "passing-secret-value-0000", verify: "test" });
    expect(passing.body).toMatchObject({ saved: true, verification: { outcome: "ok" } });
    await expect(stored()).resolves.toEqual({ value: "passing-secret-value-0000" });
    expect((await detailRow(connecta.registry, "key", vault())).verification).toMatchObject({ outcome: "ok" });
    // The hook received each candidate as its value, never the stored one.
    expect(testCredential.mock.calls.map(([value]) => value)).toEqual([CANDIDATE, "passing-secret-value-0000"]);
    // A save without `verify` keeps working for API callers, unverified.
    const plain = await put({ value: STORED });
    expect(plain.body).toMatchObject({ saved: true, verification: { outcome: "unverified" } });
    expect(testCredential).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logged)).not.toContain("passing-secret-value");
  });

  it("refuses an unknown verify mode and testing a connector without a hook", async () => {
    const { put } = await bearer(async () => ({ ok: true }));
    expect((await put({ value: CANDIDATE, verify: "maybe" })).status).toBe(400);
    const untestable = createTestConnecta({
      connectors: [api("plain", { credential: { label: "Token" }, tools: [] })],
      auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage: memoryStorage(),
      publicUrl: BASE,
      vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
    });
    const refused = await credentialRequest(untestable, "/ui/credentials/plain", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: CANDIDATE, verify: "test" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(CANDIDATE);
  });

  it("tests a multi-field candidate as a set and removes its record with the credential", async () => {
    const { connecta, storage } = makeMultiCredentialConnecta();
    const values = { email: "operator@example.com", apiKey: "api-key-secret-1234" };
    const save = await credentialRequest(connecta, "/ui/credentials/multi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, verify: "test" }),
    });
    expect(await save.json()).toMatchObject({ saved: true, verification: { outcome: "ok" } });
    expect(
      (await detailRow(connecta.registry, "multi", new CredentialVault(storage, CREDENTIAL_KEY))).verification,
    ).toMatchObject({ outcome: "ok" });
    const removed = await credentialRequest(connecta, "/ui/credentials/multi", { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await storage.list(`conn:multi:verification`)).toEqual([]);
  });
});
