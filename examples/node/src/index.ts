/**
 * connecta on Node.
 *
 * One MCP endpoint aggregating two in-code HTTP API connectors behind the nine
 * meta-tools plus execute_code (code mode, QuickJS/WASM sandbox), guarded by
 * static bearer tokens — one of them bound to a toolkit — with OAuth/cache state
 * on disk.
 *
 * Run:
 *   CONNECTA_TOKEN=dev-token npx tsx examples/node/src/index.ts
 *   # then point an MCP client at http://localhost:8787/mcp with
 *   #   Authorization: Bearer dev-token
 *   # …or at http://localhost:8787/mcp?toolkit=clock with
 *   #   Authorization: Bearer clock-dev-token
 */
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

const token = process.env.CONNECTA_TOKEN ?? "dev-token";
const clockToken = process.env.CLOCK_TOKEN ?? "clock-dev-token";
const port = Number(process.env.PORT ?? 8787);

const connecta = createConnecta({
  // fileStorage persists downstream-OAuth/cache state across restarts.
  // Swap for memoryStorage() if you don't need persistence.
  storage: fileStorage("./.connecta-state.json"),
  auth: [
    // Bound credential: this token may open ?toolkit=clock and nothing else —
    // not the `text` connector, and not an unscoped session over the whole
    // registry. Refused at connect time, before any scoped registry exists.
    bearerToken(clockToken, { subjectId: "clock-agent", toolkits: ["clock"] }),
    // Operator credential: `unscoped: true` keeps every connector plus the
    // deployment-wide operator APIs. Saying so explicitly marks the exemption
    // as deliberate — an adapter left
    // unbound beside a bound one warns at startup, because that is usually a
    // forgotten token rather than a decision.
    bearerToken(token, {
      subjectId: "operator",
      toolkits: ["clock"],
      unscoped: true,
    }),
  ],
  // A named scoped view over the registry, selected with ?toolkit=clock.
  toolkits: {
    clock: { connectors: ["time"], description: "Read-only clock access" },
  },
  // Credential liveness checks need a base URL for connector contexts (it is
  // also what downstream OAuth callbacks use), so set it explicitly for the
  // scheduled check below.
  publicUrl: `http://localhost:${port}`,
  // Code mode: QuickJS runs model-written JS in a bounded disposable child.
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

// Credential health: Node's scheduler is a timer, so wire the same check the
// Worker example runs from a cron trigger. Connecta starts no timer itself — the
// core has to run unchanged on Workers, where none exists — and inbound
// authenticated traffic already triggers a due check opportunistically, so this
// is what keeps a long-idle deployment's credentials verified. Checks are
// rate-limited per connector (default: at most one every 15 minutes), so a
// tighter interval does not multiply downstream requests.
const credentialCheck = setInterval(() => {
  void connecta.checkCredentials().catch((err) => {
    console.error("[connecta] credential check failed", err);
  });
}, 15 * 60_000);
// Don't hold the process open on this alone.
credentialCheck.unref();

console.log(`connecta listening on http://localhost:${port}/mcp`);
