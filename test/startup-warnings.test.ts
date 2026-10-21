import { operatorUi } from "../src/ui.js";
import { memoryStorage } from "../src/storage/memory.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { describe, expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { createTestConnecta } from "./helpers.js";
import { machineAuth, registerTestMaintainer } from "./helpers/machine-auth.js";
import type { Connector, InboundAuth, Logger } from "../src/types.js";
import type { CredentialVault } from "../src/credential-contract.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";

const BASE = "https://connecta.test";
const CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");

function spyLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Warnings that fired, joined for easy substring assertions. */
function warnings(logger: Logger): string {
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.join(" ")).join("\n");
}

/** A plain connector with neither credentials nor downstream OAuth. */
const plainConnector: Connector = connectorWith({
  id: "plain",
  kind: "api",
  tools: [],
  call: async () => ({}),
});

/** Downstream-OAuth connector WITHOUT a state/CSRF check. */
const oauthNoState: Connector = connectorWith({
  id: "oauth",
  kind: "mcp",
  tools: [],
  call: async () => ({}),
  async finishAuth() {},
});

/** Downstream-OAuth connector WITH a state/CSRF check. */
const oauthWithState: Connector = connectorWith({
  id: "oauthsafe",
  kind: "mcp",
  tools: [],
  call: async () => ({}),
  async verifyState() {
    return true;
  },
  async finishAuth() {},
});

/** Connector declaring an operator-managed credential slot. */
const credentialConnector: Connector = connectorWith({
  id: "vaulted",
  kind: "api",
  credential: { label: "API token" },
  tools: [],
  call: async () => ({}),
});

describe("publicUrl-unset OAuth warning", () => {
  it.each([
    [
      "warns when an OAuth connector exists and publicUrl is unset",
      () => {
        const logger = spyLogger();
        createTestConnecta({
          connectors: [oauthWithState],
          auth: machineAuth("secret"),
          logger,
        });
        expect(warnings(logger)).toContain("publicUrl is unset");
      },
    ],
  ] as const)("%s", (_name, run) => run());
});

describe("dropped-branding-URL warning", () => {
  it.each([
    [
      "names every branding URL that failed the scheme gate",
      () => {
        const logger = spyLogger();
        createTestConnecta({
          connectors: [plainConnector],
          auth: machineAuth("secret"),
          publicUrl: BASE,
          logger,
          ui: operatorUi({
            branding: {
              productUrl: "javascript:alert(1)",
              ownerUrl: "javascript:alert(2)",
              favicon: { href: "javascript:alert(3)" },
            },
          }),
        });
        const text = warnings(logger);
        expect(text).toContain("branding productUrl, ownerUrl, favicon.href");
        expect(text).toContain("The default is rendered instead.");
      },
    ],
  ] as const)("%s", (_name, run) => run());
});

describe("dropped uiAuth URL warnings", () => {
  /** An inbound provider offering the browser sign-in config `/ui` renders. */
  function uiAuthProvider(
    frontendApiUrl: string,
    portal: { signInUrl?: string; signUpUrl?: string } = {},
  ): InboundAuth {
    // The principal it admits is the default maintainer (#837).
    return registerTestMaintainer(
      {
        kind: "clerk",
        uiAuth: {
          kind: "clerk",
          publishableKey: "pk_test_fake",
          frontendApiUrl,
          ...portal,
        },
        authorize() {
          return { ok: true, userId: "user_123" };
        },
      },
      { namespace: "connecta:test", id: "user_123" },
    );
  }

  it.each([
    [
      "names each dropped sign-in/sign-up navigation target",
      () => {
        const logger = spyLogger();
        createTestConnecta({
          connectors: [plainConnector],
          auth: uiAuthProvider("https://clerk.example.com", {
            signInUrl: "javascript:alert(1)",
            signUpUrl: "http://accounts.example.com/sign-up",
          }),
          publicUrl: BASE,
          logger,
        });
        const text = warnings(logger);
        expect(text).toContain('provider "clerk"');
        expect(text).toContain("uiAuth.signInUrl, uiAuth.signUpUrl dropped");
        expect(text).toContain("absolute https URL");
        // The loader origin passed its gate, so it is not named.
        expect(text).not.toContain("uiAuth.frontendApiUrl");
      },
    ],
  ] as const)("%s", (_name, run) => run());
});

describe("missing-verifyState CSRF warning", () => {
  it.each([
    [
      "warns and names a connector whose OAuth callback has no state check",
      () => {
        const logger = spyLogger();
        createTestConnecta({
          connectors: [oauthNoState],
          auth: machineAuth("secret"),
          publicUrl: BASE,
          logger,
        });
        const text = warnings(logger);
        expect(text).toContain("state/CSRF check");
        expect(text).toContain('connector "oauth"');
        expect(text).toContain("refuses every callback");
      },
    ],
  ] as const)("%s", (_name, run) => run());
});

describe("unsealed downstream OAuth state warning", () => {
  /** A custom vault written before `seal`/`open` existed. */
  function vaultWithoutSealing(): CredentialVault {
    const inner = encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY);
    return {
      get: (...args) => inner.get(...args),
      getAll: (...args) => inner.getAll(...args),
      metadata: (...args) => inner.metadata(...args),
      set: (...args) => inner.set(...args),
      setAll: (...args) => inner.setAll(...args),
      delete: (...args) => inner.delete(...args),
    };
  }

  const oauthDownstream = remoteMcp("downstream", {
    url: "https://downstream.example/mcp",
    auth: { type: "oauth" },
  });

  it.each([
    [
      "warns when the vault cannot seal an OAuth connector's state",
      () => {
        const logger = spyLogger();
        createTestConnecta({
          connectors: [oauthDownstream],
          auth: machineAuth("secret"),
          publicUrl: BASE,
          vault: vaultWithoutSealing(),
          logger,
        });
        const text = warnings(logger);
        expect(text).toContain("seal");
        expect(text).toContain('connector "downstream"');
        expect(text).toContain("plaintext");
      },
    ],
  ] as const)("%s", (_name, run) => run());
});

describe("credential test-hook mismatch warning", () => {
  /** Named fields tested by the single-value hook. */
  const fieldsWithSingleHook: Connector = {
    ...credentialConnector,
    id: "fieldsonly",
    credential: {
      label: "Service credentials",
      fields: [
        { name: "email", label: "Account email" },
        { name: "apiKey", label: "API key" },
      ],
    },
    async testCredential() {
      return { ok: true };
    },
  };

  it.each([
    [
      "warns when named fields are paired with only testCredential",
      () => {
        const logger = spyLogger();
        createTestConnecta({
          connectors: [fieldsWithSingleHook],
          auth: machineAuth("secret"),
          publicUrl: BASE,
          vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
          logger,
        });
        const text = warnings(logger);
        expect(text).toContain('connector "fieldsonly" cannot test its credential');
        expect(text).toContain("`testCredentials(values, ctx)` can test");
        expect(text).toContain("POST /ui/credentials/fieldsonly/test answers 400");
      },
    ],
  ] as const)("%s", (_name, run) => run());
});

describe("unusable maxResultBytes", () => {
  it.each([0, 1.5])(
    "INV-11: refuses a connector override %s at construction, naming the connector",
    (maxResultBytes) => {
      expect(() =>
        createTestConnecta({
          connectors: [{ ...plainConnector, maxResultBytes }],
          auth: machineAuth("secret"),
          publicUrl: BASE,
          logger: spyLogger(),
          calls: { maxResultBytes: 400 },
        }),
      ).toThrow('Connector "plain" maxResultBytes must be a whole number of bytes >= 1');
    },
  );
});
