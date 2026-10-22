import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogReviewOf, classifyCatalog, observedCatalogDrift, observeReviewedDrift } from "../../catalog-drift.js";
import { AppAuth } from "./auth.js";
import { appJwt, privateKeyDer } from "./key.js";
import { parseScopes, ScopePolicy } from "./scope.js";
import { HOSTED_ROUTES } from "./hosted.js";
import {
  apiFixture,
  connection,
  context,
  PRIVATE_KEY,
  PUBLIC_KEY,
  SCOPES,
  SENTINEL,
} from "../../../test/fixtures/github-api.js";
import { servedTools } from "../../../test/fixtures/hosted-provider.js";
import { deferred, spyLogger, waitFor } from "../../../test/fixtures/misc.js";
import { activitySink, invokeTestCall, makeRegistry } from "../../../test/helpers.js";
import { CatalogService } from "../../catalog-service.js";
import { InvocationService } from "../../invocation.js";
import { buildSandboxProviders } from "../../execute.js";
import { silentLogger } from "../../../test/helpers.js";
import { memoryStorage } from "../../storage/memory.js";
import { responseCacheKeys } from "../../storage/keys.js";
import { classifyWriteOutcome } from "../../write-outcome.js";

function value(result: any): any {
  return result.structuredContent;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub App provider", () => {
  it("INV-5 INV-6: hosted discovery credential echoes never enter metadata or either catalog cache", async () => {
    const fixture = apiFixture();
    fixture.respond((request) => {
      if (request.body?.method !== "tools/list") return;
      const token = request.headers.get("authorization")!.slice(7);
      return Response.json({
        jsonrpc: "2.0",
        id: request.body.id,
        result: {
          resultType: "complete",
          ttlMs: 60_000,
          cacheScope: "private",
          tools: [
            {
              name: "get_file_contents",
              title: token,
              description: `Read with Bearer ${token}`,
              inputSchema: { type: "object", properties: { echo: { type: "string", description: token } } },
              outputSchema: { type: "object", properties: { echo: { type: "string", description: token } } },
              annotations: { readOnlyHint: true, title: token },
            },
          ],
        },
      });
    });
    const connector = connection();
    const storage = memoryStorage();
    const registry = makeRegistry([connector], { storage });
    const tools = await registry.getTools("github", "https://connecta.test");
    expect(tools.find((tool) => tool.name === "get_file_contents")).toMatchObject({
      title: "[redacted]",
      description: "Read with [redacted]",
      inputSchema: { properties: { echo: { description: "[redacted]" } } },
      outputSchema: { properties: { echo: { description: "[redacted]" } } },
      annotations: { title: "[redacted]" },
    });
    const token = fixture.tokens[0]!.value;
    for (const key of await storage.list(responseCacheKeys.prefix("github")))
      expect(await storage.get(key)).not.toContain(token);
    expect(await makeRegistry([connector], { storage }).getTools("github", "https://connecta.test")).toEqual(tools);
    expect(fixture.requests.filter((request) => request.body?.method === "tools/list")).toHaveLength(1);
  });

  it.each([
    ["get_file_contents", { owner: "outside", repo: "public" }],
    ["get_file_contents", { owner: "other", repo: "../one" }],
    ["issue_write", { owner: "acme", repo: "locked", method: "update" }],
    ["create_repository", { owner: "acme", repo: "one" }],
    ["issue_write", { owner: "acme", repo: "one", method: "delete" }],
    ["issue_write", { owner: "acme", repo: "one", method: "create", parent_owner: "other", parent_repo: "two" }],
    ["add_issue_comment", { owner: "acme", repo: "one", comment_id: 123 }],
    ["pull_request_review_write", { owner: "acme", repo: "one", method: "resolve_thread", threadId: "foreign" }],
    ["create_pull_request", { owner: "acme", repo: "one", head: "outside:branch" }],
    ["get_file_contents", { owner: "acme", repo: "one", new_owner: "outside" }],
  ])("INV-4: refuses %s targets/methods outside scope before key or network access (%j)", async (name, args) => {
    const fixture = apiFixture();
    const get = vi.fn(async () => PRIVATE_KEY);
    const connector = connection({ app: { appId: "12345" } });
    await expect(
      connector.callTool(
        name,
        args,
        context({ credential: { get, getAll: async () => ({ privateKey: PRIVATE_KEY }) } }),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(get).not.toHaveBeenCalled();
    expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it("INV-5: partitions tokens by vault key fingerprint and never describes app secrets", async () => {
    const fixture = apiFixture();
    const connector = connection({ app: { appId: "12345" } });
    const keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const bytes = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
    const second = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
    for (const key of [PRIVATE_KEY, second]) {
      const get = vi.fn(async (field?: string) => (field === "privateKey" ? key : null));
      await connector.callTool(
        "get_file_contents",
        { owner: "other", repo: "one" },
        context({ credential: { get, getAll: async () => ({ privateKey: key }) } }),
      );
      expect(get).toHaveBeenCalledWith("privateKey");
    }
    expect(fixture.tokens).toHaveLength(2);
    const description = JSON.stringify(connection().describe?.());
    expect(description).not.toContain(PRIVATE_KEY);
    expect(description).not.toContain("12345");
    expect(JSON.stringify(connector.describe?.())).not.toContain(second);
    expect(connector.credential?.fields?.[0]?.name).toBe("privateKey");
  });

  it("INV-4: a transferred repository leaves its installation and the cached hosted token returns no data", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.rename(201, "outside/one");
    await expect(
      connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context()),
    ).rejects.not.toThrow(SENTINEL);
    await expect(
      connector.callTool("get_file_contents", { owner: "outside", repo: "one" }, context()),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.tokens).toHaveLength(1);
  });

  it.each([0, 300_001, 3_540_001])(
    "INV-4: a replacement at the old name never inherits its repository grant after %i ms",
    async (elapsed) => {
      const fixture = apiFixture();
      const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
      fixture.rename(201, "other/renamed");
      fixture.repositories([
        { id: 201, full_name: "other/renamed" },
        { id: 999, full_name: "other/one" },
      ]);
      now += elapsed;
      const call = connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
      if (elapsed) await expect(call).rejects.toMatchObject({ code: "invalid_args" });
      else await expect(call).rejects.not.toThrow(SENTINEL);
      expect(fixture.tokens).toHaveLength(1);
      // An explicit new configuration may bind the new repository on first use.
      await connection({ scopes: [{ repo: "other/one", access: "read" }] }).callTool(
        "get_file_contents",
        { owner: "other", repo: "one" },
        context(),
      );
      expect(fixture.tokens[1]!.body.repository_ids).toEqual([999]);
    },
  );

  it("INV-4: an org's exact read-only override follows its repository ID through rename", async () => {
    const fixture = apiFixture();
    const connector = connection();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.callTool("get_file_contents", { owner: "acme", repo: "locked" }, context());
    fixture.rename(102, "acme/new-name");
    now += 300_001;
    await expect(
      connector.callTool("create_branch", { owner: "acme", repo: "new-name", branch: "new" }, context()),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.tokens.every((token) => token.body.permissions.contents !== "write")).toBe(true);
  });

  it("INV-4: an org grant cannot move to a replacement installation on lookup expiry", async () => {
    const fixture = apiFixture();
    const connector = connection();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.callTool("get_file_contents", { owner: "acme", repo: "one" }, context());
    fixture.installations([{ id: 44, account: { login: "acme", type: "Organization" }, repository_selection: "all" }]);
    now += 300_001;
    for (let i = 0; i < 2; i++)
      await expect(
        connector.callTool("get_file_contents", { owner: "acme", repo: "one" }, context()),
      ).rejects.toMatchObject({ code: "auth_required" });
    expect(fixture.tokens).toHaveLength(1);
  });

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

  it.each(["selected", "suspended", "missing", "user"])(
    "INV-4: refuses invalid org installation %s before minting",
    async (kind) => {
      const fixture = apiFixture();
      fixture.installations(
        kind === "missing"
          ? []
          : [
              {
                id: 11,
                account: { login: "acme", type: kind === "user" ? "User" : "Organization" },
                repository_selection: kind === "selected" ? "selected" : "all",
                suspended_at: kind === "suspended" ? "2026-10-07" : null,
              },
            ],
      );
      await expect(
        connection().callTool("get_file_contents", { owner: "acme", repo: "one" }, context()),
      ).rejects.toMatchObject({ code: "auth_required" });
      expect(fixture.tokens).toHaveLength(0);
    },
  );

  it("INV-8: installation resolution follows pagination, and failure never caches a partial mapping", async () => {
    const fixture = apiFixture();
    let fail = true;
    fixture.respond((request) => {
      if (request.url.pathname !== "/app/installations") return;
      const page = request.url.searchParams.get("page");
      if (page === "1")
        return Response.json(
          Array.from({ length: 100 }, (_, i) => ({
            id: 100 + i,
            account: { login: `unused-${i}`, type: "Organization" },
            repository_selection: "all",
          })),
        );
      if (fail) return Response.json({ error: SENTINEL }, { status: 500 });
      return Response.json([{ id: 22, account: { login: "other", type: "User" }, repository_selection: "selected" }]);
    });
    const connector = connection();
    await expect(
      connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context()),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fixture.tokens).toHaveLength(0);
    fail = false;
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    expect(fixture.tokens[0]!.installation).toBe("22");
    expect(
      fixture.requests
        .filter((request) => request.url.pathname === "/app/installations")
        .map((request) => request.url.searchParams.get("page")),
    ).toEqual(["1", "2", "1", "2"]);
  });

  it("INV-1: hides unlisted hosted reads and classifies every exposed operation through the registry", async () => {
    const fixture = apiFixture();
    const connector = connection();
    const ctx = context();
    const facts = await connector.listTools(ctx);
    const tools = await servedTools(connector, ctx);
    const names = tools.map((tool) => tool.name);
    for (const absent of ["create_repository", "fork_repository", "new_upstream_read"])
      expect(names).not.toContain(absent);
    expect(names.filter((name) => name === "list_scopes")).toHaveLength(1);
    for (const [name, route] of Object.entries(HOSTED_ROUTES))
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(route.verdict === "read");
    expect(facts.find((tool) => tool.name === "push_files")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "push_files")?.annotations?.readOnlyHint).toBe(false);
    expect(fixture.protocol).toBeTruthy();
    const review = catalogReviewOf(connector)!;
    const synthetic = [...facts, { name: "fresh_read", annotations: { readOnlyHint: true } }];
    expect((await classifyCatalog(review, "github", synthetic, ctx.logger)).map((tool) => tool.name)).not.toContain(
      "fresh_read",
    );
    await observeReviewedDrift(connector, review, synthetic, ctx.logger);
    expect(observedCatalogDrift(connector)?.unclassifiedTools).toBe(1);
  });

  it.each([
    ".github/workflows/ci.yml",
    ".GITHUB/WORKFLOWS/ci.yml",
    "%2egithub/workflows/ci.yml",
    "src/../.github/workflows/ci.yml",
    "src\\ci.yml",
  ])("INV-4: denies workflow or aliased file path %s before authentication", async (path) => {
    const fixture = apiFixture();
    await expect(
      connection().callTool(
        "create_or_update_file",
        { owner: "acme", repo: "one", path, branch: "main", content: "x", message: "edit" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it("INV-4: checks all pushed paths and explicitly enables workflow permission only for configured workflow writes", async () => {
    const fixture = apiFixture();
    await expect(
      connection().callTool(
        "push_files",
        {
          owner: "acme",
          repo: "one",
          files: [
            { path: "src/a", content: "a" },
            { path: ".github/workflows/ci.yml", content: "x" },
          ],
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
    const connector = connection({
      scopes: [
        { org: "acme", access: "read-write", workflows: "write" },
        { repo: "acme/locked", access: "read-write" },
      ],
    });
    await connector.callTool(
      "create_or_update_file",
      { owner: "acme", repo: "one", path: ".github/workflows/ci.yml", branch: "main", content: "x", message: "edit" },
      context(),
    );
    expect(fixture.tokens[0]!.body).toEqual({
      repository_ids: [101],
      permissions: { contents: "write", workflows: "write" },
    });
    const before = fixture.requests.length;
    await expect(
      connector.callTool(
        "delete_file",
        { owner: "acme", repo: "locked", path: ".github/workflows/ci.yml", branch: "main", message: "delete" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.requests).toHaveLength(before);
  });

  it.each([
    [
      "an unreviewed argument",
      "create_or_update_file",
      { owner: "acme", repo: "one", path: "a", content: "x", message: "m", branch: "main", sha: "a", extra: 1 },
    ],
    [
      "a workflow file without workflow scope",
      "push_files",
      {
        owner: "acme",
        repo: "one",
        branch: "main",
        message: "m",
        files: [{ path: ".github/workflows/ci.yml", content: "x" }],
      },
    ],
  ])(
    "INV-9: a hosted write's target check refuses %s before any token mint or send, a known failure",
    async (_label, name, args) => {
      const fixture = apiFixture();
      const error = await connection()
        .callTool(name, args, context())
        .then(
          () => {
            throw new Error("expected a refusal");
          },
          (failure: unknown) => failure,
        );
      expect(error).toMatchObject({ code: "invalid_args" });
      expect(fixture.fetchStub).not.toHaveBeenCalled();
      expect(fixture.tokens).toHaveLength(0);
      // Ledger provenance: nothing left, so the write is a known failure.
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("failed");
      // Served, GitHub delegates each call, so its own refusal still stands
      // for the whole logical call (round 13).
      const registry = makeRegistry([connection()]);
      const served = await new InvocationService(
        registry,
        new CatalogService(registry, "https://connecta.test"),
      ).invoke(`github.${name}`, args, { source: "call_destructive_tool" });
      expect(served).toMatchObject({ ok: false, dispatched: true, answered: true, error: { code: "invalid_args" } });
      expect(classifyWriteOutcome(served)).toBe("failed");
    },
  );

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

  it("INV-4: validates all search selectors and cursor partitions before minting", async () => {
    const fixture = apiFixture();
    for (const args of [
      { scopes: [{ org: "other" }] },
      { scopes: [{ repo: "other/two" }] },
      { scopes: [{ org: "acme" }, { repo: "outside/public" }] },
      { pages: { "org:outside": 2 } },
    ]) {
      await expect(
        connection().callTool("search_scoped", { terms: "bug", kind: "issues", ...args }, context()),
      ).rejects.toMatchObject({ code: "invalid_args" });
    }
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
    const result = value(
      await connection().callTool(
        "search_scoped",
        { terms: "bug", kind: "issues", pages: { "org:acme": 2 }, per_page: 2 },
        context(),
      ),
    );
    expect(result.partitions.map((partition: any) => partition.items.length)).toEqual([1, 1]);
    expect(result.partitions.map((partition: any) => partition.next_page)).toEqual([3, 2]);
    expect(result.incomplete_results).toBe(true);
    expect(fixture.tokens.map((token) => token.body.repository_ids)).toEqual([undefined, [201, 202]]);
    expect(
      fixture.requests
        .filter((request) => request.url.pathname === "/search/issues")
        .map((request) => request.url.searchParams.get("q")),
    ).toEqual(["org:acme bug is:issue", "repo:other/one repo:other/readonly bug is:issue"]);
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

  it.each(["repositories", "issues", "code"])(
    "INV-4: %s search checks repository IDs even when returned names still match",
    async (kind) => {
      const fixture = apiFixture();
      const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
      await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
      fixture.respond((request) => {
        if (request.url.pathname === "/repos/other/one") return Response.json({ id: 999, full_name: "other/one" });
        if (!request.url.pathname.startsWith("/search/")) return;
        const item =
          kind === "repositories"
            ? { id: 999, full_name: "other/one", body: SENTINEL }
            : kind === "code"
              ? { repository: { id: 999, full_name: "other/one" }, path: "a", body: SENTINEL }
              : { id: 1, repository_url: "https://api.github.com/repos/other/one", body: SENTINEL };
        return Response.json({ items: [item], total_count: 1 });
      });
      const call = connector.callTool("search_scoped", { terms: "test", kind }, context());
      await expect(call).rejects.toMatchObject({ code: "connector_call_failed" });
      await expect(call).rejects.not.toThrow(SENTINEL);
    },
  );

  it("INV-4: scope discovery refuses a name-matching repository with an ungranted ID", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.respond((request) =>
      request.url.pathname === "/installation/repositories"
        ? Response.json({ repositories: [{ id: 999, full_name: "other/one" }] })
        : undefined,
    );
    await expect(connector.callTool("list_scopes", { owner: "other" }, context())).rejects.toMatchObject({
      code: "connector_call_failed",
    });
  });

  it.each([
    { kind: -32602, form: "raw" },
    { kind: -32602, form: "json-escaped" },
    { kind: 400, form: "raw" },
    { kind: 403, form: "raw" },
    { kind: "isError", form: "raw" },
    { kind: "success", form: "json-escaped" },
  ])(
    "INV-5 INV-6: hosted $kind $form credential echoes are redacted for agents, guest calls and nested errors",
    async ({ kind: responseKind, form }) => {
      const fixture = apiFixture();
      const sent = new Set<string>();
      fixture.respond((request) => {
        if (request.body?.method !== "tools/call") return undefined;
        const authorization = request.headers.get("authorization")!;
        const secret = authorization.slice(7);
        sent.add(secret);
        // Put a full secret across the diagnostic's 512-byte clamp boundary:
        // redaction must happen before truncation to avoid leaking its prefix.
        const echo =
          form === "raw"
            ? secret
            : secret
                .split("")
                .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
                .join("");
        const message = `Refused ${"x".repeat(460)} Bearer ${echo}; ${encodeURIComponent(authorization)}; ${btoa(secret)}\nAuthorization: ${authorization}`;
        if (responseKind === 400 || responseKind === 403) return Response.json({ message }, { status: responseKind });
        if (responseKind === "isError" || responseKind === "success") {
          const text = responseKind === "success" ? `{"echo":"${echo}"}` : message;
          const split = text.indexOf(echo) + Math.floor(echo.length / 2);
          return Response.json({
            jsonrpc: "2.0",
            id: request.body.id,
            result: {
              resultType: "complete",
              isError: responseKind === "isError",
              content: [
                { type: "text", text: text.slice(0, split) },
                { type: "text", text: text.slice(split) },
              ],
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.body.id,
          error: { code: responseKind, message, data: { token: secret, nested: { authorization } } },
        });
      });
      const connector = connection();
      const logger = spyLogger();
      const registry = makeRegistry([connector], { logger: logger.logger });
      const activity = activitySink();
      const base = "https://connecta.test";
      const args = { owner: "acme", repo: "one" };
      const outcome = await new InvocationService(
        registry,
        new CatalogService(registry, base),
        activity.activity,
      ).invoke("github.get_file_contents", args, { source: "call_tool" });
      const providers = await buildSandboxProviders(registry, base, silentLogger);
      let guestError: any;
      let guestResult: unknown;
      try {
        guestResult = await providers[0]!.fns.call!("github.get_file_contents", args);
      } catch (error) {
        guestError = error;
      }
      const direct = await connector.callTool("get_file_contents", args, context()).catch((error) => error);
      if (responseKind === "success") {
        expect(outcome).toMatchObject({ ok: true });
        // The blocks unwrap joined by a newline, so the split document is text; each block
        // keeps its own piece of the echo as a placeholder.
        expect(guestResult).toEqual({ data: '{"echo":"[redacted]\n[redacted]"}', format: "text" });
      } else {
        expect(outcome).toMatchObject({ ok: false });
        expect(guestError).toBeInstanceOf(Error);
        if (!outcome.ok) {
          if (responseKind === 403) expect(outcome.error.code).toBe("provider_permission_denied");
          else expect(outcome.error.message).toContain("[redacted]");
        }
      }
      const visible = [
        JSON.stringify(outcome),
        guestError?.message ?? "",
        guestError?.stack ?? "",
        JSON.stringify(guestError) ?? "",
        JSON.stringify(guestError?.cause) ?? "",
        JSON.stringify(guestResult) ?? "",
        JSON.stringify(direct),
        String(direct),
        direct instanceof Error ? JSON.stringify(Object.getOwnPropertyDescriptors(direct)) : "",
        JSON.stringify(activity.events),
        logger.warnings().join(" "),
      ];
      expect(sent.size).toBeGreaterThan(0);
      for (const secret of sent)
        for (const text of visible) {
          expect(text).not.toContain(secret);
          expect(text).not.toContain(encodeURIComponent(secret));
          expect(text).not.toContain(btoa(secret));
          expect(text).not.toContain(secret.slice(0, 8));
        }
    },
  );

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

  it("INV-6: permission 403 with unused rate budget is auth failure and evicts its token", async () => {
    const fixture = apiFixture();
    fixture.respond((request) =>
      request.url.pathname === "/repos/acme/one/releases"
        ? new Response(SENTINEL, {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
            },
          })
        : undefined,
    );
    const connector = connection();
    for (let i = 0; i < 2; i++)
      await expect(
        connector.callTool("create_release", { owner: "acme", repo: "one", tag_name: "v1" }, context()),
      ).rejects.toMatchObject({ code: "auth_required", retryable: false, retryAfterMs: undefined });
    expect(fixture.tokens).toHaveLength(2);
  });

  it("INV-6: REST malformed/sentinel error responses produce typed facts without body or content-type", async () => {
    const fixture = apiFixture();
    const logger = spyLogger();
    fixture.respond((request) =>
      request.url.pathname === "/repos/acme/one/releases"
        ? new Response(SENTINEL, { status: 403, headers: { "content-type": `application/${SENTINEL}` } })
        : undefined,
    );
    const connector = connection();
    const registry = makeRegistry([connector], { logger: logger.logger });
    const activity = activitySink();
    await invokeTestCall(registry, activity, "github.create_release", { owner: "acme", repo: "one", tag_name: "v1" });
    expect(JSON.stringify(activity.events)).not.toContain(SENTINEL);
    expect(logger.warnings().join(" ")).not.toContain(SENTINEL);
    expect(activity.events[0]?.errorCode).toBe("auth_required");
    expect(fixture.requests.filter((request) => request.url.pathname === "/repos/acme/one/releases")).toHaveLength(1);
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

  it("INV-4: rename lookup expiry preserves the grant ID and token cache key across both names", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.rename(201, "other/two");
    now += 300_001;
    expect(value(await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context()))).toEqual({
      ok: true,
    });
    expect(value(await connector.callTool("get_file_contents", { owner: "other", repo: "two" }, context()))).toEqual({
      ok: true,
    });
    expect(fixture.tokens).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.url.pathname === "/installation/repositories")).toHaveLength(2);
  });

  it("INV-4: discovery and search accept renamed repositories by ID and teach their current aliases", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.rename(201, "other/renamed");
    fixture.respond((request) =>
      request.url.pathname === "/search/code"
        ? Response.json({ items: [{ repository: { id: 201, full_name: "other/renamed" }, path: "a" }], total_count: 1 })
        : undefined,
    );
    const search = value(await connector.callTool("search_scoped", { terms: "test", kind: "code" }, context()));
    expect(search.partitions[0].items[0].repository.id).toBe(201);
    const scopes = value(await connector.callTool("list_scopes", { owner: "other" }, context()));
    expect(scopes.repositories).toEqual(["other/renamed"]);
    expect(
      value(await connector.callTool("get_file_contents", { owner: "other", repo: "renamed" }, context())),
    ).toEqual({ ok: true });
    expect(fixture.tokens.filter((token) => token.body.permissions.contents === "read")).toHaveLength(1);
  });
});
