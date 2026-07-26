import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, Logger } from "../src/types.js";

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A registry over `connectors`. `opts` carries the deployment-wide settings a
 * `ConnectaConfig` would supply — including `maxResultBytes`, which is the only
 * place a deployment-wide result cap is set (issue #44), so cap tests configure
 * it exactly the way production does.
 */
export function makeRegistry(
  connectors: Connector[],
  opts: { toolCacheTtlSeconds?: number; maxResultBytes?: number } = {},
): Registry {
  return new Registry(connectors, {
    storage: memoryStorage(),
    logger: silentLogger,
    ...opts,
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
