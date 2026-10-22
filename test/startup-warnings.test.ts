import { describe, expect, it, vi } from "vitest";
import type { Connector, Logger } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { createTestConnecta } from "./helpers.js";
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
