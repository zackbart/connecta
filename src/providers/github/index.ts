import { array, keys, optionsOf } from "../../config-schema.js";
import { ConnectorCallError } from "../../errors.js";
import { delegatesEachCall, knownProviderFailure } from "../../provider-call.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import { AppAuth, type GitHubApp } from "./auth.js";
import { restConnector } from "./rest.js";
import { parseScopes, ScopePolicy, type GitHubScope } from "./scope.js";
import { skill } from "./skill.generated.js";

export type { GitHubApp } from "./auth.js";
export type { GitHubScope } from "./scope.js";

export interface GitHubOptions extends ProviderOptions {
  app: GitHubApp;
  /** Mixed org and exact repository grants, with explicit access. */
  scopes: readonly GitHubScope[];
}

/** One GitHub App, multiple owner installations, explicit org/repo grants. */
export const github = defineProvider<GitHubOptions>({
  name: "github",
  title: "GitHub",
  kind: "api",
  skill,
  bundle: {
    baselineGzip: 164063,
    note: "./providers/github initial measured baseline includes the hosted MCP SDK plus portable GitHub App signing, exact routing and REST complements; reported against this baseline, not capped (#899).",
  },
  options: optionsOf<GitHubOptions>()({
    ...PROVIDER_COMMON,
    app: optionsOf<GitHubApp>()(keys("appId", "privateKey")),
    scopes: array(optionsOf<GitHubScope>()(keys("org", "repo", "access", "workflows"))),
  }),
  create(id, options, provider) {
    if (options.authScope === "personal")
      throw new Error("shared GitHub App identity; per-user OAuth attribution is planned separately for 0.29.");
    const policy = new ScopePolicy(parseScopes(options.scopes));
    const auth = new AppAuth(options.app, policy);
    const rest = restConnector(id, auth, policy);
    // Delegation invokes these captured functions with Reflect.apply, never
    // through a property or a function's own `call`.
    const restCall = rest.callTool;
    const usageGuide = provider.usageGuide({
      context: [`Act as the GitHub App. Reachable configuration: ${policy.summary()}.`, `Purpose: ${options.purpose}`],
      summary: "GitHub App scopes, installation routing, confined search and workflow-file limits.",
      required: true,
    });
    const credential =
      options.app.privateKey === undefined
        ? {
            label: "GitHub App private key",
            description:
              "RSA PEM for the deployment's GitHub App. Stored encrypted in the configured credential vault.",
            fields: [{ name: "privateKey", label: "Private key PEM", inputType: "password" as const }],
          }
        : undefined;
    // Each call goes to its REST boundary, whose write-outcome verdict stands.
    return delegatesEachCall({
      id,
      title: options.title ?? "GitHub",
      // Preserve the REST tools' existing MCP result envelope.
      kind: "mcp",
      authScope: "shared",
      ...provider.connectorOptions,
      ...(credential ? { credential } : {}),
      description: `GitHub App access to ${policy.summary()}.`,
      usageGuide,
      describe: () => ({
        source: { kind: "custom" },
        endpoint: { origin: "https://api.github.com", path: "/" },
        auth: { mode: "request", header: "Authorization", scheme: "Bearer" },
      }),
      staticTools: rest.staticTools!,
      async listTools(ctx) {
        return rest.listTools(ctx);
      },
      async callTool(name, args, ctx, callOptions) {
        if (!rest.staticTools?.some((tool) => tool.name === name))
          throw knownProviderFailure(
            new ConnectorCallError("invalid_args", "This GitHub tool is not in the REST tool set."),
          );
        const result = await Reflect.apply(restCall, rest, [name, args, ctx, callOptions]);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      },
      async status() {
        return { state: "ok", message: "GitHub App configured; installation access is resolved lazily on use." };
      },
    });
  },
});
