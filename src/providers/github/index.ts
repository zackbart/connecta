import { array, keys, optionsOf } from "../../config-schema.js";
import { ConnectorCallError } from "../../errors.js";
import { delegatesEachCall, knownProviderFailure } from "../../provider-call.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import { kit } from "./api.js";
import { AppAuth, type GitHubApp } from "./lib/auth.js";
import { restConnector } from "./tools.js";
import { parseScopes, ScopePolicy, type GitHubScope } from "./lib/scope.js";
import { skill } from "./skill.generated.js";

export type { GitHubApp } from "./lib/auth.js";
export type { GitHubScope } from "./lib/scope.js";

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
  kit,
  bundle: {
    baselineGzip: 324003,
    note: "./providers/github measures 324,003 B gzip standalone in F3 (#703), Node 22 CI static at 9420933711af5e42bf9d134d1b73bed114a48fa0 (run 39997464724, Run pnpm run check:build). This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },
  options: optionsOf<GitHubOptions>()({
    ...PROVIDER_COMMON,
    app: optionsOf<GitHubApp>()(keys("appId", "privateKey")),
    scopes: array(optionsOf<GitHubScope>()(keys("org", "repo", "access", "workflows"))),
  }),
  create(id, options, provider) {
    if (options.authScope === "personal")
      throw new Error("shared GitHub App identity; per-user OAuth attribution is planned separately.");
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
