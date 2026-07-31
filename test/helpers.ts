import { Registry } from "../src/registry.js";
import {
  createConnecta as createRuntimeConnecta,
  type ConnectaConfig,
} from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { CredentialVault } from "../src/credentials.js";
import type { Connector, Executor, KVStorage, Logger } from "../src/types.js";

/** Minimal executor for server tests that do not exercise generated code. */
const stubExecutor: Executor = {
  execute: async () => ({ result: null }),
};

/**
 * Construct a valid deployment while allowing a test to override the executor.
 *
 * Deliberately not named `createConnecta`: shadowing the real export while
 * silently supplying an executor would hide the required-executor contract
 * from every suite that imports it. A suite that wants to observe that
 * refusal must call the real `createConnecta` from `../src/index.js`.
 */
export function createTestConnecta(
  config: Omit<ConnectaConfig, "executor"> & { executor?: Executor },
) {
  return createRuntimeConnecta({
    ...config,
    executor: config.executor ?? stubExecutor,
  });
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Return an expected test fixture value or fail with a useful message.
 *
 * This keeps indexed fixture access honest under `noUncheckedIndexedAccess`:
 * an unexpectedly missing item fails the test instead of being asserted away.
 */
export function required<T>(
  value: T | undefined,
  label = "test fixture value",
): T {
  if (value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

/**
 * A registry over `connectors`. `opts` carries the flat internal settings that
 * `ConnectaConfig` adapts into — including the `ConnectaConfig.calls` result
 * cap — so cap tests configure them exactly the way production does.
 */
export function makeRegistry(
  connectors: Connector[],
  opts: {
    toolCacheTtlSeconds?: number;
    maxResultBytes?: number;
    /** Share one store between a registry and a credential vault. */
    storage?: KVStorage;
    credentialVault?: CredentialVault;
    logger?: Logger;
  } = {},
): Registry {
  const { storage = memoryStorage(), ...rest } = opts;
  return new Registry(connectors, {
    storage,
    logger: silentLogger,
    ...rest,
  });
}

/** An in-code API-style connector (kind "api"). */
export const calcConnector: Connector = {
  id: "calc",
  kind: "api",
  description: "Calculator",
  async listTools() {
    return [
      {
        name: "add",
        description: "Add two numbers",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    ];
  },
  async callTool(name, args) {
    if (name === "add") {
      const { a, b } = args as { a: number; b: number };
      return { sum: a + b };
    }
    throw new Error(`Unknown tool "${name}" on connector "calc"`);
  },
};

/** A remote-MCP-style connector (kind "mcp") returning a content array. */
export const remoteConnector: Connector = {
  id: "remote",
  kind: "mcp",
  description: "Remote echo",
  async listTools() {
    return [
      {
        name: "echo",
        description: "Echo the given text",
        annotations: { readOnlyHint: true },
      },
    ];
  },
  async callTool(_name, args) {
    return {
      content: [
        { type: "text", text: `echo:${(args as { text: string }).text}` },
      ],
    };
  },
};

/** Always throws — exercises broken-connector isolation. */
export const brokenConnector: Connector = {
  id: "broken",
  description: "Broken",
  async listTools() {
    throw new Error("boom");
  },
  async callTool() {
    throw new Error("boom");
  },
};

/** Reports auth_required via its own status(); startAuth records force calls. */
export const authConnector: Connector & { startAuthCalls: unknown[] } = {
  id: "needsauth",
  kind: "mcp",
  description: "Needs auth",
  startAuthCalls: [],
  async listTools() {
    throw new Error("unauthorized");
  },
  async callTool() {
    throw new Error("unauthorized");
  },
  async status() {
    return {
      state: "auth_required",
      authorizationUrl: "https://auth.example/authorize?x=1",
    };
  },
  async startAuth(_ctx, opts) {
    this.startAuthCalls.push(opts);
    return {
      state: "auth_required",
      authorizationUrl: "https://auth.example/authorize?x=1",
      message: "Authorization required — open the URL to connect.",
    };
  },
};
