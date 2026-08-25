import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import {
  CredentialVault,
  STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
} from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { fakeClerkAuth } from "./fixtures/http.js";

const TOKEN = "test-token-123";
const BASE = "https://connecta.test";
const CREDENTIAL_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

const CLERK_OPTIONS = {
  frontendApiUrl: "https://clerk.example.com",
  token: "clerk-token",
  userId: "user_123",
} as const;

/** A connector whose listTools always throws — exercises broken-connector isolation. */
function credentialConnector(): Connector {
  return api("vaulted", {
    description: "Vaulted API",
    credential: {
      label: "API token",
      description: "Token used for outbound API requests.",
      placeholder: "Paste API token",
    },
    testCredential: async (value) => ({
      ok: value === "valid-secret-9876",
      message:
        value === "valid-secret-9876"
          ? "Credential is valid."
          : "Credential was rejected.",
    }),
    tools: [
      {
        name: "whoami",
        description: "Return the configured credential for test inspection.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        handler: async (_args, ctx) => ({ credential: await ctx.credential?.get() }),
      },
    ],
  });
}

function makeCredentialConnecta() {
  const storage = memoryStorage();
  const connecta = createTestConnecta({
    connectors: [credentialConnector()],
    auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
    storage,
    publicUrl: BASE,
    credentials: { encryptionKey: CREDENTIAL_KEY },
  });
  return { connecta, storage };
}

function makeMultiCredentialConnecta() {
  const storage = memoryStorage();
  const connector = api("multi", {
    description: "Multi-field API",
    credential: {
      label: "Service credentials",
      fields: [
        {
          name: "email",
          label: "Account email",
          inputType: "email",
        },
        {
          name: "apiKey",
          label: "API key",
          inputType: "password",
        },
      ],
    },
    testCredentials: async (values) => ({
      ok:
        values.email === "operator@example.com" &&
        values.apiKey === "api-key-secret-1234",
    }),
    tools: [
      {
        name: "credentials",
        description: "Inspect credentials in the test connector.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        handler: async (_args, ctx) => ctx.credential?.getAll(),
      },
    ],
  });
  const connecta = createTestConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
    storage,
    publicUrl: BASE,
    credentials: { encryptionKey: CREDENTIAL_KEY },
  });
  return { connecta, storage };
}

/**
 * Mismatch shape one: named `credential.fields` with only the single-value
 * `testCredential` hook, which reads the vault's reserved `value` field the
 * named set never writes.
 */
function makeFieldsWithSingleHookConnecta() {
  const testCredential = vi.fn(async () => ({ ok: true }));
  const connector = api("fieldsonly", {
    description: "Named fields, single-value hook",
    credential: {
      label: "Service credentials",
      fields: [
        { name: "email", label: "Account email", inputType: "email" as const },
        { name: "apiKey", label: "API key" },
      ],
    },
    testCredential,
    tools: [],
  });
  const connecta = createTestConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
    storage: memoryStorage(),
    publicUrl: BASE,
    credentials: { encryptionKey: CREDENTIAL_KEY },
    logger: silentLogger,
  });
  return { connecta, testCredential };
}

/**
 * Mismatch shape two: a single-value `credential` with only the named-set
 * `testCredentials` hook, which used to be handed the reserved `{ value }` map
 * by accident of the fallback order.
 */
function makeSingleWithFieldsHookConnecta() {
  const testCredentials = vi.fn(async () => ({ ok: true }));
  const connector = api("singleonly", {
    description: "Single value, named-set hook",
    credential: { label: "API token" },
    testCredentials,
    tools: [],
  });
  const connecta = createTestConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
    storage: memoryStorage(),
    publicUrl: BASE,
    credentials: { encryptionKey: CREDENTIAL_KEY },
    logger: silentLogger,
  });
  return { connecta, testCredentials };
}

/**
 * Both hooks declared on one shape — no mismatch, so nothing warns and the
 * shape alone decides which one runs. Each hook reports what it received, so a
 * test can tell them apart from the route's response.
 */
function makeBothHooksConnecta(shape: "single" | "multiple") {
  const testCredential = vi.fn(async (value: string) => ({
    ok: true,
    message: `single:${value}`,
  }));
  const testCredentials = vi.fn(async (values: Record<string, string>) => ({
    ok: true,
    message: `named:${Object.keys(values).sort().join(",")}`,
  }));
  const connector = api("bothhooks", {
    description: "Declares both test hooks",
    credential:
      shape === "multiple"
        ? {
            label: "Service credentials",
            fields: [
              { name: "email", label: "Account email" },
              { name: "apiKey", label: "API key" },
            ],
          }
        : { label: "API token" },
    testCredential,
    testCredentials,
    tools: [],
  });
  const connecta = createTestConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
    storage: memoryStorage(),
    publicUrl: BASE,
    credentials: { encryptionKey: CREDENTIAL_KEY },
  });
  return { connecta, testCredential, testCredentials };
}

