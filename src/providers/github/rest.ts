import { api, type ApiTool } from "../../connectors/api.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext, JsonSchema } from "../../types.js";
import { AppAuth, type Permissions } from "./auth.js";
import { ScopePolicy, target, type GitHubScope, type Target } from "./scope.js";

const text = (description: string): JsonSchema => ({ type: "string", minLength: 1, description });
const ownerRepo = { owner: text("Configured repository owner."), repo: text("Repository name under that owner.") };
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const integer = (description: string): JsonSchema => ({ type: "integer", minimum: 1, description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const jsonObject: JsonSchema = { type: "object", additionalProperties: true };
const scopeRecord = object(
  {
    org: { type: "string" },
    repo: { type: "string" },
    access: { type: "string", enum: ["read", "read-write"] },
    workflows: { type: "string", enum: ["write"] },
  },
  ["access"],
);
const selector = object({
  org: text("Configured org scope."),
  repo: text("Exact owner/repo within configured scope."),
});
const repoPath = (t: Target): string => `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
const row = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};

function selectors(input: unknown, policy: ScopePolicy): GitHubScope[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100)
    throw new ConnectorCallError("invalid_args", "Select between 1 and 100 configured scopes.");
  return input.map((item) => {
    const value = row(item);
    if ((value.org === undefined) === (value.repo === undefined))
      throw new ConnectorCallError("invalid_args", "Each selector names either org or repo.");
    if (value.org !== undefined) {
      const owner = policy.owner(value.org);
      const grant = policy.scopes.find((scope) => scope.org === owner);
      if (!grant) throw new ConnectorCallError("invalid_args", "This org is not configured for org-wide access.");
      return grant;
    }
    const parts = typeof value.repo === "string" ? value.repo.split("/") : [];
    const t = target(parts[0], parts.length === 2 ? parts[1] : undefined);
    const grant = policy.scope(t);
    return { repo: `${t.owner}/${t.repo}`, access: grant.access };
  });
}

function searchPartitions(
  scopes: readonly GitHubScope[],
): { id: string; owner: string; repos?: string[]; qualifier: string }[] {
  const orgs = new Set(scopes.flatMap((scope) => (scope.org ? [scope.org] : [])));
  const repos = new Map<string, Set<string>>();
  for (const scope of scopes) {
    if (!scope.repo) continue;
    const [owner, repo] = scope.repo.split("/") as [string, string];
    if (orgs.has(owner)) continue;
    if (!repos.has(owner)) repos.set(owner, new Set());
    repos.get(owner)!.add(repo);
  }
  const partitions = [...orgs].sort().map((owner) => ({ id: `org:${owner}`, owner, qualifier: `org:${owner}` }));
  const result: { id: string; owner: string; repos?: string[]; qualifier: string }[] = [...partitions];
  for (const [owner, names] of [...repos].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...names].sort();
    for (let offset = 0; offset < sorted.length; offset += 5) {
      const chunk = sorted.slice(offset, offset + 5);
      result.push({
        id: chunk.map((repo) => `${owner}/${repo}`).join(","),
        owner,
        repos: chunk,
        qualifier: chunk.map((repo) => `repo:${owner}/${repo}`).join(" "),
      });
    }
  }
  if (result.length > 20)
    throw new ConnectorCallError("invalid_args", "Search fan-out exceeds 20 partitions. Select fewer scopes.");
  return result;
}

function resultTarget(item: Record<string, any>, kind: string): Target {
  if (kind === "repositories" || kind === "code") {
    const name = kind === "code" ? row(item.repository).full_name : item.full_name;
    const parts = typeof name === "string" ? name.split("/") : [];
    return target(parts[0], parts.length === 2 ? parts[1] : undefined);
  }
  let url: URL;
  try {
    url = new URL(item.repository_url);
  } catch {
    throw new ConnectorCallError("connector_call_failed", "GitHub search omitted the repository binding.");
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (url.origin !== "https://api.github.com" || !match || url.search || url.hash)
    throw new ConnectorCallError("connector_call_failed", "GitHub search returned an invalid repository binding.");
  return target(match[1], match[2]);
}

export function restConnector(id: string, auth: AppAuth, policy: ScopePolicy) {
  const scopedRequest = async (
    args: Record<string, any>,
    permissions: Permissions,
    method: "POST" | "PATCH" | "DELETE",
    suffix: string,
    body: unknown,
    ctx: ConnectorContext,
  ) => {
    const t = target(args.owner, args.repo);
    policy.scope(t, true);
    const token = await auth.repo(t, permissions, ctx);
    const data = await auth.json(
      { method, path: `${repoPath(t)}${suffix}`, ...(body !== undefined ? { body } : {}) },
      token,
      ctx,
    );
    return data ?? { deleted: true };
  };
  const tools: ApiTool[] = [
    {
      name: "list_scopes",
      description: "List configured GitHub scopes and reachable repositories for one owner.",
      annotations: { readOnlyHint: true },
      inputSchema: object({
        owner: text("Configured owner; omit to return configuration without network access."),
        page: integer("Repository page, default 1, at most 1000."),
        per_page: { ...integer("Repositories per page, default 100."), maximum: 100 },
      }),
      outputSchema: object(
        {
          acting_as: { type: "string" },
          scopes: { type: "array", items: scopeRecord },
          repositories: { type: "array", items: { type: "string" } },
          next_page: { type: ["integer", "null"] },
        },
        ["acting_as", "scopes"],
      ),
      async handler(args, ctx) {
        if (args.owner === undefined) return { acting_as: "GitHub App", scopes: policy.scopes };
        const owner = policy.owner(args.owner);
        const page = args.page ?? 1;
        const count = args.per_page ?? 100;
        if (page > 1000) throw new ConnectorCallError("invalid_args", "Repository page must be at most 1000.");
        const token = await auth.token(owner, undefined, { metadata: "read" }, ctx);
        const data = row(
          await auth.json(
            { method: "GET", path: "/installation/repositories", query: { page, per_page: count } },
            token,
            ctx,
          ),
        );
        if (!Array.isArray(data.repositories))
          throw new ConnectorCallError("connector_call_failed", "GitHub returned an invalid repository list.");
        const repositories = [];
        for (const item of data.repositories) {
          const repository = row(item);
          const t = resultTarget(repository, "repositories");
          if (t.owner !== owner)
            throw new ConnectorCallError(
              "connector_call_failed",
              "GitHub returned a repository from another installation owner.",
            );
          await auth.checkResult(t, repository.id, token, ctx);
          repositories.push(`${t.owner}/${t.repo}`);
        }
        return {
          acting_as: "GitHub App",
          scopes: policy.scopes.filter((scope) => scope.org === owner || scope.repo?.startsWith(`${owner}/`)),
          repositories,
          next_page: repositories.length === count ? page + 1 : null,
        };
      },
    },
    {
      name: "search_scoped",
      description: "Search GitHub repositories, issues, pull requests or code within configured scopes.",
      annotations: { readOnlyHint: true },
      inputSchema: object(
        {
          terms: text("Literal words only; scope qualifiers and Boolean operators are refused."),
          kind: {
            type: "string",
            enum: ["repositories", "issues", "pull-requests", "code"],
            description: "Resource to search.",
          },
          scopes: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: selector,
            description: "Optional subset; defaults to all configured scopes.",
          },
          pages: {
            type: "object",
            additionalProperties: { type: "integer", minimum: 1, maximum: 10 },
            description: "Page per returned partition ID, at most 10.",
          },
          per_page: { ...integer("Results per partition, default 30."), maximum: 100 },
        },
        ["terms", "kind"],
      ),
      outputSchema: object(
        { partitions: { type: "array", items: jsonObject }, incomplete_results: { type: "boolean" } },
        ["partitions", "incomplete_results"],
      ),
      async handler(args, ctx) {
        if (!/^[a-z0-9_. -]{1,128}$/i.test(args.terms) || /\b(?:OR|NOT|AND)\b/i.test(args.terms))
          throw new ConnectorCallError(
            "invalid_args",
            "Search terms must be literal words, without qualifiers or Boolean operators.",
          );
        const selected = args.scopes === undefined ? policy.scopes : selectors(args.scopes, policy);
        const partitions = searchPartitions(selected);
        if (Object.keys(args.pages ?? {}).some((key) => !partitions.some((partition) => partition.id === key)))
          throw new ConnectorCallError("invalid_args", "Pagination keys must match the selected search partitions.");
        const type = args.kind === "issues" ? " is:issue" : args.kind === "pull-requests" ? " is:pr" : "";
        const queries = partitions.map((partition) => `${partition.qualifier} ${args.terms.trim()}${type}`);
        if (queries.some((query) => query.length > 256))
          throw new ConnectorCallError(
            "invalid_args",
            "The scoped search query exceeds GitHub's 256-character bound. Select fewer repositories.",
          );
        const seen = new Set<string>();
        const output = [];
        let incomplete = false;
        for (const partition of partitions) {
          const page = args.pages?.[partition.id] ?? 1;
          const count = args.per_page ?? 30;
          const permissions: Permissions =
            args.kind === "repositories"
              ? { metadata: "read" }
              : args.kind === "code"
                ? { contents: "read" }
                : { issues: "read", pull_requests: "read" };
          const token = await auth.token(partition.owner, partition.repos, permissions, ctx);
          const kind = args.kind === "pull-requests" ? "issues" : args.kind;
          const query = `${partition.qualifier} ${args.terms.trim()}${type}`;
          const data = row(
            await auth.json(
              { method: "GET", path: `/search/${kind}`, query: { q: query, page, per_page: count } },
              token,
              ctx,
            ),
          );
          if (!Array.isArray(data.items))
            throw new ConnectorCallError("connector_call_failed", "GitHub returned an invalid search result.");
          const items = [];
          for (const value of data.items) {
            const item = row(value);
            const t = resultTarget(item, args.kind);
            policy.owner(t.owner);
            if (t.owner !== partition.owner)
              throw new ConnectorCallError(
                "connector_call_failed",
                "GitHub search escaped its selected partition; results were withheld.",
              );
            await auth.checkResult(
              t,
              args.kind === "repositories" ? item.id : args.kind === "code" ? row(item.repository).id : undefined,
              token,
              ctx,
            );
            const key = `${args.kind}:${t.owner}/${t.repo}:${args.kind === "code" ? item.path : item.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              items.push(value);
            }
          }
          const more = data.items.length === count || data.total_count > page * count;
          const limited = data.incomplete_results === true || (more && page === 10);
          incomplete ||= limited;
          output.push({
            scope: partition.id,
            items,
            total_count: data.total_count,
            incomplete_results: limited,
            next_page: more && page < 10 ? page + 1 : null,
          });
        }
        return { partitions: output, incomplete_results: incomplete };
      },
    },
    {
      name: "create_release",
      description: "Create a GitHub release, optionally as a draft.",
      annotations: { readOnlyHint: false },
      inputSchema: object(
        {
          ...ownerRepo,
          tag_name: text("Release tag."),
          target_commitish: text("Branch or commit for a new tag."),
          name: text("Release title."),
          body: { type: "string", description: "Release notes." },
          draft: bool("Create a draft release."),
          prerelease: bool("Mark as a prerelease."),
        },
        ["owner", "repo", "tag_name"],
      ),
      outputSchema: jsonObject,
      handler: (args, ctx) => {
        const { owner: _owner, repo: _repo, ...body } = args;
        return scopedRequest(args, { contents: "write" }, "POST", "/releases", body, ctx);
      },
    },
    {
      name: "update_release",
      description: "Update or publish an existing GitHub release.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: object(
        {
          ...ownerRepo,
          release_id: integer("Release ID in this repository."),
          tag_name: text("Release tag."),
          name: text("Release title."),
          body: { type: "string", description: "Release notes." },
          draft: bool("Set false to publish a draft."),
          prerelease: bool("Mark as a prerelease."),
        },
        ["owner", "repo", "release_id"],
      ),
      outputSchema: jsonObject,
      handler: (args, ctx) => {
        const { owner: _owner, repo: _repo, release_id, ...body } = args;
        return scopedRequest(args, { contents: "write" }, "PATCH", `/releases/${release_id}`, body, ctx);
      },
    },
    {
      name: "delete_release",
      description: "Delete a GitHub release from the scoped repository.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: object({ ...ownerRepo, release_id: integer("Release ID in this repository.") }, [
        "owner",
        "repo",
        "release_id",
      ]),
      outputSchema: jsonObject,
      handler: (args, ctx) =>
        scopedRequest(args, { contents: "write" }, "DELETE", `/releases/${args.release_id}`, undefined, ctx),
    },
    {
      name: "merge_pull_request",
      description: "Merge a same-repository GitHub pull request with explicit workflow-write scope.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: object(
        {
          ...ownerRepo,
          pull_number: integer("Pull request number."),
          sha: text("Expected head commit SHA; reread after a conflict."),
          merge_method: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: "Merge strategy, default merge.",
          },
        },
        ["owner", "repo", "pull_number", "sha"],
      ),
      outputSchema: jsonObject,
      async handler(args, ctx) {
        const t = target(args.owner, args.repo);
        // GitHub's atomic sha guard binds only the head, not the base/ref.
        // Retargeting can turn a file-safe diff into workflow changes. Require
        // explicit workflow permission before any authentication for merges.
        policy.scope(t, true, true);
        const reader = await auth.repo(t, { pull_requests: "read", contents: "read" }, ctx);
        const pr = row(
          await auth.json({ method: "GET", path: `${repoPath(t)}/pulls/${args.pull_number}` }, reader, ctx),
        );
        const head = row(pr.head);
        const base = row(pr.base);
        if (
          head.sha !== args.sha ||
          row(head.repo).full_name?.toLowerCase() !== `${t.owner}/${t.repo}` ||
          row(base.repo).full_name?.toLowerCase() !== `${t.owner}/${t.repo}`
        )
          throw new ConnectorCallError(
            "conflict",
            "Merge requires the expected head SHA and a same-repository head and base. Reread the pull request.",
          );
        const token = await auth.repo(t, { contents: "write", pull_requests: "write", workflows: "write" }, ctx);
        // GitHub verifies sha atomically. No automatic write retry.
        return auth.json(
          {
            method: "PUT",
            path: `${repoPath(t)}/pulls/${args.pull_number}/merge`,
            body: { sha: args.sha, merge_method: args.merge_method ?? "merge" },
          },
          token,
          ctx,
        );
      },
    },
  ];
  return api(id, { tools });
}
