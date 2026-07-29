import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ConnectorCallError,
  api,
  bearerToken,
  createConnecta,
  memoryStorage,
  type Connector,
  type ConnectorContext,
  type ToolCallActivityEvent,
  type ToolDef,
} from "../../src/index.js";
import { CredentialVault } from "../../src/credentials.js";
import { quickJsExecutor } from "../../src/executors/quickjs.js";
import { listen } from "../../src/node.js";

interface HoldoutCorpus {
  connectors: {
    id: string;
    description: string;
    tools: { name: string; description: string }[];
  }[];
}

const holdout = JSON.parse(
  await readFile(
    fileURLToPath(new URL("./discovery-holdout.json", import.meta.url)),
    "utf8",
  ),
) as HoldoutCorpus;

const token = process.env.CONNECTA_EVAL_TOKEN ?? "connecta-eval-token";
const operatorToken =
  process.env.CONNECTA_EVAL_OPERATOR_TOKEN ?? "connecta-eval-operator";
const sourceCommit = process.env.CONNECTA_EVAL_SOURCE_COMMIT ?? "working-tree";
const port = Number(process.env.CONNECTA_EVAL_PORT ?? "0");
const host = "127.0.0.1";
const credentialEncryptionKey = Buffer.alloc(32, 7).toString("base64");
const storage = memoryStorage();
const vault = new CredentialVault(storage, credentialEncryptionKey);
const activityEvents: ToolCallActivityEvent[] = [];

function fixtureTools(
  definitions: { name: string; description: string }[],
): ToolDef[] {
  return definitions.map((definition) => ({
    ...definition,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }));
}

const discoveryConnectors: Connector[] = holdout.connectors.map((fixture) => {
  const tools = fixtureTools(fixture.tools);
  return {
    id: fixture.id,
    kind: "api",
    description: fixture.description,
    staticTools: tools,
    async listTools() {
      return tools;
    },
    async callTool(name) {
      return { connector: fixture.id, tool: name, fixture: true };
    },
  };
});

let mutationCount = 0;
const controlled = api("controlled", {
  title: "Controlled Eval Fixtures",
  description:
    "Deterministic fixtures for calls, paging, reduction, and approval routing",
  maxResultBytes: 700,
  tools: [
    {
      name: "read_record",
      description: "Return one deterministic record.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1, maximum: 10_000 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { id: number }) => ({
        id: args.id,
        group: ["alpha", "beta", "gamma"][args.id % 3],
        score: (args.id * 17) % 101,
      }),
    },
    {
      name: "large_document",
      description:
        "Return a deterministic UTF-8 document large enough to require paging.",
      inputSchema: {
        type: "object",
        properties: {
          paragraphs: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 40,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { paragraphs?: number }) => ({
        title: "Deterministic paging fixture",
        paragraphs: Array.from(
          { length: args.paragraphs ?? 40 },
          (_, index) =>
            `${index + 1}. Connecta keeps results bounded. UTF-8: café, 東京, 🧪.`,
        ),
      }),
    },
    {
      name: "records",
      description:
        "Return deterministic records for execute_code filtering and reduction.",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            default: 100,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: (args: { count?: number }) =>
        Array.from({ length: args.count ?? 100 }, (_, index) => ({
          id: index + 1,
          group: ["alpha", "beta", "gamma"][index % 3],
          score: (index * 17) % 101,
        })),
    },
    {
      name: "increment_counter",
      description:
        "Increment an isolated counter to exercise approved destructive routing.",
      inputSchema: {
        type: "object",
        properties: {
          amount: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            default: 1,
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      handler: (args: { amount?: number }) => {
        mutationCount += args.amount ?? 1;
        return { counter: mutationCount };
      },
    },
    {
      name: "activity_snapshot",
      description:
        "Report only the structural keys retained by the isolated activity sink.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: () => {
        const keys = [
          ...new Set(activityEvents.flatMap((event) => Object.keys(event))),
        ].sort();
        const forbidden = [
          "args",
          "arguments",
          "result",
          "results",
          "code",
          "error",
          "errorText",
          "rawError",
        ];
        return {
          eventCount: activityEvents.length,
          keys,
          forbiddenPresent: forbidden.filter((key) => keys.includes(key)),
        };
      },
    },
  ],
});

