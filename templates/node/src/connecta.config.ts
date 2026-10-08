/**
 * This deployment's configuration: connectors, authentication, storage, public
 * origin, and the optional operator modules. Add application logic only inside
 * deliberate api() connector handlers.
 *
 * Every optional module is type-checked code switched by the environment
 * (.env.example lists each variable): set it and the module is on, leave it
 * empty and it is off. README.md § "Select optional modules" covers each one.
 * Connecta validates the result when src/index.ts starts it; a mistake refuses
 * to boot rather than running in a shape nobody chose.
 */
import { api, defineConfig } from "@zackbart/connecta";
import { activityHistory } from "@zackbart/connecta/activity";
import { accessTokens } from "@zackbart/connecta/auth/access-tokens";
import { clerkAuth } from "@zackbart/connecta/auth/clerk";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
import { openSqlite, sqliteActivityStore, sqliteStorage } from "@zackbart/connecta/sqlite";
import { operatorUi } from "@zackbart/connecta/ui";

/** The variables this file reads (see .env.example). */
export interface Env {
  PORT?: string;
  PUBLIC_URL?: string;
  CONNECTA_DATABASE?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CONNECTA_CREDENTIAL_KEY?: string;
  CONNECTA_ACTIVITY?: string;
}

export default defineConfig((env: Env) => {
  // Empty is unset: an untouched `.env` passes through Compose as "".
  const set = (name: keyof Env) => env[name] || undefined;
  const publicUrl = set("PUBLIC_URL") ?? `http://localhost:${set("PORT") ?? 8787}`;

  // Operator sign-in. Only a Clerk-authenticated human may manage connector
  // credentials. Machine access tokens never grant interactive authority.
  // Both keys, or neither.
  const clerkPublishableKey = set("CLERK_PUBLISHABLE_KEY");
  const clerkSecretKey = set("CLERK_SECRET_KEY");
  if (Boolean(clerkPublishableKey) !== Boolean(clerkSecretKey)) {
    throw new Error("Operator sign-in needs both CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.");
  }
  const clerk =
    clerkPublishableKey && clerkSecretKey
      ? clerkAuth({
          publishableKey: clerkPublishableKey,
          secretKey: clerkSecretKey,
          // Enable Clerk aud_claim_enabled; hosts request the MCP URL as
          // resource. Bound JWT and opaque tokens are the default.
          publicUrl,
          // Restrict who may sign in with `allowedDomains: ["acme.com"]`, or
          // `gate` for anything a domain cannot express. Absent, every
          // authenticated Clerk user is admitted.
        })
      : undefined;
  // Every piece of state — OAuth grants, sealed credentials, catalogs,
  // paging, access tokens, activity — lives in this one file.
  const database = openSqlite(set("CONNECTA_DATABASE") ?? "./.connecta.sqlite");
  const storage = sqliteStorage(database);

  // The credential vault. A connector that declares a `credential` slot
  // becomes editable inside its connection on /, encrypted in the database
  // with this key — so keep the key out of that file and out of source.
  const credentialKey = set("CONNECTA_CREDENTIAL_KEY");

  return {
    storage,
    publicUrl,
    // Required: model-written programs run in a bounded QuickJS child.
    executor: quickJsExecutor(),
    auth: clerk ? [clerk] : [],
    // Always installed: an empty database refuses machine requests. Provision
    // locally with `npm run provision-token -- "machine-name"`, or grant an
    // interactive human `identity.accessTokenManagement` for later issuance.
    // v0.23 client tokens survive `connecta migrate-state` on this storage.
    accessTokens: accessTokens(storage),
    // Connection management permissions default to none, so the template
    // grants them. Split members from operators with `connectorAccess`,
    // `activityAccess`, and `accessTokenManagement`, each derived from the
    // authenticated identity and never from an MCP argument.
    identity: {
      credentialAdministration: () => "all",
      personalConnection: () => "all",
    },
    vault: credentialKey ? encryptedCredentialVault(storage, credentialKey) : undefined,
    // Payload-free activity history at /activity: who called what, when, how
    // long it took, and whether it worked. Each write prunes rows older than
    // `retentionDays`; the number is yours to choose.
    activity:
      set("CONNECTA_ACTIVITY") === "on"
        ? activityHistory({
            store: sqliteActivityStore(database, { retentionDays: 90 }),
            deploymentId: "production",
          })
        : undefined,
    // The operator UI at /. Branding is code too: operatorUi({ branding }).
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
  };
});
