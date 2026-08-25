import { describe, expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { createTestConnecta } from "./helpers.js";
import { bearerToken } from "../src/auth/bearer.js";
import type { Connector, InboundAuth, Logger } from "../src/types.js";

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
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call.join(" "))
    .join("\n");
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

describe("open-mode credential-exposure warning", () => {
  it.each([
    ["warns when open mode has an OAuth-capable connector", () => {
      const logger = spyLogger();
      createTestConnecta({ connectors: [oauthWithState], publicUrl: BASE, logger });
      expect(warnings(logger)).toContain("no inbound authentication");
    }],

    ["warns when open mode has a credential connector", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [credentialConnector],
        credentials: { encryptionKey: CREDENTIAL_KEY },
        logger,
      });
      expect(warnings(logger)).toContain("no inbound authentication");
    }],

    ["does not warn when inbound auth is configured", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [oauthWithState],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("no inbound authentication");
    }],

    ["does not warn in open mode without credentials or OAuth", () => {
      const logger = spyLogger();
      createTestConnecta({ connectors: [plainConnector], logger });
      expect(warnings(logger)).not.toContain("no inbound authentication");
    }],
  ] as const)("%s", (_name, run) => run());
});

describe("publicUrl-unset OAuth warning", () => {
  it.each([
    ["warns when an OAuth connector exists and publicUrl is unset", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [oauthWithState],
        auth: bearerToken("secret"),
        logger,
      });
      expect(warnings(logger)).toContain("publicUrl is unset");
    }],

    ["does not warn when publicUrl is set", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [oauthWithState],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("publicUrl is unset");
    }],

    ["does not warn when no OAuth connector exists", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: bearerToken("secret"),
        logger,
      });
      expect(warnings(logger)).not.toContain("publicUrl is unset");
    }],
  ] as const)("%s", (_name, run) => run());
});

describe("dropped-branding-URL warning", () => {
  it.each([
    ["names every branding URL that failed the scheme gate", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
        branding: {
          productUrl: "javascript:alert(1)",
          ownerUrl: "javascript:alert(2)",
          favicon: { href: "javascript:alert(3)" },
        },
      });
      const text = warnings(logger);
      expect(text).toContain("branding productUrl, ownerUrl, favicon.href");
      expect(text).toContain("The default is rendered instead.");
    }],

    ["does not warn for accepted branding URLs", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
        branding: {
          productUrl: "https://acme.example",
          ownerUrl: "https://acme.example/about",
          favicon: { href: "/assets/acme.svg" },
        },
      });
      expect(warnings(logger)).not.toContain("branding");
    }],

    ["reports non-string branding URLs without throwing", () => {
      const logger = spyLogger();
      expect(() =>
        createTestConnecta({
          connectors: [plainConnector],
          auth: bearerToken("secret"),
          publicUrl: BASE,
          logger,
          branding: {
            productUrl: 1 as unknown as string,
            ownerUrl: {} as unknown as string,
            favicon: { href: 42 as unknown as string },
          },
        }),
      ).not.toThrow();
      expect(warnings(logger)).toContain(
        "branding productUrl, ownerUrl, favicon.href",
      );
    }],

    ["does not warn when no branding is configured", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("branding");
    }],
  ] as const)("%s", (_name, run) => run());
});

describe("dropped uiAuth URL warnings", () => {
  /** An inbound provider offering the browser sign-in config `/ui` renders. */
  function uiAuthProvider(
    frontendApiUrl: string,
    portal: { signInUrl?: string; signUpUrl?: string } = {},
  ): InboundAuth {
    return {
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
    };
  }

  it.each([
    ["names the provider whose sign-in loader origin was dropped", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: uiAuthProvider("javascript:alert(1)"),
        publicUrl: BASE,
        logger,
      });
      const text = warnings(logger);
      expect(text).toContain('provider "clerk"');
      expect(text).toContain("uiAuth.frontendApiUrl dropped");
      expect(text).toContain("absolute https URL");
    }],

    ["names each dropped sign-in/sign-up navigation target", () => {
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
    }],

    ["does not warn for https URLs in every uiAuth position", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: uiAuthProvider("https://clerk.example.com", {
          signInUrl: "https://accounts.example.com/sign-in",
          signUpUrl: "https://accounts.example.com/sign-up",
        }),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("uiAuth");
    }],

    ["does not warn for unset sign-in/sign-up URLs", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: uiAuthProvider("https://clerk.example.com"),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("uiAuth");
    }],
  ] as const)("%s", (_name, run) => run());

  // "Set" means the same thing here as it does for a branding URL, so the two
  // warning paths cannot disagree about which values an operator meant to
  // supply. A blank is indistinguishable from leaving the field alone.
  it.each([
    ["treats a blank sign-in URL as unset rather than as a drop", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: uiAuthProvider("https://clerk.example.com", {
          signInUrl: "   ",
        }),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("uiAuth");
    }],

    ["warns for a non-string sign-in URL rather than dropping it silently", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: uiAuthProvider("https://clerk.example.com", {
          // A custom InboundAuth is untyped at a JS call site; 0 is falsy, so
          // raw truthiness would have skipped it while the page still dropped it.
          signInUrl: 0 as unknown as string,
        }),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).toContain("uiAuth.signInUrl dropped");
    }],

    ["does not warn for a provider that offers no browser sign-in", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [plainConnector],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("uiAuth");
    }],
  ] as const)("%s", (_name, run) => run());
});

