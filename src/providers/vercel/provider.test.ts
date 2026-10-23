import { configureGuardedTransport } from "../../guarded-transport.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connector, ConnectorContext } from "../../types.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { classifyCallError, ConnectorCallError } from "../../errors.js";

import { vercel } from "./index.js";

import { REDACTED } from "../_shared/rest/value-safety.js";

const TOKEN = { purpose: "Production web applications", auth: { type: "token" }, teamId: "team_default" } as const;

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

describe("vercel() over an access token", () => {
  let sent: Sent[];
  let respond: (request: Sent) => Response;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
    sent = [];
    respond = () => Response.json({});
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      const request: Sent = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers,
        body:
          typeof raw === "string"
            ? headers.get("content-type")?.includes("json")
              ? JSON.parse(raw)
              : raw
            : raw instanceof Uint8Array
              ? raw
              : undefined,
      };
      sent.push(request);
      return respond(request);
    }) as typeof fetch;
  });

  afterEach(() => {
    configureGuardedTransport(undefined);
    globalThis.fetch = realFetch;
  });

  const keyed = (token = "vercel-token"): ConnectorContext => ({
    ...connectorContext(),
    credential: { get: async () => token, getAll: async () => ({ value: token }) },
  });

  async function refusal(promise: Promise<unknown>): Promise<ConnectorCallError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorCallError);
    return error as ConnectorCallError;
  }

  const call = (connector: Connector, name: string, args: Record<string, unknown> = {}) =>
    connector.callTool(name, args, keyed()) as Promise<any>;

  it("INV-5: sanitizes embedded URLs in named build/runtime log streams before clamping (#812)", async () => {
    const connector = vercel("hosting", TOKEN);
    const ordinary = "[public](https://EXAMPLE.com/a?width=400#section)";
    const input = `${ordinary} download [file](https://files.example/a?sig=PRIVATE_SIG&X-Goog-Credential=PRIVATE_CREDENTIAL)`;
    const expected = `${ordinary} download [file](https://files.example/a?[redacted])`;
    respond = () => Response.json([{ type: "stdout", payload: { text: input } }]);
    expect((await call(connector, "get_deployment_build_logs", { deploymentId: "dpl_1" })).events[0].text).toBe(
      expected,
    );
    respond = () =>
      new Response(JSON.stringify({ level: "info", message: input }) + "\n", {
        headers: { "content-type": "application/x-ndjson" },
      });
    expect((await call(connector, "get_runtime_logs", { projectId: "web", deploymentId: "dpl_1" })).logs[0].text).toBe(
      expected,
    );
    respond = () => Response.json([{ type: "stdout", payload: { text: "x".repeat(3900) + input } }]);
    const long = await call(connector, "get_deployment_build_logs", { deploymentId: "dpl_1" });
    expect(JSON.stringify(long)).not.toMatch(/PRIVATE_SIG|PRIVATE_CREDENTIAL/);
  });

  it("INV-1 INV-5: redacts arbitrary daemon probe header values and internal endpoint ciphertext before select (#890)", async () => {
    const connector = vercel("hosting", TOKEN);
    const headerPath = "daemons.config.livenessProbe.httpGet.httpHeaders";
    const daemon = {
      name: "worker",
      config: {
        livenessProbe: {
          httpGet: {
            httpHeaders: [
              { name: "X-Proof", value: "stored-daemon-credential-marker" },
              { name: "Accept", value: "ordinary-daemon-header-marker" },
            ],
          },
        },
      },
      replicas: { items: [{ id: "instance", iroh: { publicKeyCiphertext: "internal-endpoint-marker" } }] },
    };
    for (const select of [undefined, [headerPath]]) {
      respond = () => Response.json({ daemons: [daemon], pagination: { count: 1 } });
      const result = await call(connector, "vercel_api_read", {
        path: "/v1/projects/web/daemons",
        ...(select ? { select } : {}),
      });
      expect(result.data.daemons[0].config.livenessProbe.httpGet.httpHeaders).toEqual([
        { name: "X-Proof", value: "[redacted]" },
        { name: "Accept", value: "[redacted]" },
      ]);
      expect(JSON.stringify(result)).not.toMatch(
        /stored-daemon-credential-marker|ordinary-daemon-header-marker|internal-endpoint-marker/,
      );
    }
    respond = () => Response.json({ error: { code: "bad_request", message: JSON.stringify(daemon) } }, { status: 400 });
    const error = await refusal(call(connector, "vercel_api_read", { path: "/v1/projects/web/daemons" }));
    expect(error.message).not.toMatch(
      /stored-daemon-credential-marker|ordinary-daemon-header-marker|internal-endpoint-marker/,
    );

    sent = [];
    for (const args of [
      { method: "PUT", path: "/v1/projects/web/daemons/worker/instances", body: { iad1: 2 } },
      { method: "POST", path: "/v1/projects/web/daemons/worker/instances/dmni_01k7d0q5w3x8y9z0a1b2c3d4e5/restart" },
    ]) {
      expect((await refusal(call(connector, "vercel_api_read", args))).code).toBe("invalid_args");
    }
    expect(sent).toEqual([]);
    respond = () => Response.json({ ok: true });
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "PUT",
          path: "/v1/projects/web/daemons/worker/instances",
          body: { iad1: 2 },
        })
      ).data,
    ).toEqual({ ok: true });
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "POST",
          path: "/v1/projects/web/daemons/worker/instances/dmni_01k7d0q5w3x8y9z0a1b2c3d4e5/restart",
        })
      ).data,
    ).toEqual({ ok: true });
  });

  it("refuses live log streams on the generic read tool and names the bounded tool instead", async () => {
    const connector = vercel("hosting", TOKEN);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["vercel_api_read", { path: "/v3/deployments/dpl_1/events", query: { follow: 1 } }, "get_deployment_build_logs"],
      ["vercel_api_read", { path: "/v1/projects/web/deployments/dpl_1/runtime-logs" }, "get_runtime_logs"],
    ];
    for (const [tool, args, message] of cases) {
      const error = await refusal(call(connector, tool, args));
      expect(error.code, message).toBe("invalid_args");
      expect(error.message).toContain(message);
    }
    expect(sent).toEqual([]);
  });

  it("INV-5: redacts invite codes in audit events, integration drain headers, and route header values (#801 detector)", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        events: [{ id: "ev_1", type: "team-invite", payload: { inviteCode: "JOIN-CODE", role: "MEMBER" } }],
      });
    expect((await call(connector, "vercel_api_read", { path: "/v3/events" })).data.events[0].payload).toEqual({
      inviteCode: REDACTED,
      role: "MEMBER",
    });
    respond = () =>
      Response.json({
        products: [
          {
            protocols: {
              logDrain: {
                status: "enabled",
                endpoint: "https://logs.partner.example/ingest/PATH-SECRET",
                headers: { "X-Partner": "PARTNER-SECRET" },
              },
            },
          },
        ],
      });
    const products = (
      await call(connector, "vercel_api_read", { path: "/v1/integrations/configuration/icfg_1/products" })
    ).data;
    expect(products.products[0].protocols.logDrain).toEqual({
      status: "enabled",
      endpoint: `https://logs.partner.example/${REDACTED}`,
      headers: { "X-Partner": REDACTED },
    });
    respond = () =>
      Response.json({ routes: [{ id: "r1", route: { src: "/api", headers: { "X-Upstream": "UPSTREAM-SECRET" } } }] });
    expect(
      (await call(connector, "vercel_api_read", { path: "/v1/projects/prj_1/routes" })).data.routes[0].route,
    ).toEqual({
      src: "/api",
      headers: { "X-Upstream": REDACTED },
    });
    // An environment container's own fields are still walked: a credential-named key inside it goes too.
    respond = () =>
      Response.json({ id: "prj_1", env: [{ key: "DB", value: "postgres://x", meta: { token: "NESTED" } }] });
    expect((await call(connector, "vercel_api_read", { path: "/v9/projects/prj_1" })).data.env).toEqual([
      { key: "DB", value: REDACTED, meta: { token: REDACTED } },
    ]);
  });

  it("INV-5: withholds conditional-bypass credentials in compiled and structured responses before selection", async () => {
    const connector = vercel("hosting", TOKEN);
    const rule = {
      id: "rule_1",
      projectId: "prj_1",
      domain: "app.example.com",
      condition: 'http.request.headers["x-auth-key"] == "stored-access"',
      conditionGroup: [
        {
          conditions: [
            { type: "header", key: "X-Auth-Key", op: "eq", value: "stored-access" },
            { type: "cookie", key: "session", op: "eq", value: ["stored-cookie"] },
            { type: "query", key: "proof", op: "eq", value: "stored-query" },
            { type: "ip_address", op: "eq", value: "192.0.2.1" },
          ],
        },
      ],
    };
    for (const data of [rule, { rules: [rule] }]) {
      respond = () => Response.json(data);
      const result = await call(connector, "vercel_api_read", {
        path: "/v1/security/firewall/bypass/rules",
        query: { projectId: "prj_1" },
      });
      expect(JSON.stringify(result)).not.toMatch(/stored-access|stored-cookie|stored-query/);
      expect(JSON.stringify(result)).toContain("192.0.2.1");
      expect(JSON.stringify(result)).toContain("[redacted]");
    }
    respond = () => Response.json(rule);
    const created = await call(connector, "vercel_api_write", {
      method: "POST",
      path: "/v1/security/firewall/bypass/rules",
      query: { projectId: "prj_1" },
      body: { domain: "app.example.com", conditionGroup: [{ conditions: [rule.conditionGroup[0]!.conditions[0]!] }] },
      select: ["condition", "conditionGroup"],
    });
    expect(JSON.stringify(created)).not.toMatch(/stored-access|stored-cookie|stored-query/);
    respond = () =>
      Response.json({
        projects: [
          {
            security: {
              firewallRoutes: [
                { response_has: [{ type: "header", key: "X-Auth-Key", value: "stored-response-match" }] },
              ],
            },
          },
        ],
      });
    expect(JSON.stringify(await call(connector, "vercel_api_read", { path: "/v10/projects" }))).not.toContain(
      "stored-response-match",
    );
  });

  it("INV-5: names an upsert conflict without echoing the submitted value", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        failed: [{ error: { code: "ENV_ALREADY_EXISTS", message: "exists", key: "TOKEN", value: "s3cret" } }],
      });
    const conflict = await refusal(
      call(connector, "upsert_project_env_var", {
        projectId: "web",
        key: "TOKEN",
        value: "s3cret",
        type: "sensitive",
        targets: ["preview"],
      }),
    );
    expect(conflict.message).toContain("Vercel ENV_ALREADY_EXISTS: a variable with this key already targets");
    expect(conflict.message).not.toContain("s3cret");
  });

  it("collects runtime logs until waitMs on a stream that never ends, then says why it stopped", async () => {
    const connector = vercel("hosting", TOKEN);
    const lines = [
      { timestampInMs: 1, level: "info", message: "GET /", source: "serverless" },
      { timestampInMs: 2, level: "error", message: "TypeError: x is undefined", requestPath: "/api" },
    ];
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const line of lines) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
            // Never closed: Vercel keeps the stream open for new logs.
          },
        }),
        { headers: { "content-type": "application/stream+json" } },
      );
    const started = Date.now();
    const result = await call(connector, "get_runtime_logs", {
      projectId: "web",
      deploymentId: "dpl_1",
      waitMs: 1000,
      levels: ["error"],
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toEqual({
      logs: [{ timestampInMs: 2, level: "error", text: "TypeError: x is undefined", requestPath: "/api" }],
      stopped: "time",
    });
    expect(sent[0]!.url.pathname).toBe("/v1/projects/web/deployments/dpl_1/runtime-logs");
    // The row limit stops a stream that stays open as soon as it is met, not at waitMs.
    const quick = Date.now();
    expect(
      await call(connector, "get_runtime_logs", {
        projectId: "web",
        deploymentId: "dpl_1",
        maxRows: 1,
        waitMs: 20_000,
        levels: ["error"],
      }),
    ).toEqual({
      logs: [{ timestampInMs: 2, level: "error", text: "TypeError: x is undefined", requestPath: "/api" }],
      stopped: "rows",
    });
    expect(Date.now() - quick).toBeLessThan(5_000);
  });

  it("reads Vercel's x-ratelimit-reset as the retry delay", async () => {
    const connector = vercel("hosting", TOKEN);
    const reset = String(Math.ceil(Date.now() / 1000) + 30);
    respond = () =>
      Response.json(
        { error: { code: "bad_request", message: "No." } },
        { status: 429, headers: { "x-ratelimit-reset": reset } },
      );
    const failure = await refusal(call(connector, "vercel_api_read", { path: "/v7/deployments" }));
    expect(failure.code).toBe("rate_limited");
    expect(classifyCallError(failure).message).toContain("wait for the reported reset");
    expect(failure.retryAfterMs).toBeGreaterThan(0);
  });

  it("refuses a domain move-out, whose answer is a transfer token, before dispatch", async () => {
    const connector = vercel("hosting", TOKEN);
    const refused = await refusal(
      call(connector, "vercel_api_write", {
        method: "PATCH",
        path: "/v3/domains/example.com",
        body: { op: "move-out", destination: "team_other" },
      }),
    );
    expect(refused.message).toContain("transfer token");
    expect(sent).toEqual([]);
    respond = () => Response.json({ moved: true, token: "move-token" });
    // Another op is an ordinary write, and a token in any answer is still removed.
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "PATCH",
          path: "/v3/domains/example.com",
          body: { op: "update", zone: true },
        })
      ).data,
    ).toEqual({ moved: true, token: "[redacted]" });
  });
});
