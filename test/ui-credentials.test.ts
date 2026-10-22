import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR } from "../src/credential-rules.js";
import { CredentialVault, encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
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
    expect(await response.json()).toEqual({ ok: !throws });
    expect(closeScope).toHaveBeenCalledTimes(1);
    expect(closeScope).toHaveBeenCalledWith(testCredential.mock.calls[0]?.[1]);
    expect(active).toBe(0);
  });

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

  it("keeps named fields and removal available when a stored credential is unreadable", async () => {
    const { connecta, storage } = makeMultiCredentialConnecta();
    await storage.set("conn:multi:credential:v1", "corrupt-ciphertext");

    const data = await fetchTestUiDetails(
      connecta,
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: null,
      removable: true,
      error: "Stored credential could not be read.",
      fields: [
        { name: "email", inputType: "email", configured: null },
        { name: "apiKey", inputType: "password", configured: null },
      ],
    });

    const remove = await credentialRequest(connecta, "/ui/credentials/multi", { method: "DELETE" });
    expect(remove.status).toBe(204);
    expect(await storage.get("conn:multi:credential:v1")).toBeNull();
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

  it("rejects undeclared slots and never enables wildcard CORS", async () => {
    const { connecta } = makeCredentialConnecta();
    const missing = await credentialRequest(connecta, "/ui/credentials/not-declared", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "secret" }),
    });
    expect(missing.status).toBe(404);

    const preflight = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
