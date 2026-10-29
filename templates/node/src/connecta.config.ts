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
  CLERK_ORGANIZATION_ID?: string;
  CONNECTA_MAINTAINERS?: string;
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
  const clerkOrganizationId = set("CLERK_ORGANIZATION_ID");
  if (clerkOrganizationId && !clerkSecretKey) {
    throw new Error("CLERK_ORGANIZATION_ID needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.");
  }
  const clerk =
    clerkPublishableKey && clerkSecretKey
      ? clerkAuth({
          publishableKey: clerkPublishableKey,
          secretKey: clerkSecretKey,
          // Enable Clerk aud_claim_enabled; hosts request the MCP URL as
          // resource. Bound JWT and opaque tokens are the default.
          publicUrl,
          // One Clerk instance can serve many deployments, one Organization
          // each: with CLERK_ORGANIZATION_ID set, only its members sign in.
          ...(clerkOrganizationId ? { organizationId: clerkOrganizationId } : {}),
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
    // Required: can /mcp write? false lets call_destructive_tool and programs
    // write, with the MCP client approving; true leaves write tools out of
    // search and describe and refuses every write call. Pools inherit it
    // unless they set their own readOnly. Startup fails without it.
    readOnly: false,
    // Required: model-written programs run in a bounded QuickJS child.
    executor: quickJsExecutor(),
    auth: clerk ? [clerk] : [],
    // Required with Clerk: the Clerk user ids (comma-separated in
    // CONNECTA_MAINTAINERS) who use plain /mcp, which serves every connector,
    // and the operator UI. They alone administer shared credentials, manage
    // agent tokens, and read activity. Everyone else uses a pool that lists
    // them. Agents are never maintainers.
    maintainers: clerk
      ? (set("CONNECTA_MAINTAINERS") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : [],
    // Each pool serves exactly its tools to its members: Clerk user ids at
    // /mcp/<name>, and "agent:<name>" for a declared agent at /agent/<name>.
    // A member connects their own account on the pool's personal connectors.
    // `npm run doctor` checks /agent/local-machine with its token. The starter
    // pool is the agent's base pool, its lowest tier (shared connectors, no
    // owner), named after the agent as the agent pool layout requires.
    // Each pool lists only people or only agents; share tool lists across separate pools.
    pools: { "local-machine": { tools: ["time"], members: ["agent:local-machine"] } },
    // Machine clients are agents declared here by name, each with one cta_
    // token. Issue or rotate one locally with
    // `npm run --silent rotate-token -- local-machine`, or as a signed-in
    // maintainer from the operator UI. Removing a name stops its token on the
    // next request.
    agents: ["local-machine"],
    // Always installed: a slot with no issued token refuses every request.
    // Tokens from before agents stop admitting until `npm run adopt-token`
    // binds each machine's token to an agent; human-bound tokens never do.
    accessTokens: accessTokens(storage),
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
