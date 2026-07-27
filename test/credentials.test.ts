import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  describeUndeclaredCredentialFields,
  STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
  storedCredentialShape,
} from "../src/credentials.js";
import type { ConnectorCredentialConfig } from "../src/types.js";
import { memoryStorage } from "../src/storage/memory.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("storedCredentialShape", () => {
  const single: ConnectorCredentialConfig = { label: "API token" };
  const named: ConnectorCredentialConfig = {
    label: "Service credentials",
    fields: [
      { name: "email", label: "Account email" },
      { name: "apiKey", label: "API key" },
    ],
  };
  const cases: Array<{
    name: string;
    declaration: ConnectorCredentialConfig;
    stored: Record<string, unknown> | null;
    state: "missing" | "valid" | "mismatch";
    /** Expected leftovers, for a `valid` verdict. */
    undeclared?: string[];
  }> = [
    {
      name: "reports no stored credential",
      declaration: single,
      stored: null,
      state: "missing",
    },
    {
      name: "accepts exactly the reserved single-value field",
      declaration: single,
      stored: { value: "secret" },
      state: "valid",
      undeclared: [],
    },
    {
      name: "rejects an old named field for a single declaration",
      declaration: single,
      stored: { apiKey: "secret" },
      state: "mismatch",
    },
    {
      name: "accepts extra fields beside a single declaration",
      declaration: single,
      stored: { value: "secret", extra: "old", legacy: "older" },
      state: "valid",
      undeclared: ["extra", "legacy"],
    },
    {
      name: "accepts an exact named set regardless of order",
      declaration: named,
      stored: { apiKey: "secret", email: "operator@example.com" },
      state: "valid",
      undeclared: [],
    },
    {
      name: "compares duplicate named declarations as a key set",
      declaration: {
        label: "Service credential",
        fields: [
          { name: "apiKey", label: "Primary API key" },
          { name: "apiKey", label: "Repeated API key" },
        ],
      },
      stored: { apiKey: "secret" },
      state: "valid",
      undeclared: [],
    },
    {
      name: "rejects an old single value for a named declaration",
      declaration: named,
      stored: { value: "secret" },
      state: "mismatch",
    },
    {
      name: "rejects missing named fields",
      declaration: named,
      stored: { apiKey: "secret" },
      state: "mismatch",
    },
    {
      // The regression this rule was relaxed for: a redeploy that drops
      // `email` leaves a stored set that still answers every `get("apiKey")`
      // the connector makes, so it is not drift.
      name: "accepts a stored superset of the declared named fields",
      declaration: {
        label: "Service credential",
        fields: [{ name: "apiKey", label: "API key" }],
      },
      stored: { apiKey: "secret", email: "operator@example.com" },
      state: "valid",
      undeclared: ["email"],
    },
    {
      name: "rejects a superset that is still missing a declared field",
      declaration: named,
      stored: { apiKey: "secret", region: "old" },
      state: "mismatch",
    },
    {
      name: "rejects an empty stored map against a single declaration",
      declaration: single,
      stored: {},
      state: "mismatch",
    },
    {
      name: "rejects an empty stored map against a named declaration",
      declaration: named,
      stored: {},
      state: "mismatch",
    },
    {
      name: "accepts a named field literally called value",
      declaration: {
        label: "Service credential",
        fields: [{ name: "value", label: "Value" }],
      },
      stored: { value: "secret" },
      state: "valid",
      undeclared: [],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = storedCredentialShape(
        testCase.declaration,
        testCase.stored,
      );
      expect(result.state).toBe(testCase.state);
      if (result.state === "mismatch") {
        expect(result.message).toBe(
          STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
        );
      }
      if (result.state === "valid") {
        expect(result.undeclared).toEqual(testCase.undeclared);
      }
    });
  }

  it("names leftover fields once, and summarizes a long tail", () => {
    expect(describeUndeclaredCredentialFields(["email"])).toContain("(email)");
    expect(describeUndeclaredCredentialFields(["email"])).toContain(
      "drop it",
    );
    const many = describeUndeclaredCredentialFields([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    expect(many).toContain("(a, b, c, d, e, and 2 more)");
    expect(many).toContain("drop them");
  });
});

