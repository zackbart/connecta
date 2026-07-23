/**
 * connecta on Node.
 *
 * One MCP endpoint aggregating an HTTP API connector behind the nine meta-tools
 * plus execute_code (code mode, QuickJS/WASM sandbox), guarded by a static
 * bearer token, with OAuth/cache state on disk.
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
  auth: bearerToken(token),
  // Code mode: execute_code runs model-written JS in a QuickJS/WASM sandbox.
  // Remove this line to serve the nine base meta-tools only.
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
  ],
});

listen(connecta, port);
console.log(`connecta listening on http://localhost:${port}/mcp`);
