import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialVault } from "../../credentials.js";
import { CatalogService } from "../../catalog-service.js";
import { InvocationService } from "../../invocation.js";
import { memoryStorage } from "../../storage/memory.js";
import { createTestConnecta, makeRegistry, silentLogger } from "../../../test/helpers.js";
import { mcpRpc, readJsonRpc } from "../../../test/fixtures/http.js";
import { infisical } from "./index.js";

const BASE = "https://connecta.test";
let clientCounter = 0;
const target = { projectId: "project-1", environment: "prod", secretName: "API_KEY", secretPath: "/apps" };

function json(body: unknown) {
  return Response.json(body);
}
function login() {
  return json({ accessToken: "access-token-12345", expiresIn: 3600 });
}
async function setup(padded = false) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  const credentials = { clientId: `security-client-${++clientCounter}`, clientSecret: 'client-secret/+"12345' };
  await vault.setAll(
    "infisical",
    Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, padded ? `  ${value}  ` : value])),
    "operator",
  );
  const connector = infisical("infisical", { purpose: "security tests" });
  const registry = makeRegistry([connector], { storage, credentialVault: vault });
  return { storage, vault, connector, registry, credentials };
}
function invocation(registry: Awaited<ReturnType<typeof setup>>["registry"]) {
  // A fresh upstream request must track the credentials even on token-cache hits.
  return new InvocationService(registry, new CatalogService(registry, BASE));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Infisical security boundaries", () => {
  const writes = [
    ["create_secret", "POST", { ...target, secretValue: "submitted-value-12345" }],
    ["update_secret", "PATCH", { ...target, secretValue: "submitted-value-12345" }],
    ["delete_secret", "DELETE", target],
    [
      "create_folder",
      "POST",
      { projectId: target.projectId, environment: target.environment, name: "apps", path: "/" },
    ],
  ] as const;
  for (const source of ["call_destructive_tool", "execute_code"] as const) {
    it.each(writes)(
      `requires an explicit counted retry of %s after 401 through ${source} (INV-9)`,
      async (tool, method, args) => {
        const { registry } = await setup();
        let logins = 0;
        const dispatched: RequestInit[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof globalThis.fetch>(async (input, init) => {
            if (String(input).endsWith("/login"))
              return json({ accessToken: `auth-token-${++logins}`, expiresIn: 3600 });
            dispatched.push(init!);
            return dispatched.length === 1
              ? Response.json({ message: "private-upstream-body" }, { status: 401 })
              : json({});
          }),
        );
        const outcome = await invocation(registry).invoke(`infisical.${tool}`, args, { source, trust: "trusted" });
        expect(outcome).toMatchObject({
          ok: false,
          dispatched: true,
          attempts: 1,
          error: { code: "auth_required", retryable: false, reconciliationRequired: true },
        });
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]!.method).toBe(method);
        expect(logins).toBe(2);
        expect(JSON.stringify(outcome)).not.toContain("private-upstream-body");
        const explicit = await invocation(registry).invoke(`infisical.${tool}`, args, { source, trust: "trusted" });
        expect(explicit).toMatchObject({ ok: true, dispatched: true, attempts: 1 });
        expect(dispatched).toHaveLength(2);
        expect(new Headers(dispatched[1]!.headers).get("authorization")).toBe("Bearer auth-token-2");
        expect(logins).toBe(2);
      },
    );
  }
  it.each(writes)("refreshes an expiring cached token before dispatching %s (INV-9)", async (tool, _method, args) => {
    const { registry } = await setup();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let logins = 0;
    const dispatched: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) => {
        if (String(input).endsWith("/login")) return json({ accessToken: `expiry-token-${++logins}`, expiresIn: 10 });
        if (init?.method === "GET") return json({ projects: [] });
        dispatched.push(init!);
        return json({});
      }),
    );
    await invocation(registry).invoke("infisical.list_projects", {}, { source: "call_tool" });
    now += 9000; // Ten-second TTL with the existing ten-percent refresh margin.
    const result = await invocation(registry).invoke(`infisical.${tool}`, args, { source: "call_destructive_tool" });
    expect(result).toMatchObject({ ok: true, attempts: 1, dispatched: true });
    expect(logins).toBe(2);
    expect(dispatched).toHaveLength(1);
    expect(new Headers(dispatched[0]!.headers).get("authorization")).toBe("Bearer expiry-token-2");
  });
  for (const failure of ["network", "timeout"] as const) {
    it.each(writes)(`dispatches %s once on ${failure} and counts one attempt (INV-9)`, async (tool, _method, args) => {
      const { registry } = await setup();
      let operational = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof globalThis.fetch>(async (input, init) => {
          if (String(input).endsWith("/login")) return login();
          operational++;
          if (failure === "network") throw new TypeError("Synthetic connection lost");
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init!.signal!;
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }),
      );
      const outcome = await invocation(registry).invoke(`infisical.${tool}`, args, {
        source: "call_destructive_tool",
        timeoutMs: 100,
      });
      expect(outcome).toMatchObject({
        ok: false,
        dispatched: true,
        attempts: 1,
        error: { code: failure === "network" ? "unavailable" : "write_outcome_unknown" },
      });
      expect(operational).toBe(1);
    });
  }
  const encodings = {
    raw: (value: string) => value,
    url: encodeURIComponent,
    base64: btoa,
    base64url: (value: string) => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    json: (value: string) =>
      [...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  };
  for (const source of ["call_tool", "execute_code"] as const) {
    for (const padded of [false, true]) {
      it.each(Object.entries(encodings))(
        `redacts normalized credential %s echoes through ${source}, padded=${padded}, on login and cache hits (INV-5)`,
        async (_name, encode) => {
          const { registry, credentials } = await setup(padded);
          const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
            String(input).endsWith("/login")
              ? login()
              : json({
                  projects: [
                    { id: "p1", name: `${encode(credentials.clientId)} / ${encode(credentials.clientSecret)}` },
                  ],
                }),
          );
          vi.stubGlobal("fetch", fetch);
          for (let call = 0; call < 2; call++) {
            const outcome = await invocation(registry).invoke("infisical.list_projects", {}, { source });
            expect(outcome).toMatchObject({
              ok: true,
              value: { projects: [{ id: "p1", name: "[redacted] / [redacted]", environments: [] }] },
            });
          }
          const logins = fetch.mock.calls.filter(([input]) => String(input).endsWith("/login"));
          expect(logins).toHaveLength(1);
          expect(JSON.parse(String(logins[0]![1]?.body))).toEqual(credentials);
        },
      );
    }
  }

  const values = [
    ["short", "q"],
    ["ordinary", "submitted-secret-value-12345"],
    ["over-budget", "large-secret-value-".repeat(100)],
  ];
  for (const tool of ["create_secret", "update_secret"]) {
    it.each(values)(
      `omits %s values from ${tool} registry refusals and write uncertainty (INV-5, INV-9)`,
      async (_label, secretValue) => {
        const { registry } = await setup();
        const args = { ...target, secretValue };
        let writes = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
          if (String(input).endsWith("/login")) return login();
          writes++;
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init!.signal!;
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        });
        vi.stubGlobal("fetch", fetch);
        for (const source of ["call_tool", "execute_code"] as const) {
          const refusal = await invocation(registry).invoke(`infisical.${tool}`, args, { source, trust: "read-only" });
          expect(refusal).toMatchObject({
            ok: false,
            dispatched: false,
            error: {
              code: "destructive_tool_requires_approval",
              nextAction: { arguments: { args: target, argsRedacted: true } },
            },
          });
          if (refusal.ok) throw new Error("Expected refusal");
          const action = refusal.error.nextAction;
          if (!action || !("tool" in action) || action.tool !== "call_destructive_tool")
            throw new Error("Expected destructive-call recovery");
          expect(action.purpose).toContain("original arguments");
          expect(action.arguments["args"]).not.toHaveProperty("secretValue");
        }
        expect(fetch).not.toHaveBeenCalled();
        for (const source of ["call_destructive_tool", "execute_code"] as const) {
          const outcome = await invocation(registry).invoke(`infisical.${tool}`, args, {
            source,
            trust: "trusted",
            timeoutMs: 100,
          });
          expect(outcome).toMatchObject({
            ok: false,
            dispatched: true,
            error: {
              code: "write_outcome_unknown",
              retryable: false,
              uncertainCall: { address: `infisical.${tool}`, args: target, argsRedacted: true },
            },
          });
          if (outcome.ok) throw new Error("Expected timeout");
          expect(outcome.error.uncertainCall?.args).not.toHaveProperty("secretValue");
          expect(outcome.error.retry).toContain("Sensitive fields are omitted");
        }
        expect(writes).toBe(2);
        expect(args.secretValue).toBe(secretValue);
        const body = JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body));
        expect(body.secretValue).toBe(secretValue);
      },
    );

    it.each(values)(
      `omits %s values from ${tool} MCP text and structured exits (INV-5, INV-9)`,
      async (_label, secretValue) => {
        const { storage, vault, connector } = await setup();
        let writes = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
          if (String(input).endsWith("/login")) return login();
          writes++;
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init!.signal!;
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        });
        vi.stubGlobal("fetch", fetch);
        const deployment = createTestConnecta({ storage, vault, connectors: [connector], logger: silentLogger });
        try {
          for (const name of ["call_tool", "call_destructive_tool"]) {
            const rpc = await readJsonRpc(
              await mcpRpc(deployment, "tools/call", {
                name,
                arguments: { address: `infisical.${tool}`, args: { ...target, secretValue }, timeoutMs: 100 },
              }),
            );
            expect(rpc.result.isError).toBe(true);
            const result = rpc.result;
            expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
            const error = result.structuredContent.error;
            expect(error.code).toBe(
              name === "call_tool" ? "destructive_tool_requires_approval" : "write_outcome_unknown",
            );
            const echoed = error.uncertainCall ?? error.nextAction.arguments;
            expect(echoed).toMatchObject({ args: target, argsRedacted: true });
            expect(echoed.args).not.toHaveProperty("secretValue");
            if (secretValue.length >= 8) expect(JSON.stringify(result)).not.toContain(secretValue);
          }
          expect(writes).toBe(1);
        } finally {
          await deployment.close();
        }
      },
    );
  }

  it.each([
    ["marker-secret-12345", "absolute URL"],
    ["https://[marker-secret-12345]/api", "absolute URL"],
    ["http://operator:marker-secret-12345@secrets.example/api", "to be https"],
    ["ftp://secrets.example/api?secret=marker-secret-12345", "to be https"],
    ["https://operator:marker-secret-12345@secrets.example/api", "URL credentials"],
    ["https://secrets.example/api?secret=marker-secret-12345", "query or fragment"],
    ["https://secrets.example/api#marker-secret-12345", "query or fragment"],
  ])("rejects secret-bearing baseUrl %s without printing its value (INV-5, INV-11)", (baseUrl, rule) => {
    expect(() => infisical("infisical", { purpose: "security tests", baseUrl })).toThrow(rule);
    try {
      infisical("infisical", { purpose: "security tests", baseUrl });
    } catch (error) {
      expect(String(error)).toContain("baseUrl");
      expect(String(error)).not.toContain("marker-secret-12345");
    }
  });
});
