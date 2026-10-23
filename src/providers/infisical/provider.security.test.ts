import { configureGuardedTransport } from "../../guarded-transport.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { CredentialVault } from "../../credentials.js";
import { CatalogService } from "../../catalog-service.js";
import { InvocationService } from "../../invocation.js";
import { memoryStorage } from "../../storage/memory.js";
import { createTestConnecta, makeRegistry, silentLogger } from "../../../test/helpers.js";
import { mcpRpc, readJsonRpc } from "../../../test/fixtures/http.js";
import { infisical } from "./index.js";
import {
  checkInfisicalResult,
  checkInfisicalRecovery,
  checkInfisicalSequence,
  infisicalRecoveryCases,
  infisicalResultCases,
} from "../../../test/fixtures/infisical-write-results.js";

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

// One case per projection branch the fixture matrix exercises; the full
// matrix repeats each branch across every write tool.
const RESULT_CASES = new Set([
  "list_projects default slug derived from a free-text name",
  "create_secret free text",
  "create_secret nested objects",
  "create_secret invalid identifiers",
  "create_secret wrong scalar types",
  "create_secret invalid container",
  "update_secret comment-only free text",
  "default list and imports nested objects",
  "create_secret keeps identifiers independent of value length 1",
  "create_secret keeps its UUID after a successful 32 KiB private write",
  "create_folder keeps its UUID with a short private description",
  "update_secret keeps pending approval when clearing an empty comment",
  "create_secret approval nested objects",
  "create_secret approval unknown status",
  "list_folders free text",
  "get_secret explicit value and comment read",
  "list_secrets explicit value and comment read",
]);

beforeEach(() => {
  configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
});

afterEach(() => {
  configureGuardedTransport(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Infisical security boundaries", () => {
  it.each(infisicalRecoveryCases.filter((testCase) => testCase.name !== "update with value and comment"))(
    "omits free text from $name MCP refusals and dispatched timeouts in both result modes (INV-5, INV-9)",
    async (testCase) => {
      await checkInfisicalRecovery(testCase);
    },
  );
  it.each(infisicalResultCases.filter((testCase) => RESULT_CASES.has(testCase.name)))(
    "projects identifiers or explicitly reads values for $name in provider and MCP exits (INV-5)",
    async (testCase) => {
      await checkInfisicalResult(testCase);
    },
  );
  it("preserves subsequent ordinary arguments and repeated write values in one program (INV-5)", async () => {
    await checkInfisicalSequence();
  });
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
  it.each([writes[0]])(
    "refreshes an expiring cached token before dispatching %s (INV-9)",
    async (tool, _method, args) => {
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
    },
  );
  const encodings = {
    raw: (value: string) => value,
    url: encodeURIComponent,
    base64: btoa,
    json: (value: string) =>
      [...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  };
  it.each([
    ["raw", "call_tool", false],
    ["base64", "call_tool", true],
    ["url", "execute_code", false],
    ["json", "execute_code", true],
  ] as const)(
    "redacts normalized credential %s echoes through %s, padded=%s, on login and cache hits (INV-5)",
    async (name, source, padded) => {
      const encode = encodings[name];
      const { connector, storage, vault, credentials } = await setup(padded);
      // Echo after provider projection so structural omission cannot mask a
      // broken credential registration. This wrapper is only a test probe.
      const registry = makeRegistry(
        [
          {
            ...connector,
            callTool: async (tool, args, ctx) => ({
              ...((await connector.callTool(tool, args, ctx)) as Record<string, unknown>),
              credentialEcho: `${encode(credentials.clientId)} / ${encode(credentials.clientSecret)}`,
            }),
          },
        ],
        { storage, credentialVault: vault },
      );
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
        String(input).endsWith("/login")
          ? login()
          : json({
              projects: [{ id: "p1", name: `${encode(credentials.clientId)} / ${encode(credentials.clientSecret)}` }],
            }),
      );
      vi.stubGlobal("fetch", fetch);
      for (let call = 0; call < 2; call++) {
        const outcome = await invocation(registry).invoke("infisical.list_projects", {}, { source });
        expect(outcome).toMatchObject({
          ok: true,
          value: {
            projects: [{ environments: [] }],
            metadataOmitted: true,
            // Padded vault values are registered as read, so a literal space beside an echo
            // can be part of the match.
            credentialEcho: expect.stringMatching(
              padded ? /^\[redacted\] ?\/ ?\[redacted\]$/ : /^\[redacted\] \/ \[redacted\]$/,
            ),
          },
        });
      }
      const logins = fetch.mock.calls.filter(([input]) => String(input).endsWith("/login"));
      expect(logins).toHaveLength(1);
      expect(JSON.parse(String(logins[0]![1]?.body))).toEqual(credentials);
    },
  );

  const values = [
    ["short", "q"],
    ["over-budget", "large-secret-value-".repeat(100)],
  ];
  for (const tool of ["create_secret"]) {
    it.each(values)(
      `omits %s values from ${tool} MCP text and structured exits (INV-5, INV-9)`,
      async (_label, secretValue) => {
        const { storage, vault, connector } = await setup();
        let writes = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
          if (String(input).endsWith("/login")) return login();
          writes++;
          // Inject the lost reply after dispatch; setup must not race a
          // 100 ms request deadline in these accounting/redaction cases.
          throw new DOMException("Downstream reply timed out", "TimeoutError");
        });
        vi.stubGlobal("fetch", fetch);
        const deployment = createTestConnecta({ storage, vault, connectors: [connector], logger: silentLogger });
        try {
          for (const name of ["call_tool", "call_destructive_tool"]) {
            const rpc = await readJsonRpc(
              await mcpRpc(deployment, "tools/call", {
                name,
                arguments: { address: `infisical.${tool}`, args: { ...target, secretValue }, timeoutMs: 30_000 },
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
    ["http://operator:marker-secret-12345@secrets.example/api", "to be https"],
    ["https://operator:marker-secret-12345@secrets.example/api", "URL credentials"],
    ["https://secrets.example/api?secret=marker-secret-12345", "query or fragment"],
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
