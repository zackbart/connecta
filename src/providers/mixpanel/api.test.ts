import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixpanel, type MixpanelApiOptions } from "./index.js";
import { responses } from "./fixtures.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { classifyTool } from "../../tool-safety.js";
import { createConnecta, customExecutor } from "../../index.js";
import { mcpRpc, readJsonRpc } from "../../../test/fixtures/http.js";
import { openapi } from "./operations.js";
import { MIXPANEL_VALUE_SAFETY } from "./value-safety.js";

const options: MixpanelApiOptions = {
  via: "api",
  auth: { type: "credential" },
  purpose: "Product reporting",
  defaultProjectId: 42,
};
const range = { from_date: "2020-09-01", to_date: "2020-09-30" };
const calls: { url: URL; init: RequestInit }[] = [];
let reply: () => Response = () => Response.json(responses.account);
const ctx = () => ({
  ...connectorContext(),
  credential: {
    get: async () => "fixture-account:fixture-secret",
    getAll: async () => ({ value: "fixture-account:fixture-secret" }),
  },
});
const api = (overrides: Partial<MixpanelApiOptions> = {}) => mixpanel("raw", { ...options, ...overrides });
const call = (name: string, args: Record<string, unknown> = {}, overrides: Partial<MixpanelApiOptions> = {}) =>
  api(overrides).callTool(name, args, ctx());

