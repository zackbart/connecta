/**
 * Prescribed Connecta deployment.
 *
 * Keep this file as deployment configuration: connectors, authentication,
 * storage, and public origin. Add application logic only inside deliberate
 * api() connector handlers.
 *
 * Environment (see .env.example):
 *   CONNECTA_TOKEN        required inbound bearer token
 *   PORT                  listen port (default 8787)
 *   PUBLIC_URL            public origin; downstream OAuth calls back to it
 *   CONNECTA_STATE_FILE   fileStorage path (the container points it at /data)
 */
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

const token = process.env.CONNECTA_TOKEN;
if (!token) {
  throw new Error(
    "CONNECTA_TOKEN is required. Refusing to start without inbound auth.",
  );
}
const port = Number(process.env.PORT ?? 8787);
// Empty is unset: an untouched `.env` passes through Compose as "", and an
// empty state path or public origin is worse than the local default.
const stateFile = process.env.CONNECTA_STATE_FILE || "./.connecta-state.json";
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;

const connecta = createConnecta({
  storage: fileStorage(stateFile),
  auth: bearerToken(token, { subjectId: "operator" }),
  publicUrl,
  // Required: model-written programs run in a bounded QuickJS child.
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
console.log(`connecta listening on port ${port}; MCP at ${publicUrl}/mcp`);
