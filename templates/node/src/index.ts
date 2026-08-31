/**
 * Prescribed Connecta deployment.
 *
 * Keep this file as deployment configuration: connectors, authentication,
 * storage, and public origin. Add application logic only inside deliberate
 * api() connector handlers.
 *
 * The operator surface — sign-in, credential vault, access tokens, activity —
 * ships here as commented configuration, because each half needs a secret or a
 * retention decision this file cannot make for you. Uncomment the block you
 * want; README.md § "Turn on the operator surface" walks through all four.
 *
 * Environment (see .env.example):
 *   CONNECTA_TOKEN           required inbound bearer token
 *   PORT                     listen port (default 8787)
 *   PUBLIC_URL               public origin; downstream OAuth calls back to it
 *   CONNECTA_STATE_FILE      fileStorage path (the container points it at /data)
 *   CLERK_PUBLISHABLE_KEY    operator sign-in, once the Clerk block is on
 *   CLERK_SECRET_KEY         operator sign-in, once the Clerk block is on
 *   CONNECTA_CREDENTIAL_KEY  vault key, once the credentials block is on
 *   CONNECTA_ACTIVITY_FILE   activity log, once the activity block is on
 */
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
// Operator sign-in. Needs `npm install @clerk/backend` — it is an optional
// peer, so it does not install with Connecta.
// import { clerkAuth } from "@zackbart/connecta/auth/clerk";
// Payload-free activity history, kept beside the state file.
// import { fileActivityStore } from "./file-activity.js";

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

// Operator sign-in. A bearer token is a client key: it may call tools and read
// connector status, but only a Clerk-authenticated human may write a visible
// connector's credential, and only an operator may issue an access token.
// Without this block the operator pages still render — an operator pastes the
// bearer to read them — and Credentials and Tokens stay read-only.
// const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
// const clerkSecretKey = process.env.CLERK_SECRET_KEY;
// if (!clerkPublishableKey || !clerkSecretKey) {
//   throw new Error(
//     "Operator sign-in needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.",
//   );
// }

const connecta = createConnecta({
  storage: fileStorage(stateFile),
  auth: [
    bearerToken(token, { subjectId: "operator" }),
    // clerkAuth({
    //   publishableKey: clerkPublishableKey,
    //   secretKey: clerkSecretKey,
    //   publicUrl,
    //   // Restrict who may sign in — or use `gate` for anything a domain
    //   // cannot express. Absent, every authenticated Clerk user is admitted.
    //   // allowedDomains: ["acme.com"],
    // }),
  ],
  // Optional member/operator split for Clerk-backed Docker deployments.
  // Connector access is derived from the authenticated identity and cannot be
  // selected by an MCP argument. Omit this block for the legacy all-visible,
  // all-interactive-users-are-operators behavior.
  // identity: {
  //   connectorAccess: ({ principal }) =>
  //     principal?.id === "user_admin" ? "all" : ["time"],
  //   operatorAccess: ({ id }) => id === "user_admin",
  // },
  publicUrl,
  // Required: model-written programs run in a bounded QuickJS child.
  executor: quickJsExecutor(),
  // Credential vault. A connector that declares a `credential` slot becomes
  // editable at /credentials, and its value is encrypted in the state file
  // with this key — so keep the key out of that file and out of source:
  //   node -e "console.log(crypto.randomBytes(32).toString('base64'))"
  // Rotating a credential takes effect on the next call; no restart.
  // credentials: { encryptionKey: process.env.CONNECTA_CREDENTIAL_KEY },
  //
  // Named, revocable Bearer tokens for MCP clients, issued at /tokens by a
  // signed-in operator. Secrets are shown once; only their hashes are stored.
  // Requires the Clerk block above — there is nobody to authorize issuance
  // otherwise.
  // accessTokens: {},
  //
  // Payload-free activity history at /activity: who called what, when, how
  // long it took, and whether it worked. Never arguments, results, generated
  // code, or raw error messages. Commented because retention is yours to
  // choose — see src/file-activity.ts.
  // activity: {
  //   store: fileActivityStore(
  //     process.env.CONNECTA_ACTIVITY_FILE || "./.connecta-activity.jsonl",
  //   ),
  //   deploymentId: "production",
  // },
  connectors: [
    api("time", {
      description: "Time — current timestamp",
      // /credentials lists connectors, not deployments: the page stays hidden
      // until at least one connector declares a slot, vault or no vault. A
      // connector that needs an operator-managed secret adds one here —
      //   credential: { label: "API token" },
      // — and reads it inside a handler with `await ctx.credential?.get()`.
      // Telling the time needs no secret, so this one declares nothing.
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
