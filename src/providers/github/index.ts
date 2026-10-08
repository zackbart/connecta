import { remoteMcp } from "../../connectors/remote-mcp.js";
import { array, keys, optionsOf } from "../../config-schema.js";
import { ConnectorCallError } from "../../errors.js";
import { redactSentSecrets } from "../../sent-secrets.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import type { Connector, ConnectorContext, ToolClassification } from "../../types.js";
import { AppAuth, type GitHubApp } from "./auth.js";
import { HOSTED_CLASSIFICATION, HOSTED_ROUTES, hostedTarget } from "./hosted.js";
import { restConnector } from "./rest.js";
import { parseScopes, ScopePolicy, type GitHubScope } from "./scope.js";
import { skill } from "./skill.generated.js";

export type { GitHubApp } from "./auth.js";
export type { GitHubScope } from "./scope.js";
export const GITHUB_MCP_ENDPOINT = "https://api.githubcopilot.com/mcp/";

export interface GitHubOptions extends ProviderOptions {
  app: GitHubApp;
  /** Mixed org and exact repository grants, with explicit access. */
  scopes: readonly GitHubScope[];
}

const CLASSIFICATION: ToolClassification = {
  unlisted: "hide",
  tools: {
    ...HOSTED_CLASSIFICATION.tools,
    list_scopes: "read", search_scoped: "read", create_release: "write",
    update_release: "destructive", delete_release: "destructive", merge_pull_request: "destructive",
  },
};

/** One GitHub App, multiple owner installations, explicit org/repo grants. */
export const github = defineProvider<GitHubOptions>({
  name: "github", title: "GitHub", kind: "composed", skill,
  classify: CLASSIFICATION,
  bundle: { baselineGzip: 164063, maxGzip: 224063, note: "./providers/github initial measured baseline includes the hosted MCP SDK plus portable GitHub App signing, exact routing and REST complements; cap retains the existing 60,000-byte provider headroom policy." },
  options: optionsOf<GitHubOptions>()({
    ...PROVIDER_COMMON,
    app: optionsOf<GitHubApp>()(keys("appId", "privateKey")),
    scopes: array(optionsOf<GitHubScope>()(keys("org", "repo", "access", "workflows"))),
  }),
  create(id, options, provider) {
    if (options.authScope === "personal") throw new Error("shared GitHub App identity; per-user OAuth attribution is planned separately for 0.29.");
    const policy = new ScopePolicy(parseScopes(options.scopes));
    const auth = new AppAuth(options.app, policy);
    const rest = restConnector(id, auth, policy);
    const usageGuide = provider.usageGuide({
      context: [`Act as the GitHub App. Reachable configuration: ${policy.summary()}.`, `Purpose: ${options.purpose}`],
      summary: "GitHub App scopes, installation routing, confined search and workflow-file limits.",
      required: true,
    });
    // Each operation owns its token-bound client, transport and callback.
    // It closes them before returning; no shared header or client mutation.
    const hosted = (token: string, classify: ToolClassification = HOSTED_CLASSIFICATION): Connector =>
      remoteMcp(id, {
        url: GITHUB_MCP_ENDPOINT, requireHttps: true, redirects: "none", classify,
        auth: { type: "request", token: async () => token, headers: { "X-MCP-Toolsets": "repos,git,issues,pull_requests,actions,labels", "X-MCP-Tools": Object.keys(HOSTED_ROUTES).join(",") } },
      });
    const withHosted = async <T>(token: string, ctx: ConnectorContext, run: (connector: Connector) => Promise<T>): Promise<T> => {
      const client = hosted(token);
      try { return await run(client); }
      catch (error) {
        if (error instanceof ConnectorCallError && error.code === "auth_required") await auth.rejectToken(token);
        throw redactSentSecrets(ctx, error);
      } finally { await client.closeScope?.(ctx); }
    };
    const credential = options.app.privateKey === undefined ? {
      label: "GitHub App private key",
      description: "RSA PEM for the deployment's GitHub App. Stored encrypted in the configured credential vault.",
      fields: [{ name: "privateKey", label: "Private key PEM", inputType: "password" as const }],
    } : undefined;
    return {
      id, title: options.title ?? "GitHub", kind: "mcp", authScope: "shared",
      ...provider.connectorOptions,
      ...(credential ? { credential } : {}),
      classification: provider.classify,
      description: `GitHub App access to ${policy.summary()}.`, usageGuide,
      describe: () => ({ source: { kind: "custom" }, endpoint: { origin: "https://api.githubcopilot.com", path: "/mcp/" }, auth: { mode: "request", header: "Authorization", scheme: "Bearer" } }),
      async listTools(ctx) {
        // Catalog discovery authenticates only a configured scope, with read
        // permissions. Fetch one complete vendor catalog and preserve schemas.
        const first = policy.scopes[0]!;
        const owner = first.org ?? first.repo!.split("/")[0]!;
        const repos = first.repo ? [first.repo.split("/")[1]!] : undefined;
        const token = await auth.token(owner, repos, { contents: "read", issues: "read", pull_requests: "read", actions: "read", checks: "read", statuses: "read" }, ctx);
        const facts = await withHosted(token, ctx, (client) => client.listTools(ctx));
        const complement = await rest.listTools(ctx);
        // Names not reviewed never leave this boundary, including collisions
        // with the REST complement. The registry alone applies verdicts.
        return [...facts.filter((tool) => Object.hasOwn(HOSTED_ROUTES, tool.name)), ...complement];
      },
      async callTool(name, args, ctx, callOptions) {
        if (Object.hasOwn(HOSTED_ROUTES, name)) {
          const route = hostedTarget(name, args, policy);
          const token = await auth.repo(route.target, route.permissions, ctx);
          return withHosted(token, ctx, (client) => client.callTool(name, args, ctx, callOptions));
        }
        if (!Object.hasOwn(CLASSIFICATION.tools, name)) throw new ConnectorCallError("invalid_args", "This GitHub tool is not in the reviewed allowlist.");
        const result = await rest.callTool(name, args, ctx, callOptions);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      },
      async status() { return { state: "ok", message: "GitHub App configured; installation access is resolved lazily on use." }; },
    };
  },
});
