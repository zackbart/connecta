import { Effect, Option, Schema } from "effect";
import { api } from "../../connectors/api.js";
import { deriveContext } from "../../derived-context.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { fieldsInput, fieldsProblem, selectFields } from "../../http/fields.js";
import { hatch, type HatchBinding } from "../../http/hatch.js";
import { githubPage } from "../../http/hatch-paging.js";
import { Integer, isMinChars } from "../../http/json-schema.js";
import { boundCursor, StandardPage } from "../../http/paging.js";
import { Dispatches } from "../../http/services.js";
import { read, write } from "../../http/tools.js";
import type { SendOptions } from "../../http/vendor.js";
import { Operation } from "../../runtime/call.js";
import { encodeForAgent, redactBeforeCut } from "../../sent-secrets.js";
import { tracksEveryRequest } from "../../provider-call.js";
import type { ConnectorContext } from "../../types.js";
import { checked } from "../_shared/rest/kit.js";
import { withholdEmbeddedUrlsIn } from "../_shared/rest/value-safety.js";
import { githubConnection, rejectedToken } from "./api.js";
import { AppAuth, type Permissions } from "./lib/auth.js";
import { contentsPath, githubIndex, GITHUB_HATCH } from "./lib/discovery.js";
import { READ_PERMISSIONS, RELEASE_PERMISSIONS, hatchRefusal } from "./lib/operations.js";
import { ScopePolicy, target, workflowPath, isPullHead, type GitHubScope, type Target } from "./lib/scope.js";

