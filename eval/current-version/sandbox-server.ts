import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ConnectorCallError,
  api,
  bearerToken,
  createConnecta,
  memoryStorage,
  type AdmittingExecutor,
  type ApiTool,
  type Connecta,
  type Connector,
  type ExecutorProvider,
  type InboundAuth,
  type ToolCallActivityEvent,
  type ToolDef,
} from "../../src/index.js";
import { quickJsExecutor } from "../../src/executors/quickjs.js";
import { listen } from "../../src/node.js";

interface HoldoutCorpus {
  connectors: {
    id: string;
    description: string;
    tools: { name: string; description: string }[];
  }[];
}

type EvalTraceSource = "outer" | "execute_code";

interface EvalMetaToolTrace {
  schemaVersion: 1;
  sequence: number;
  kind: "meta_tool";
  source: EvalTraceSource;
  operation: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  durationMs: number;
}

interface EvalExecutionTrace {
  schemaVersion: 1;
  sequence: number;
  kind: "execution";
  address: string;
  source: ToolCallActivityEvent["source"];
  outcome: ToolCallActivityEvent["outcome"];
  durationMs: number;
  attempts: number;
  errorCode?: string;
}

type EvalTraceInput =
  | Omit<EvalMetaToolTrace, "schemaVersion" | "sequence">
  | Omit<EvalExecutionTrace, "schemaVersion" | "sequence">;

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
const traceEnabled = process.env.CONNECTA_EVAL_TRACE === "enabled";
const port = Number(process.env.CONNECTA_EVAL_PORT ?? "0");
const host = "127.0.0.1";
const credentialEncryptionKey = Buffer.alloc(32, 7).toString("base64");
const storage = memoryStorage();
const activityEvents: ToolCallActivityEvent[] = [];
const evalTraces: Array<EvalMetaToolTrace | EvalExecutionTrace> = [];
let traceSequence = 0;

function emitTrace(trace: EvalTraceInput): void {
  if (!traceEnabled) return;
  const event = {
    schemaVersion: 1,
    sequence: ++traceSequence,
    ...trace,
  } as EvalMetaToolTrace | EvalExecutionTrace;
  evalTraces.push(event);
  console.log(JSON.stringify({ event: "eval_trace", trace: event }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerOperation(
  name: string,
  args: unknown[],
): { operation: string; arguments: unknown } {
  if (name === "search") {
    return { operation: "search_tools", arguments: args[0] ?? {} };
  }
  if (name === "describe") {
    return { operation: "describe_tools", arguments: args[0] ?? {} };
  }
  if (name === "call") {
    return {
      operation: "call_tool",
      arguments: { address: String(args[0]), args: args[1] ?? {} },
    };
  }
  if (name === "batch") {
    return { operation: "batch_call", arguments: { calls: args[0] ?? [] } };
  }
  if (name === "__callNamespace") {
    return {
      operation: "call_tool",
      arguments: {
        address: `${String(args[0])}.${String(args[1])}`,
        args: args[2] ?? {},
        via: "namespace",
      },
    };
  }
  return { operation: name, arguments: args };
}

function tracedProviders(
  providers: ExecutorProvider[],
): ExecutorProvider[] {
  return providers.map((provider) => ({
    ...provider,
    fns: Object.fromEntries(
      Object.entries(provider.fns).map(([name, fn]) => [
        name,
        async (...args: unknown[]) => {
          const operation = providerOperation(name, args);
          const started = performance.now();
          try {
            const result = await fn(...args);
            emitTrace({
              kind: "meta_tool",
              source: "execute_code",
              ...operation,
              result,
              durationMs: performance.now() - started,
            });
            return result;
          } catch (error) {
            emitTrace({
              kind: "meta_tool",
              source: "execute_code",
              ...operation,
              error: errorMessage(error),
              durationMs: performance.now() - started,
            });
            throw error;
          }
        },
      ]),
    ),
  }));
}

function tracedExecutor(base: AdmittingExecutor): AdmittingExecutor {
  return {
    async acquire(options = {}) {
      const lease = await base.acquire(options);
      return {
        ...(lease.waitMs !== undefined ? { waitMs: lease.waitMs } : {}),
        execute: (code, providers) =>
          lease.execute(code, tracedProviders(providers)),
        release: () => lease.release(),
      };
    },
    execute: (code, providers) =>
      base.execute(code, tracedProviders(providers)),
    ...(base.admissionSnapshot
      ? { admissionSnapshot: () => base.admissionSnapshot!() }
      : {}),
    close: () => base.close?.(),
  };
}

async function outerMetaToolCall(
  request: Request,
): Promise<{ operation: string; arguments: unknown } | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const body = (await request.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown; arguments?: unknown };
    };
    if (
      body.method !== "tools/call" ||
      typeof body.params?.name !== "string"
    ) {
      return undefined;
    }
    return {
      operation: body.params.name,
      arguments: body.params.arguments ?? {},
    };
  } catch {
    return undefined;
  }
}

