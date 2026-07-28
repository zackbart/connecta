/**
 * connecta — Docker compose entrypoint.
 *
 * A single self-contained MCP service, configured entirely from environment
 * variables. State (downstream-OAuth tokens, caches) persists to a JSON file on
 * a named volume via fileStorage. No database.
 *
 * Env vars (see .env.example):
 *   PORT                    listen port (default 8787)
 *   STATE_FILE              fileStorage path (default /data/connecta-state.json)
 *   PUBLIC_URL              public origin, needed for downstream-OAuth callbacks
 *   CONNECTA_TOKEN          static bearer token (inbound auth)
 *   CLERK_PUBLISHABLE_KEY   Clerk OAuth (both keys required to enable)
 *   CLERK_SECRET_KEY        Clerk OAuth (both keys required to enable)
 *   CONNECTA_ALLOW_OPEN     "1" to allow running with NO inbound auth (dev only)
 *
 * Run locally:
 *   docker compose -f examples/docker/docker-compose.yml up -d
 */
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import type { InboundAuth } from "@zackbart/connecta";
import { clerkAuth } from "@zackbart/connecta/auth/clerk";
import { fileStorage, listen } from "@zackbart/connecta/node";

const port = Number(process.env.PORT ?? 8787);
const stateFile = process.env.STATE_FILE ?? "/data/connecta-state.json";
const publicUrl = process.env.PUBLIC_URL;

// --- Inbound auth, assembled from whatever is configured --------------------
const auth: InboundAuth[] = [];

const token = process.env.CONNECTA_TOKEN;
if (token) auth.push(bearerToken(token));

const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const clerkSecretKey = process.env.CLERK_SECRET_KEY;
// Clerk is only enabled when BOTH keys are present.
if (clerkPublishableKey && clerkSecretKey) {
  auth.push(
    clerkAuth({
      publishableKey: clerkPublishableKey,
      secretKey: clerkSecretKey,
      ...(publicUrl !== undefined ? { publicUrl } : {}),
    }),
  );
}

// Fail fast: refuse to start wide open unless explicitly allowed.
if (auth.length === 0 && process.env.CONNECTA_ALLOW_OPEN !== "1") {
  console.error(
    "[connecta] No inbound auth configured. Set CONNECTA_TOKEN and/or " +
      "CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY, or set CONNECTA_ALLOW_OPEN=1 " +
      "to run with an OPEN endpoint (dev only). Refusing to start.",
  );
  process.exit(1);
}

// --- Connectors -------------------------------------------------------------
const connecta = createConnecta({
  // fileStorage persists downstream-OAuth/cache state on the mounted volume.
  storage: fileStorage(stateFile),
  auth,
  ...(publicUrl !== undefined ? { publicUrl } : {}),
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

    // --- Add remote MCP connectors here. Two downstream-auth variants: -------
    //
    // Static headers (simplest — no state needed):
    //
    // remoteMcp("notion", {
    //   url: "https://mcp.notion.com/mcp",
    //   auth: {
    //     type: "headers",
    //     headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}` },
    //   },
    // }),
    //
    // Full downstream OAuth (discovery, DCR, PKCE, refresh — persisted to the
    // state volume). Requires PUBLIC_URL so the /oauth/callback/<id> route is
    // reachable; list_connectors surfaces the authorization URL to open:
    //
    // remoteMcp("linear", {
    //   url: "https://mcp.linear.app/mcp",
    //   auth: { type: "oauth" },
    // }),
    //
    // (import { remoteMcp } from "@zackbart/connecta" above to use these.)
  ],
});

listen(connecta, port);

const mode =
  auth.length === 0 ? "OPEN (no auth)" : `${auth.length} auth provider(s)`;
console.log(
  `[connecta] listening on http://0.0.0.0:${port}/mcp — ${mode}; ` +
    `state: ${stateFile}`,
);