const text = (description: string) => Schema.String.check(isMinChars(1)).annotate({ description });
const row = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
const repoPath = (t: Target) => `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
const ownerRepo = { owner: text("Configured repository owner."), repo: text("Repository name under that owner.") };
const optional = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Schema.optionalKey(v)])));
const ScopeRow = optional({
  org: Schema.String,
  repo: Schema.String,
  owner: Schema.String,
  id: Integer,
  full_name: Schema.String,
  access: Schema.Literals(["read", "read-write"]),
  workflows: Schema.Literal("write"),
});
const SearchRow = optional({
  scope: Schema.String,
  repository: Schema.String,
  item: Schema.Record(Schema.String, Schema.Unknown),
});
const common = {
  limit: Schema.optionalKey(
    Integer.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description:
        "Maximum returned items, default 30; at most 100. Keep the same limit with cursor; omission uses 30.",
      default: 30,
    }),
  ),
  cursor: Schema.optionalKey(text("Opaque page.nextCursor from this same search or scope listing.")),
  fields: Schema.optionalKey(fieldsInput("Dot paths into each item; only narrows already-safe data.")),
};
const scopeNames = new Set(["org", "repo", "owner", "id", "full_name", "access", "workflows"]);
const searchNames = new Set(["scope", "repository", "item"]);
const contextOf = Effect.gen(function* () {
  const op = yield* Effect.serviceOption(Operation);
  if (Option.isNone(op) || !op.value) return yield* Effect.die(new Error("Missing GitHub call context."));
  return op.value;
});
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

function authCall<A>(ctx: ConnectorContext, run: (view: ConnectorContext) => Promise<A>): Effect.Effect<A, Refusal> {
  return Effect.tryPromise({
    try: (interrupted) =>
      run(deriveContext(ctx, { signal: ctx.signal ? AbortSignal.any([ctx.signal, interrupted]) : interrupted })),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
}

/** Redact before decoding/cutting; keep only bounded inline UTF-8 content and patches. */
function boundedData(data: unknown, ctx: ConnectorContext): { data: unknown; truncated?: string[] } {
  const cutPaths = new Set<string>();
  const cut = (value: string, path: string) => {
    let end = 32768;
    if (value.length <= end) return value;
    if (/[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    cutPaths.add(path);
    return value.slice(0, end);
  };
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => visit(v, `${path}[]`));
    if (value === null || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(source)) {
      const at = `${path}.${key}`;
      if (key === "patch" && typeof entry === "string")
        out[key] = cut(withholdEmbeddedUrlsIn(redactBeforeCut(ctx, entry)) as string, at);
      else if (key === "content" && source.encoding === "base64" && typeof entry === "string") {
        if (entry.includes("[redacted]")) {
          out[key] = "[redacted]";
          continue;
        }
        const normalized = entry.replace(/\s/g, "");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized))
          throw new ConnectorCallError("connector_call_failed", "GitHub returned invalid base64 file content.");
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0)),
          );
        } catch {
          throw new ConnectorCallError(
            "invalid_args",
            "This GitHub connection returns inline UTF-8 file content only; binary and raw downloads are unavailable.",
          );
        }
        const safe = withholdEmbeddedUrlsIn(redactBeforeCut(ctx, decoded)) as string;
        out[key] = encodeForAgent(ctx, cut(safe, at));
      } else out[key] = visit(entry, at);
    }
    return out;
  };
  const safe = visit(data, "data");
  return { data: safe, ...(cutPaths.size ? { truncated: [...cutPaths] } : {}) };
}

export function restConnector(id: string, auth: AppAuth, policy: ScopePolicy) {
  const connection = githubConnection(),
    adapter = githubPage("https://api.github.com");
  const send = (
    request: Omit<Parameters<AppAuth["json"]>[0], "query"> & { query?: Readonly<Record<string, unknown>> },
    bearer: string,
    options: SendOptions = {},
  ) =>
    Effect.gen(function* () {
      const dispatches = yield* Dispatches,
        start = dispatches.length;
      return yield* connection
        .sendPath(
          {
            method: request.method,
            path: request.path,
            template: request.path,
            ...(request.query
              ? {
                  query: Object.entries(request.query).flatMap(([k, v]) =>
                    v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((entry) => [k, String(entry)] as const),
                  ),
                }
              : {}),
            ...(request.body !== undefined ? { json: JSON.stringify(request.body) } : {}),
            headers: { Authorization: `Bearer ${bearer}` },
          },
          options,
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (
                dispatches
                  .slice(start)
                  .some((d) => d.status !== undefined && rejectedToken(d.status, d.headers ?? new Headers()))
              )
                void auth.rejectToken(bearer);
            }),
          ),
        );
    });
  const cursorArgs = (args: Record<string, unknown>) => {
    const { fields: _fields, cursor: _cursor, ...rest } = args;
    return { ...rest, grants: policy.scopes };
  };
  const decode = (name: string, args: Record<string, unknown>) =>
    args.cursor === undefined
      ? Effect.succeed(undefined)
      : boundCursor.decode(name, cursorArgs(args), String(args.cursor));
  const finish = (
    name: string,
    args: Record<string, unknown>,
    items: unknown[],
    next: Record<string, unknown> | undefined,
    extra: Record<string, unknown> = {},
  ) =>
    Effect.gen(function* () {
      const page =
        next === undefined
          ? { hasMore: false }
          : {
              hasMore: true,
              nextCursor: yield* boundCursor.encode(
                name,
                cursorArgs(args),
                JSON.stringify({ ...next, limit: args.limit }),
              ),
            };
      return {
        items: selectFields(items, args.fields as string[] | undefined) as Record<string, unknown>[],
        page,
        ...extra,
      };
    });
  const parse = (cursor: string | undefined, limit: number) => {
    if (cursor === undefined) return {};
    const position = JSON.parse(cursor) as Record<string, any>;
    if (!Number.isSafeInteger(position.limit) || position.limit < 1 || position.limit > 100)
      throw new ConnectorCallError("invalid_args", "This listing cursor is out of date; start a new listing.");
    if (position.limit !== limit)
      throw new ConnectorCallError(
        "invalid_args",
        `This cursor was issued with limit ${position.limit}; repeat limit ${position.limit} or start a new listing.`,
      );
    return position;
  };
  const namesCheck = (fields: readonly string[] | undefined, names: ReadonlySet<string>) =>
    checked(() => {
      const bad = fieldsProblem(fields, names, "an item");
      if (bad) throw bad;
    });
  const scopesTool = read(connection, {
    name: "list_scopes",
    description:
      "List configured GitHub grants locally, or verified reachable repositories for one configured owner. Without owner this reads configuration without network access.",
    input: Schema.Struct({ owner: Schema.optionalKey(text("Configured owner; omit for local grants.")), ...common }),
    output: Schema.Struct({ items: Schema.Array(ScopeRow), page: StandardPage }),
    run: (args) =>
      Effect.gen(function* () {
        yield* namesCheck(args.fields, scopeNames);
        const limit = args.limit ?? 30,
          normalized = { ...args, limit };
        const raw = yield* decode("list_scopes", normalized);
        const position = yield* checked(() => parse(raw, limit));
        const page = position.page ?? 1;
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
          return yield* checked(() => {
            throw new ConnectorCallError("invalid_args", "This repository cursor is outside its page bound.");
          });
        if (args.owner === undefined) {
          const items = policy.scopes.slice((page - 1) * limit, page * limit);
          return yield* finish(
            "list_scopes",
            normalized,
            items,
            page * limit < policy.scopes.length ? { page: page + 1 } : undefined,
          );
        }
        const owner = yield* checked(() => policy.owner(args.owner)),
          ctx = yield* contextOf;
        const token = yield* authCall(ctx, (view) => auth.token(owner, undefined, { metadata: "read" }, view));
        const answer = yield* send(
          { method: "GET", path: "/installation/repositories", query: { page, per_page: limit } },
          token,
          { responseHeaders: ["link"] },
        );
        const body = row(answer.data);
        if (!Array.isArray(body.repositories))
          return yield* checked(() => {
            throw new ConnectorCallError("connector_call_failed", "GitHub returned an invalid repository list.");
          });
        const items = [];
        for (const entry of body.repositories) {
          const repository = row(entry),
            t = yield* checked(() => resultTarget(repository, "repositories"));
          if (t.owner !== owner)
            return yield* checked(() => {
              throw new ConnectorCallError(
                "connector_call_failed",
                "GitHub returned a repository from another installation owner.",
              );
            });
          yield* authCall(ctx, (view) => auth.checkResult(t, repository.id, token, view));
          const grant = yield* checked(() => policy.scope(t));
          items.push({
            id: repository.id,
            full_name: `${t.owner}/${t.repo}`,
            owner: t.owner,
            repo: t.repo,
            access: grant.access,
            ...(grant.workflows ? { workflows: grant.workflows } : {}),
          });
        }
        const next = yield* checked(() =>
          adapter.next(answer.data, {
            path: "/installation/repositories",
            query: { page, per_page: limit },
            headers: answer.headers ?? {},
          }),
        );
        if (next !== null && page === 1000)
          return yield* checked(() => {
            throw new ConnectorCallError(
              "connector_call_failed",
              "The GitHub repository list exceeded its page bound; narrow the configured scope.",
            );
          });
        return yield* finish(
          "list_scopes",
          normalized,
          items,
          next === null ? undefined : { page: adapter.decode(next as number | string) },
        );
      }),
  });
  const searchTool = read(connection, {
    name: "search_scoped",
    description:
      "Search GitHub repositories, issues, pull requests or code within configured scopes. Results carry verified repository and partition bindings; continuation visits one bounded partition page at a time.",
    input: Schema.Struct({
      terms: text("Literal words only; qualifiers and Boolean operators are refused."),
      kind: Schema.Literals(["repositories", "issues", "pull-requests", "code"]).annotate({
        description: "Resource to search.",
      }),
      scopes: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            org: Schema.optionalKey(text("Configured organization grant.")),
            repo: Schema.optionalKey(text("Exact configured owner/repository.")),
          }),
        )
          .check(Schema.isMinLength(1), Schema.isMaxLength(100))
          .annotate({ description: "Optional subset of the configured scopes." }),
      ),
      ...common,
    }),
    output: Schema.Struct({ items: Schema.Array(SearchRow), page: StandardPage, incomplete_results: Schema.Boolean }),
    run: (args) =>
      Effect.gen(function* () {
        yield* namesCheck(args.fields, searchNames);
        const selected = yield* checked(() => {
          if (!/^[a-z0-9_. -]{1,128}$/i.test(args.terms) || /\b(?:OR|NOT|AND)\b/i.test(args.terms))
            throw new ConnectorCallError(
              "invalid_args",
              "Search terms must be literal words, without qualifiers or Boolean operators.",
            );
          return args.scopes === undefined ? policy.scopes : selectors(args.scopes, policy);
        });
        const partitions = yield* checked(() => searchPartitions(selected)),
          limit = args.limit ?? 30,
          normalized = { ...args, limit };
        const raw = yield* decode("search_scoped", normalized),
          at = yield* checked(() => parse(raw, limit));
        const partitionIndex = at.partition ?? 0,
          page = at.page ?? 1;
        if (
          !Number.isSafeInteger(partitionIndex) ||
          partitionIndex < 0 ||
          partitionIndex >= partitions.length ||
          !Number.isSafeInteger(page) ||
          page < 1 ||
          page > 10
        )
          return yield* checked(() => {
            throw new ConnectorCallError("invalid_args", "This search cursor is outside the selected partitions.");
          });
        const partition = partitions[partitionIndex]!,
          kind = args.kind === "pull-requests" ? "issues" : args.kind;
        const type = args.kind === "issues" ? " is:issue" : args.kind === "pull-requests" ? " is:pr" : "";
        const query = `${partition.qualifier} ${args.terms.trim()}${type}`;
        if (query.length > 256)
          return yield* checked(() => {
            throw new ConnectorCallError(
              "invalid_args",
              "The scoped search query exceeds GitHub's 256-character bound. Select fewer repositories.",
            );
          });
        const permissions: Permissions =
          args.kind === "repositories"
            ? { metadata: "read" }
            : args.kind === "code"
              ? { contents: "read" }
              : args.kind === "issues"
                ? { issues: "read" }
                : { pull_requests: "read" };
        const ctx = yield* contextOf,
          token = yield* authCall(ctx, (view) => auth.token(partition.owner, partition.repos, permissions, view));
        const answer = yield* send(
          { method: "GET", path: `/search/${kind}`, query: { q: query, page, per_page: limit } },
          token,
          { responseHeaders: ["link"] },
        );
        const body = row(answer.data);
        if (!Array.isArray(body.items))
          return yield* checked(() => {
            throw new ConnectorCallError("connector_call_failed", "GitHub returned an invalid search result.");
          });
        const items = [],
          seen = new Set<string>();
        for (const value of body.items) {
          const item = row(value),
            t = yield* checked(() => resultTarget(item, args.kind));
          yield* checked(() => policy.owner(t.owner));
          if (t.owner !== partition.owner)
            return yield* checked(() => {
              throw new ConnectorCallError(
                "connector_call_failed",
                "GitHub search escaped its selected partition; results were withheld.",
              );
            });
          yield* authCall(ctx, (view) =>
            auth.checkResult(
              t,
              args.kind === "repositories" ? item.id : args.kind === "code" ? row(item.repository).id : undefined,
              token,
              view,
            ),
          );
          const key = `${args.kind}:${t.owner}/${t.repo}:${args.kind === "code" ? item.path : item.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            items.push({ scope: partition.id, repository: `${t.owner}/${t.repo}`, item: value });
          }
        }
        const next = yield* checked(() =>
          adapter.next(body, {
            path: `/search/${kind}`,
            query: { q: query, page, per_page: limit },
            headers: answer.headers ?? {},
          }),
        );
        const capped = next !== null && page === 10;
        const position =
          next !== null && !capped
            ? { partition: partitionIndex, page: adapter.decode(next as number | string) }
            : partitionIndex + 1 < partitions.length
              ? { partition: partitionIndex + 1, page: 1 }
              : undefined;
        const incomplete = at.incomplete === true || body.incomplete_results === true || capped;
        return {
          ...(yield* finish(
            "search_scoped",
            normalized,
            items,
            position === undefined ? undefined : { ...position, incomplete },
          )),
          incomplete_results: incomplete,
        };
      }),
  });
  const mergeTool = write(connection, {
    name: "merge_pull_request",
    description:
      "Merge a same-repository GitHub pull request once, guarded by expected head SHA and explicit workflow-write scope. A failed preflight sends no merge.",
    destructive: true,
    writeSteps: { pull: "once", write: "once" },
    input: Schema.Struct({
      ...ownerRepo,
      pull_number: Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Pull request number." }),
      sha: text("Expected head commit SHA; reread after a conflict."),
      merge_method: Schema.optionalKey(
        Schema.Literals(["merge", "squash", "rebase"]).annotate({ description: "Merge strategy, default merge." }),
      ),
    }),
    output: Schema.Record(Schema.String, Schema.Unknown),
    run: (args) =>
      Effect.gen(function* () {
        const t = yield* checked(() => target(args.owner, args.repo));
        yield* checked(() => policy.scope(t, true, true));
        const ctx = yield* contextOf,
          reader = yield* authCall(ctx, (view) => auth.repo(t, { pull_requests: "read" }, view));
        const pr = row(
          (yield* send({ method: "GET", path: `${repoPath(t)}/pulls/${args.pull_number}` }, reader, {
            step: "pull",
            effect: "read",
          })).data,
        );
        const head = row(pr.head),
          base = row(pr.base);
        if (
          head.sha !== args.sha ||
          row(head.repo).full_name?.toLowerCase() !== `${t.owner}/${t.repo}` ||
          row(base.repo).full_name?.toLowerCase() !== `${t.owner}/${t.repo}`
        )
          return yield* checked(() => {
            throw new ConnectorCallError(
              "conflict",
              "Merge requires the expected head SHA and a same-repository head and base. Reread the pull request.",
            );
          });
        const token = yield* authCall(ctx, (view) =>
          auth.repo(t, { contents: "write", pull_requests: "write", workflows: "write" }, view),
        );
        return row(
          (yield* send(
            {
              method: "PUT",
              path: `${repoPath(t)}/pulls/${args.pull_number}/merge`,
              body: { sha: args.sha, merge_method: args.merge_method ?? "merge" },
            },
            token,
          )).data,
        );
      }),
  });
  const binding: HatchBinding = {
    review:
      "Repository-ID-bound App tokens and per-operation documented permissions; all unreviewed operations, raw search and merge refuse before authentication.",
    truncated: true,
    path: contentsPath,
    refusal: (op) => hatchRefusal(`${op.method} ${op.path}`),
    refuse: (call) => {
      const key = `${call.method} ${call.op.path}`,
        refusal = hatchRefusal(key);
      if (refusal) return refusal;
      const { params } = githubIndex.resolve(call.method, call.path),
        t = target(params.owner, params.repo);
      policy.scope(t, Boolean(RELEASE_PERMISSIONS[key]));
      if (params.path !== undefined && params.path !== "") workflowPath(decodeURIComponent(params.path));
      const pullList = key === "GET /repos/{owner}/{repo}/pulls";
      if (pullList && call.query.head !== undefined && !isPullHead(call.query.head))
        return "GitHub needs head in owner:branch form; a bare branch is silently ignored. Pass a valid login and branch.";
      // A PR head label only filters this repository's PRs. Owner-prefixed
      // object refs can select fork-network objects and remain unavailable.
      const refs = [
        params.ref,
        params.basehead,
        params.tag,
        ...["ref", "sha", "base", "branch", "head_sha"].map((name) => call.query[name]),
        ...(pullList ? [] : [call.query.head]),
        ...["target_commitish", "tag_name"].map((name) => row(call.body)[name]),
      ];
      for (const ref of refs) {
        if (typeof ref !== "string") continue;
        let decoded: string;
        try {
          decoded = decodeURIComponent(ref);
        } catch {
          return "Use a literal repository-local ref, without malformed percent-encoding.";
        }
        if (/[:%]/.test(decoded))
          return params.basehead !== undefined
            ? "Compare refs within this repository; cross-repository compare is unavailable."
            : "Use refs within this repository; owner-prefixed and encoded repository aliases are unavailable.";
      }
      const perPage = call.query.per_page;
      if (
        perPage !== undefined &&
        (!/^\d+$/.test(String(perPage)) ||
          !Number.isSafeInteger(Number(perPage)) ||
          Number(perPage) < 1 ||
          Number(perPage) > 100)
      )
        return "GitHub per_page must be a whole number from 1 to 100.";
      return undefined;
    },
    send: (call, options) =>
      Effect.gen(function* () {
        const key = `${call.method} ${call.op.path}`,
          { params } = githubIndex.resolve(call.method, call.path),
          t = target(params.owner, params.repo),
          ctx = yield* contextOf;
        const permissions = READ_PERMISSIONS[key] ?? RELEASE_PERMISSIONS[key];
        if (!permissions)
          return yield* checked(() => {
            throw new ConnectorCallError(
              "invalid_args",
              "This GitHub operation has no reviewed permission declaration.",
            );
          });
        const token = yield* authCall(ctx, (view) => auth.repo(t, permissions, view));
        const answer = yield* send(
          {
            method: call.method,
            path: call.path,
            query: call.query,
            ...(call.body === undefined ? {} : { body: call.body }),
          },
          token,
          options,
        );
        const bounded = yield* checked(() => boundedData(answer.data, ctx));
        return { ...answer, ...bounded };
      }),
  };
  return tracksEveryRequest(
    api(id, {
      tools: [
        ...hatch({
          ...GITHUB_HATCH,
          connection,
          binding,
          notes: {
            read: "Only the reviewed repository reads are available. Nested contents paths such as /repos/alice/widget/contents/src/index.ts and the root /repos/alice/widget/contents are accepted. In commits/{ref} and compare/{basehead}, encode branch-name slashes as %2F. Owner-prefixed object refs are refused; PR-list head filters require login:branch. Pass page.nextCursor as cursor; raw page numbers, diffs and log downloads are refused.",
            write: "Only release create/update/delete are available here. Use merge_pull_request for merges.",
          },
        }),
        scopesTool,
        searchTool,
        mergeTool,
      ],
    }),
  );
}
