import { bearerToken } from "@zackbart/connecta/auth/bearer";
import { operatorUi } from "@zackbart/connecta/ui";
// import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
// import { activityHistory } from "@zackbart/connecta/activity";
/**
 * Prescribed Connecta deployment.
 *
 * Keep this file as deployment configuration: connectors, authentication,
 * storage, and public origin. Add application logic only inside deliberate
 * api() connector handlers.
 *
 * The optional modules — operator sign-in, credential vault, activity — ship
 * here as commented configuration, because each needs a secret or a retention
 * decision this file cannot make for you. Uncomment the block you want;
 * README.md § "Select optional modules" walks through all three.
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
import { api, createConnecta } from "@zackbart/connecta";
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
const storage = fileStorage(stateFile);

// Operator sign-in. A bearer token is a client key: it may call tools and read
// connector status, but only a Clerk-authenticated human may write a visible
// connector's credential. Without this block the operator UI still renders —
// an operator pastes the bearer to read it — and connections stay read-only.
// const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
// const clerkSecretKey = process.env.CLERK_SECRET_KEY;
// if (!clerkPublishableKey || !clerkSecretKey) {
//   throw new Error(
//     "Operator sign-in needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.",
//   );
// }

const connecta = createConnecta({
  storage,
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
  // Code-owned identity resolvers. The two management permissions default to
  // none, so the template grants them. The commented pair is the optional
  // member/operator split for Clerk-backed deployments: connector access is
  // derived from the authenticated identity and cannot be selected by an MCP
  // argument. Leave them commented for the all-visible,
  // all-interactive-users-read-activity behavior.
  identity: {
    credentialAdministration: () => "all",
    personalConnection: () => "all",
    // connectorAccess: ({ principal }) =>
    //   principal?.id === "user_admin" ? "all" : ["time"],
    // activityAccess: ({ id }) => id === "user_admin",
  },
  publicUrl,
  // Required: model-written programs run in a bounded QuickJS child.
  executor: quickJsExecutor(),
  // Credential vault. A connector that declares a `credential` slot becomes
  // editable inside its connection on /, and its value is encrypted in the state file
  // with this key — so keep the key out of that file and out of source:
  //   node -e "console.log(crypto.randomBytes(32).toString('base64'))"
  // Rotating a credential takes effect on the next call; no restart.
  // vault: encryptedCredentialVault(storage, process.env.CONNECTA_CREDENTIAL_KEY!),
  // Payload-free activity history at /activity: who called what, when, how
  // long it took, and whether it worked. Never arguments, results, generated
  // code, or raw error messages. Commented because retention is yours to
  // choose — see src/file-activity.ts.
  // activity: activityHistory({
  //   store: fileActivityStore(
  //     process.env.CONNECTA_ACTIVITY_FILE || "./.connecta-activity.jsonl",
  //   ),
  //   deploymentId: "production",
  // }),
  // The operator UI at /. Its branding is code, like everything else here:
  // name, owner, description, favicon, and five theme tokens that every
  // other color is mixed from. A value that fails its check falls back to the
  // default, and the startup warning names it.
  // ui: operatorUi({
  //   branding: {
  //     productName: "Acme Tools",
  //     ownerName: "Acme",
  //     theme: {
  //       accent: "#2f5fe0", // hex only
  //       radius: 10, // pixels, or a CSS length such as "0.5rem"
  //       fontFamily: "Inter, system-ui, sans-serif",
  //       monoFamily: "ui-monospace, monospace",
  //       colorScheme: "system", // or "light" | "dark"
  //     },
  //   },
  // }),
  ui: operatorUi(),
  connectors: [
    api("time", {
      description: "Time — current timestamp",
      // A connector that needs an operator-managed secret declares a slot —
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
