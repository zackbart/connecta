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
import { AppAuth } from "./lib/auth.js";
import { githubConnection } from "./api.js";
import { runEdge } from "../../runtime/run.js";
import { appJwt, privateKeyDer } from "./lib/key.js";
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
          connector.callTool("create_release", { owner: "acme", repo: "one", tag_name: "v1" }, context()),
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
    await invokeTestCall(registry, activity, "github.create_release", { owner: "acme", repo: "one", tag_name: "v1" });
    expect(JSON.stringify(activity.events)).not.toContain(SENTINEL);
    expect(logger.warnings().join(" ")).not.toContain(SENTINEL);
    expect(activity.events[0]?.errorCode).toBe("auth_required");
    expect(logger.warn.mock.calls.find(([message]) => String(message).includes("call failed"))?.[1]).toMatchObject({
      httpStatus: 403,
    });
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
});
