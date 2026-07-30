/**
 * connecta on Node.
 *
 * One MCP endpoint aggregating two in-code HTTP API connectors behind the
 * seven-tool code-first surface (execute_code in a QuickJS/WASM sandbox plus the
 * six explicit tools), guarded by a static bearer token, with OAuth/cache state
 * on disk.
 *
 * Run:
 *   CONNECTA_TOKEN=dev-token npx tsx examples/node/src/index.ts
 *   # then point an MCP client at http://localhost:8787/mcp with
 *   #   Authorization: Bearer dev-token
 */
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

const token = process.env.CONNECTA_TOKEN ?? "dev-token";
const port = Number(process.env.PORT ?? 8787);

const connecta = createConnecta({
  // fileStorage persists downstream-OAuth/cache state across restarts.
  // Swap for memoryStorage() if you don't need persistence.
  storage: fileStorage("./.connecta-state.json"),
  auth: bearerToken(token, { subjectId: "operator" }),
  // Downstream OAuth callbacks use this deployment origin.
  publicUrl: `http://localhost:${port}`,
  // Code mode: QuickJS runs model-written JS in a bounded disposable child.
  // This line is also what selects the seven-tool code-first surface; remove it
  // to serve the nine classic meta-tools instead.
  executor: quickJsExecutor(),
  connectors: [
    api("time", {
      description: "Time — current timestamp",
      tools: [
        {
          name: "get_now",
          description: "Return the current time as an ISO 8601 timestamp.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: async () => ({ now: new Date().toISOString() }),
        },
      ],
    }),
    api("text", {
      description: "Text — string utilities",
      tools: [
        {
          name: "upper",
          description: "Uppercase the given text.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          annotations: { readOnlyHint: true },
          handler: async ({ text }: { text: string }) => ({
            text: text.toUpperCase(),
          }),
        },
      ],
    }),
  ],
});

listen(connecta, port);

console.log(`connecta listening on http://localhost:${port}/mcp`);
