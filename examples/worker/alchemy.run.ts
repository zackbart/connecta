/**
 * The Alchemy stack that deploys this Worker: the script, its D1 database,
 * Worker Loader, vars and secrets, the Worker-level Cloudflare Access
 * application with Managed OAuth, and the `/agent/*` bypass application.
 * README.md § "Deploy" walks through it; wrangler.jsonc serves only
 * `wrangler dev`.
 *
 * Deploy, update, and plan with an explicit stage, from this folder:
 *   npx alchemy deploy --stage production
 * Alchemy reads CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and the two
 * secrets below from the environment or `.env`. Never commit `.env` or
 * `.alchemy/`: local state records secret values in plaintext.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// Who may sign in. Replace with the deployment's own Access rule.
const signIn = { emailDomain: "example.com" };

export default Alchemy.Stack(
  "Connecta",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // The one database. Retained on destroy: `alchemy destroy` forgets it
    // instead of deleting every grant, credential, and token in it, and the
    // next deploy adopts it again by name. connecta creates its tables.
    const database = yield* Cloudflare.D1.Database("ConnectaDB", { name: "connecta" }).pipe(
      Alchemy.RemovalPolicy.retain(),
    );

    // Optional R2 bucket, for an api() connector handler that stores files.
    // connecta itself never uses one. Bind it as FILES in env below.
    // const files = yield* Cloudflare.R2.Bucket("Files", { name: "connecta-files" }).pipe(
    //   Alchemy.RemovalPolicy.retain(),
    // );

    // Attached to the Worker itself, so Access supplies ctx.access. Managed
    // OAuth's allowlist must keep all three redirect URIs (AGENTS.md).
    const access = yield* Cloudflare.Access.Application("ConnectaAccess", {
      type: "self_hosted",
      name: "connecta",
      policies: [
        { decision: "allow", include: [signIn] },
        // Admits a service token at the edge for `connecta doctor`'s /health
        // read; connecta refuses service identities on MCP and operator routes.
        // { decision: "non_identity", include: [{ serviceToken: "<service token id>" }] },
      ],
      oauthConfiguration: {
        enabled: true,
        dynamicClientRegistration: {
          enabled: true,
          allowedUris: [
            "https://claude.ai/api/mcp/auth_callback",
            "https://chatgpt.com/connector_platform_oauth_redirect",
            "https://chatgpt.com/connector/oauth/*",
          ],
        },
      },
    });

    const worker = yield* Cloudflare.Worker("Connecta", {
      name: "connecta",
      main: "./src/index.ts",
      // Keep enable_request_signal: a client disconnect aborts its request.
      compatibility: { date: "2025-01-01", flags: ["nodejs_compat", "enable_request_signal"] },
      access,
      env: {
        CONNECTA_DB: database,
        // Required by execute_code; Dynamic Workers use the Workers Paid plan.
        LOADER: Cloudflare.WorkerLoader(),
        // FILES: files,
        // The Worker's own URL: its custom domain if any, else workers.dev.
        PUBLIC_URL: Cloudflare.Worker.URL,
        // Comma-separated Access user ids (user_uuid, else email).
        CONNECTA_MAINTAINERS: "operator@example.com",
        // CONNECTA_ACTIVITY: "on",
        // Declare every secret here. Each deploy replaces the Worker's whole
        // binding set, deleting secrets set any other way.
        DOWNSTREAM_TOKEN: Config.Redacted("DOWNSTREAM_TOKEN"),
        CREDENTIAL_ENCRYPTION_KEY: Config.Redacted("CREDENTIAL_ENCRYPTION_KEY"),
      },
    });

    // Lets agents reach /agent/<pool> with only their cta_ token. It bypasses
    // Access on the Worker's primary URL host and never on any other path.
    const agents = yield* Cloudflare.Access.Application("ConnectaAgents", {
      type: "self_hosted",
      name: "connecta agents",
      destinations: Output.map(worker.url, (url) => [
        { type: "public" as const, uri: `${new URL(url!).host}/agent/*` },
      ]),
      policies: [{ decision: "bypass", include: ["everyone"] }],
    });

    return {
      url: worker.url,
      workerId: worker.workerId,
      databaseId: database.databaseId,
      accessApplicationId: access.applicationId,
      agentsApplicationId: agents.applicationId,
    };
  }),
);