function authTool(description: string): ToolDef {
  return {
    name: "whoami",
    description,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
}

const oauthRecoverableTools = [
  authTool("Return the OAuth fixture identity after consent."),
];
let oauthAuthorized = false;
const oauthRecoverable: Connector = {
  id: "oauth-recoverable",
  kind: "api",
  description: "OAuth recovery fixture with an isolated consent route",
  staticTools: oauthRecoverableTools,
  async listTools() {
    return oauthRecoverableTools;
  },
  async callTool() {
    if (!oauthAuthorized) {
      throw new ConnectorCallError(
        "auth_required",
        "OAuth consent is required.",
      );
    }
    return { id: "oauth-evaluator", recovered: true };
  },
  async status() {
    return oauthAuthorized
      ? { state: "ok" }
      : {
          state: "auth_required",
          message: "OAuth consent is required.",
        };
  },
  async startAuth(ctx) {
    return {
      state: "auth_required",
      authorizationUrl: `${ctx.baseUrl}/fixture/oauth-recoverable/consent`,
      message: "Open the isolated consent URL.",
    };
  },
  async handleRequest(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/fixture/oauth-recoverable/consent") return null;
    oauthAuthorized = true;
    return new Response("OAuth fixture authorized.");
  },
};

const oauthUnavailableTools = [
  authTool("Exercise an OAuth recovery path with no authorization URL."),
];
const oauthUnavailable: Connector = {
  id: "oauth-unavailable",
  kind: "api",
  description: "OAuth fixture whose provider cannot issue a consent URL",
  staticTools: oauthUnavailableTools,
  async listTools() {
    return oauthUnavailableTools;
  },
  async callTool() {
    throw new ConnectorCallError(
      "auth_required",
      "OAuth provider is unavailable.",
    );
  },
  async status() {
    return {
      state: "auth_required",
      message: "OAuth provider is unavailable.",
    };
  },
  async startAuth() {
    return {
      state: "auth_required",
      message: "OAuth provider did not return an authorization URL.",
    };
  },
};

function staticCredentialConnector(
  id: "static-recoverable" | "static-unavailable",
  allowOperatorUpdate: boolean,
): Connector {
  const tools = [
    authTool("Return the static-credential fixture identity after recovery."),
  ];
  return {
    id,
    kind: "api",
    description: allowOperatorUpdate
      ? "Static credential fixture with an isolated operator handoff"
      : "Static credential fixture with no available operator handoff",
    credential: {
      label: "Eval access token",
      description: "Configured only by the isolated operator fixture.",
    },
    staticTools: tools,
    async listTools() {
      return tools;
    },
    async callTool(_name, _args, ctx) {
      if ((await ctx.credential?.get()) !== "sandbox-ok") {
        throw new ConnectorCallError(
          "auth_required",
          `Credential for ${id} is missing.`,
        );
      }
      return { id: "static-evaluator", recovered: true };
    },
    async handleRequest(request: Request, _ctx: ConnectorContext) {
      const url = new URL(request.url);
      if (
        !allowOperatorUpdate ||
        url.pathname !== `/fixture/${id}/configure`
      ) {
        return null;
      }
      if (request.headers.get("x-connecta-eval-operator") !== operatorToken) {
        return new Response("Forbidden", { status: 403 });
      }
      await vault.set(id, "sandbox-ok", "isolated-eval-operator");
      return Response.json({ configured: true });
    },
  };
}

const staticRecoverable = staticCredentialConnector(
  "static-recoverable",
  true,
);
const staticUnavailable = staticCredentialConnector(
  "static-unavailable",
  false,
);

const connecta = createConnecta({
  auth: bearerToken(token, { subjectId: "current-version-evaluator" }),
  connectors: [
    ...discoveryConnectors,
    controlled,
    oauthRecoverable,
    oauthUnavailable,
    staticRecoverable,
    staticUnavailable,
  ],
  storage,
  executor: quickJsExecutor({
    timeoutMs: 10_000,
    cpuTimeMs: 2_000,
  }),
  credentials: {
    encryptionKey: credentialEncryptionKey,
  },
  calls: {
    defaultTimeoutMs: 15_000,
    maxResultBytes: 8_000,
    maxBatchResultBytes: 12_000,
  },
  activity: {
    deploymentId: "current-version-eval",
    store: {
      record(event) {
        activityEvents.push(event);
      },
      async list({ limit }) {
        return { events: activityEvents.slice(-limit).reverse() };
      },
    },
  },
  serverInfo: {
    name: "connecta-current-version-eval",
    version: sourceCommit.slice(0, 12),
    title: "Connecta current-version eval sandbox",
  },
  deploymentInfo: {
    sourceCommit,
    isolated: true,
  },
});

const server = listen(connecta, {
  port,
  host,
  gracefulShutdown: false,
});
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Eval server did not expose a TCP address.");
}

console.log(
  JSON.stringify({
    event: "ready",
    url: `http://${host}:${address.port}/mcp`,
    baseUrl: `http://${host}:${address.port}`,
    sourceCommit,
    connectorCount: discoveryConnectors.length + 5,
  }),
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await connecta.close();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