describe("CredentialVault", () => {
  it("encrypts credentials in the existing KV storage and decrypts on demand", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);

    const metadata = await vault.set(
      "service",
      "secret-token-1234",
      "user_123",
    );

    expect(metadata).toMatchObject({
      configured: true,
      lastFour: "1234",
    });
    expect(await vault.get("service")).toBe("secret-token-1234");

    const raw = await storage.get("conn:service:credential:v1");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("secret-token-1234");
    expect(JSON.parse(raw!)).toMatchObject({
      version: 1,
      algorithm: "AES-GCM",
    });
  });

  it("returns masked metadata without returning the credential", async () => {
    const vault = new CredentialVault(memoryStorage(), KEY);
    await vault.set("service", "abcdefghij9876", "user_123");

    const metadata = await vault.metadata("service");
    expect(metadata?.lastFour).toBe("9876");
    expect(metadata).not.toHaveProperty("value");
  });

  it("emits lastFour only for values comfortably longer than four chars", async () => {
    const vault = new CredentialVault(memoryStorage(), KEY);

    const long = await vault.set("long", "abcdefghijklmnop1234", "user_123");
    expect(long.lastFour).toBe("1234");
    expect(long.fields?.value.lastFour).toBe("1234");

    const short = await vault.set("short", "abcd1234", "user_123");
    expect(short).not.toHaveProperty("lastFour");
    expect(short.fields?.value).not.toHaveProperty("lastFour");
    expect(short.fields?.value.configured).toBe(true);
  });

  it("encrypts and retrieves named multi-field credentials", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);

    const metadata = await vault.setAll(
      "cloudflare",
      {
        apiEmail: "operator@example.com",
        apiKey: "global-key-5678",
      },
      "user_123",
    );

    expect(metadata.fields).toMatchObject({
      apiEmail: { configured: true, lastFour: ".com" },
      apiKey: { configured: true, lastFour: "5678" },
    });
    await expect(vault.getAll("cloudflare")).resolves.toEqual({
      apiEmail: "operator@example.com",
      apiKey: "global-key-5678",
    });
    await expect(vault.get("cloudflare", "apiKey")).resolves.toBe(
      "global-key-5678",
    );
    expect(await storage.get("conn:cloudflare:credential:v1")).not.toContain(
      "operator@example.com",
    );
  });

  it("binds ciphertext to its connector id", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.set("one", "token-one", "user_123");
    const raw = await storage.get("conn:one:credential:v1");
    await storage.set("conn:two:credential:v1", raw!);

    await expect(vault.get("two")).rejects.toThrow(
      "Stored credential could not be decrypted",
    );
  });

  it("cannot decrypt with a different key", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, KEY).set(
      "service",
      "top-secret",
      "user_123",
    );
    const otherKey = Buffer.alloc(32, 9).toString("base64");

    await expect(
      new CredentialVault(storage, otherKey).get("service"),
    ).rejects.toThrow("Stored credential could not be decrypted");
  });

  it("deletes a credential", async () => {
    const vault = new CredentialVault(memoryStorage(), KEY);
    await vault.set("service", "top-secret", "user_123");
    await vault.delete("service");

    expect(await vault.get("service")).toBeNull();
    expect(await vault.metadata("service")).toBeNull();
  });

  it("shares CONNECTA_KV without touching existing downstream MCP OAuth state", async () => {
    const storage = memoryStorage();
    await storage.set("conn:notion:oauth:tokens", '{"access_token":"mcp-token"}');
    await storage.set("conn:notion:oauth:client", '{"client_id":"mcp-client"}');
    const vault = new CredentialVault(storage, KEY);

    await vault.set("notion", "static-fallback-token", "user_123");
    await vault.delete("notion");

    expect(await storage.get("conn:notion:oauth:tokens")).toBe(
      '{"access_token":"mcp-token"}',
    );
    expect(await storage.get("conn:notion:oauth:client")).toBe(
      '{"client_id":"mcp-client"}',
    );
  });

  it("rejects invalid keys, empty values, and oversized values", async () => {
    expect(() => new CredentialVault(memoryStorage(), "not-base64")).toThrow(
      "base64-encoded 32-byte key",
    );
    const vault = new CredentialVault(memoryStorage(), KEY);
    // .then(null, handler) attaches the rejection handler synchronously;
    // expect(...).rejects attaches a microtask later, which workerd (the
    // Workers test pool) reports as an unhandled rejection.
    const empty = await vault
      .set("service", "  ", "user_123")
      .then(() => null, (e: unknown) => e as Error);
    expect(empty?.message).toContain("cannot be empty");
    const oversized = await vault
      .set("service", "x".repeat(16_385), "user_123")
      .then(() => null, (e: unknown) => e as Error);
    expect(oversized?.message).toContain("cannot exceed");
  });
});
