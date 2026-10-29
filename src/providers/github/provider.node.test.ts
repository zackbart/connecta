// Node-only: the value-safety review harness imports the maintainer schema detector.
import { reviewProblems } from "../../../test/fixtures/value-safety.js";
import candidates from "./evidence/value-safety.json";
import source from "./evidence/openapi.json";
import { SAFETY, githubSafety } from "./safety.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFixture,
  connection,
  context,
  PRIVATE_KEY,
  PUBLIC_KEY,
  SCOPES,
  SENTINEL,
} from "../../../test/fixtures/github-api.js";
import { deferred, spyLogger, waitFor } from "../../../test/fixtures/misc.js";
import { activitySink, invokeTestCall, makeRegistry } from "../../../test/helpers.js";
import { ConnectorCallError } from "../../errors.js";
import { AppAuth } from "./lib/auth.js";
import { githubConnection } from "./api.js";
import { runEdge } from "../../runtime/run.js";
import { appJwt, privateKeyDer } from "./lib/key.js";
import { READ_PERMISSIONS, RELEASE_PERMISSIONS } from "./lib/operations.js";
import { githubIndex, GITHUB_VERDICTS } from "./lib/discovery.js";
import { parseScopes, ScopePolicy } from "./lib/scope.js";

function value(result: any): any {
  return result.structuredContent;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub App provider", () => {
  it("INV-7: concurrent installation resolution uses compare-and-set completed mappings", async () => {
    const fixture = apiFixture();
    const blocked = deferred<Response>();
    let reads = 0;
    fixture.respond((request) => {
      if (request.url.pathname !== "/app/installations") return;
      if (++reads === 1) return blocked.promise;
      return Response.json([
        { id: 44, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
      ]);
    });
    const auth = new AppAuth({ appId: "12345", privateKey: PRIVATE_KEY }, new ScopePolicy(parseScopes(SCOPES)));
    const first = auth.repo({ owner: "acme", repo: "one" }, { contents: "read" }, context());
    await waitFor(() => reads === 1);
    await auth.repo({ owner: "acme", repo: "two" }, { contents: "read" }, context());
    blocked.resolve(
      Response.json([
        { id: 11, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
      ]),
    );
    await first;
    expect(fixture.tokens.map((token) => token.installation)).toEqual(["44", "44"]);
  });

  it("INV-7: a cancelled token owner neither poisons a follower nor caches its late answer", async () => {
    const fixture = apiFixture();
    const blocked = deferred<Response>();
    let mints = 0;
    fixture.respond((request) => {
      if (!request.url.pathname.endsWith("/access_tokens") || !request.body?.repository_ids) return;
      if (++mints === 1) return blocked.promise;
    });
    const auth = new AppAuth({ appId: "12345", privateKey: PRIVATE_KEY }, new ScopePolicy(parseScopes(SCOPES)));
    const controller = new AbortController();
    const first = auth.repo(
      { owner: "acme", repo: "one" },
      { contents: "read" },
      context({ signal: controller.signal }),
    );
    const firstResult = first.catch((error) => error);
    await waitFor(() => mints === 1);
    const second = await auth.repo({ owner: "acme", repo: "one" }, { contents: "read" }, context());
    controller.abort(new Error("cancelled"));
    blocked.resolve(
      Response.json({ token: "ghs_cancelled", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    expect(await firstResult).toBe(controller.signal.reason);
    expect(await auth.repo({ owner: "acme", repo: "one" }, { contents: "read" }, context())).toBe(second);
    expect(mints).toBe(2);
  });

  it.each(["org:outside", "foo OR bar", "foo\nbar"])(
    "INV-4: refuses search injection %s before authentication",
    async (terms) => {
      const fixture = apiFixture();
      await expect(connection().callTool("search_scoped", { terms, kind: "issues" }, context())).rejects.toMatchObject({
        code: "invalid_args",
      });
      expect(fixture.fetchStub).not.toHaveBeenCalled();
    },
  );

  it("INV-4: one search refusal carries every fix the three serial refusals did, with a corrected call", async () => {
    const fixture = apiFixture();
    // A live trace needed three calls: the fields path, then the terms, then the selector.
    const error = await connection()
      .callTool(
        "search_scoped",
        {
          terms: "bug is:open OR crash",
          kind: "issues",
          scopes: [{ org: "other", repo: "one" }],
          fields: ["number", "repository"],
        },
        context(),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(fixture.fetchStub).not.toHaveBeenCalled();
    const { message, validation } = error as ConnectorCallError;
    expect(validation?.issues.map((issue) => issue.path)).toEqual(["/fields/0", "/terms", "/scopes/0"]);
    expect(validation?.issues[0]?.expected).toContain("scope, repository, item");
    expect(validation?.issues[2]).toMatchObject({
      expected: expect.stringMatching(/\{"org": "<org>"\}.*\{"repo": "<owner>\/<repo>"\}.*repo other\/one/),
      received: "both org and repo",
    });
    for (const path of ["/fields/0", "/terms", "/scopes/0"]) expect(message).toContain(path);
    const example = {
      terms: "bug crash",
      kind: "issues",
      scopes: [{ repo: "other/one" }],
      fields: ["item.number", "repository"],
    };
    expect(validation?.example).toEqual(example);
    // The example is the one call that now succeeds.
    fixture.respond((request) =>
      request.url.pathname === "/search/issues" ? Response.json({ items: [], total_count: 0 }) : undefined,
    );
    await expect(connection().callTool("search_scoped", example, context())).resolves.toMatchObject({
      structuredContent: { items: [] },
    });
  });

  it("INV-4: an unfixable search problem gets placeholders, never an invented scope", async () => {
    apiFixture();
    const error = (await connection()
      .callTool("search_scoped", { terms: "is:open", kind: "issues", scopes: [{}, { repo: "outside/x" }] }, context())
      .catch((caught: unknown) => caught)) as ConnectorCallError;
    expect(error.validation?.issues.map((issue) => [issue.path, issue.received])).toEqual([
      ["/terms", undefined],
      ["/scopes/0", "neither org nor repo"],
      ["/scopes/1/repo", undefined],
    ]);
    expect(error.validation?.example).toEqual({
      terms: "<literal words>",
      kind: "issues",
      scopes: [{ repo: "<owner>/<repo>" }, { repo: "<owner>/<repo>" }],
    });
    const owner = (await connection()
      .callTool("list_scopes", { owner: "outside", fields: ["nope"] }, context())
      .catch((caught: unknown) => caught)) as ConnectorCallError;
    expect(owner.validation).toMatchObject({
      issues: [{ path: "/fields/0" }, { path: "/owner", expected: expect.stringContaining("org acme") }],
      example: {},
    });
  });

  it("INV-4: validates all search selectors and cursor partitions before minting", async () => {
    const fixture = apiFixture();
    for (const args of [
      { scopes: [{ org: "other" }] },
      { scopes: [{ repo: "other/two" }] },
      { scopes: [{ org: "acme" }, { repo: "outside/public" }] },
      { cursor: "not-an-issued-cursor" },
    ]) {
      await expect(
        connection().callTool("search_scoped", { terms: "bug", kind: "issues", ...args }, context()),
      ).rejects.toMatchObject({ code: "invalid_args" });
    }
    const review = reviewProblems({ table: SAFETY, index: githubIndex, source, candidates });
    expect(Object.values(review).flat()).toEqual([]);
    const scrubbed = githubSafety.redact(
      {
        temp_clone_token: SENTINEL,
        parent: { temp_clone_token: SENTINEL },
        token: SENTINEL,
        key: SENTINEL,
        download_url: `https://example.com/?token=${SENTINEL}`,
      },
      "GET",
      "/repos/{owner}/{repo}",
    );
    expect(JSON.stringify(scrubbed)).not.toContain(SENTINEL);
    for (const [path, data] of [
      ["/search/issues", { items: [{ body: `See https://example.com/?token=${SENTINEL}` }] }],
      ["/repos/{owner}/{repo}/commits/{ref}", { commit: { message: `See https://example.com/?token=${SENTINEL}` } }],
    ] as const)
      expect(JSON.stringify(githubSafety.redact(data, "GET", path))).not.toContain(SENTINEL);
    const connector = connection(),
      ctx = context();
    expect(connector.staticTools?.map((t) => t.name)).toEqual([
      "github_api_search",
      "github_api_details",
      "github_api_read",
      "github_api_write",
      "list_scopes",
      "search_scoped",
      "merge_pull_request",
    ]);
    expect(Object.keys(READ_PERMISSIONS)).toHaveLength(31);
    for (const op of githubIndex.ops) {
      const key = `${op.method} ${op.path}`;
      if (!READ_PERMISSIONS[key] && !RELEASE_PERMISSIONS[key])
        expect(GITHUB_VERDICTS[key as keyof typeof GITHUB_VERDICTS] ?? "refuse").toBe("refuse");
    }
    for (const path of [
      "/repos/outside/public/issues",
      "/repos/acme/%2e%2e/issues",
      "/repos/acme/one%2f..%2flocked/issues",
      "/repos/acme%2fone/two/issues",
      "/repos/acme/one/contents/%252e%252e%252fsecret",
      "/repos/outside/public/contents",
      "/repos/acme%2Foutside/one/contents",
      "/repos/acme/one%2Foutside/contents",
      "/repos/acme/one/contents/src/index.ts?ref=outside",
      "/repos/acme/one/contents/src/index.ts#fragment",
      "/repos/acme/one/contents/{path}",
      "/repos/acme/one/contents/src/../secret",
      "/repos/acme/one/contents/src/%2e%2e/secret",
      "/repos/acme/one/contents/src%2F..%2Fsecret",
      "/repos/acme/one/contents/src//index.ts",
      "/repos/acme/one/contents/src\\index.ts",
      "/repos/acme/one/contents/src%5Cindex.ts",
      "/repos/acme/one/contents/",
      "/repos/acme/one/commits/feature%2F..%2Foutside",
      "/repos/acme/one/compare/main...outsider:feature",
      "/repos/acme/one/compare/main...outsider%3Afeature",
      "/repos/acme/one/compare/main...outsider%253Afeature",
      "/repos/acme/one/actions/secrets",
      "/repos/acme/one/keys",
      "/repos/acme/one/actions/runs/1/logs",
      "/app/installations",
    ]) {
      await expect(connector.callTool("github_api_read", { path }, ctx), path).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    for (const [path, query] of [
      ["/repos/acme/one/commits/outsider%3Afeature", {}],
      ["/repos/acme/one/contents/settings.json", { ref: "outsider:feature" }],
      ["/repos/acme/one/contents", { ref: "outsider%253Afeature" }],
      ["/repos/acme/one/commits", { sha: "outsider:feature" }],
      ["/repos/acme/one/pulls", { head: "feature" }],
      ["/repos/acme/one/pulls", { base: "outsider:feature" }],
      ["/repos/acme/one/actions/runs", { branch: "outsider:feature" }],
      ["/repos/acme/one/actions/workflows/1/runs", { head_sha: "outsider:feature" }],
      ["/repos/acme/one/releases/tags/outsider%3Av1", {}],
      ["/repos/acme/one/contents/settings.json", { ref: "%broken" }],
    ] as const)
      await expect(connector.callTool("github_api_read", { path, query }, ctx)).rejects.toMatchObject({
        code: "invalid_args",
      });
    for (const head of [
      "feature",
      "acme:",
      "bad_owner:feature",
      "acme:feature:extra",
      "acme:feature%2Fx",
      "acme:feature x",
      "acme:../x",
      "acme:feature\\x",
      "acme:feature//x",
    ]) {
      await expect(
        connector.callTool("github_api_read", { path: "/repos/acme/one/pulls", query: { head } }, ctx),
      ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("head in owner:branch form") });
    }
    for (const path of ["/repos/acme/one/commits/feature/x", "/repos/acme/one/compare/main...feature/x"]) {
      await expect(connector.callTool("github_api_read", { path }, ctx)).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("Encode '/' inside refs as %2F."),
      });
    }
    for (const args of [
      { method: "POST", path: "/app/installations/11/access_tokens", body: {} },
      { method: "PUT", path: "/repos/acme/one/pulls/7/merge", body: { sha: "a".repeat(40) } },
      { method: "POST", path: "/repos/acme/one/releases", body: { tag_name: "v1" }, fields: ["missing"] },
      { method: "POST", path: "/repos/acme/one/releases", body: { tag_name: "[redacted]" } },
      {
        method: "POST",
        path: "/repos/acme/one/releases",
        body: { tag_name: "v1", target_commitish: "outsider:feature" },
      },
      { method: "PATCH", path: "/repos/acme/one/releases/1", body: { tag_name: "outsider:v1" } },
    ])
      await expect(connector.callTool("github_api_write", args, ctx)).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it("INV-4: federates search with narrowed owner tokens, verified results, deduplication and per-partition pagination", async () => {
    const fixture = apiFixture();
    fixture.respond((request) => {
      if (request.url.pathname !== "/search/issues") return;
      const q = request.url.searchParams.get("q")!;
      const repo = q.includes("org:acme") ? "acme/one" : "other/one";
      const item = { id: repo === "acme/one" ? 1 : 2, repository_url: `https://api.github.com/repos/${repo}` };
      return Response.json({ items: [item, item], total_count: 100, incomplete_results: q.includes("org:acme") });
    });
    const connector = connection(),
      ctx = context();
    const first = value(await connector.callTool("search_scoped", { terms: "bug", kind: "issues", limit: 2 }, ctx));
    const second = value(
      await connector.callTool(
        "search_scoped",
        { terms: "bug", kind: "issues", limit: 2, cursor: first.page.nextCursor },
        ctx,
      ),
    );
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.page.hasMore).toBe(true);
    expect(second.page).toEqual({ hasMore: false });
    expect(first.incomplete_results).toBe(true);
    expect(second.incomplete_results).toBe(true);
    expect(fixture.tokens.map((token) => token.body.repository_ids)).toEqual([undefined, [201, 202]]);
    expect(fixture.tokens.map((token) => token.body.permissions)).toEqual([{ issues: "read" }, { issues: "read" }]);
    expect(
      fixture.requests
        .filter((request) => request.url.pathname === "/search/issues")
        .map((request) => request.url.searchParams.get("q")),
    ).toEqual(["org:acme bug is:issue", "repo:other/one repo:other/readonly bug is:issue"]);
    for (const limit of [undefined, 3]) {
      const before = fixture.requests.length;
      await expect(
        connector.callTool(
          "search_scoped",
          { terms: "bug", kind: "issues", ...(limit === undefined ? {} : { limit }), cursor: first.page.nextCursor },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringMatching(/issued with limit 2; repeat limit 2.*\.$/),
      });
      expect(fixture.requests).toHaveLength(before);
    }
    // Default-30 cursors accept the same effective limit, explicit or omitted.
    const defaults = value(await connector.callTool("search_scoped", { terms: "bug", kind: "issues" }, ctx));
    const omitted = value(
      await connector.callTool(
        "search_scoped",
        { terms: "bug", kind: "issues", cursor: defaults.page.nextCursor },
        ctx,
      ),
    );
    const explicit = value(
      await connector.callTool(
        "search_scoped",
        { terms: "bug", kind: "issues", limit: 30, cursor: defaults.page.nextCursor },
        ctx,
      ),
    );
    expect(omitted).toEqual(explicit);
    const beforeDefault = fixture.requests.length;
    await expect(
      connector.callTool(
        "search_scoped",
        { terms: "bug", kind: "issues", limit: 31, cursor: defaults.page.nextCursor },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("issued with limit 30; repeat limit 30"),
    });
    expect(fixture.requests).toHaveLength(beforeDefault);
    fixture.respond((request) =>
      request.url.pathname === "/installation/repositories"
        ? Response.json(
            { repositories: [{ id: 101, full_name: "acme/one" }] },
            {
              headers: {
                link: `<https://api.github.com/installation/repositories?page=${Number(request.url.searchParams.get("page")) + 1}&per_page=${request.url.searchParams.get("per_page")}>; rel="next"`,
              },
            },
          )
        : undefined,
    );
    for (const args of [{}, { owner: "acme" }]) {
      const listing = value(await connector.callTool("list_scopes", { ...args, limit: 1 }, ctx));
      expect(listing.page.hasMore).toBe(true);
      for (const limit of [undefined, 2]) {
        const before = fixture.requests.length;
        await expect(
          connector.callTool(
            "list_scopes",
            { ...args, ...(limit === undefined ? {} : { limit }), cursor: listing.page.nextCursor },
            ctx,
          ),
        ).rejects.toMatchObject({
          code: "invalid_args",
          message: expect.stringMatching(/issued with limit 1; repeat limit 1.*\.$/),
        });
        expect(fixture.requests).toHaveLength(before);
      }
      await connector.callTool("list_scopes", { ...args, limit: 1, cursor: listing.page.nextCursor }, ctx);
    }
    const ownerDefault = value(await connector.callTool("list_scopes", { owner: "acme" }, ctx));
    expect(
      value(await connector.callTool("list_scopes", { owner: "acme", cursor: ownerDefault.page.nextCursor }, ctx)),
    ).toEqual(
      value(
        await connector.callTool(
          "list_scopes",
          { owner: "acme", limit: 30, cursor: ownerDefault.page.nextCursor },
          ctx,
        ),
      ),
    );
    const local = connection({
      scopes: Array.from({ length: 31 }, (_, i) => ({ repo: `acme/repo-${i}`, access: "read" })),
    });
    const beforeLocal = fixture.requests.length;
    const localDefault = value(await local.callTool("list_scopes", {}, ctx));
    expect(localDefault.items).toHaveLength(30);
    const localNext = value(await local.callTool("list_scopes", { cursor: localDefault.page.nextCursor }, ctx));
    expect(localNext.items).toHaveLength(1);
    expect(localNext).toEqual(
      value(await local.callTool("list_scopes", { limit: 30, cursor: localDefault.page.nextCursor }, ctx)),
    );
    expect(fixture.requests).toHaveLength(beforeLocal);
  });

  it("INV-4: rejects public-repository search escapes from both configuration and selected subset", async () => {
    const fixture = apiFixture();
    let repo = "outside/public";
    fixture.respond((request) =>
      request.url.pathname === "/search/code"
        ? Response.json({ items: [{ repository: { full_name: repo }, path: "a" }], total_count: 1 })
        : undefined,
    );
    const connector = connection();
    await expect(
      connector.callTool("search_scoped", { terms: "test", kind: "code", scopes: [{ repo: "acme/one" }] }, context()),
    ).rejects.toMatchObject({ code: "invalid_args" });
    repo = "acme/two";
    await expect(
      connector.callTool("search_scoped", { terms: "test", kind: "code", scopes: [{ repo: "acme/one" }] }, context()),
    ).rejects.toMatchObject({ code: "connector_call_failed" });
  });

  it("INV-4: merge is refused before authentication when workflow-write access is absent, even for apparently safe files", async () => {
    const fixture = apiFixture();
    await expect(
      connection().callTool(
        "merge_pull_request",
        { owner: "acme", repo: "one", pull_number: 7, sha: "a".repeat(40) },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it.each(["retargeted-base", "foreign-head", "stale-sha"])(
    "INV-4: explicit workflow scope covers base-retarget races and merge refuses unsafe head case %s",
    async (kind) => {
      installOwnedTransport();
      const fixture = apiFixture();
      const sha = "a".repeat(40);
      const base = "b".repeat(40);
      fixture.respond((request) => {
        if (request.url.pathname === "/repos/acme/one/pulls/7")
          return Response.json({
            head: {
              sha: kind === "stale-sha" ? "c".repeat(40) : sha,
              repo: { full_name: kind === "foreign-head" ? "outside/public" : "acme/one" },
            },
            base: { sha: base, ref: "main", repo: { full_name: "acme/one" } },
          });
        if (kind === "retargeted-base" && request.url.pathname.endsWith("/merge"))
          return Response.json({ merged: true, base: "old-release-with-workflow-differences" });
      });
      const connector = connection({ scopes: [{ org: "acme", access: "read-write", workflows: "write" }] });
      const call = connector.callTool(
        "merge_pull_request",
        { owner: "acme", repo: "one", pull_number: 7, sha },
        context(),
      );
      const safe = ["normal", "retargeted-base"].includes(kind);
      if (safe) await call;
      else await expect(call).rejects.toMatchObject({ code: "conflict" });
      const merges = fixture.requests.filter((request) => request.url.pathname.endsWith("/merge"));
      expect(merges).toHaveLength(safe ? 1 : 0);
      const writer = fixture.tokens.filter((token) => token.body.permissions.contents === "write");
      expect(writer).toHaveLength(safe ? 1 : 0);
      if (safe) {
        expect(merges[0]!.body).toEqual({ sha, merge_method: "merge" });
        expect(writer[0]!.body.permissions.workflows).toBe("write");
      }
    },
  );

  it("INV-6: 403 classification and token eviction agree on strict rate-limit facts", async () => {
    installOwnedTransport();
    for (const [headers, rate, wait] of [
      [
        { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
        false,
        undefined,
      ],
      ...["1.5", "+5", "1e2", "0x10", "-1"].map((value) => [{ "retry-after": value }, false, undefined] as const),
      [{ "retry-after": "60" }, true, 60_000],
      [{ "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" }, true, 0],
      [{ "x-ratelimit-remaining": "00" }, true, undefined],
      [{ "x-ratelimit-remaining": "0.0" }, false, undefined],
    ] as const) {
      const fixture = apiFixture();
      fixture.respond((request) =>
        request.url.pathname === "/repos/acme/one/releases"
          ? new Response(SENTINEL, { status: 403, headers })
          : undefined,
      );
      const connector = connection();
      for (let i = 0; i < 2; i++)
        await expect(
          connector.callTool(
            "github_api_write",
            { method: "POST", path: "/repos/acme/one/releases", body: { tag_name: "v1" } },
            context(),
          ),
          JSON.stringify(headers),
        ).rejects.toMatchObject({
          code: rate ? "rate_limited" : "auth_required",
          retryable: rate,
          retryAfterMs: wait,
        });
      expect(fixture.tokens, JSON.stringify(headers)).toHaveLength(rate ? 1 : 2);
    }
  });

  it("INV-6: REST malformed/sentinel error responses produce typed facts without body or content-type", async () => {
    installOwnedTransport();
    const fixture = apiFixture();
    const resource = githubConnection();
    for (const [method, path] of [
      ["GET", "/app/installations"],
      ["POST", "/app/installations/11/access_tokens"],
    ] as const) {
      await expect(runEdge(resource.safety.resolve(method, path))).rejects.toMatchObject({
        error: { code: "invalid_args", message: "This GitHub operation is not exposed by the connection." },
      });
    }
    expect(await runEdge(resource.safety.resolve("POST", "/repos/acme/one/releases"))).toEqual({
      method: "POST",
      template: "/repos/{owner}/{repo}/releases",
    });
    expect(await runEdge(resource.safety.resolve("GET", "/installation/repositories"))).toEqual({
      method: "GET",
      template: "/installation/repositories",
    });
    expect(fixture.requests).toHaveLength(0);
    const logger = spyLogger();
    fixture.respond((request) =>
      request.url.pathname === "/repos/acme/one/releases"
        ? new Response(SENTINEL, { status: 403, headers: { "content-type": `application/${SENTINEL}` } })
        : undefined,
    );
    const connector = connection();
    const registry = makeRegistry([connector], { logger: logger.logger });
    const activity = activitySink();
    await invokeTestCall(registry, activity, "github.github_api_write", {
      method: "POST",
      path: "/repos/acme/one/releases",
      body: { tag_name: "v1" },
    });
    expect(JSON.stringify(activity.events)).not.toContain(SENTINEL);
    expect(logger.warnings().join(" ")).not.toContain(SENTINEL);
    expect(activity.events[0]?.errorCode).toBe("auth_required");
    expect(logger.warn.mock.calls.find(([message]) => String(message).includes("call failed"))?.[1]).toMatchObject({
      httpStatus: 403,
    });
    expect(fixture.requests.filter((request) => request.url.pathname === "/repos/acme/one/releases")).toHaveLength(1);
    fixture.respond((request) => (request.url.pathname === "/repos/acme/one/issues" ? Response.json([]) : undefined));
    expect(
      value(
        await connector.callTool(
          "github_api_read",
          { path: "/repos/acme/one/issues", fields: ["id", "title"] },
          context(),
        ),
      ),
    ).toMatchObject({ data: [] });
    fixture.respond((request) =>
      request.url.pathname === "/repos/acme/one/pulls/7" ? new Response("<broken>") : undefined,
    );
    const merge = connection({ scopes: [{ org: "acme", access: "read-write", workflows: "write" }] });
    const failed = await merge
      .callTool("merge_pull_request", { owner: "acme", repo: "one", pull_number: 7, sha: "a".repeat(40) }, context())
      .catch((e) => e);
    expect(failed).toMatchObject({ code: "connector_call_failed" });
    if (!(failed instanceof ConnectorCallError)) throw new Error("Expected the auxiliary lookup to fail.");
    expect(failed.writeOutcome).toBeUndefined();
    expect(failed.message).not.toMatch(/Whether the write|outcome is unknown/);
    expect(fixture.requests.filter((r) => r.url.pathname.endsWith("/merge"))).toHaveLength(0);
    fixture.respond((request) =>
      request.url.pathname === "/repos/acme/one/pulls/7"
        ? Response.json({
            head: { sha: "a".repeat(40), repo: { full_name: "acme/one" } },
            base: { repo: { full_name: "acme/one" } },
          })
        : request.url.pathname.endsWith("/merge")
          ? Response.json({ merged: false, message: SENTINEL })
          : undefined,
    );
    await expect(
      merge.callTool(
        "merge_pull_request",
        { owner: "acme", repo: "one", pull_number: 7, sha: "a".repeat(40) },
        context(),
      ),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    fixture.respond((request) =>
      request.url.pathname === "/repos/acme/one/pulls/7/files"
        ? Response.json([{ sha: "abc", filename: "one.ts", patch: "x".repeat(40000), token: SENTINEL, key: SENTINEL }])
        : undefined,
    );
    const cut = value(
      await connector.callTool("github_api_read", { path: "/repos/acme/one/pulls/7/files" }, context()),
    );
    expect(cut.truncated).toEqual(["data[].patch"]);
    expect(cut.data[0].patch).toHaveLength(32768);
    fixture.respond((request) => {
      if (!request.url.pathname.endsWith("/contents/settings.json")) return;
      return Response.json({ name: "settings.json", encoding: "base64", content: btoa("x".repeat(40000)) });
    });
    const content = value(
      await connector.callTool("github_api_read", { path: "/repos/acme/one/contents/settings.json" }, context()),
    );
    expect(content.truncated).toEqual(["data.content"]);
    expect(atob(content.data.content)).toHaveLength(32768);
    fixture.respond((request) => {
      if (!request.url.pathname.endsWith("/contents/settings.json")) return;
      const bearer = request.headers.get("authorization")!.slice(7);
      return Response.json({
        name: "settings.json",
        path: "settings.json",
        sha: "abc",
        encoding: "base64",
        content: btoa("x".repeat(32766) + bearer + " tail"),
        download_url: `https://example.com/?token=${SENTINEL}`,
      });
    });
    const secretContent = value(
      await connector.callTool("github_api_read", { path: "/repos/acme/one/contents/settings.json" }, context()),
    );
    expect(secretContent.data.content).toBe("[redacted]");
    expect(secretContent.truncated).toBeUndefined();
    expect(JSON.stringify(secretContent)).not.toContain("ghs_");
    expect(JSON.stringify(secretContent)).not.toContain(SENTINEL);
    for (const [path, sent] of [
      ["/repos/acme/one/contents/src/index.ts", "/repos/acme/one/contents/src%2Findex.ts"],
      ["/repos/acme/one/contents/src%2Findex.ts", "/repos/acme/one/contents/src%2Findex.ts"],
      ["/repos/acme/one/contents", "/repos/acme/one/contents"],
      ["/repos/acme/one/commits/feature%2Fx", "/repos/acme/one/commits/feature%2Fx"],
      ["/repos/acme/one/compare/main...feature%2Fx", "/repos/acme/one/compare/main...feature%2Fx"],
    ]) {
      fixture.respond((request) => (request.url.pathname === sent ? Response.json({ id: 42 }) : undefined));
      const before = fixture.requests.length;
      expect(value(await connector.callTool("github_api_read", { path }, context()))).toMatchObject({
        data: { id: 42 },
      });
      expect(fixture.requests.slice(before).filter((request) => request.url.pathname === sent)).toHaveLength(1);
    }
    for (const text of [PRIVATE_KEY, PRIVATE_KEY.split("\n")[1]!.slice(120, 220)]) {
      fixture.respond((request) =>
        request.url.pathname.endsWith("/contents/settings.json")
          ? Response.json({ encoding: "base64", content: btoa(`prefix ${text} suffix`) })
          : request.url.pathname.endsWith("/issues/1")
            ? Response.json({ id: 1, body: `prefix ${text} suffix` })
            : undefined,
      );
      for (const path of ["/repos/acme/one/contents/settings.json", "/repos/acme/one/issues/1"]) {
        const reply = value(await connector.callTool("github_api_read", { path }, context()));
        const display =
          reply.data.content === "[redacted]"
            ? "[redacted]"
            : reply.data.content
              ? atob(reply.data.content)
              : JSON.stringify(reply);
        expect(display).toContain("[redacted]");
        expect(display).not.toContain(PRIVATE_KEY.split("\n")[1]!.slice(120, 160));
      }
    }
    fixture.respond((request) =>
      request.url.pathname === "/repos/acme/one/pulls"
        ? Response.json([{ number: 7, head: { label: request.url.searchParams.get("head") } }])
        : undefined,
    );
    for (const head of ["acme:feature", "ACME:feature/x", "outsider:feature", "outsider:feature+x"]) {
      const before = fixture.requests.length;
      const reply = value(
        await connector.callTool("github_api_read", { path: "/repos/acme/one/pulls", query: { head } }, context()),
      );
      expect(reply.data).toEqual([{ number: 7, head: { label: head } }]);
      const resource = fixture.requests.slice(before).filter((r) => r.url.pathname === "/repos/acme/one/pulls");
      expect(resource).toHaveLength(1);
      expect(resource[0]!.url.searchParams.get("head")).toBe(head);
      expect(fixture.requests.slice(before).some((r) => r.url.pathname.startsWith("/repos/outsider/"))).toBe(false);
      const token = fixture.tokens.find((t) => resource[0]!.headers.get("authorization") === `Bearer ${t.value}`)!;
      expect(token.body.permissions).toEqual({ pull_requests: "read" });
      expect(token.body.repository_ids).toEqual([101]);
    }
    for (const [key, permissions] of Object.entries(READ_PERMISSIONS)) {
      const path = key
        .slice(4)
        .replace("{owner}", "acme")
        .replace("{repo}", "one")
        .replace(/\{[^}]+\}/g, "1");
      fixture.respond((request) => (request.url.pathname === path ? Response.json({ id: 1 }) : undefined));
      await connector.callTool("github_api_read", { path }, context());
      const request = fixture.requests.filter((r) => r.url.pathname === path).at(-1)!;
      const token = fixture.tokens.find((t) => request.headers.get("authorization") === `Bearer ${t.value}`)!;
      expect(token.body.permissions, key).toEqual(permissions);
      expect(token.body.repository_ids, key).toEqual([101]);
    }

    expect(JSON.stringify(cut)).not.toContain(SENTINEL);
  });

  it("INV-5: signs a verifiable RS256 JWT with bounded time and normalized PKCS#1/PKCS#8 keys", async () => {
    const jwt = await appJwt("12345", privateKeyDer(PRIVATE_KEY), Date.now());
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    const decode = (text: string) =>
      Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(new TextDecoder().decode(decode(claims)));
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBe(600);
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        PUBLIC_KEY,
        decode(signature),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
    // PKCS#8's OCTET STRING contains GitHub's PKCS#1 RSA sequence.
    const der = privateKeyDer(PRIVATE_KEY);
    const marker = 22; // 4-byte outer header + version + rsaEncryption sequence.
    expect(der[marker]).toBe(4);
    const lengthBytes = der[marker + 1]! & 127;
    const rsa = der.slice(marker + 2 + lengthBytes);
    const pkcs1 = `-----BEGIN RSA PRIVATE KEY-----\n${btoa(String.fromCharCode(...rsa))}\n-----END RSA PRIVATE KEY-----`;
    expect(privateKeyDer(pkcs1)).toEqual(der);
  });
});
