import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { memoryStorage } from "../../storage/memory.js";
import { vercel, type VercelTokenOptions } from "./index.js";
import { Effect } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Budget, ContinuationBinding, setViewService } from "../../runtime/call.js";
import { vercelIndex, VERCEL_VERDICTS, transformGuide } from "./api.js";
import { MAX_PIN_LOOKUPS, pinQuery, pinRoute } from "./lib/pin.js";
import type { RestCall } from "../_shared/rest/tools.js";
import { makeRegistry } from "../../../test/helpers.js";
import { createMetaTools } from "../../meta-tools.js";
import { SkillsRegistry } from "../../skills.js";
import { CatalogService, flatSearchResult } from "../../catalog-service.js";

const OPTIONS = { purpose: "Team applications", auth: { type: "token" }, teamId: "team_alice" } as const;

describe("Vercel deployment team pin", () => {
  const originalFetch = globalThis.fetch;
  let sent: Array<{ url: URL; method: string; body: unknown }>;
  let answer: (request: (typeof sent)[number]) => Response;
  const storage = memoryStorage();
  const context = () => ({
    ...connectorContext(),
    storage,
    credential: { get: async () => "vercel-test-token", getAll: async () => ({ value: "vercel-test-token" }) },
  });
  const connector = (pin: unknown = { teamId: "team_alice" }) =>
    vercel("hosting", { ...OPTIONS, ...(pin === undefined ? {} : { pin }) } as VercelTokenOptions);
  const call = (name: string, args: Record<string, unknown>, pin: unknown = { teamId: "team_alice" }) =>
    connector(pin).callTool(name, args, context()) as Promise<any>;

  beforeEach(() => {
    installOwnedTransport();
    sent = [];
    answer = ({ url }) => {
      if (url.pathname.startsWith("/v2/teams/"))
        return Response.json({ id: "team_alice", slug: "alice", name: "Alice" });
      if (url.pathname.startsWith("/v9/projects/")) return Response.json({ id: "prj_web", accountId: "team_alice" });
      if (url.pathname.startsWith("/v13/deployments/")) return Response.json({ id: "dpl_web", ownerId: "team_alice" });
      return Response.json({ ok: true });
    };
    globalThis.fetch = (async (input, init) => {
      const request = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      sent.push(request);
      return answer(request);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const denied = vercelIndex.ops.filter((op) => pinRoute(vercelIndex, op) === "denied");
  it.each(denied)(
    "INV-2 INV-10: pinned discovery truthfully refuses $method $path without account work",
    async (op) => {
      const client = connector();
      const ctx = context();
      const credentials = vi.spyOn(ctx.credential, "getAll");
      const path = op.path.replace(/\{[^}]+\}/g, "sample");
      const details = (await client.callTool("vercel_api_details", { method: op.method, path: op.path }, ctx)) as any;
      const search = (await client.callTool(
        "vercel_api_search",
        { query: op.path.endsWith("/") ? op.operationId : path, method: op.method, limit: 8 },
        ctx,
      )) as any;
      const hit = search.operations.find((entry: any) => entry.path === op.path && entry.method === op.method);
      expect(hit, `${op.method} ${op.path}`).toBeDefined();
      expect(details.verdict).toBe("refuse");
      expect(details).not.toHaveProperty("tool");
      expect(hit).not.toHaveProperty("tool");
      expect(details.summary).toBe(op.summary);
      expect(hit.summary).toBe(op.summary.length > 300 ? `${op.summary.slice(0, 299)}…` : op.summary);
      // Includes all nine overlaps with the static refusal table: the pin's
      // construction reason wins without replacing the vendor's summary.
      expect(details.refusal).toBe("This operation has no reviewed deployment-team confinement.");
      expect(hit.refusal).toBe(details.refusal);
      expect(credentials).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(() =>
        pinQuery(
          vercelIndex,
          {
            method: op.method,
            op,
            path,
            params: {},
            query: {},
            body: undefined,
          },
          { teamId: "team_alice" },
        ),
      ).toThrow(/no reviewed team confinement/i);
      // Query admission runs before argument validation: even a body-less
      // write proves the actual unchanged route policy refuses this operation.
      await expect(
        client.callTool(
          VERCEL_VERDICTS[`${op.method} ${op.path}`] === "read" ? "vercel_api_read" : "vercel_api_write",
          { method: op.method, path },
          ctx,
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(provider_permission_denied|invalid_args)$/) });
      expect(credentials).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    },
  );

  it("INV-2 INV-4 INV-10: composes pinned vocabulary with grants, safety and read-only policy without handlers", async () => {
    const pinned = connector();
    const unpinned = vercel("other-hosting", OPTIONS);
    const readOnly = vercel("read-only-hosting", { ...OPTIONS, pin: { teamId: "team_alice" }, readOnly: true });
    const handlers = [pinned, unpinned, readOnly].map((client) => vi.spyOn(client, "callTool"));
    const registry = makeRegistry([pinned, unpinned, readOnly]);
    const search = async (
      client: typeof pinned,
      options: { safety?: "readOnly" | "approvalRequired"; endpointReadOnly?: boolean; grants?: string[] } = {},
    ) => {
      const scope = registry.scoped({
        connectorIds: [client.id],
        ...(options.grants ? { toolAccess: new Map([[client.id, new Set(options.grants)]]) } : {}),
      });
      const catalog = new CatalogService(scope, "https://connecta.example", {
        readOnly: options.endpointReadOnly ?? false,
      });
      const result = flatSearchResult(
        await catalog.search({ query: "getAuthUser", ...(options.safety ? { safety: options.safety } : {}) }),
      );
      return result.tools.some((tool) => tool.address === `${client.id}.vercel_api_search`);
    };
    // Repeat after cache population under different policy; caches convey no grants.
    for (const _round of [0, 1]) {
      expect(await search(unpinned)).toBe(true);
      expect(await search(pinned)).toBe(true);
      expect(await search(unpinned, { grants: ["vercel_api_search"] })).toBe(false);
      expect(await search(pinned, { grants: ["vercel_api_search"] })).toBe(true);
      expect(await search(pinned, { grants: ["vercel_api_read"] })).toBe(false);
      expect(await search(unpinned, { safety: "readOnly" })).toBe(true);
      expect(await search(pinned, { safety: "readOnly" })).toBe(false);
      expect(await search(unpinned, { safety: "approvalRequired" })).toBe(false);
      expect(await search(pinned, { safety: "approvalRequired" })).toBe(true);
      expect(await search(unpinned, { endpointReadOnly: true })).toBe(true);
      expect(await search(pinned, { endpointReadOnly: true })).toBe(false);
      expect(await search(readOnly)).toBe(false);
    }
    const hidden = makeRegistry([pinned], { classification: { hosting: { vercel_api_search: "hidden" } } });
    expect(
      flatSearchResult(
        await new CatalogService(hidden, "https://connecta.example").search({ query: "getAuthUser" }),
      ).tools.map((tool) => tool.address),
    ).not.toContain("hosting.vercel_api_search");
    for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    const ctx = context();
    const credentials = vi.spyOn(ctx.credential, "getAll");
    await expect(pinned.callTool("vercel_api_read", { path: "/v2/user" }, ctx)).rejects.toMatchObject({
      code: "provider_permission_denied",
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("INV-4 INV-10: isolates pinned and unpinned discovery and derives the actual guide refusal count", async () => {
    const pinned = connector();
    const unpinned = vercel("other-hosting", OPTIONS);
    const ctx = context();
    const credentials = vi.spyOn(ctx.credential, "getAll");
    const count = vercelIndex.ops.filter(
      (op) => pinRoute(vercelIndex, op) === "denied" || VERCEL_VERDICTS[`${op.method} ${op.path}`] === "refuse",
    ).length;
    const guideText = (client: typeof pinned) => {
      const guide = client.usageGuide!;
      return typeof guide === "string" ? guide : guide.content;
    };
    const originalGuide = guideText(unpinned);
    expect(guideText(pinned)).toContain(`${count} operations are refused by design`);
    expect(originalGuide).toContain(
      `${Object.values(VERCEL_VERDICTS).filter((v) => v === "refuse").length} operations are refused by design`,
    );
    for (const client of [unpinned, pinned, unpinned, pinned]) {
      const details = (await client.callTool("vercel_api_details", { method: "GET", path: "/v2/user" }, ctx)) as any;
      expect(details.verdict).toBe(client === pinned ? "refuse" : "read");
      expect(details.tool).toBe(client === pinned ? undefined : "vercel_api_read");
      const result = (await client.callTool("vercel_api_search", { query: "current user", limit: 8 }, ctx)) as any;
      const user = result.operations.find((entry: any) => entry.method === "GET" && entry.path === "/v2/user");
      expect(user).toBeDefined();
      expect(user.tool).toBe(client === pinned ? undefined : "vercel_api_read");
      const allowed = (await client.callTool(
        "vercel_api_details",
        { method: "GET", path: "/v10/projects" },
        ctx,
      )) as any;
      expect(allowed).toMatchObject({ verdict: "read", tool: "vercel_api_read" });
    }
    expect(guideText(unpinned)).toBe(originalGuide);
    const registry = makeRegistry([pinned, unpinned]);
    const skills = new SkillsRegistry(registry, "https://connecta.example");
    const resources = await skills.resources();
    for (const client of [pinned, unpinned]) {
      const resource = resources.resources.find((entry) => entry.uri.includes(`/connectors/${client.id}/`))!;
      expect(resource).toBeDefined();
      const read = await skills.read(resource.uri);
      expect(read.contents[0]!.text).toContain(guideText(client));
      const meta = createMetaTools(registry, "https://connecta.example");
      const shown = await meta.skills({ name: `connector:${client.id}` });
      expect(shown.structuredContent).toMatchObject({ text: expect.stringContaining(guideText(client)) });
    }
    expect(credentials).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("INV-10 INV-11: changes only the precisely identified generated Hatch count and preserves later guidance", () => {
    const baseGuide = unpinnedGuide();
    const suffix = " Separate refusal guidance. Schema-first guidance remains verbatim.";
    const content = baseGuide.content
      .split("\n")
      .map((line) => (line.startsWith("- **Hatch:** `vercel_api_search` ") ? `${line}${suffix}` : line))
      .join("\n");
    const guide = { ...baseGuide, content };
    expect(transformGuide(guide, OPTIONS)).toBe(guide);
    const changed = transformGuide(guide, { ...OPTIONS, pin: { teamId: "team_alice" } });
    const baseCount = Object.values(VERCEL_VERDICTS).filter((v) => v === "refuse").length;
    const total = vercelIndex.ops.filter(
      (op) => pinRoute(vercelIndex, op) === "denied" || VERCEL_VERDICTS[`${op.method} ${op.path}`] === "refuse",
    ).length;
    expect(changed).toEqual({
      ...guide,
      content: content.replace(
        `${baseCount} operations are refused by design`,
        `${total} operations are refused by design`,
      ),
    });
    expect(changed.content).toContain(suffix);
    expect(changed.content).toContain("inspect the original operation summary and its separate refusal.");
    expect(changed.content).toContain(
      "Use details for refused methods outside the read/write call schemas; those methods remain unavailable.",
    );
    const pinned = { ...OPTIONS, pin: { teamId: "team_alice" } };
    expect(() => transformGuide({ ...guide, content: "Missing Hatch sentence." }, pinned)).toThrow(/exactly one/);
    const hatchLine = content.split("\n").find((line) => line.startsWith("- **Hatch:**"))!;
    expect(() => transformGuide({ ...guide, content: `${content}\n${hatchLine}` }, pinned)).toThrow(/exactly one/);
    function unpinnedGuide() {
      const guide = vercel("other_hosting", OPTIONS).usageGuide!;
      return typeof guide === "string" ? { content: guide } : guide;
    }
  });

  it("INV-11: validates an explicit ID-only pin and a compatible routing default", () => {
    for (const pin of [
      null,
      {},
      { teamId: "" },
      { teamId: " team_alice" },
      { teamId: "team_%61lice" },
      { teamId: ["team_alice"] },
    ]) {
      expect(() => connector(pin)).toThrow(/pin/i);
    }
    expect(() => vercel("hosting", { ...OPTIONS, pin: { teamId: "team_bob" } } as VercelTokenOptions)).toThrow(
      /teamId|pin/,
    );
  });

  it("INV-2 INV-5: refuses foreign, null, conflicting and encoded selectors before IO on each dispatch branch", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["vercel_api_read", { path: "/v3/teams/team_bob/members" }],
      ["vercel_api_read", { path: "/v10/projects", query: { teamId: null } }],
      ["vercel_api_read", { path: "/v10/projects", query: { teamId: ["team_alice", "team_bob"] } }],
      ["vercel_api_read", { path: "/v10/projects", query: { teamId: "team_alice", "%74eamId": "team_bob" } }],
      ["vercel_api_read", { path: "/v2/teams/team_%62ob" }],
      ["list_project_env_vars", { projectId: "web", teamId: "team_bob" }],
      ["get_deployment_build_logs", { deploymentId: "dpl_web", teamId: null }],
      ["get_runtime_logs", { projectId: "web", deploymentId: "dpl_web", teamId: "team_bob" }],
      ["vercel_api_upload", { method: "POST", path: "/v2/files", query: { teamId: "team_bob" }, textBody: "hello" }],
      ["vercel_api_write", { method: "PUT", path: "/v1/bulk-redirects", body: { teamId: "team_bob", redirects: [] } }],
    ];
    for (const [name, args] of cases) {
      await expect(call(name, args)).rejects.toMatchObject({
        code: expect.stringMatching(/invalid_args|provider_permission_denied/),
      });
      expect(sent, name).toEqual([]);
    }
  });

  it("INV-2: refuses global/account escapes and unprovable ownership before an affected write", async () => {
    for (const [method, path] of [
      ["GET", "/v2/user"],
      ["POST", "/v1/teams"],
      ["GET", "/storage/stores/blob"],
      ["POST", "/v2/observability/query"],
    ]) {
      await expect(
        call(method === "GET" || path === "/v2/observability/query" ? "vercel_api_read" : "vercel_api_write", {
          method,
          path,
          body: method === "POST" ? {} : undefined,
        }),
      ).rejects.toBeDefined();
    }
    expect(sent).toEqual([]);
    answer = () => Response.json({ accountId: "team_bob" });
    await expect(call("vercel_api_write", { method: "DELETE", path: "/v9/projects/prj_bob" })).rejects.toMatchObject({
      code: "provider_permission_denied",
    });
    expect(sent.map(({ method }) => method)).toEqual(["GET"]);
  });

  it("INV-5: resolves a slug against the pinned team and never dispatches the foreign target", async () => {
    await expect(call("vercel_api_read", { path: "/v10/projects", query: { slug: "bob" } })).rejects.toMatchObject({
      code: "provider_permission_denied",
    });
    expect(sent.map(({ url }) => url.pathname)).toEqual(["/v2/teams/team_alice"]);
    sent = [];
    await call("vercel_api_read", { path: "/v10/projects", query: { slug: "alice" } });
    expect(sent.at(-1)?.url.searchParams.get("teamId")).toBe("team_alice");
  });

  it("INV-2 INV-5: admits owned project writes once and preserves secret withholding", async () => {
    await call("vercel_api_write", { method: "PATCH", path: "/v9/projects/web", body: { name: "web" } });
    expect(sent.map(({ method }) => method)).toEqual(["GET", "PATCH"]);
    sent = [];
    await expect(
      call("vercel_api_write", { method: "PATCH", path: "/v9/projects/web", body: { name: "[redacted]" } }),
    ).rejects.toBeDefined();
    expect(sent).toEqual([]);
  });

  it("INV-5: reads only the pinned team and emits a terminal list", async () => {
    expect(await call("list_teams", {})).toMatchObject({
      items: [{ id: "team_alice", slug: "alice" }],
      page: { hasMore: false },
    });
    expect(sent.map(({ url }) => url.pathname)).toEqual(["/v2/teams/team_alice"]);
  });

  it("INV-2 INV-5 INV-9: applies the pin to successful named reads/writes, bounded logs, uploads and read-only POSTs", async () => {
    answer = ({ url, method }) => {
      if (url.pathname === "/v9/projects/web") return Response.json({ id: "prj_web", accountId: "team_alice" });
      if (url.pathname === "/v13/deployments/dpl_web") return Response.json({ id: "dpl_web", ownerId: "team_alice" });
      if (url.pathname.endsWith("/runtime-logs"))
        return new Response('{"message":"hello","level":"info"}\n', {
          headers: { "content-type": "application/x-ndjson" },
        });
      if (url.pathname.endsWith("/events")) return Response.json([{ type: "stdout", payload: { text: "hello" } }]);
      if (url.pathname.endsWith("/env") && method === "GET") return Response.json({ envs: [] });
      if (url.pathname.endsWith("/env") && method === "POST")
        return Response.json(
          { created: [{ id: "env_web", key: "KEY", type: "encrypted", value: "new-secret-value" }] },
          { status: 201 },
        );
      if (url.pathname.endsWith("/env/env_web")) return Response.json({ id: "env_web", key: "KEY", type: "encrypted" });
      return Response.json({ ok: true });
    };
    for (const [name, args] of [
      ["list_project_env_vars", { projectId: "web" }],
      [
        "upsert_project_env_var",
        { projectId: "web", key: "KEY", value: "new-secret-value", type: "encrypted", targets: ["preview"] },
      ],
      ["update_project_env_var", { projectId: "web", envVarId: "env_web", comment: "rotation" }],
      ["get_deployment_build_logs", { deploymentId: "dpl_web" }],
      ["get_runtime_logs", { projectId: "web", deploymentId: "dpl_web" }],
      ["vercel_api_upload", { method: "POST", path: "/v2/files", textBody: "hello" }],
      ["vercel_api_read", { method: "POST", path: "/v8/artifacts", body: { hashes: ["digest"] } }],
    ] as const) {
      sent = [];
      expect(JSON.stringify(await call(name, args))).not.toContain("new-secret-value");
      expect(sent.length).toBeGreaterThan(0);
      expect(
        sent.every((r) => r.url.searchParams.get("teamId") === "team_alice"),
        name,
      ).toBe(true);
      expect(sent.filter((r) => r.method !== "GET")).toHaveLength(
        ["upsert_project_env_var", "update_project_env_var", "vercel_api_upload", "vercel_api_read"].includes(name)
          ? 1
          : 0,
      );
    }
    sent = [];
    const probe = await connector().testCredential!("candidate-token", context());
    expect(probe.ok).toBe(false); // The fake supplies no pinned-team identity.
    expect(sent.map((r) => r.url.pathname)).toEqual(["/v2/teams/team_alice"]);
  });

  it("INV-2: audits every pinned operation's route and rejects foreign selectors", () => {
    expect(vercelIndex.ops).toHaveLength(466);
    const counts = { "query-team": 0, "path-team": 0, denied: 0 };
    for (const op of vercelIndex.ops) {
      const params = Object.fromEntries(
        [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1]!, m[1] === "teamId" ? "team_alice" : "sample"]),
      );
      const base: RestCall = {
        method: op.method,
        op,
        params,
        path: op.path.replace(/\{([^}]+)\}/g, (_, name: string) => params[name]!),
        query: {},
        body: undefined,
      };
      const route = pinRoute(vercelIndex, op);
      counts[route]++;
      for (const selectors of [
        { teamId: "team_bob" },
        { teamId: null },
        { teamId: ["team_alice", "team_alice"] },
        { "teamId[]": "team_bob" },
        { "%2574eamId": "team_bob" },
        { ownerId: "team_bob" },
        { newDefaultTeamId: "team_alice" },
      ])
        expect(
          () => pinQuery(vercelIndex, { ...base, query: selectors }, { teamId: "team_alice" }),
          `${op.method} ${op.path}`,
        ).toThrow();
      if (route === "denied") expect(() => pinQuery(vercelIndex, base, { teamId: "team_alice" })).toThrow();
      else expect(() => pinQuery(vercelIndex, base, { teamId: "team_alice" })).not.toThrow();
    }
    expect(counts).toEqual({ "query-team": 368, "path-team": 17, denied: 81 });
  });

  it("INV-5: preserves resource slugs and third-party metadata in their reviewed locations", () => {
    for (const [method, path, body] of [
      ["PUT", "/v1/projects/web/feature-flags/flags", { slug: "ordinary-flag" }],
      ["POST", "/v9/projects/web/custom-environments", { slug: "staging" }],
      [
        "POST",
        "/v1/connect/connectors",
        { data: { owner: { slug: "github-org" }, slackTeam: { id: "slack_team" }, projectId: "photon-project" } },
      ],
    ] as const) {
      const { op, params } = vercelIndex.resolve(method, path);
      expect(() =>
        pinQuery(vercelIndex, { method, path, op, params, query: {}, body }, { teamId: "team_alice" }),
      ).not.toThrow();
    }
  });

  it("INV-2 INV-9: bounds and charges each sequential ownership read and sends no write after foreign/unknown ownership", async () => {
    const args = {
      method: "POST",
      path: "/v1/webhooks",
      body: { url: "https://hooks.example.test", events: ["deployment.created"], projectIds: ["prj_web", "prj_bob"] },
    };
    let charged = 0;
    const ctx = context();
    setViewService(ctx, Budget, {
      charge: Effect.sync(() => {
        charged++;
      }),
    });
    answer = ({ url }) =>
      Response.json({
        id: url.pathname.split("/").at(-1),
        accountId: url.pathname.endsWith("prj_bob") ? "team_bob" : "team_alice",
      });
    await expect(connector().callTool("vercel_api_write", args, ctx)).rejects.toMatchObject({
      code: "provider_permission_denied",
    });
    expect(charged).toBe(2);
    expect(sent.map((r) => r.method)).toEqual(["GET", "GET"]);
    sent = [];
    await expect(
      call("vercel_api_write", {
        ...args,
        body: { ...args.body, projectIds: Array.from({ length: MAX_PIN_LOOKUPS + 1 }, (_, i) => `prj_${i}`) },
      }),
    ).rejects.toMatchObject({ code: "provider_permission_denied" });
    expect(sent).toEqual([]);
    const denied = context();
    setViewService(denied, Budget, {
      charge: Effect.fail(new ConnectorCallError("rate_limited", "Auxiliary budget exhausted")),
    });
    await expect(connector().callTool("vercel_api_write", args, denied)).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(sent).toEqual([]);
    for (const data of [{}, { id: "prj_web", accountId: null }, { id: "prj_web", accountId: ["team_alice"] }]) {
      answer = () => Response.json(data);
      await expect(call("vercel_api_write", { method: "DELETE", path: "/v9/projects/web" })).rejects.toMatchObject({
        code: "provider_permission_denied",
      });
    }
    expect(sent.every((r) => r.method === "GET")).toBe(true);
  });

  it("INV-5: binds paginated team paths and queries to pin policy and credential owner before lookup IO", async () => {
    answer = () => Response.json({ members: [], deployments: [], pagination: { next: 123 } });
    const pinned = connector();
    const unpinned = vercel("hosting", OPTIONS);
    const ctx = context();
    setViewService(ctx, ContinuationBinding, { connection: "hosting", principal: "alice" });
    for (const path of ["/v3/teams/team_alice/members", "/v7/deployments"]) {
      const args = { path, query: { limit: 10 } };
      const first = (await pinned.callTool("vercel_api_read", args, ctx)) as any;
      const normal = (await unpinned.callTool("vercel_api_read", args, ctx)) as any;
      expect(first.page.nextCursor).toBeTypeOf("string");
      expect(normal.page.nextCursor).toBeTypeOf("string");
      sent = [];
      for (const [source, cursor] of [
        [unpinned, first.page.nextCursor],
        [pinned, normal.page.nextCursor],
      ] as const)
        await expect(
          source.callTool("vercel_api_read", { ...args, query: { ...args.query, until: cursor } }, ctx),
        ).rejects.toMatchObject({ code: "invalid_args" });
      const bob = context();
      setViewService(bob, ContinuationBinding, { connection: "hosting", principal: "bob" });
      await expect(
        pinned.callTool("vercel_api_read", { ...args, query: { ...args.query, until: first.page.nextCursor } }, bob),
      ).rejects.toMatchObject({ code: "invalid_args" });
      const other = vercel("hosting", { ...OPTIONS, teamId: "team_bob", pin: { teamId: "team_bob" } });
      await expect(
        other.callTool("vercel_api_read", { ...args, query: { ...args.query, until: first.page.nextCursor } }, ctx),
      ).rejects.toBeDefined();
      expect(sent).toEqual([]);
      await pinned.callTool("vercel_api_read", { ...args, query: { limit: 10, until: first.page.nextCursor } }, ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.searchParams.get("until")).toBe("123");
    }
  });

  it("INV-2 INV-5 INV-9: preserves readOnly, single-attempt writes and construction-owned pins", async () => {
    const options = { ...OPTIONS, pin: { teamId: "team_alice" } };
    const pinned = vercel("hosting", options);
    options.pin.teamId = "team_bob";
    await pinned.callTool("vercel_api_read", { path: "/v10/projects" }, context());
    expect(sent.at(-1)?.url.searchParams.get("teamId")).toBe("team_alice");
    sent = [];
    const registry = makeRegistry([vercel("hosting", { ...OPTIONS, pin: { teamId: "team_alice" }, readOnly: true })]);
    const blocked = await createMetaTools(registry, "https://connecta.example").callDestructiveTool({
      address: "hosting.vercel_api_write",
      args: { method: "DELETE", path: "/v9/projects/web" },
    });
    expect(blocked.structuredContent).toMatchObject({ ok: false, error: { code: "read_only_endpoint" } });
    expect(sent).toEqual([]);
    answer = ({ method }) =>
      method === "GET"
        ? Response.json({ id: "prj_web", accountId: "team_alice" })
        : Response.json({ error: { message: "failed" } }, { status: 503 });
    await expect(call("vercel_api_write", { method: "DELETE", path: "/v9/projects/web" })).rejects.toMatchObject({
      retryable: false,
    });
    expect(sent.map((r) => r.method)).toEqual(["GET", "DELETE"]);
  });
});
