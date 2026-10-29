import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connector, ConnectorContext } from "../../types.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { classifyCallError, ConnectorCallError } from "../../errors.js";
import { CredentialVault } from "../../credentials.js";
import { createMetaTools } from "../../meta-tools.js";
import { memoryStorage } from "../../storage/memory.js";
import { makeRegistry } from "../../../test/helpers.js";
import { vercel, type VercelTokenOptions } from "./index.js";
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
    installOwnedTransport();
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

  it("INV-1 INV-5: redacts arbitrary daemon probe header values and internal endpoint ciphertext before fields (#890)", async () => {
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
    for (const fields of [undefined, [headerPath]]) {
      respond = () => Response.json({ daemons: [daemon], pagination: { count: 1 } });
      const result = await call(connector, "vercel_api_read", {
        path: "/v1/projects/web/daemons",
        ...(fields ? { fields } : {}),
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
    const artifact = await refusal(call(connector, "vercel_api_read", { path: "/v8/artifacts/hash_1" }));
    expect(artifact.message).toContain("Artifact downloads serve binary bytes");
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
    for (const field of ["drainUrl", "logDrainUrl", "webhookUrl", "prevWebhookUrl"]) {
      const event = {
        id: "ev_drain",
        payload: { [field]: "https://logs.example/secret-path?token=secret-query", id: "drain_1" },
      };
      for (const shape of [event, [event], { events: [event] }, { data: { events: [event] } }]) {
        respond = () => Response.json(shape);
        const result = await call(connector, "vercel_api_read", { path: "/v3/events" });
        expect(JSON.stringify(result), field).not.toMatch(/secret-path|secret-query|token=/);
        expect(JSON.stringify(result), field).toContain(REDACTED);
        expect(JSON.stringify(result), field).toContain("drain_1");
      }
      for (const fields of [[`events[].payload.${field}`], ["events[].payload"]]) {
        respond = () => Response.json({ events: [event] });
        const selected = await call(connector, "vercel_api_read", { path: "/v3/events", fields });
        expect(selected.data.events[0].payload[field], field).toBe(REDACTED);
        expect(JSON.stringify(selected), field).not.toMatch(/secret-path|secret-query|token=/);
      }
    }
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

  it("INV-5: withholds conditional-bypass credentials in compiled and structured responses before field selection", async () => {
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
      fields: ["condition", "conditionGroup"],
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

  it("INV-5: an argument refusal on an env write never echoes its value in an example", async () => {
    const connector = vercel("hosting", TOKEN);
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.setAll("hosting", { value: "vercel-token" }, "fixture");
    const meta = createMetaTools(
      makeRegistry([connector], { storage, credentialVault: vault }),
      "https://connecta.example",
    );
    sent = [];
    const refused = await meta.callDestructiveTool({
      address: "hosting.vercel_api_write",
      args: {
        method: "POST",
        path: "/v10/projects/web/env",
        query: { bogus: 1 },
        body: { key: "TOKEN", value: "env-secret-sentinel", type: "encrypted", target: ["preview"] },
      },
    });
    expect(refused.structuredContent).toMatchObject({
      ok: false,
      error: { code: "invalid_args", validation: { issues: [{ path: "/query/bogus" }] } },
    });
    // The generic hatch schema cannot prove this body safe to echo, so no example is derived.
    expect((refused.structuredContent as any).error.validation).not.toHaveProperty("example");
    expect((refused.structuredContent as any).error.validation.exampleUnavailable).toContain("vercel_api_details");
    expect(JSON.stringify(refused)).not.toContain("env-secret-sentinel");
    expect(sent).toHaveLength(0);
  });

  it("INV-5 INV-9: names upsert conflicts, preserves partial commits and reports missing acknowledgements without replay", async () => {
    const connector = vercel("hosting", TOKEN);
    const catalog = await connector.listTools(keyed());
    for (const name of ["upsert_project_env_var", "update_project_env_var"])
      expect(
        (catalog.find((tool) => tool.name === name)!.inputSchema as { properties: { value: { writeOnly?: boolean } } })
          .properties.value.writeOnly,
      ).toBe(true);
    const body = { key: "TOKEN", value: "s3cret", type: "sensitive", target: ["preview"] };
    const named = { projectId: "web", key: body.key, value: body.value, type: body.type, targets: body.target };
    for (const code of ["ENV_ALREADY_EXISTS", "ENV_CONFLICT"])
      for (const [tool, args] of [
        ["upsert_project_env_var", named],
        ["vercel_api_write", { method: "POST", path: "/v10/projects/web/env", body }],
      ] as const) {
        sent = [];
        respond = () =>
          Response.json(
            { created: [], failed: [{ error: { code, message: "exists", key: "TOKEN", value: "s3cret" } }] },
            { status: 201 },
          );
        const error = await refusal(call(connector, tool, args));
        expect(error).toMatchObject({ code: "invalid_args", retryable: false });
        expect(error.message).toContain(code);
        expect(error.message).toContain(
          "Pass upsert: true to replace it, or update it by id with update_project_env_var.",
        );
        expect(error.message).not.toMatch(/s3cret|HTTP 400/);
        expect(sent).toHaveLength(1);
      }
    const partial = {
      created: [{ id: "env_a", key: "FIRST", type: "sensitive", value: "stored-first-secret" }],
      failed: [{ error: { code: "ENV_CONFLICT", key: "SECOND", value: "stored-second-secret" } }],
    };
    sent = [];
    respond = () => Response.json(partial, { status: 201 });
    const raw = await call(connector, "vercel_api_write", {
      method: "POST",
      path: "/v10/projects/web/env",
      body: [body, { ...body, key: "SECOND" }],
    });
    expect(raw.status).toBe(201);
    expect(raw.data.created[0]).toMatchObject({ id: "env_a", key: "FIRST" });
    expect(raw.data.failed[0].error).toMatchObject({ code: "ENV_CONFLICT", key: "SECOND" });
    expect(JSON.stringify(raw)).not.toMatch(/stored-first-secret|stored-second-secret/);
    expect(sent).toHaveLength(1);
    sent = [];
    const namedPartial = await refusal(call(connector, "upsert_project_env_var", named));
    expect(namedPartial).toMatchObject({ code: "connector_call_failed", writeOutcome: "unknown", retryable: false });
    expect(namedPartial.message).toMatch(
      /sent key "TOKEN".*Created entries.*env_a.*Failed entries.*SECOND.*ENV_CONFLICT/,
    );
    expect(namedPartial.message).not.toMatch(/stored-first-secret|stored-second-secret|HTTP 400/);
    expect(sent).toHaveLength(1);
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.setAll("hosting", { value: "vercel-token" }, "fixture");
    const meta = createMetaTools(
      makeRegistry([connector], { storage, credentialVault: vault }),
      "https://connecta.example",
    );
    for (const array of [false, true]) {
      const created = { id: body.value, key: "FIRST", type: "sensitive", value: "stored-first-secret" };
      respond = () =>
        Response.json(
          {
            created: array ? [created] : created,
            failed: [
              {
                key: body.value,
                error: {
                  code: "ENV_CONFLICT",
                  message: `Stored value ${body.value} / stored-second-secret was refused`,
                  value: "stored-second-secret",
                },
              },
            ],
          },
          { status: 201 },
        );
      for (const fields of [undefined, ["created", "failed.error.message", "failed.error.code"]]) {
        sent = [];
        const raw = await meta.callDestructiveTool({
          address: "hosting.vercel_api_write",
          args: { method: "POST", path: "/v10/projects/web/env", body, ...(fields ? { fields } : {}) },
        });
        expect(raw.isError).not.toBe(true);
        expect(JSON.stringify(raw)).not.toMatch(/s3cret|Stored value|stored-second-secret|stored-first-secret/);
        expect(JSON.stringify(raw)).toContain("ENV_CONFLICT");
        expect(sent).toHaveLength(1);
      }
      sent = [];
      const namedEcho = await meta.callDestructiveTool({ address: "hosting.upsert_project_env_var", args: named });
      expect(namedEcho.structuredContent).toMatchObject({
        ok: false,
        error: { code: "connector_call_failed", writeOutcome: "unknown", retryable: false },
      });
      expect(JSON.stringify(namedEcho)).toContain("sent key");
      expect(JSON.stringify(namedEcho)).toContain("TOKEN");
      expect(JSON.stringify(namedEcho)).not.toMatch(/s3cret|stored-second-secret|stored-first-secret/);
      expect(sent).toHaveLength(1);
    }
    // A successful single-variable acknowledgement and raw batches register the same private value.
    for (const [tool, args] of [
      ["upsert_project_env_var", named],
      ["update_project_env_var", { projectId: "web", envVarId: "env_1", value: body.value }],
      ["vercel_api_write", { method: "POST", path: "/v10/projects/web/env", body: [body] }],
    ] as const) {
      sent = [];
      const variable = { id: body.value, key: body.value, type: "sensitive" };
      respond = () =>
        Response.json(tool === "update_project_env_var" ? variable : { created: [variable] }, { status: 201 });
      const echoed = await meta.callDestructiveTool({ address: `hosting.${tool}`, args });
      expect(echoed.isError).not.toBe(true);
      expect(JSON.stringify(echoed)).not.toContain(body.value);
      expect(JSON.stringify(echoed)).toContain("[redacted]");
      expect(sent).toHaveLength(1);
    }
    for (const method of ["POST", "PATCH", "DELETE"]) {
      for (const fields of [undefined, ["failed.error.message", "failed.error.code"]]) {
        sent = [];
        respond = () =>
          Response.json({
            created: [{ id: "env_safe", key: "TOKEN" }],
            failed: [{ error: { code: "ENV_CONFLICT", message: "stored-shared-env-secret" } }],
          });
        const shared = await meta.callDestructiveTool({
          address: "hosting.vercel_api_write",
          args: {
            method,
            path: "/v1/env",
            body:
              method === "POST"
                ? { evs: [{ key: "TOKEN", value: body.value }], type: "encrypted", target: ["preview"] }
                : method === "PATCH"
                  ? { updates: { env_1: { key: "TOKEN", value: body.value } } }
                  : { ids: ["env_1"] },
            ...(fields ? { fields } : {}),
          },
        });
        expect(shared.isError).not.toBe(true);
        expect(JSON.stringify(shared)).not.toContain("stored-shared-env-secret");
        expect(JSON.stringify(shared)).toContain("ENV_CONFLICT");
        expect(sent).toHaveLength(1);
      }
    }
    for (const [tool, args] of [
      ["upsert_project_env_var", named],
      ["vercel_api_write", { method: "POST", path: "/v10/projects/web/env", body }],
    ] as const) {
      sent = [];
      respond = () => Response.json({ ok: true }, { status: 201 });
      const missing = await refusal(call(connector, tool, args));
      expect(missing).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      expect(missing.message).toContain("check the target before repeating");
      expect(missing.message).not.toMatch(/handler failed|kit|in-band refusal/);
      expect(sent).toHaveLength(1);
    }
  });

  it.each([
    [201, false],
    [201, true],
    [400, false],
    [400, true],
    [500, false],
    [500, true],
  ] as const)(
    "INV-5 INV-9: withholds all project-create environment echoes at HTTP %s with fields=%s (#1032)",
    async (status, fields) => {
      const values = ["fixture-project-env-private-value", "qz"];
      const body = {
        name: "web",
        environmentVariables: values.map((value, index) => ({
          key: `VALUE_${index}`,
          value,
          type: "encrypted",
          target: ["preview"],
        })),
      };
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, btoa("k".repeat(32)));
      await vault.setAll("hosting", { value: "vercel-token" }, "fixture");
      const meta = createMetaTools(
        makeRegistry([vercel("hosting", TOKEN)], { storage, credentialVault: vault }),
        "https://connecta.example",
      );
      respond = () =>
        Response.json(
          status === 201
            ? {
                id: "prj_public",
                name: "web",
                env: [
                  { id: values[0], key: "VALUE_0", type: "encrypted", value: "stored-project-value" },
                  { id: "env_public", key: values[1], type: "encrypted", value: "stored-project-value" },
                ],
                commandForIgnoringBuildStep: `echo ${values[0]}`,
                [values[0]!]: "public metadata",
              }
            : { error: { code: "bad_request", message: `Rejected ${values.join(" / ")}`, [values[0]!]: values[1] } },
          { status },
        );
      const result = await meta.callDestructiveTool({
        address: "hosting.vercel_api_write",
        args: { method: "POST", path: "/v11/projects", body, ...(fields ? { fields: ["id", "name", "env"] } : {}) },
      });
      const serialized = JSON.stringify(result);
      for (const value of [...values, "stored-project-value"]) expect(serialized).not.toContain(value);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ method: "POST", body });
      if (status === 201) {
        expect(result.isError).not.toBe(true);
        for (const value of ["prj_public", "env_public", "VALUE_0", "encrypted", "[redacted]"])
          expect(serialized).toContain(value);
      } else {
        expect(result.structuredContent).toMatchObject({
          ok: false,
          error:
            status === 400
              ? { code: "invalid_args", retryable: false }
              : { code: "connector_call_failed", writeOutcome: "unknown", retryable: false },
        });
        if (status === 400) expect(result.structuredContent?.["error"]).not.toHaveProperty("writeOutcome");
      }
    },
  );

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
      truncated: [],
    });
    expect(sent[0]!.url.pathname).toBe("/v1/projects/web/deployments/dpl_1/runtime-logs");
    // The row limit stops a stream that stays open as soon as it is met, not at waitMs.
    const quick = Date.now();
    expect(
      await call(connector, "get_runtime_logs", {
        projectId: "web",
        deploymentId: "dpl_1",
        limit: 1,
        waitMs: 20_000,
        levels: ["error"],
      }),
    ).toEqual({
      logs: [{ timestampInMs: 2, level: "error", text: "TypeError: x is undefined", requestPath: "/api" }],
      stopped: "rows",
      truncated: ["logs[]"],
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

  it("INV-3 INV-4 INV-5 INV-9: routes selectors and confines fields, continuations and secret-bearing writes before dispatch", async () => {
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

    for (const [path, method, body] of [
      ["/v1/installations/icfg/products/product/resources/resource/secrets", "PUT", { secrets: [] }],
      ["/v1/deployments/dpl_1/checks", "POST", {}],
    ] as const) {
      const before = sent.length;
      await expect(call(connector, "vercel_api_write", { path, method, body })).rejects.toMatchObject({
        code: "invalid_args",
      });
      expect(sent).toHaveLength(before);
    }
    // All dispatch routes apply the same intentional team routing overrides.
    respond = () => Response.json({ projects: [], envs: [], pagination: { next: null } });
    for (const selectors of [{}, { teamId: "team_other" }, { teamId: null }, { slug: "studio" }]) {
      sent = [];
      await call(connector, "vercel_api_read", { path: "/v10/projects", query: selectors });
      await call(connector, "list_project_env_vars", { projectId: "web", ...selectors });
      await call(connector, "vercel_api_upload", {
        method: "POST",
        path: "/v2/files",
        textBody: "hello",
        query: selectors,
      });
      const expected =
        "teamId" in selectors && selectors.teamId === null
          ? ""
          : "slug" in selectors
            ? "slug=studio"
            : `teamId=${"teamId" in selectors ? selectors.teamId : "team_default"}`;
      for (const request of sent)
        expect(request.url.searchParams.toString().replace(/&?decrypt=false&?/, "")).toBe(expected);
    }
    // The signed cursor is bound to resolved default selectors, including config changes.
    const ctx = keyed("k7Q9w2E4r6T8y1U3");
    respond = () => Response.json({ deployments: [], pagination: { next: 123 } });
    const first = (await connector.callTool(
      "vercel_api_read",
      { path: "/v7/deployments", query: { limit: 10 } },
      ctx,
    )) as any;
    const changed = vercel("hosting", { ...TOKEN, teamId: "team_other" });
    const count = sent.length;
    await expect(
      changed.callTool(
        "vercel_api_read",
        { path: "/v7/deployments", query: { limit: 10, until: first.page.nextCursor } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(count);
    respond = () => Response.json({ deployments: [], pagination: { next: null } });
    await changed.callTool(
      "vercel_api_read",
      { path: "/v7/deployments", query: { limit: 10, teamId: "team_default", until: first.page.nextCursor } },
      ctx,
    );
    expect(sent.at(-1)!.url.searchParams.get("until")).toBe("123");
    const initialTime = await call(connector, "vercel_api_read", {
      path: "/v7/deployments",
      query: { until: 1700000000000 },
    });
    expect(initialTime.page.hasMore).toBe(false);
    expect(sent.at(-1)!.url.searchParams.get("until")).toBe("1700000000000");
    respond = () =>
      Response.json({
        deployments: [{ uid: "dpl_keep" }],
        pagination: { next: "https://untrusted.example/next?token=private" },
      });
    const unsafeNext = await call(connector, "vercel_api_read", { path: "/v7/deployments" });
    expect(unsafeNext.data.deployments).toEqual([{ uid: "dpl_keep" }]);
    expect(unsafeNext.page).toEqual({ hasMore: true, param: "until", in: "query" });
    respond = () => Response.json({ data: [], pagination: { next: "opaque:continuation" } });
    const labelPath = "/v1/projects/web/feature-flags/labels";
    const labelQuery = { entityKind: "user", attributeKey: "name" };
    const opaqueNext = (await connector.callTool(
      "vercel_api_read",
      { path: labelPath, query: labelQuery },
      ctx,
    )) as any;
    expect(opaqueNext.page.nextCursor).toEqual(expect.any(String));
    respond = () => Response.json({ data: [], pagination: { next: null } });
    await connector.callTool(
      "vercel_api_read",
      { path: labelPath, query: { ...labelQuery, cursor: opaqueNext.page.nextCursor } },
      ctx,
    );
    expect(sent.at(-1)!.url.searchParams.get("cursor")).toBe("opaque:continuation");
    const beforeBadCursor = sent.length;
    const badCursor = await refusal(
      call(connector, "vercel_api_read", { path: "/v7/deployments", query: { until: "abc" } }),
    );
    expect(badCursor.message).toContain("Pass the signed page.nextCursor unchanged");
    expect(sent).toHaveLength(beforeBadCursor);
    for (const limit of [-1, 0, 1.5, "abc"]) {
      const before = sent.length;
      await expect(
        call(connector, "vercel_api_read", { path: "/v7/deployments", query: { limit } }),
      ).rejects.toMatchObject({ code: "invalid_args" });
      expect(sent).toHaveLength(before);
    }
    for (const fields of [["does_not_exist"], ["value"]]) {
      const before = sent.length;
      await expect(call(connector, "list_project_env_vars", { projectId: "web", fields })).rejects.toMatchObject({
        code: "invalid_args",
      });
      await expect(
        call(connector, "vercel_api_write", {
          method: "PATCH",
          path: "/v9/projects/web",
          body: { framework: "nextjs" },
          fields,
        }),
      ).rejects.toMatchObject({ code: "invalid_args" });
      expect(sent).toHaveLength(before);
    }
    respond = () =>
      Response.json({
        apiKey: { id: "key_1", partialKey: "abc", metadata: { value: "stored-quota-secret" } },
        quota: { limitAmount: 10 },
      });
    const quota = await call(connector, "vercel_api_write", {
      method: "PATCH",
      path: "/api-keys/key_1/quota",
      body: { active: true },
      fields: ["apiKey", "quota"],
    });
    expect(JSON.stringify(quota)).not.toContain("stored-quota-secret");
    expect(quota.data.quota).toEqual({ limitAmount: 10 });
  });
});

describe("vercel() with a deployment team pin", () => {
  const realFetch = globalThis.fetch;
  let sent: Array<{ url: URL; method: string }>;
  let answer: () => Response;
  const call = (name: string, args: Record<string, unknown>) =>
    vercel("hosting", { ...TOKEN, teamId: "team_alice", pin: { teamId: "team_alice" } } as VercelTokenOptions).callTool(
      name,
      args,
      {
        ...connectorContext(),
        storage: memoryStorage(),
        credential: { get: async () => "vercel-test-token", getAll: async () => ({ value: "vercel-test-token" }) },
      },
    );

  beforeEach(() => {
    installOwnedTransport();
    sent = [];
    answer = () => Response.json({ ok: true });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: new URL(String(input)), method: init?.method ?? "GET" });
      return answer();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
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
    // A well-formed foreign project and one with no provable identity.
    for (const project of [{ id: "prj_bob", accountId: "team_bob" }, { accountId: "team_bob" }]) {
      sent = [];
      answer = () => Response.json(project);
      await expect(call("vercel_api_write", { method: "DELETE", path: "/v9/projects/prj_bob" })).rejects.toMatchObject({
        code: "provider_permission_denied",
      });
      expect(sent.map(({ method }) => method)).toEqual(["GET"]);
    }
  });
});
