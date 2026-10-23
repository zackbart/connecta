import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureGuardedTransport } from "../../guarded-transport.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { responses } from "./fixtures.js";
import { mixpanel, type MixpanelApiOptions } from "./index.js";

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
    get: async () => "mp9Qx2.sa:pQ6?eT8+dW3=G5/f",
    getAll: async () => ({ value: "mp9Qx2.sa:pQ6?eT8+dW3=G5/f" }),
  },
});
const api = (overrides: Partial<MixpanelApiOptions> = {}) => mixpanel("raw", { ...options, ...overrides });
const call = (name: string, args: Record<string, unknown> = {}, overrides: Partial<MixpanelApiOptions> = {}) =>
  api(overrides).callTool(name, args, ctx());

let restoreTransport: ReturnType<typeof configureGuardedTransport>;
beforeEach(() => {
  restoreTransport = configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
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
afterEach(() => {
  configureGuardedTransport(restoreTransport);
  vi.unstubAllGlobals();
});

describe("Mixpanel service-account REST", () => {
  it.each(["eu", "in"] as const)(
    "INV-5: routes query, app, export and import to %s residency using ordinary Basic",
    async (region) => {
      reply = () => Response.json(responses.insights);
      await call("get_insights_report", { bookmark_id: 7 }, { region });
      await call("list_projects", {}, { region });
      reply = () => new Response(responses.export, { headers: { "content-type": "text/plain" } });
      await call("export_events", range, { region });
      reply = () => Response.json(responses.imported);
      await call("import_events", { events: [responses.event] }, { region });
      const app = `${region}.mixpanel.com`;
      const suffix = `-${region}`;
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
        expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${btoa("mp9Qx2.sa:pQ6?eT8+dW3=G5/f")}`);
        expect(init.redirect).toBe("manual");
      }
    },
  );

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
    reply = () => Response.json({ error: "pQ6?eT8+dW3=G5/f private vendor message" }, { status: 400 });
    await expect(call("list_projects")).rejects.toMatchObject({
      message: expect.not.stringContaining("pQ6?eT8+dW3=G5/f"),
    });
  });
});