beforeEach(() => {
  calls.length = 0;
  reply = () => Response.json(responses.account);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: new URL(url), init });
      return reply();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Mixpanel service-account REST", () => {
  it("INV-11: refuses invalid implementations, API auth, residency and project defaults at construction", () => {
    for (const bad of [
      { via: "unknown" },
      { auth: undefined },
      { auth: { type: "oauth" } },
      { auth: { type: "headers", headers: {} } },
      { region: "apac" },
      { region: "toString" },
      { defaultProjectId: 0 },
      { defaultProjectId: -1 },
      { defaultProjectId: "42" },
      { defaultProjectId: 1.5 },
      { defaultProjectId: Infinity },
      { defaultProjectId: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() => mixpanel("bad", { ...options, ...bad } as never)).toThrow('mixpanel("bad") requires');
    expect(() => mixpanel("mcp", { purpose: "Analytics", defaultProjectId: 42 } as never)).toThrow("defaultProjectId");
  });

  it("INV-1: annotates ten reads and the additive import write, with no generic mutation or delete", async () => {
    const connector = api();
    expect(connector.kind).toBe("api");
    expect(mixpanel.definition.kind).toBe("dual");
    const tools = await connector.listTools(ctx());
    expect(tools.map((t) => t.name)).toEqual([
      "mixpanel_api_search",
      "mixpanel_api_details",
      "mixpanel_api_read",
      "list_projects",
      "export_events",
      "get_profile_activity",
      "query_profiles",
      "get_insights_report",
      "get_funnel_report",
      "query_retention",
      "import_events",
    ]);
    expect(tools.filter((t) => classifyTool(t) !== "read").map((t) => t.name)).toEqual(["import_events"]);
    expect(tools.find((t) => t.name === "import_events")?.annotations).toEqual({ readOnlyHint: false });
    expect(connector.describe?.()).toMatchObject({ source: { kind: "api", provider: "mixpanel" } });
    expect(JSON.stringify(connector.describe?.())).not.toContain("fixture-secret");
    expect(JSON.stringify(connector.usageGuide)).toContain("never guess one");
    expect(JSON.stringify(connector.usageGuide)).toContain("maintenance mode");
  });

  it("uses an overridable conservative Query/Export call-admission default", () => {
    expect(api().callAdmission?.rules.map((r) => r.budget)).toEqual([
      { kind: "rolling-window", maxCalls: 60, windowMs: 3_600_000 },
    ]);
    const custom = { rules: [{ maxConcurrency: 1 }] };
    expect(api({ callAdmission: custom }).callAdmission).toEqual(custom);
  });

  it.each(["us", "eu", "in"] as const)(
    "INV-5: routes query, app, export and import to %s residency using ordinary Basic",
    async (region) => {
      reply = () => Response.json(responses.insights);
      await call("get_insights_report", { bookmark_id: 7 }, { region });
      await call("list_projects", {}, { region });
      reply = () => new Response(responses.export, { headers: { "content-type": "text/plain" } });
      await call("export_events", range, { region });
      reply = () => Response.json(responses.imported);
      await call("import_events", { events: [responses.event] }, { region });
      const app = region === "us" ? "mixpanel.com" : `${region}.mixpanel.com`;
      const suffix = region === "us" ? "" : `-${region}`;
      expect(calls.map((c) => c.url.host)).toEqual([
        app,
        app,
        `data${suffix}.mixpanel.com`,
        `api${suffix}.mixpanel.com`,
      ]);
      expect(calls.map((c) => c.url.pathname)).toEqual([
        "/api/query/insights",
        "/api/app/me",
        "/api/2.0/export",
        "/import",
      ]);
      expect(calls[1]?.url.search).toBe("");
      for (const { init } of calls) {
        expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${btoa("fixture-account:fixture-secret")}`);
        expect(init.redirect).toBe("manual");
      }
    },
  );

  it("INV-5: refuses missing or malformed service accounts before network dispatch", async () => {
    for (const pair of [undefined, "", "user", ":secret", "user:", "user:secret\n"]) {
      await expect(
        api().callTool(
          "list_projects",
          {},
          { ...connectorContext(), credential: { get: async () => pair ?? null, getAll: async () => ({}) } },
        ),
      ).rejects.toMatchObject({ code: "auth_required" });
    }
    expect(calls).toHaveLength(0);
    const connector = api();
    expect(await connector.testCredential?.("user:secret", connectorContext())).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/api/app/me");
  });

  it("requires or defaults project ids per call and lets explicit ids select a second granted project", async () => {
    reply = () => Response.json(responses.insights);
    await call("get_insights_report", { bookmark_id: 7 });
    await call("get_insights_report", { bookmark_id: 7, project_id: 99 });
    await call("mixpanel_api_read", { path: "/api/query/insights", project_id: 100, query: { bookmark_id: 7 } });
    expect(calls.map((c) => c.url.searchParams.get("project_id"))).toEqual(["42", "99", "100"]);
    await expect(
      call("get_insights_report", { bookmark_id: 7 }, { defaultProjectId: undefined } as never),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call("mixpanel_api_read", {
        path: "/api/query/insights",
        project_id: 99,
        query: { project_id: 42, bookmark_id: 7 },
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call("get_insights_report", { bookmark_id: 7, project_id: 0 })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(3);
  });

  it("queries profiles with form encoding, explicit workspace/project ids and vendor session paging", async () => {
    reply = () => Response.json(responses.profiles);
    const first = await call("query_profiles", {
      project_id: 99,
      workspace_id: 3,
      distinct_ids: ["13793"],
      output_properties: ["$email"],
      where: 'properties["$first_name"]=="Example"',
    });
    expect(first).toMatchObject({
      data: { total: 2, session_id: "1234567890-EXAMPL" },
      page: { hasMore: true, next: "1", param: "page", in: "body" },
    });
    const sent = calls[0]!;
    expect(sent.url.pathname).toBe("/api/query/engage");
    expect(sent.url.searchParams.get("project_id")).toBe("99");
    expect(sent.url.searchParams.get("workspace_id")).toBe("3");
    expect(sent.init.method).toBe("POST");
    expect(new Headers(sent.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(sent.init.body));
    expect(form.get("distinct_ids")).toBe('["13793"]');
    expect(form.get("output_properties")).toBe('["$email"]');
    reply = () => Response.json({ ...responses.profiles, page: 1, results: [] });
    expect(await call("query_profiles", { page: 1, session_id: responses.profiles.session_id })).toMatchObject({
      page: { hasMore: false },
    });
    expect(await call("query_profiles", { raw: true })).toMatchObject({ data: { status: "ok", page: 1 }, status: 200 });
    await expect(call("query_profiles", { page: 2 })).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("orders activity events and preserves the redacted vendor envelope with raw", async () => {
    reply = () => Response.json(responses.activity);
    expect(await call("get_profile_activity", { ...range, distinct_id: "fixture-user", project_id: 99 })).toMatchObject(
      {
        data: {
          events: [responses.activity.results.events[1], responses.activity.results.events[0]],
          notice: expect.stringContaining("Maintenance"),
        },
      },
    );
    expect(calls[0]?.url.searchParams.get("distinct_ids")).toBe('["fixture-user"]');
    expect(await call("get_profile_activity", { ...range, distinct_id: "fixture-user", raw: true })).toMatchObject({
      data: responses.activity,
    });
  });

  it.each([
    ["get_insights_report", { bookmark_id: 11 }, responses.insights, "/api/query/insights"],
    ["get_funnel_report", { funnel_id: 12, ...range }, responses.funnel, "/api/query/funnels"],
    [
      "query_retention",
      { ...range, born_event: "Signup", event: "Purchase", retention_type: "birth" },
      responses.retention,
      "/api/query/retention",
    ],
  ] as const)("returns the documented %s report shape", async (name, args, body, path) => {
    reply = () => Response.json(body);
    expect(await call(name, args)).toMatchObject({ status: 200, data: body });
    expect(calls[0]?.url.pathname).toBe(path);
  });

  it("export encodes event filters, enforces dates, and exposes a complete bounded JSONL response", async () => {
    reply = () => new Response(responses.export, { headers: { "content-type": "text/plain" } });
    expect(await call("export_events", { ...range, event: ["Signed up"], time_in_ms: true })).toMatchObject({
      events: [JSON.parse(responses.export)],
      truncated: false,
      bytes_read: new TextEncoder().encode(responses.export).length,
    });
    expect(calls[0]?.url.searchParams.get("event")).toBe('["Signed up"]');
    expect(calls[0]?.url.searchParams.get("limit")).toBe("1000");
    expect(calls[0]?.url.searchParams.has("max_bytes")).toBe(false);
    for (const args of [
      { from_date: "2020-02-30", to_date: "2020-03-02" },
      { from_date: "2020-10-01", to_date: "2020-09-30" },
      { ...range, limit: 100_001 },
      { ...range, max_bytes: 1_048_577 },
    ])
      await expect(call("export_events", args)).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(1);
  });

  it("refuses default birth retention without born_event on named and generic routes", async () => {
    for (const name of ["query_retention", "mixpanel_api_read"]) {
      const args = name === "query_retention" ? range : { path: "/api/query/retention", query: range };
      await expect(call(name, args)).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toHaveLength(0);
    reply = () => Response.json(responses.retention);
    await call("query_retention", { ...range, retention_type: "compounded" });
    expect(calls).toHaveLength(1);
  });

  it("INV-7: cancels a failed export body before the connector call returns", async () => {
    const cancelled = vi.fn();
    reply = () =>
      new Response(
        new ReadableStream({
          start() {
            /* A failed response can flush headers and never emit a chunk. */
          },
          cancel: cancelled,
        }),
        { status: 403 },
      );
    await expect(call("export_events", range)).rejects.toMatchObject({ code: "provider_permission_denied" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("INV-7: stops an oversized export stream at the byte ceiling and discards its trailing partial record", async () => {
    const cancel = vi.fn();
    const prefix = responses.export;
    reply = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(prefix + responses.export.repeat(20)));
          },
          cancel,
        }),
        { headers: { "content-type": "text/plain", "content-length": "99999999" } },
      );
    const result = await call("export_events", { ...range, max_bytes: prefix.length + 12 });
    expect(result).toMatchObject({
      events: [JSON.parse(prefix)],
      bytes_read: prefix.length + 12,
      truncated: true,
      notice: expect.stringContaining("no cursor"),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("marks event-limited export as possibly incomplete, and bounds generic export too", async () => {
    reply = () => new Response(responses.export, { headers: { "content-type": "text/plain" } });
    expect(await call("export_events", { ...range, limit: 1 })).toMatchObject({ truncated: true });
    expect(
      await call("mixpanel_api_read", {
        path: "/api/2.0/export",
        project_id: 99,
        query: { ...range, event: '["Signed up"]', limit: 1 },
      }),
    ).toMatchObject({ data: { truncated: true } });
    expect(calls[1]?.url.searchParams.get("project_id")).toBe("99");
    reply = () => new Response("broken json\n");
    await expect(call("export_events", range)).rejects.toMatchObject({ code: "connector_call_failed" });
  });

  it("INV-3 INV-5: refuses URLs, unknown paths, mutations, credentials in queries and redirects", async () => {
    for (const args of [
      { path: "https://evil.example/api/query/insights" },
      { path: "//evil.example/x" },
      { path: "/api/query/../app/me" },
      { path: "/api/app/projects" },
      { path: "/api/query/insights?bookmark_id=7" },
      { path: "/import", method: "POST" },
      { path: "/api/query/engage", method: "POST" },
      { path: "/api/query/insights", query: { bookmark_id: 7, token: "secret" } },
    ])
      await expect(call("mixpanel_api_read", args)).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
    reply = () => new Response(null, { status: 302, headers: { location: "https://evil.example" } });
    await expect(call("list_projects")).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("local operation search/details route import and Engage to existing named tools", async () => {
    expect(await call("mixpanel_api_search", { query: "/import" })).toMatchObject({
      operations: [{ path: "/import", tool: "import_events" }],
    });
    expect(await call("mixpanel_api_details", { method: "POST", path: "/api/query/engage" })).toMatchObject({
      tool: "query_profiles",
    });
    expect(calls).toHaveLength(0);
  });

  it("INV-9: imports one strict batch without retries, including ambiguous server failures", async () => {
    reply = () => Response.json(responses.imported);
    expect(await call("import_events", { project_id: 99, events: [responses.event] })).toMatchObject({
      data: responses.imported,
    });
    expect(calls[0]?.url.searchParams.get("strict")).toBe("1");
    expect(calls[0]?.url.searchParams.get("project_id")).toBe("99");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual([responses.event]);
    reply = () => Response.json({ error: "fixture-secret raw payload" }, { status: 503 });
    await expect(call("import_events", { events: [responses.event] })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("unknown"),
    });
    expect(calls).toHaveLength(2);
  });

  it("imports documented historical seconds and milliseconds without a guessed unit threshold", async () => {
    reply = () => Response.json(responses.imported);
    for (const time of [63072000, 63072000000])
      await call("import_events", {
        events: [{ ...responses.event, properties: { ...responses.event.properties, time } }],
      });
    expect(calls).toHaveLength(2);
  });

  it("refuses import count, size, required-key and nested-property violations before sending", async () => {
    const event = responses.event;
    const badProps = [
      { ...event.properties, $insert_id: "bad_id" },
      { ...event.properties, $insert_id: "null" },
      { ...event.properties, distinct_id: "anonymous" },
      { ...event.properties, time: 1 },
      { ...event.properties, time: Date.now() + 7_200_000 },
      { ...event.properties, huge: "x".repeat(1_000_000) },
      { ...event.properties, array: Array(255).fill(1) },
      { ...event.properties, nested: { a: { b: { c: { d: 1 } } } } },
      { ...event.properties, ...Object.fromEntries(Array.from({ length: 255 }, (_, n) => [`p${n}`, n])) },
    ];
    for (const properties of badProps)
      await expect(call("import_events", { events: [{ ...event, properties }] })).rejects.toMatchObject({
        code: "invalid_args",
      });
    await expect(call("import_events", { events: Array(2001).fill(event) })).rejects.toMatchObject({
      code: "invalid_args",
    });
    const large = { ...event, properties: { ...event.properties, text: "x".repeat(600_000) } };
    await expect(call("import_events", { events: Array(17).fill(large) })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(call("import_events", { events: [{ event: "Signup", properties: {} }] })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(0);
  });

  it("INV-5: redacts credentials in account, profile and event properties and withholds vendor error text", async () => {
    reply = () =>
      Response.json({
        projects: [{ token: "project-secret", api_secret: "api-secret" }],
        secret: "service-secret",
        url: "https://example.com/file?token=bearer",
      });
    const result = await call("list_projects");
    expect(JSON.stringify(result)).not.toMatch(/project-secret|api-secret|service-secret|bearer/);
    reply = () =>
      Response.json({
        ...responses.profiles,
        results: [{ $distinct_id: "13793", $properties: { password: "private-password" } }],
      });
    expect(JSON.stringify(await call("query_profiles"))).not.toContain("private-password");
    reply = () => new Response('{"event":"Signup","properties":{"time":1602611311,"password":"private-password"}}\n');
    expect(JSON.stringify(await call("export_events", range))).not.toContain("private-password");
    reply = () => Response.json({ error: "fixture-secret private vendor message" }, { status: 400 });
    await expect(call("list_projects")).rejects.toMatchObject({
      message: expect.not.stringContaining("fixture-secret"),
    });
    expect(Object.keys(MIXPANEL_VALUE_SAFETY.operations!).sort()).toEqual(
      openapi.ops.map(([method, path]) => `${method} ${path}`).sort(),
    );
  });

  it.each([
    [401, "auth_required"],
    [403, "provider_permission_denied"],
    [429, "rate_limited"],
    [404, "connector_call_failed"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    reply = () => Response.json({ error: "secret" }, { status, headers: { "retry-after": "17" } });
    await expect(call("list_projects")).rejects.toMatchObject({
      code,
      ...(status === 429 ? { retryAfterMs: 17000 } : {}),
    });
  });

  it("INV-2: a read-only endpoint hides import and refuses it before validation, auth or dispatch", async () => {
    const deployment = createConnecta({
      readOnly: true,
      connectors: [api()],
      storage: connectorContext().storage,
      logger: "silent",
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
    });
    try {
      const search = await readJsonRpc(
        await mcpRpc(deployment, "tools/call", {
          name: "search_tools",
          arguments: { connector: "raw", query: "import", safety: "all" },
        }),
      );
      expect(JSON.stringify(search)).not.toContain('"address":"raw.import_events"');
      for (const name of ["call_tool", "call_destructive_tool"]) {
        const body = await readJsonRpc(
          await mcpRpc(deployment, "tools/call", { name, arguments: { address: "raw.import_events", args: {} } }),
        );
        expect(JSON.stringify(body)).toContain("read_only_endpoint");
      }
      expect(calls).toHaveLength(0);
    } finally {
      await deployment.close();
    }
  });
});