function withOuterTracing(connecta: Connecta): Connecta {
  return {
    ...connecta,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname === "/__eval/trace"
      ) {
        if (
          request.headers.get("authorization") !== `Bearer ${token}`
        ) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ traces: evalTraces });
      }
      const operation = await outerMetaToolCall(request);
      const started = performance.now();
      try {
        const response = await connecta.fetch(request, env, ctx);
        if (!operation) return response;
        let payload: {
          result?: unknown;
          error?: { message?: unknown };
        } = {};
        try {
          payload = await response.clone().json() as typeof payload;
        } catch {
          // A malformed transport result is still traced below as an error.
        }
        emitTrace({
          kind: "meta_tool",
          source: "outer",
          ...operation,
          ...(payload.result !== undefined
            ? { result: payload.result }
            : {
                error:
                  typeof payload.error?.message === "string"
                    ? payload.error.message
                    : `HTTP ${response.status}`,
              }),
          durationMs: performance.now() - started,
        });
        return response;
      } catch (error) {
        if (operation) {
          emitTrace({
            kind: "meta_tool",
            source: "outer",
            ...operation,
            error: errorMessage(error),
            durationMs: performance.now() - started,
          });
        }
        throw error;
      }
    },
  };
}

const operatorAuth: InboundAuth = {
  kind: "clerk",
  uiAuth: {
    kind: "clerk",
    publishableKey: "pk_test_eval",
    frontendApiUrl: "https://clerk.eval.invalid",
  },
  authorize(request) {
    if (
      request.headers.get("authorization") === `Bearer ${operatorToken}`
    ) {
      return { ok: true, userId: "isolated-eval-operator" };
    }
    return {
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  },
};

const objectOutput = {
  type: "object",
  additionalProperties: true,
} as const;

function genericFixtureContract(
  connectorId: string,
  name: string,
): Pick<ApiTool, "inputSchema" | "outputSchema" | "handler"> {
  if (name.startsWith("list_")) {
    return {
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 25,
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: objectOutput },
          nextCursor: { type: "string" },
        },
        required: ["items"],
        additionalProperties: false,
      },
      handler: (args: { limit?: number }) => ({
        items: [
          {
            id: `${connectorId}-${name}-1`,
            label: `Deterministic ${name.replaceAll("_", " ")} fixture`,
          },
        ].slice(0, args.limit ?? 25),
      }),
    };
  }
  if (name.startsWith("search_")) {
    return {
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 25,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          results: { type: "array", items: objectOutput },
        },
        required: ["query", "results"],
        additionalProperties: false,
      },
      handler: (args: { query: string }) => ({
        query: args.query,
        results: [
          {
            id: `${connectorId}-${name}-1`,
            label: `Result for ${args.query}`,
          },
        ],
      }),
    };
  }
  if (name.startsWith("create_")) {
    return {
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
        },
        required: ["title"],
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      handler: (args: { title: string }) => ({
        id: `${connectorId}-${name}-created`,
        title: args.title,
        created: true,
      }),
    };
  }
  if (name.startsWith("update_")) {
    return {
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          fields: { type: "object", additionalProperties: true },
        },
        required: ["id", "fields"],
        additionalProperties: false,
      },
      outputSchema: objectOutput,
      handler: (args: { id: string; fields: Record<string, unknown> }) => ({
        id: args.id,
        fields: args.fields,
        updated: true,
      }),
    };
  }
  return {
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: objectOutput,
    handler: (args: { id: string }) => ({
      id: args.id,
      connector: connectorId,
      operation: name,
    }),
  };
}

