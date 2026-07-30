/**
 * Prescribed Connecta deployment.
 *
 * Keep this file as deployment configuration: connectors, authentication,
 * storage, and public origin. Add application logic only inside deliberate
 * api() connector handlers.
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

const connecta = createConnecta({
  storage: fileStorage("./.connecta-state.json"),
  auth: bearerToken(token, { subjectId: "operator" }),
  publicUrl: `http://localhost:${port}`,
  // Keep this for the prescribed seven-tool code-first surface.
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