function makeShapeDriftConnecta(
  storage: ReturnType<typeof memoryStorage>,
  shape: "single" | "multiple",
) {
  const testCredential = vi.fn(async () => ({ ok: true }));
  const testCredentials = vi.fn(async () => ({ ok: true }));
  const connector =
    shape === "single"
      ? api("drift", {
          description: "Shape drift test",
          credential: { label: "API token" },
          testCredential,
          tools: [],
        })
      : api("drift", {
          description: "Shape drift test",
          credential: {
            label: "Service credentials",
            fields: [
              { name: "email", label: "Account email" },
              { name: "apiKey", label: "API key" },
            ],
          },
          testCredentials,
          tools: [],
        });
  const connecta = createTestConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
    storage,
    publicUrl: BASE,
    credentials: {
      encryptionKey: CREDENTIAL_KEY,
    },
  });
  return { connecta, testCredential, testCredentials };
}

function credentialRequest(
  connecta: ReturnType<typeof createTestConnecta>,
  path: string,
  init: RequestInit = {},
) {
  return connecta.fetch(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer clerk-token",
        Origin: BASE,
        ...init.headers,
      },
    }),
  );
}

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
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage,
      publicUrl: BASE,
      credentials: {
        encryptionKey: CREDENTIAL_KEY,
      },
    });

    const data = await connecta.fetch(
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
        new Request(`${BASE}/credentials`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).text();
    expect(html).not.toContain("live-key-secret");
    // Credentials is rendered from /ui/data, so the page ships both branches:
    // the notice prints as muted copy, not the underlined `.msg` an error gets.
    expect(html).toContain('"credential-copy meta"');
    expect(html).toContain('"msg"');

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/superset/test",
      { method: "POST" },
    );
    expect(test.status).toBe(200);
    await expect(test.json()).resolves.toEqual({ ok: true });
    // The hook sees what the vault holds, exactly as a real call would.
    expect(testCredentials).toHaveBeenCalledWith(
      { email: "operator@example.com", apiKey: "live-key-secret" },
      expect.anything(),
    );

  });

  it("keeps a single-value credential usable when an old named field lingers", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).setAll(
      "legacy",
      { value: "current-secret", region: "eu-west-1" },
      "user_123",
    );
    const testCredential = vi.fn(async () => ({ ok: true }));
    const connecta = createTestConnecta({
      connectors: [
        api("legacy", {
          description: "Single value beside a leftover",
          credential: { label: "API token" },
          testCredential,
          tools: [],
        }),
      ],
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage,
      publicUrl: BASE,
      credentials: {
        encryptionKey: CREDENTIAL_KEY,
      },
    });

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const credential = ((await data.json()) as any).connectors[0].credential;
    expect(credential).toMatchObject({ configured: true, testable: true });
    expect(credential).not.toHaveProperty("error");
    expect(credential.notice).toContain("region");

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/legacy/test",
      { method: "POST" },
    );
    expect(test.status).toBe(200);
    expect(testCredential).toHaveBeenCalledWith(
      "current-secret",
      expect.anything(),
    );
  });

  it("treats duplicate named declarations with true key-set semantics", async () => {
    const testCredentials = vi.fn(
      async (values: Record<string, string>) => ({
        ok: values.apiKey === "duplicate-field-secret",
      }),
    );
    const connector = api("duplicate", {
      description: "Duplicate field declaration",
      credential: {
        label: "Service credential",
        fields: [
          { name: "apiKey", label: "Primary API key" },
          { name: "apiKey", label: "Repeated API key" },
        ],
      },
      testCredentials,
      tools: [],
    });
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage: memoryStorage(),
      publicUrl: BASE,
      credentials: {
        encryptionKey: CREDENTIAL_KEY,
      },
    });

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/duplicate",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { apiKey: "duplicate-field-secret" },
        }),
      },
    );
    expect(save.status).toBe(200);

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: true,
      removable: true,
      testable: true,
      fields: [
        { name: "apiKey", configured: true },
        { name: "apiKey", configured: true },
      ],
    });
    expect(payload.connectors[0].credential).not.toHaveProperty("error");

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/duplicate/test",
      { method: "POST" },
    );
    expect(test.status).toBe(200);
    await expect(test.json()).resolves.toEqual({ ok: true });
    expect(testCredentials).toHaveBeenCalledTimes(1);
    expect(testCredentials).toHaveBeenCalledWith(
      { apiKey: "duplicate-field-secret" },
      expect.anything(),
    );

    expect(testCredentials).toHaveBeenCalledTimes(1);
  });

  it("detects named-to-single storage drift and recovers after replacement", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).setAll(
      "drift",
      { email: "operator@example.com", apiKey: "old-key-secret" },
      "user_123",
    );
    const { connecta, testCredential } = makeShapeDriftConnecta(
      storage,
      "single",
    );

    const data = await connecta.fetch(
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
    expect(payload.connectors[0]).toMatchObject({
      status: "auth_required",
      message: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });

    const driftedTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(driftedTest.status).toBe(409);
    await expect(driftedTest.json()).resolves.toEqual({
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    expect(testCredential).not.toHaveBeenCalled();

    const replacement = await credentialRequest(
      connecta,
      "/ui/credentials/drift",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "replacement-secret" }),
      },
    );
    expect(replacement.status).toBe(200);
    const recoveredData = await connecta.fetch(
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
    expect(recoveredPayload.connectors[0].credential).not.toHaveProperty(
      "error",
    );
    expect(recoveredPayload.connectors[0].status).not.toBe("auth_required");
    const recoveredTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(recoveredTest.status).toBe(200);
    expect(testCredential).toHaveBeenCalledWith(
      "replacement-secret",
      expect.anything(),
    );
  });

  it("detects single-to-named storage drift and recovers after replacement", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).set(
      "drift",
      "old-single-secret",
      "user_123",
    );
    const { connecta, testCredentials } = makeShapeDriftConnecta(
      storage,
      "multiple",
    );

    const data = await connecta.fetch(
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
      fields: [
        { name: "email", configured: false },
        { name: "apiKey", configured: false },
      ],
    });

    const driftedTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(driftedTest.status).toBe(409);
    await expect(driftedTest.json()).resolves.toEqual({
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    expect(testCredentials).not.toHaveBeenCalled();

    const values = {
      email: "operator@example.com",
      apiKey: "replacement-key",
    };
    const replacement = await credentialRequest(
      connecta,
      "/ui/credentials/drift",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      },
    );
    expect(replacement.status).toBe(200);
    const recoveredData = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const recoveredPayload = (await recoveredData.json()) as any;
    expect(recoveredPayload.connectors[0].credential).toMatchObject({
      configured: true,
      removable: true,
      testable: true,
      fields: [
        { name: "email", configured: true },
        { name: "apiKey", configured: true },
      ],
    });
    expect(recoveredPayload.connectors[0].credential).not.toHaveProperty(
      "error",
    );
    const recoveredTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(recoveredTest.status).toBe(200);
    expect(testCredentials).toHaveBeenCalledWith(values, expect.anything());
  });

  it("stores, masks, exposes to the connector, tests, and removes a credential", async () => {
    const { connecta, storage } = makeCredentialConnecta();

    const save = await credentialRequest(connecta, "/ui/credentials/vaulted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "valid-secret-9876" }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      credential: { configured: true, lastFour: "9876" },
    });

    const raw = await storage.get("conn:vaulted:credential:v1");
    expect(raw).not.toContain("valid-secret-9876");

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      label: "API token",
      configured: true,
      lastFour: "9876",
      testable: true,
    });
    expect(JSON.stringify(payload)).not.toContain("valid-secret-9876");

    const connector = connecta.registry.getConnector("vaulted")!;
    await expect(
      connector.callTool(
        "whoami",
        {},
        connecta.registry.contextFor("vaulted", BASE),
      ),
    ).resolves.toEqual({ credential: "valid-secret-9876" });

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/vaulted/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({
      ok: true,
      message: "Credential is valid.",
    });

    const remove = await credentialRequest(
      connecta,
      "/ui/credentials/vaulted",
      { method: "DELETE" },
    );
    expect(remove.status).toBe(204);
    expect(
      await connecta.registry.contextFor("vaulted", BASE).credential?.get(),
    ).toBeNull();
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
    expect(await storage.get("conn:multi:credential:v1")).not.toContain(
      "operator@example.com",
    );

    const data = await connecta.fetch(
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
    await expect(
      configured.callTool(
        "credentials",
        {},
        connecta.registry.contextFor("multi", BASE),
      ),
    ).resolves.toEqual(values);

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/multi/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({ ok: true });
  });

  it("runs testCredential for a single value that declares both hooks", async () => {
    // The one deliberate behavior change for a connector declaring both: the
    // route used to prefer `testCredentials` and hand it the reserved
    // `{ value }` map. The shape picks the hook now, so the single-value hook
    // runs against the string it was written to expect.
    const { connecta, testCredential, testCredentials } =
      makeBothHooksConnecta("single");

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "both-secret-9876" }),
      },
    );
    expect(save.status).toBe(200);

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: true,
      testable: true,
    });

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({
      ok: true,
      message: "single:both-secret-9876",
    });
    // The route ran it, and so did the liveness sweep the /ui/data request
    // triggered (documentation/storage-and-credentials.md) — both through the one rule,
    // so every call is the single-value hook against the raw stored string.
    expect(testCredential).toHaveBeenCalled();
    for (const [value] of testCredential.mock.calls) {
      expect(value).toBe("both-secret-9876");
    }
    expect(testCredentials).not.toHaveBeenCalled();
  });

  it("runs testCredentials for named fields that declare both hooks", async () => {
    const { connecta, testCredential, testCredentials } =
      makeBothHooksConnecta("multiple");

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { email: "operator@example.com", apiKey: "api-key-1234" },
        }),
      },
    );
    expect(save.status).toBe(200);

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({
      ok: true,
      message: "named:apiKey,email",
    });
    expect(testCredentials).toHaveBeenCalledTimes(1);
    expect(testCredential).not.toHaveBeenCalled();
  });

  it("offers no Test action for named fields with only the single-value hook", async () => {
    const { connecta, testCredential } = makeFieldsWithSingleHookConnecta();

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/fieldsonly",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { email: "operator@example.com", apiKey: "api-key-1234" },
        }),
      },
    );
    expect(save.status).toBe(200);

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: true,
      testable: false,
    });

    // The old behavior: a shown button whose click answered 409 "configure the
    // credential before testing it" on a fully configured credential.
    const test = await credentialRequest(
      connecta,
      "/ui/credentials/fieldsonly/test",
      { method: "POST" },
    );
    expect(test.status).toBe(400);
    expect((await test.json()) as any).toMatchObject({
      error: expect.stringContaining("testCredentials(values, ctx)"),
    });
    expect(testCredential).not.toHaveBeenCalled();
  });

  it("offers no Test action for a single value with only the named-set hook", async () => {
    const { connecta, testCredentials } = makeSingleWithFieldsHookConnecta();

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/singleonly",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "single-secret-9876" }),
      },
    );
    expect(save.status).toBe(200);

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: true,
      testable: false,
    });

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/singleonly/test",
      { method: "POST" },
    );
    expect(test.status).toBe(400);
    expect((await test.json()) as any).toMatchObject({
      error: expect.stringContaining("testCredential(value, ctx)"),
    });
    // Never handed the reserved `{ value }` map it did not ask for.
    expect(testCredentials).not.toHaveBeenCalled();
  });

  it("keeps named fields and removal available when a stored credential is unreadable", async () => {
    const { connecta, storage } = makeMultiCredentialConnecta();
    await storage.set("conn:multi:credential:v1", "corrupt-ciphertext");

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: false,
      removable: true,
      error: "Stored credential could not be read.",
      fields: [
        { name: "email", inputType: "email", configured: false },
        { name: "apiKey", inputType: "password", configured: false },
      ],
    });

    const remove = await credentialRequest(
      connecta,
      "/ui/credentials/multi",
      { method: "DELETE" },
    );
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
    expect(bearerOnly.status).toBe(401);

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

    const bearerData = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const bearerPayload = (await bearerData.json()) as any;
    expect(bearerPayload.connectors[0].credential).toBeUndefined();
  });

  it("rejects undeclared slots and never enables wildcard CORS", async () => {
    const { connecta } = makeCredentialConnecta();
    const missing = await credentialRequest(
      connecta,
      "/ui/credentials/not-declared",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret" }),
      },
    );
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

  it("boots without a vault and reports credential management unavailable", async () => {
    const warn = vi.fn();
    const connecta = createTestConnecta({
      connectors: [credentialConnector()],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: {
        debug() {},
        info() {},
        warn,
        error() {},
      },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("credentials.encryptionKey is not configured"),
    );
    expect(
      connecta.registry.contextFor("vaulted", BASE).credential,
    ).toBeUndefined();

    const response = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await response.json()) as any;
    expect(payload.credentialManagement).toBe("vault_not_configured");
    expect(payload.connectors[0].credential).toBeUndefined();
  });
});