function agentFixtureContract(
  connectorId: string,
  name: string,
): Pick<ApiTool, "inputSchema" | "outputSchema" | "handler"> | undefined {
  const address = `${connectorId}.${name}`;
  if (address === "projects.list_issues") {
    return {
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["open", "closed"] },
          label: { type: "string", minLength: 1 },
        },
        required: ["state"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["open", "closed"] },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                number: { type: "integer" },
                title: { type: "string" },
                state: { type: "string", enum: ["open", "closed"] },
              },
              required: ["number", "title", "state"],
              additionalProperties: false,
            },
          },
        },
        required: ["state", "issues"],
        additionalProperties: false,
      },
      handler: (args: { state: "open" | "closed"; label?: string }) => ({
        state: args.state,
        issues:
          args.state === "open"
            ? [
                {
                  number: 213,
                  title: "Measure agent routing overhead",
                  state: "open",
                },
                {
                  number: 214,
                  title: "Document benchmark protocol",
                  state: "open",
                },
              ]
            : [
                {
                  number: 212,
                  title: "Improve tool lookup ranking",
                  state: "closed",
                },
              ],
      }),
    };
  }
  if (address === "documents.search_content") {
    return {
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                snippet: { type: "string" },
              },
              required: ["id", "title", "snippet"],
              additionalProperties: false,
            },
          },
        },
        required: ["query", "results"],
        additionalProperties: false,
      },
      handler: (args: { query: string }) => ({
        query: args.query,
        results: [
          {
            id: "page-launch-plan",
            title: "Launch plan",
            snippet: "The launch plan begins with a staged customer rollout.",
          },
        ],
      }),
    };
  }
  if (address === "builds.get_workflow_run") {
    return {
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "integer", minimum: 1 },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          runId: { type: "integer" },
          status: { type: "string" },
          conclusion: { type: "string" },
          failedJobId: { type: "integer" },
        },
        required: ["runId", "status", "conclusion", "failedJobId"],
        additionalProperties: false,
      },
      handler: (args: { runId: number }) => ({
        runId: args.runId,
        status: "completed",
        conclusion: "failure",
        failedJobId: args.runId * 100 + 7,
      }),
    };
  }
  if (address === "builds.get_job_logs") {
    return {
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "integer", minimum: 1 },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          jobId: { type: "integer" },
          runId: { type: "integer" },
          lines: { type: "array", items: { type: "string" } },
        },
        required: ["jobId", "runId", "lines"],
        additionalProperties: false,
      },
      handler: (args: { jobId: number }) => ({
        jobId: args.jobId,
        runId: Math.trunc(args.jobId / 100),
        lines: [
          "test: expected 2 received 3",
          "process exited with status 1",
        ],
      }),
    };
  }
  return undefined;
}

function fixtureTools(
  connectorId: string,
  definitions: { name: string; description: string }[],
): ApiTool[] {
  return definitions.map((definition) => ({
    ...definition,
    ...(agentFixtureContract(connectorId, definition.name) ??
      genericFixtureContract(connectorId, definition.name)),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }));
}

const discoveryConnectors: Connector[] = holdout.connectors.map((fixture) =>
  api(fixture.id, {
    description: fixture.description,
    strictValidation: true,
    tools: fixtureTools(fixture.id, fixture.tools),
  }),
);

let mutationCount = 0;
const controlled = api("controlled", {
  title: "Controlled Eval Fixtures",
  description:
    "Deterministic fixtures for calls, paging, reduction, and approval routing",
  maxResultBytes: 700,
  tools: [
    {
      name: "read_record",
      description:
        "Return one deterministic record by id. Use this point lookup when specific ids are requested.",
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
        "Generate a deterministic record collection for filtering and aggregation. Do not use this collection tool for point lookups by id.",
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
    ...(allowOperatorUpdate
      ? {
          credential: {
            label: "Eval access token",
            description: "Configured only by the isolated operator fixture.",
          },
        }
      : {}),
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

const baseExecutor = quickJsExecutor({
  timeoutMs: 10_000,
  cpuTimeMs: 2_000,
});
const executor = traceEnabled ? tracedExecutor(baseExecutor) : baseExecutor;

const connecta = createConnecta({
  auth: [
    bearerToken(token, { subjectId: "current-version-evaluator" }),
    operatorAuth,
  ],
  connectors: [
    ...discoveryConnectors,
    controlled,
    oauthRecoverable,
    oauthUnavailable,
    staticRecoverable,
    staticUnavailable,
  ],
  storage,
  executor,
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
        emitTrace({
          kind: "execution",
          address: event.address,
          source: event.source,
          outcome: event.outcome,
          durationMs: event.durationMs,
          attempts: event.attempts,
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        });
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

const server = listen(traceEnabled ? withOuterTracing(connecta) : connecta, {
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
    traceEnabled,
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
