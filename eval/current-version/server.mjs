import { once } from "node:events";

import { api, bearerToken, createConnecta } from "../../dist/index.js";
import { quickJsExecutor } from "../../dist/executors/quickjs.js";
import { listen } from "../../dist/node.js";

const host = "127.0.0.1";
const port = Number(process.env.CONNECTA_BENCHMARK_PORT ?? "0");
const token = process.env.CONNECTA_BENCHMARK_TOKEN ?? "connecta-benchmark-token";
const downstreamCalls = [];
const outerCalls = [];

const objectSchema = {
  type: "object",
  additionalProperties: true,
};

function readTool(name, description, inputSchema, handler, outputSchema = objectSchema) {
  return {
    name,
    description,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true },
    async handler(args) {
      return handler(args);
    },
  };
}

function connector(id, options) {
  const tools = options.tools.map((tool) => ({
    ...tool,
    handler: async (args) => {
      downstreamCalls.push({ address: `${id}.${tool.name}`, args });
      return tool.handler(args);
    },
  }));
  return api(id, { ...options, tools });
}

const projectTools = [
  readTool(
    "list_projects",
    "List current projects with status and owner.",
    { type: "object", properties: {}, additionalProperties: false },
    () => ({
      projects: [
        { name: "Atlas", status: "on_track", owner: "Rina Shah" },
        { name: "Pulse", id: 2803261, status: "active", owner: "Mina Cho" },
      ],
    }),
  ),
];

const mixpanelTools = [
  readTool(
    "list_events",
    "List tracked Mixpanel event names for a project.",
    {
      type: "object",
      properties: { projectId: { type: "integer" } },
      required: ["projectId"],
      additionalProperties: false,
    },
    () => ({
      events: [
        "App Open or Present Session",
        "App Intention FAQ Troubleshooting Opened",
        "Present Session Completed",
      ],
    }),
  ),
  readTool(
    "query_event_usage",
    "Return a Mixpanel event total for one exact event name and date window.",
    {
      type: "object",
      properties: {
        projectId: { type: "integer" },
        eventName: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90 },
      },
      required: ["projectId", "eventName", "days"],
      additionalProperties: false,
    },
    ({ projectId, eventName, days }) => ({
      headers: ["event", "total", "project_id", "days"],
      rows: [[
        eventName,
        projectId === 2803261 && eventName === "App Open or Present Session" && days === 30
          ? 334100
          : 471,
        projectId,
        days,
      ]],
    }),
  ),
];

const customerRecords = Array.from({ length: 225 }, (_, index) => ({
  id: `cus_benchmark_${String(index + 1).padStart(3, "0")}`,
  email: `private-${String(index + 1).padStart(3, "0")}@example.invalid`,
  status: index % 9 === 0 ? "trialing" : "active",
  plan: index % 3 === 0 ? "annual" : "monthly",
}));

const subscriptionTools = [
  readTool(
    "list_customers",
    "List Stripe sandbox customers with cursor pagination.",
    {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        starting_after: { type: "string" },
      },
      additionalProperties: false,
    },
    ({ limit = 100, starting_after: startingAfter }) => {
      const start = startingAfter
        ? customerRecords.findIndex((record) => record.id === startingAfter) + 1
        : 0;
      const data = customerRecords.slice(start, start + limit);
      return {
        data,
        has_more: start + data.length < customerRecords.length,
      };
    },
  ),
];

const decoys = Array.from({ length: 16 }, (_, connectorIndex) => {
  const id = `service-${String(connectorIndex + 1).padStart(2, "0")}`;
  return connector(id, {
    title: `Fixture service ${connectorIndex + 1}`,
    description: "A deterministic benchmark catalog distractor.",
    tools: Array.from({ length: 4 }, (_, toolIndex) =>
      readTool(
        `lookup_record_${toolIndex + 1}`,
        `Look up fixture record family ${connectorIndex + 1}.${toolIndex + 1}.`,
        {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        ({ id: recordId }) => ({ id: recordId, fixture: true }),
      ),
    ),
  });
});

const connectors = [
  connector("projects", {
    title: "Project registry",
    description: "Current project ownership and delivery status.",
    tools: projectTools,
  }),
  connector("mixpanel", {
    title: "Mixpanel sandbox",
    description: "Product analytics fixtures.",
    usageGuide: {
      required: true,
      summary: "Exact project and event identities plus tabular response rules.",
      content: `# Mixpanel benchmark guide

- The project named Pulse has exact project id \`2803261\`, passed as a JSON number (never a string).
- “Product-wide usage” means the exact event \`App Open or Present Session\`. Do not fuzzy-match event names.
- Resolve it with \`list_events({ "projectId": 2803261 })\` before querying it.
- Query with exactly \`{ "projectId": 2803261, "eventName": "App Open or Present Session", "days": 30 }\`; these field names are case-sensitive.
- Query results are positional: validate that every row has the same width as \`headers\`, then map values by header name.
`,
    },
    tools: mixpanelTools,
  }),
  connector("stripe-sandbox", {
    title: "Stripe sandbox",
    description: "Synthetic subscription and customer records; no production data.",
    tools: subscriptionTools,
  }),
  ...decoys,
];

const app = createConnecta({
  auth: bearerToken(token, { subjectId: "benchmark-agent" }),
  connectors,
  executor: quickJsExecutor({ timeoutMs: 10_000, cpuTimeMs: 2_000 }),
  calls: { defaultTimeoutMs: 10_000, maxResultBytes: 64_000 },
  serverInfo: {
    name: "connecta-current-version-benchmark",
    version: "1",
    title: "Connecta current-version benchmark",
  },
});

async function benchmarkFetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/__benchmark/state") {
    return Response.json({ downstreamCalls, outerCalls });
  }

  let requestJson;
  if (url.pathname === "/mcp" && request.method === "POST") {
    try {
      requestJson = JSON.parse(await request.clone().text());
    } catch {
      requestJson = undefined;
    }
  }
  const response = await app.fetch(request, env, ctx);
  if (requestJson?.method === "tools/call") {
    const text = await response.clone().text();
    outerCalls.push({
      tool: requestJson.params?.name,
      arguments: requestJson.params?.arguments,
      status: response.status,
      contentType: response.headers.get("content-type"),
      responseText: text,
      responseBytes: Buffer.byteLength(text),
    });
  }
  return response;
}

const exposed = { ...app, fetch: benchmarkFetch };
const server = listen(exposed, { port, host, gracefulShutdown: false });
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Benchmark server did not expose a TCP address.");
}

console.log(JSON.stringify({
  event: "ready",
  url: `http://${host}:${address.port}/mcp`,
  stateUrl: `http://${host}:${address.port}/__benchmark/state`,
  token,
}));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await app.close();
}

process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