describe("missing-verifyState CSRF warning", () => {
  it.each([
    ["warns and names a connector whose OAuth callback has no state check", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [oauthNoState],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
      });
      const text = warnings(logger);
      expect(text).toContain("state/CSRF check");
      expect(text).toContain('connector "oauth"');
      expect(text).toContain("refuses every callback");
    }],

    ["does not warn when the OAuth connector implements verifyState", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [oauthWithState],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        logger,
      });
      expect(warnings(logger)).not.toContain("state/CSRF check");
    }],
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

  /** A single value tested by the named-set hook. */
  const singleWithFieldsHook: Connector = {
    ...credentialConnector,
    id: "singleonly",
    async testCredentials() {
      return { ok: true };
    },
  };

  it.each([
    ["warns when named fields are paired with only testCredential", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [fieldsWithSingleHook],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        credentials: { encryptionKey: CREDENTIAL_KEY },
        logger,
      });
      const text = warnings(logger);
      expect(text).toContain('connector "fieldsonly" cannot test its credential');
      expect(text).toContain("`testCredentials(values, ctx)` can test");
      expect(text).toContain("POST /ui/credentials/fieldsonly/test answers 400");
    }],

    ["warns when a single-value credential is paired with only testCredentials", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [singleWithFieldsHook],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        credentials: { encryptionKey: CREDENTIAL_KEY },
        logger,
      });
      const text = warnings(logger);
      expect(text).toContain('connector "singleonly" cannot test its credential');
      expect(text).toContain("`testCredential(value, ctx)` can test");
    }],

    ["stays quiet when a connector declares both hooks, on either shape", () => {
      const logger = spyLogger();
      createTestConnecta({
        connectors: [
          {
            ...fieldsWithSingleHook,
            id: "bothfields",
            async testCredentials() {
              return { ok: true };
            },
          },
          {
            ...singleWithFieldsHook,
            id: "bothsingle",
            async testCredential() {
              return { ok: true };
            },
          },
        ],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        credentials: { encryptionKey: CREDENTIAL_KEY },
        logger,
      });
      expect(warnings(logger)).not.toContain("cannot test its credential");
    }],

    ["stays quiet for matched shapes and for a credential with no test hook", () => {
      const logger = spyLogger();
      const matchedFields: Connector = {
        ...fieldsWithSingleHook,
        id: "matchedfields",
        async testCredentials() {
          return { ok: true };
        },
      };
      delete matchedFields.testCredential;
      const matchedSingle: Connector = {
        ...singleWithFieldsHook,
        id: "matchedsingle",
        async testCredential() {
          return { ok: true };
        },
      };
      delete matchedSingle.testCredentials;
      createTestConnecta({
        connectors: [
          credentialConnector,
          matchedFields,
          matchedSingle,
        ],
        auth: bearerToken("secret"),
        publicUrl: BASE,
        credentials: { encryptionKey: CREDENTIAL_KEY },
        logger,
      });
      expect(warnings(logger)).not.toContain("cannot test its credential");
    }],
  ] as const)("%s", (_name, run) => run());
});

describe("unusable calls.maxResultBytes warning", () => {
  it.each([0, -1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "warns that deployment cap %s fell back to the default",
    (maxResultBytes) => {
    const logger = spyLogger();
    createTestConnecta({
      connectors: [plainConnector],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
      calls: { maxResultBytes },
    });
    const text = warnings(logger);
    expect(text).toContain(`calls.maxResultBytes ${maxResultBytes}`);
    expect(text).toContain("50000");
    },
  );

  it.each([0, -1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "warns and names a connector whose override %s cannot be honoured",
    (maxResultBytes) => {
    const logger = spyLogger();
    createTestConnecta({
      connectors: [{ ...plainConnector, maxResultBytes }],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
      calls: { maxResultBytes: 400 },
    });
    expect(warnings(logger)).toContain(
      `connector "plain" sets maxResultBytes ${maxResultBytes}`,
    );
    },
  );

  it.each([1, 4, 100, 50_000])("does not warn for cap %s", (maxResultBytes) => {
    const logger = spyLogger();
    createTestConnecta({
      connectors: [{ ...plainConnector, maxResultBytes }],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
      calls: { maxResultBytes },
    });
    expect(warnings(logger)).not.toContain("maxResultBytes");
  });
});
