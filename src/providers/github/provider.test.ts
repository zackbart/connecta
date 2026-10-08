import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogReviewOf, classifyCatalog, observedCatalogDrift, observeReviewedDrift } from "../../catalog-drift.js";
import { AppAuth } from "./auth.js";
import { appJwt, privateKeyDer } from "./key.js";
import { parseScopes, ScopePolicy } from "./scope.js";
import { HOSTED_ROUTES } from "./hosted.js";
import { apiFixture, connection, context, PRIVATE_KEY, PUBLIC_KEY, SCOPES, SENTINEL } from "../../../test/fixtures/github-api.js";
import { failureRecord, logFailure } from "../../operator-record.js";
import { servedTools } from "../../../test/fixtures/hosted-provider.js";
import { deferred, spyLogger, waitFor } from "../../../test/fixtures/misc.js";
import { activitySink, invokeTestCall, makeRegistry } from "../../../test/helpers.js";

function value(result: any): any { return result.structuredContent; }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GitHub App provider", () => {
  it("INV-11: validates scopes, explicit access, closed options, duplicate and widening grants", () => {
    for (const scopes of [[], [{ org: "acme" }], [{ repo: "other/one", access: "all" }], [{ repo: "../one", access: "read" }], [{ org: "acme", repo: "acme/one", access: "read" }], [{ org: "Acme", access: "read" }, { org: "acme", access: "read" }], [{ org: "acme", access: "read" }, { repo: "acme/one", access: "read-write" }], [{ org: "acme", access: "read-write" }, { repo: "acme/one", access: "read-write", workflows: "write" }], [{ repo: "other/one", access: "read", workflows: "write" }]]) {
      expect(() => connection({ scopes: scopes as never })).toThrow(/^github\("github"\) requires/);
    }
    expect(() => connection({ authScope: "personal" })).toThrow("shared GitHub App");
    expect(() => connection({ scope: [] } as never)).toThrow("Unknown option");
    expect(() => connection({ app: { appId: "12345", privateKey: SENTINEL } })).toThrow("RSA PEM");
    expect(() => connection({ app: { appId: "12345", privateKey: SENTINEL } })).not.toThrow(SENTINEL);
  });

  it.each([
    ["get_file_contents", { owner: "outside", repo: "public" }],
    ["get_file_contents", { owner: "other", repo: "two" }],
    ["get_file_contents", { owner: "other", repo: "../one" }],
    ["issue_write", { owner: "acme", repo: "locked", method: "update" }],
    ["issue_write", { owner: "other", repo: "readonly", method: "create" }],
    ["create_repository", { owner: "acme", repo: "one" }],
    ["fork_repository", { owner: "acme", repo: "one" }],
    ["new_upstream_read", { owner: "acme", repo: "one" }],
    ["issue_write", { owner: "acme", repo: "one", method: "delete" }],
    ["issue_write", { owner: "acme", repo: "one", method: "create", parent_owner: "other", parent_repo: "two" }],
    ["add_issue_comment", { owner: "acme", repo: "one", comment_id: 123 }],
    ["pull_request_review_write", { owner: "acme", repo: "one", method: "resolve_thread", threadId: "foreign" }],
    ["create_pull_request", { owner: "acme", repo: "one", head: "outside:branch" }],
    ["get_file_contents", { owner: "acme", repo: "one", new_owner: "outside" }],
  ])("INV-4: refuses %s targets/methods outside scope before key or network access (%j)", async (name, args) => {
    const fixture = apiFixture(); const get = vi.fn(async () => PRIVATE_KEY);
    const connector = connection({ app: { appId: "12345" } });
    await expect(connector.callTool(name, args, context({ credential: { get, getAll: async () => ({ privateKey: PRIVATE_KEY }) } }))).rejects.toMatchObject({ code: "invalid_args" });
    expect(get).not.toHaveBeenCalled(); expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it("INV-4: routes mixed in-scope org, future repo, exact repo and case-normalized targets to narrowed per-owner tokens", async () => {
    const fixture = apiFixture(); const connector = connection();
    const args = [
      { owner: "ACME", repo: "future" }, { owner: "acme", repo: "locked" }, { owner: "other", repo: "one" }, { owner: "other", repo: "readonly" },
    ];
    await Promise.all(args.map((input) => connector.callTool("get_file_contents", input, context())));
    expect(fixture.tokens.map((token) => token.installation).sort()).toEqual(["11", "11", "22", "22"]);
    expect(fixture.tokens.map((token) => token.body.repository_ids[0]).sort()).toEqual([103, 102, 201, 202].sort());
    for (const token of fixture.tokens) expect(token.body.permissions).toEqual({ contents: "read" });
    const calls = fixture.requests.filter((request) => request.body?.method === "tools/call");
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      const token = fixture.tokens.find((entry) => `Bearer ${entry.value}` === call.headers.get("authorization"))!;
      expect(token.body.repository_ids).toEqual([({ "acme/future": 103, "acme/locked": 102, "other/one": 201, "other/readonly": 202 } as Record<string, number>)[`${call.body.params.arguments.owner}/${call.body.params.arguments.repo}`.toLowerCase()]]);
      expect(token.installation).toBe(call.body.params.arguments.owner.toLowerCase() === "acme" ? "11" : "22");
    }
  });

  it("INV-5: caches completed tokens by repository/permissions, refreshes before expiry and stores no secrets", async () => {
    const fixture = apiFixture(); const connector = connection(); const ctx = context();
    const set = vi.spyOn(ctx.storage, "set"); const cas = vi.spyOn(ctx.storage, "compareAndSet");
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const args = { owner: "acme", repo: "one" };
    await connector.callTool("get_file_contents", args, ctx);
    await connector.callTool("get_file_contents", args, context());
    expect(fixture.tokens).toHaveLength(1);
    await connector.callTool("create_branch", { ...args, branch: "new" }, context());
    expect(fixture.tokens).toHaveLength(2);
    expect(fixture.tokens[1]!.body.permissions).toEqual({ contents: "write" });
    now += 3_540_001;
    await connector.callTool("get_file_contents", args, context());
    expect(fixture.tokens).toHaveLength(3);
    expect(set).not.toHaveBeenCalled(); expect(cas).not.toHaveBeenCalled();
  });

  it("INV-5: partitions tokens by vault key fingerprint and never describes app secrets", async () => {
    const fixture = apiFixture(); const connector = connection({ app: { appId: "12345" } });
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer);
    const second = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
    for (const key of [PRIVATE_KEY, second]) {
      const get = vi.fn(async (field?: string) => field === "privateKey" ? key : null);
      await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context({ credential: { get, getAll: async () => ({ privateKey: key }) } }));
      expect(get).toHaveBeenCalledWith("privateKey");
    }
    expect(fixture.tokens).toHaveLength(2);
    const description = JSON.stringify(connection().describe?.());
    expect(description).not.toContain(PRIVATE_KEY); expect(description).not.toContain("12345");
    expect(JSON.stringify(connector.describe?.())).not.toContain(second);
    expect(connector.credential?.fields?.[0]?.name).toBe("privateKey");
  });

  it("INV-4: a cached ID token follows a repository rename and returns the same repository's result", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    const args = { owner: "other", repo: "one" };
    await connector.callTool("get_file_contents", args, context());
    fixture.rename(201, "other/renamed");
    expect(value(await connector.callTool("get_file_contents", args, context()))).toEqual({ ok: true });
    expect(fixture.tokens).toHaveLength(1);
    expect(fixture.tokens[0]!.body).toEqual({ repository_ids: [201], permissions: { contents: "read" } });
    expect(fixture.tokens[0]!.body).not.toHaveProperty("repositories");
    expect(fixture.resolverTokens[0]!.body).toEqual({ permissions: { metadata: "read" } });
    expect(fixture.requests.filter((request) => request.body?.method === "tools/call").every((request) => request.headers.get("authorization") === `Bearer ${fixture.tokens[0]!.value}`)).toBe(true);
  });

  it("INV-4: rename lookup expiry preserves the grant ID and token cache key across both names", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.rename(201, "other/two");
    now += 300_001;
    expect(value(await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context()))).toEqual({ ok: true });
    expect(value(await connector.callTool("get_file_contents", { owner: "other", repo: "two" }, context()))).toEqual({ ok: true });
    expect(fixture.tokens).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.url.pathname === "/installation/repositories")).toHaveLength(2);
  });

  it("INV-4: discovery and search accept renamed repositories by ID and teach their current aliases", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.rename(201, "other/renamed");
    fixture.respond((request) => request.url.pathname === "/search/code" ? Response.json({ items: [{ repository: { id: 201, full_name: "other/renamed" }, path: "a" }], total_count: 1 }) : undefined);
    const search = value(await connector.callTool("search_scoped", { terms: "test", kind: "code" }, context()));
    expect(search.partitions[0].items[0].repository.id).toBe(201);
    const scopes = value(await connector.callTool("list_scopes", { owner: "other" }, context()));
    expect(scopes.repositories).toEqual(["other/renamed"]);
    expect(value(await connector.callTool("get_file_contents", { owner: "other", repo: "renamed" }, context()))).toEqual({ ok: true });
    expect(fixture.tokens.filter((token) => token.body.permissions.contents === "read")).toHaveLength(1);
  });

  it("INV-4: a transferred repository leaves its installation and the cached hosted token returns no data", async () => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.rename(201, "outside/one");
    await expect(connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context())).rejects.not.toThrow(SENTINEL);
    await expect(connector.callTool("get_file_contents", { owner: "outside", repo: "one" }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.tokens).toHaveLength(1);
  });

  it.each([0, 300_001, 3_540_001])("INV-4: a replacement at the old name never inherits its repository grant after %i ms", async (elapsed) => {
    const fixture = apiFixture();
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.rename(201, "other/renamed");
    fixture.repositories([{ id: 201, full_name: "other/renamed" }, { id: 999, full_name: "other/one" }]);
    now += elapsed;
    const call = connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    if (elapsed) await expect(call).rejects.toMatchObject({ code: "invalid_args" });
    else await expect(call).rejects.not.toThrow(SENTINEL);
    expect(fixture.tokens).toHaveLength(1);
    // An explicit new configuration may bind the new repository on first use.
    await connection({ scopes: [{ repo: "other/one", access: "read" }] }).callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    expect(fixture.tokens[1]!.body.repository_ids).toEqual([999]);
  });

  it("INV-4: an org's exact read-only override follows its repository ID through rename", async () => {
    const fixture = apiFixture(); const connector = connection();
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.callTool("get_file_contents", { owner: "acme", repo: "locked" }, context());
    fixture.rename(102, "acme/new-name"); now += 300_001;
    await expect(connector.callTool("create_branch", { owner: "acme", repo: "new-name", branch: "new" }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.tokens.every((token) => token.body.permissions.contents !== "write")).toBe(true);
  });

  it("INV-4: an org grant cannot move to a replacement installation on lookup expiry", async () => {
    const fixture = apiFixture(); const connector = connection();
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.callTool("get_file_contents", { owner: "acme", repo: "one" }, context());
    fixture.installations([{ id: 44, account: { login: "acme", type: "Organization" }, repository_selection: "all" }]);
    now += 300_001;
    for (let i = 0; i < 2; i++) await expect(connector.callTool("get_file_contents", { owner: "acme", repo: "one" }, context())).rejects.toMatchObject({ code: "auth_required" });
    expect(fixture.tokens).toHaveLength(1);
  });

  it("INV-5: repository-ID sets sort and deduplicate token caches independently of requested names", async () => {
    const fixture = apiFixture();
    const auth = new AppAuth({ appId: "12345", privateKey: PRIVATE_KEY }, new ScopePolicy(parseScopes(SCOPES)));
    const first = await auth.token("other", ["readonly", "one", "one"], { contents: "read" }, context());
    expect(await auth.token("other", ["one", "readonly"], { contents: "read" }, context())).toBe(first);
    expect(fixture.tokens).toHaveLength(1); expect(fixture.tokens[0]!.body.repository_ids).toEqual([201, 202]);
  });

  it("INV-6: failed repository-resolution pages cache no partial name bindings or downstream error text", async () => {
    const fixture = apiFixture(); let fail = true;
    fixture.respond((request) => {
      if (request.url.pathname !== "/installation/repositories") return;
      if (request.url.searchParams.get("page") === "1") return Response.json({ repositories: [{ id: 201, full_name: "other/one" }, ...Array.from({ length: 99 }, (_, i) => ({ id: 1000 + i, full_name: `other/unused-${i}` }))] });
      return fail ? new Response(SENTINEL, { status: 500 }) : Response.json({ repositories: [] });
    });
    const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    const call = connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    await expect(call).rejects.toMatchObject({ code: "unavailable" });
    await expect(call).rejects.not.toThrow(SENTINEL);
    expect(fixture.tokens).toHaveLength(0); fail = false;
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    expect(fixture.requests.filter((request) => request.url.pathname === "/installation/repositories").map((request) => request.url.searchParams.get("page"))).toEqual(["1", "2", "1", "2"]);
  });

  it("INV-7: concurrent installation resolution uses compare-and-set completed mappings", async () => {
    const fixture = apiFixture(); const blocked = deferred<Response>(); let reads = 0;
    fixture.respond((request) => {
      if (request.url.pathname !== "/app/installations") return;
      if (++reads === 1) return blocked.promise;
      return Response.json([{ id: 44, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }]);
    });
    const auth = new AppAuth({ appId: "12345", privateKey: PRIVATE_KEY }, new ScopePolicy(parseScopes(SCOPES)));
    const first = auth.repo({ owner: "acme", repo: "one" }, { contents: "read" }, context());
    await waitFor(() => reads === 1);
    await auth.repo({ owner: "acme", repo: "two" }, { contents: "read" }, context());
    blocked.resolve(Response.json([{ id: 11, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }]));
    await first;
    expect(fixture.tokens.map((token) => token.installation)).toEqual(["44", "44"]);
  });

  it("INV-7: a cancelled token owner neither poisons a follower nor caches its late answer", async () => {
    const fixture = apiFixture(); const blocked = deferred<Response>(); let mints = 0;
    fixture.respond((request) => {
      if (!request.url.pathname.endsWith("/access_tokens") || !request.body?.repository_ids) return;
      if (++mints === 1) return blocked.promise;
    });
    const auth = new AppAuth({ appId: "12345", privateKey: PRIVATE_KEY }, new ScopePolicy(parseScopes(SCOPES)));
    const controller = new AbortController();
    const first = auth.repo({ owner: "acme", repo: "one" }, { contents: "read" }, context({ signal: controller.signal }));
    const firstResult = first.catch((error) => error);
    await waitFor(() => mints === 1);
    const second = await auth.repo({ owner: "acme", repo: "one" }, { contents: "read" }, context());
    controller.abort(new Error("cancelled"));
    blocked.resolve(Response.json({ token: "ghs_cancelled", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    expect(await firstResult).toBe(controller.signal.reason);
    expect(await auth.repo({ owner: "acme", repo: "one" }, { contents: "read" }, context())).toBe(second);
    expect(mints).toBe(2);
  });

  it.each(["selected", "suspended", "missing", "user"])("INV-4: refuses invalid org installation %s before minting", async (kind) => {
    const fixture = apiFixture();
    fixture.installations(kind === "missing" ? [] : [{ id: 11, account: { login: "acme", type: kind === "user" ? "User" : "Organization" }, repository_selection: kind === "selected" ? "selected" : "all", suspended_at: kind === "suspended" ? "2026-10-07" : null }]);
    await expect(connection().callTool("get_file_contents", { owner: "acme", repo: "one" }, context())).rejects.toMatchObject({ code: "auth_required" });
    expect(fixture.tokens).toHaveLength(0);
  });

  it("INV-8: installation resolution follows pagination, and failure never caches a partial mapping", async () => {
    const fixture = apiFixture(); let fail = true;
    fixture.respond((request) => {
      if (request.url.pathname !== "/app/installations") return;
      const page = request.url.searchParams.get("page");
      if (page === "1") return Response.json(Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, account: { login: `unused-${i}`, type: "Organization" }, repository_selection: "all" })));
      if (fail) return Response.json({ error: SENTINEL }, { status: 500 });
      return Response.json([{ id: 22, account: { login: "other", type: "User" }, repository_selection: "selected" }]);
    });
    const connector = connection();
    await expect(connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context())).rejects.toMatchObject({ code: "unavailable" });
    expect(fixture.tokens).toHaveLength(0); fail = false;
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    expect(fixture.tokens[0]!.installation).toBe("22");
    expect(fixture.requests.filter((request) => request.url.pathname === "/app/installations").map((request) => request.url.searchParams.get("page"))).toEqual(["1", "2", "1", "2"]);
  });

  it("INV-1: hides unlisted hosted reads and classifies every exposed operation through the registry", async () => {
    const fixture = apiFixture(); const connector = connection(); const ctx = context();
    const facts = await connector.listTools(ctx); const tools = await servedTools(connector, ctx);
    const names = tools.map((tool) => tool.name);
    for (const absent of ["create_repository", "fork_repository", "new_upstream_read"]) expect(names).not.toContain(absent);
    expect(names.filter((name) => name === "list_scopes")).toHaveLength(1);
    for (const [name, route] of Object.entries(HOSTED_ROUTES)) expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(route.verdict === "read");
    expect(facts.find((tool) => tool.name === "push_files")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "push_files")?.annotations?.readOnlyHint).toBe(false);
    expect(fixture.protocol).toBeTruthy();
    const review = catalogReviewOf(connector)!;
    const synthetic = [...facts, { name: "fresh_read", annotations: { readOnlyHint: true } }];
    expect((await classifyCatalog(review, "github", synthetic, ctx.logger)).map((tool) => tool.name)).not.toContain("fresh_read");
    await observeReviewedDrift(connector, review, synthetic, ctx.logger);
    expect(observedCatalogDrift(connector)?.unclassifiedTools).toBe(1);
  });

  it.each([".github", ".github/workflows", ".github/workflows/ci.yml", ".GITHUB/WORKFLOWS/ci.yml", "../.github/workflows/ci.yml", "%2egithub/workflows/ci.yml", "src/../.github/workflows/ci.yml", "src\\ci.yml"])("INV-4: denies workflow or aliased file path %s before authentication", async (path) => {
    const fixture = apiFixture();
    await expect(connection().callTool("create_or_update_file", { owner: "acme", repo: "one", path, branch: "main", content: "x", message: "edit" }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it("INV-4: checks all pushed paths and explicitly enables workflow permission only for configured workflow writes", async () => {
    const fixture = apiFixture();
    await expect(connection().callTool("push_files", { owner: "acme", repo: "one", files: [{ path: "src/a", content: "a" }, { path: ".github/workflows/ci.yml", content: "x" }] }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
    const connector = connection({ scopes: [{ org: "acme", access: "read-write", workflows: "write" }, { repo: "acme/locked", access: "read-write" }] });
    await connector.callTool("create_or_update_file", { owner: "acme", repo: "one", path: ".github/workflows/ci.yml", branch: "main", content: "x", message: "edit" }, context());
    expect(fixture.tokens[0]!.body).toEqual({ repository_ids: [101], permissions: { contents: "write", workflows: "write" } });
    const before = fixture.requests.length;
    await expect(connector.callTool("delete_file", { owner: "acme", repo: "locked", path: ".github/workflows/ci.yml", branch: "main", message: "delete" }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.requests).toHaveLength(before);
  });

  it("INV-10: exposes secret-free mixed scope discovery and lazily pages only the selected owner", async () => {
    const fixture = apiFixture(); const connector = connection();
    const config = value(await connector.callTool("list_scopes", {}, context()));
    expect(config).toEqual({ acting_as: "GitHub App", scopes: SCOPES });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
    const result = value(await connector.callTool("list_scopes", { owner: "other", per_page: 1 }, context()));
    expect(result.repositories).toEqual(["other/one", "other/readonly"]);
    expect(fixture.tokens[0]!.body.repository_ids.sort()).toEqual([201, 202]);
    expect(fixture.tokens[0]!.body.permissions).toEqual({ metadata: "read" });
    expect(JSON.stringify(connector.usageGuide)).toContain("org acme");
    expect(JSON.stringify(connector.usageGuide)).toContain("other/one");
    const before = fixture.requests.length;
    await expect(connector.callTool("list_scopes", { owner: "unconfigured" }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.requests).toHaveLength(before);
  });

  it.each(["org:outside", "foo OR bar", "foo NOT bar", "repo:other/two", '"foo"', "foo\nbar"])("INV-4: refuses search injection %s before authentication", async (terms) => {
    const fixture = apiFixture();
    await expect(connection().callTool("search_scoped", { terms, kind: "issues" }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it("INV-4: validates all search selectors and cursor partitions before minting", async () => {
    const fixture = apiFixture();
    for (const args of [{ scopes: [{ org: "other" }] }, { scopes: [{ repo: "other/two" }] }, { scopes: [{ org: "acme" }, { repo: "outside/public" }] }, { pages: { "org:outside": 2 } }]) {
      await expect(connection().callTool("search_scoped", { terms: "bug", kind: "issues", ...args }, context())).rejects.toMatchObject({ code: "invalid_args" });
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
    const result = value(await connection().callTool("search_scoped", { terms: "bug", kind: "issues", pages: { "org:acme": 2 }, per_page: 2 }, context()));
    expect(result.partitions.map((partition: any) => partition.items.length)).toEqual([1, 1]);
    expect(result.partitions.map((partition: any) => partition.next_page)).toEqual([3, 2]);
    expect(result.incomplete_results).toBe(true);
    expect(fixture.tokens.map((token) => token.body.repository_ids)).toEqual([undefined, [201, 202]]);
    expect(fixture.requests.filter((request) => request.url.pathname === "/search/issues").map((request) => request.url.searchParams.get("q"))).toEqual(["org:acme bug is:issue", "repo:other/one repo:other/readonly bug is:issue"]);
  });

  it("INV-4: rejects public-repository search escapes from both configuration and selected subset", async () => {
    const fixture = apiFixture(); let repo = "outside/public";
    fixture.respond((request) => request.url.pathname === "/search/code" ? Response.json({ items: [{ repository: { full_name: repo }, path: "a" }], total_count: 1 }) : undefined);
    const connector = connection();
    await expect(connector.callTool("search_scoped", { terms: "test", kind: "code", scopes: [{ repo: "acme/one" }] }, context())).rejects.toMatchObject({ code: "invalid_args" });
    repo = "acme/two";
    await expect(connector.callTool("search_scoped", { terms: "test", kind: "code", scopes: [{ repo: "acme/one" }] }, context())).rejects.toMatchObject({ code: "connector_call_failed" });
  });

  it.each(["repositories", "issues", "pull-requests", "code"])("INV-4: %s search checks repository IDs even when returned names still match", async (kind) => {
    const fixture = apiFixture(); const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.respond((request) => {
      if (request.url.pathname === "/repos/other/one") return Response.json({ id: 999, full_name: "other/one" });
      if (!request.url.pathname.startsWith("/search/")) return;
      const item = kind === "repositories" ? { id: 999, full_name: "other/one", body: SENTINEL } : kind === "code" ? { repository: { id: 999, full_name: "other/one" }, path: "a", body: SENTINEL } : { id: 1, repository_url: "https://api.github.com/repos/other/one", body: SENTINEL };
      return Response.json({ items: [item], total_count: 1 });
    });
    const call = connector.callTool("search_scoped", { terms: "test", kind }, context());
    await expect(call).rejects.toMatchObject({ code: "connector_call_failed" });
    await expect(call).rejects.not.toThrow(SENTINEL);
  });

  it("INV-4: scope discovery refuses a name-matching repository with an ungranted ID", async () => {
    const fixture = apiFixture(); const connector = connection({ scopes: [{ repo: "other/one", access: "read" }] });
    await connector.callTool("get_file_contents", { owner: "other", repo: "one" }, context());
    fixture.respond((request) => request.url.pathname === "/installation/repositories" ? Response.json({ repositories: [{ id: 999, full_name: "other/one" }] }) : undefined);
    await expect(connector.callTool("list_scopes", { owner: "other" }, context())).rejects.toMatchObject({ code: "connector_call_failed" });
  });

  it("INV-9: a release write is dispatched once, errors carry retry hints but no downstream body", async () => {
    const fixture = apiFixture(); const logger = spyLogger();
    fixture.respond((request) => request.url.pathname === "/repos/other/one/releases" ? new Response(SENTINEL, { status: 429, headers: { "retry-after": "3", "content-type": `application/${SENTINEL}` } }) : undefined);
    const connector = connection(); let failure: unknown;
    try { await connector.callTool("create_release", { owner: "other", repo: "one", tag_name: "v1" }, context({ logger: logger.logger })); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "rate_limited", retryAfterMs: 3000 });
    expect(String(failure)).not.toContain(SENTINEL);
    logFailure(logger.logger, "call failed", failureRecord({ connector: "github" }, failure));
    expect(logger.warnings().join(" ")).not.toContain(SENTINEL);
    expect(fixture.requests.filter((request) => request.url.pathname === "/repos/other/one/releases")).toHaveLength(1);
  });

  it("INV-6: hosted error sentinels never enter operator or activity records through real invocation", async () => {
    const fixture = apiFixture(); fixture.mcpError();
    const logger = spyLogger(); const connector = connection(); const registry = makeRegistry([connector], { logger: logger.logger });
    const activity = activitySink();
    await invokeTestCall(registry, activity, "github.get_file_contents", { owner: "acme", repo: "one" });
    expect(JSON.stringify(activity.events)).not.toContain(SENTINEL);
    expect(logger.warnings().join(" ")).not.toContain(SENTINEL);
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]?.outcome).toBe("error");
  });

  it("INV-9: release update/publish/delete use explicit write tokens and correct repository paths", async () => {
    const fixture = apiFixture(); const connector = connection();
    await connector.callTool("update_release", { owner: "other", repo: "one", release_id: 7, draft: false, name: "v1" }, context());
    await connector.callTool("delete_release", { owner: "other", repo: "one", release_id: 7 }, context());
    const writes = fixture.requests.filter((request) => request.url.pathname === "/repos/other/one/releases/7");
    expect(writes.map((request) => request.method)).toEqual(["PATCH", "DELETE"]);
    expect(writes[0]!.body).toEqual({ draft: false, name: "v1" });
    expect(fixture.tokens).toHaveLength(1);
    expect(fixture.tokens[0]!.body).toEqual({ repository_ids: [201], permissions: { contents: "write" } });
  });

  it("INV-4: merge is refused before authentication when workflow-write access is absent, even for apparently safe files", async () => {
    const fixture = apiFixture();
    await expect(connection().callTool("merge_pull_request", { owner: "acme", repo: "one", pull_number: 7, sha: "a".repeat(40) }, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it.each(["normal", "retargeted-base", "foreign-head", "stale-sha"])("INV-4: explicit workflow scope covers base-retarget races and merge refuses unsafe head case %s", async (kind) => {
    const fixture = apiFixture(); const sha = "a".repeat(40); const base = "b".repeat(40);
    fixture.respond((request) => {
      if (request.url.pathname === "/repos/acme/one/pulls/7") return Response.json({ head: { sha: kind === "stale-sha" ? "c".repeat(40) : sha, repo: { full_name: kind === "foreign-head" ? "outside/public" : "acme/one" } }, base: { sha: base, ref: "main", repo: { full_name: "acme/one" } } });
      if (kind === "retargeted-base" && request.url.pathname.endsWith("/merge")) return Response.json({ merged: true, base: "old-release-with-workflow-differences" });
    });
    const connector = connection({ scopes: [{ org: "acme", access: "read-write", workflows: "write" }] });
    const call = connector.callTool("merge_pull_request", { owner: "acme", repo: "one", pull_number: 7, sha }, context());
    const safe = ["normal", "retargeted-base"].includes(kind);
    if (safe) await call; else await expect(call).rejects.toMatchObject({ code: "conflict" });
    const merges = fixture.requests.filter((request) => request.url.pathname.endsWith("/merge"));
    expect(merges).toHaveLength(safe ? 1 : 0);
    const writer = fixture.tokens.filter((token) => token.body.permissions.contents === "write");
    expect(writer).toHaveLength(safe ? 1 : 0);
    if (safe) {
      expect(merges[0]!.body).toEqual({ sha, merge_method: "merge" });
      expect(writer[0]!.body.permissions.workflows).toBe("write");
    }
  });

  it.each(["tools/call", "server/discover"])("INV-9: hosted 401 at %s evicts a rejected token without replaying the failed operation", async (method) => {
    const fixture = apiFixture();
    fixture.respond((request) => request.url.origin === "https://api.githubcopilot.com" && request.body?.method === method ? new Response(SENTINEL, { status: 401 }) : undefined);
    const connector = connection();
    for (let i = 0; i < 2; i++) await expect(connector.callTool("create_branch", { owner: "acme", repo: "one", branch: "new" }, context())).rejects.toMatchObject({ code: "auth_required" });
    expect(fixture.tokens).toHaveLength(2);
    expect(fixture.requests.filter((request) => request.body?.method === method)).toHaveLength(2);
    expect(fixture.requests.filter((request) => request.body?.method === "tools/call")).toHaveLength(method === "tools/call" ? 2 : 0);
  });

  it("INV-6: permission 403 with unused rate budget is auth failure and evicts its token", async () => {
    const fixture = apiFixture();
    fixture.respond((request) => request.url.pathname === "/repos/acme/one/releases" ? new Response(SENTINEL, { status: 403, headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } }) : undefined);
    const connector = connection();
    for (let i = 0; i < 2; i++) await expect(connector.callTool("create_release", { owner: "acme", repo: "one", tag_name: "v1" }, context())).rejects.toMatchObject({ code: "auth_required", retryable: false, retryAfterMs: undefined });
    expect(fixture.tokens).toHaveLength(2);
  });

  it.each(["create", "submit_pending", "delete_pending"])("INV-4: reviewed pending-review method %s routes to the scoped repository", async (method) => {
    const fixture = apiFixture();
    await connection().callTool("pull_request_review_write", { owner: "other", repo: "one", method, pullNumber: 1 }, context());
    expect(fixture.requests.find((request) => request.body?.method === "tools/call")?.body.params.arguments.method).toBe(method);
  });

  it("INV-10: operator status performs no installation/token/catalog fetch or key read", async () => {
    const fixture = apiFixture(); const get = vi.fn(async () => PRIVATE_KEY);
    const connector = connection({ app: { appId: "12345" } });
    expect(await connector.status?.(context({ credential: { get, getAll: async () => ({ privateKey: PRIVATE_KEY }) } }))).toMatchObject({ state: "ok" });
    const registry = makeRegistry([connector]);
    expect(await registry.statusFor("github", "https://connecta.test")).toMatchObject({ state: "ok" });
    expect(get).not.toHaveBeenCalled(); expect(fixture.fetchStub).not.toHaveBeenCalled();
  });

  it("INV-6: REST malformed/sentinel error responses produce typed facts without body or content-type", async () => {
    const fixture = apiFixture(); const logger = spyLogger();
    fixture.respond((request) => request.url.pathname === "/repos/acme/one/releases" ? new Response(SENTINEL, { status: 403, headers: { "content-type": `application/${SENTINEL}` } }) : undefined);
    const connector = connection(); const registry = makeRegistry([connector], { logger: logger.logger }); const activity = activitySink();
    await invokeTestCall(registry, activity, "github.create_release", { owner: "acme", repo: "one", tag_name: "v1" });
    expect(JSON.stringify(activity.events)).not.toContain(SENTINEL); expect(logger.warnings().join(" ")).not.toContain(SENTINEL);
    expect(activity.events[0]?.errorCode).toBe("auth_required");
    expect(fixture.requests.filter((request) => request.url.pathname === "/repos/acme/one/releases")).toHaveLength(1);
  });

  it("INV-5: signs a verifiable RS256 JWT with bounded time and normalized PKCS#1/PKCS#8 keys", async () => {
    const jwt = await appJwt("12345", privateKeyDer(PRIVATE_KEY), Date.now());
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(new TextDecoder().decode(decode(claims)));
    expect(payload.iss).toBe("12345"); expect(payload.exp - payload.iat).toBe(600);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", PUBLIC_KEY, decode(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
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
