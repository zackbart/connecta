import { vi } from "vitest";
import { bearerToken } from "../../src/auth/bearer.js";
import { api } from "../../src/connectors/api.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector } from "../../src/types.js";
import { createTestConnecta, silentLogger } from "../helpers.js";
import { fakeClerkAuth } from "./http.js";

export const TOKEN = "test-token-123";
export const BASE = "https://connecta.test";
export const CREDENTIAL_KEY =
  "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

export const CLERK_OPTIONS = {
  frontendApiUrl: "https://clerk.example.com",
  token: "clerk-token",
  userId: "user_123",
} as const;

export type CredentialShape = "single" | "multiple";

export function credentialConnector(): Connector {
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
        handler: async (_args, ctx) => ({
          credential: await ctx.credential?.get(),
        }),
      },
    ],
  });
}

export function makeCredentialConnecta() {
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

export function makeMultiCredentialConnecta() {
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
export function makeFieldsWithSingleHookConnecta() {
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
export function makeSingleWithFieldsHookConnecta() {
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
export function makeBothHooksConnecta(shape: CredentialShape) {
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

export function makeShapeDriftConnecta(
  storage: ReturnType<typeof memoryStorage>,
  shape: CredentialShape,
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
    credentials: { encryptionKey: CREDENTIAL_KEY },
  });
  return { connecta, testCredential, testCredentials };
}

export function credentialRequest(
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
