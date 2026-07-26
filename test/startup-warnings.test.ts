import { describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { bearerToken } from "../src/auth/bearer.js";
import type { ToolkitConfig } from "../src/toolkits.js";
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
const plainConnector: Connector = {
  id: "plain",
  kind: "api",
  async listTools() {
    return [];
  },
  async callTool() {
    return {};
  },
};

/** Downstream-OAuth connector WITHOUT a state/CSRF check. */
const oauthNoState: Connector = {
  id: "oauth",
  kind: "mcp",
  async listTools() {
    return [];
  },
  async callTool() {
    return {};
  },
  async finishAuth() {},
};

/** Downstream-OAuth connector WITH a state/CSRF check. */
const oauthWithState: Connector = {
  id: "oauthsafe",
  kind: "mcp",
  async listTools() {
    return [];
  },
  async callTool() {
    return {};
  },
  async verifyState() {
    return true;
  },
  async finishAuth() {},
};

/** Connector declaring an operator-managed credential slot. */
const credentialConnector: Connector = {
  id: "vaulted",
  kind: "api",
  credential: { label: "API token" },
  async listTools() {
    return [];
  },
  async callTool() {
    return {};
  },
};

describe("open-mode credential-exposure warning", () => {
  it("warns when open mode has an OAuth-capable connector", () => {
    const logger = spyLogger();
    createConnecta({ connectors: [oauthWithState], publicUrl: BASE, logger });
    expect(warnings(logger)).toContain("no inbound authentication");
  });

  it("warns when open mode has a credential connector", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [credentialConnector],
      credentialEncryptionKey: CREDENTIAL_KEY,
      logger,
    });
    expect(warnings(logger)).toContain("no inbound authentication");
  });

  it("does not warn when inbound auth is configured", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [oauthWithState],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
    });
    expect(warnings(logger)).not.toContain("no inbound authentication");
  });

  it("does not warn in open mode without credentials or OAuth", () => {
    const logger = spyLogger();
    createConnecta({ connectors: [plainConnector], logger });
    expect(warnings(logger)).not.toContain("no inbound authentication");
  });
});

describe("toolkit-selection warning", () => {
  it("warns when a selectable toolkit exists with no inbound auth", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      toolkits: { support: { connectors: ["plain"] } },
      logger,
    });
    expect(warnings(logger)).toContain(
      "toolkits are configured but there is no inbound",
    );
  });

  it("stays quiet for `toolkits: {}`, where nothing is selectable", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      toolkits: {},
      logger,
    });
    expect(warnings(logger)).not.toContain("toolkits are configured");
  });

  it("stays quiet when toolkits are paired with inbound auth", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      toolkits: { support: { connectors: ["plain"] } },
      auth: bearerToken("secret"),
      logger,
    });
    expect(warnings(logger)).not.toContain("toolkits are configured");
  });

  it("still warns about the unauthenticated deployment itself, whatever `toolkits` holds", () => {
    const shapes: Array<ToolkitConfig | undefined> = [
      undefined,
      {},
      { support: { connectors: ["vaulted"] } },
    ];
    for (const toolkits of shapes) {
      const logger = spyLogger();
      createConnecta({
        connectors: [credentialConnector],
        credentialEncryptionKey: CREDENTIAL_KEY,
        toolkits,
        logger,
      });
      expect(warnings(logger)).toContain("no inbound authentication");
    }
  });
});

describe("publicUrl-unset OAuth warning", () => {
  it("warns when an OAuth connector exists and publicUrl is unset", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [oauthWithState],
      auth: bearerToken("secret"),
      logger,
    });
    expect(warnings(logger)).toContain("publicUrl is unset");
  });

  it("does not warn when publicUrl is set", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [oauthWithState],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
    });
    expect(warnings(logger)).not.toContain("publicUrl is unset");
  });

  it("does not warn when no OAuth connector exists", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      auth: bearerToken("secret"),
      logger,
    });
    expect(warnings(logger)).not.toContain("publicUrl is unset");
  });
});

describe("dropped-branding-URL warning", () => {
  it("names every branding URL that failed the scheme gate", () => {
    const logger = spyLogger();
    createConnecta({
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
  });

  it("does not warn for accepted branding URLs", () => {
    const logger = spyLogger();
    createConnecta({
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
  });

  it("reports non-string branding URLs without throwing", () => {
    const logger = spyLogger();
    expect(() =>
      createConnecta({
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
  });

  it("does not warn when no branding is configured", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
    });
    expect(warnings(logger)).not.toContain("branding");
  });
});

describe("dropped uiAuth.frontendApiUrl warning", () => {
  /** An inbound provider offering the browser sign-in config `/ui` renders. */
  function uiAuthProvider(frontendApiUrl: string): InboundAuth {
    return {
      kind: "clerk",
      uiAuth: {
        kind: "clerk",
        publishableKey: "pk_test_fake",
        frontendApiUrl,
      },
      authorize() {
        return { ok: true, userId: "user_123" };
      },
    };
  }

  it("names the provider whose sign-in loader origin was dropped", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      auth: uiAuthProvider("javascript:alert(1)"),
      publicUrl: BASE,
      logger,
    });
    const text = warnings(logger);
    expect(text).toContain('provider "clerk"');
    expect(text).toContain("uiAuth.frontendApiUrl dropped");
    expect(text).toContain("absolute https URL");
  });

  it("does not warn for an https frontendApiUrl", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      auth: uiAuthProvider("https://clerk.example.com"),
      publicUrl: BASE,
      logger,
    });
    expect(warnings(logger)).not.toContain("uiAuth");
  });

  it("does not warn for a provider that offers no browser sign-in", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
    });
    expect(warnings(logger)).not.toContain("uiAuth");
  });
});

describe("missing-verifyState CSRF warning", () => {
  it("warns and names a connector whose OAuth callback has no state check", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [oauthNoState],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
    });
    const text = warnings(logger);
    expect(text).toContain("state/CSRF check");
    expect(text).toContain('connector "oauth"');
  });

  it("does not warn when the OAuth connector implements verifyState", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [oauthWithState],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
    });
    expect(warnings(logger)).not.toContain("state/CSRF check");
  });
});

describe("unusable maxResultBytes warning", () => {
  it("warns that a zero deployment cap fell back to the default", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [plainConnector],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
      maxResultBytes: 0,
    });
    const text = warnings(logger);
    expect(text).toContain("maxResultBytes 0");
    expect(text).toContain("50000");
  });

  it("warns and names a connector whose override cannot be honoured", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [{ ...plainConnector, maxResultBytes: -1 }],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
      maxResultBytes: 400,
    });
    expect(warnings(logger)).toContain(
      'connector "plain" sets maxResultBytes -1',
    );
  });

  it("does not warn for caps in range", () => {
    const logger = spyLogger();
    createConnecta({
      connectors: [{ ...plainConnector, maxResultBytes: 1 }],
      auth: bearerToken("secret"),
      publicUrl: BASE,
      logger,
      maxResultBytes: 10_000,
    });
    expect(warnings(logger)).not.toContain("maxResultBytes");
  });
});
