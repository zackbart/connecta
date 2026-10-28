import { describe, expect, it, vi } from "vitest";
import type { Connector, Logger } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { createTestConnecta } from "./helpers.js";
import { remoteMcp, type RemoteMcpOptions } from "../src/connectors/remote-mcp.js";
import { googleServiceAccountToken } from "../src/google.js";
import { PRIVATE_KEY } from "./fixtures/rsa.js";
import { machineAuth } from "./helpers/machine-auth.js";

const BASE = "https://connecta.test";

function spyLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** A plain connector with neither credentials nor downstream OAuth. */
const plainConnector: Connector = connectorWith({
  id: "plain",
  kind: "api",
  description: "Plain — no downstream authorization",
  tools: [],
  call: async () => ({}),
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

describe("OAuth callback state warnings", () => {
  const authModes: [string, RemoteMcpOptions["auth"]][] = [
    ["credential", { type: "credential" }],
    ["request token", { type: "request", token: async () => "token" }],
    ["request principal", { type: "request", principal: { accept: "human", token: async () => "token" } }],
    [
      "Google service-account token",
      {
        type: "request",
        token: googleServiceAccountToken({
          serviceAccount: { clientEmail: "assistant@example.com", privateKey: PRIVATE_KEY },
          scopes: ["https://www.googleapis.com/auth/bigquery"],
        }),
      },
    ],
    ["headers", { type: "headers", headers: { Authorization: "Bearer token" } }],
    ["no auth", undefined],
    ["OAuth with state verification", { type: "oauth" }],
  ];

  it.each(authModes)("does not warn for %s", async (_mode, auth) => {
    const logger = spyLogger();
    const connector = remoteMcp("notes", {
      url: "https://notes.example/mcp",
      description: "Notes — read notes",
      ...(auth ? { auth } : {}),
    });
    expect(Boolean(connector.finishAuth)).toBe(auth?.type === "oauth");
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: machineAuth("secret"),
      publicUrl: BASE,
      logger,
    });
    try {
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await connecta.close();
    }
  });

  it.each([false, true])(
    "warns only when a custom code exchange lacks verifyState (verified: %s)",
    async (verified) => {
      const logger = spyLogger();
      const connector: Connector = {
        ...plainConnector,
        finishAuth: async () => {},
        ...(verified ? { verifyState: async () => true } : {}),
      };
      const connecta = createTestConnecta({
        connectors: [connector],
        auth: machineAuth("secret"),
        publicUrl: BASE,
        logger,
      });
      try {
        if (verified) expect(logger.warn).not.toHaveBeenCalled();
        else {
          expect(logger.warn).toHaveBeenCalledOnce();
          expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('connector "plain" has an OAuth callback with no state/CSRF check'),
          );
          expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Implement `verifyState` to complete authorization."),
          );
        }
      } finally {
        await connecta.close();
      }
    },
  );
});
