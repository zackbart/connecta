import { expect, vi } from "vitest";
import { CredentialVault } from "../../src/credentials.js";
import { infisical } from "../../src/providers/infisical/index.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Executor } from "../../src/types.js";
import { createTestConnecta, silentLogger } from "../helpers.js";
import { mcpRpc, readJsonRpc } from "./http.js";

const ordinary = 'r3-private-argument/+"marker-1092837465';
const unicode = (value: string) => [...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const encodings = {
  raw: (value: string) => value,
  url: encodeURIComponent,
  "lowercase URL": (value: string) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
  "URI": encodeURI,
  form: (value: string) => new URLSearchParams({ value }).toString().slice(6),
  base64: btoa,
  base64url: (value: string) => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  "JSON escaped": (value: string) => JSON.stringify(value).slice(1, -1),
  "JSON Unicode": unicode,
  "twice JSON escaped": (value: string) => JSON.stringify(unicode(value)).slice(1, -1),
};

type Case = {
  name: string;
  value: string;
  kind: "echo" | "nested" | "wrong scalar types" | "invalid container" | "control";
  encode: (value: string) => string;
};
export const infisicalWriteCases: Case[] = [
  { name: "one-character value", value: "q", kind: "echo", encode: encodings.raw },
  ...Object.entries(encodings).filter(([name]) => name !== "raw").map(([name, encode]): Case => ({
    name: `${name} one-character echo`, value: "q", kind: "echo", encode,
  })),
  { name: "numeric short value", value: "9", kind: "echo", encode: encodings.raw },
  { name: "seven-character value", value: "1234567", kind: "echo", encode: encodings.raw },
  ...Object.entries(encodings).map(([name, encode]): Case => ({ name: `${name} echo`, value: ordinary, kind: "echo", encode })),
  { name: "nested object metadata", value: ordinary, kind: "nested", encode: encodings.raw },
  { name: "nested short-value metadata", value: "q", kind: "nested", encode: encodings.raw },
  { name: "unexpected scalar and tag types", value: ordinary, kind: "wrong scalar types", encode: encodings.raw },
  { name: "invalid metadata container", value: ordinary, kind: "invalid container", encode: encodings.raw },
  { name: "legitimate long-value metadata", value: ordinary, kind: "control", encode: encodings.raw },
  { name: "eight-character metadata control", value: "12345678", kind: "control", encode: encodings.raw },
  { name: "short-value benign text withheld", value: "q", kind: "control", encode: encodings.raw },
  { name: "empty-value benign text withheld", value: "", kind: "control", encode: encodings.raw },
];

function responseFor(testCase: Case, approval: boolean) {
  const { value, kind, encode } = testCase;
  const safe = {
    id: "id1", secretKey: "API_KEY", secretValue: value, secretComment: "Rotated by the application team",
    environment: "prod", secretPath: "/apps", type: "shared", version: 9,
    tags: [{ slug: "web" }], updatedAt: "2026-10-08T12:00:00Z",
  };
  if (kind === "invalid container") return approval ? { approval: [value] } : { secret: [value] };
  if (kind === "wrong scalar types") return approval ? { approval: { id: 42, status: false } } : {
    secret: { id: 42, secretKey: false, secretComment: [value], environment: 42, secretPath: 42,
      type: false, version: "9", updatedAt: 42, tags: { secretValue: value } },
  };
  if (kind === "nested") {
    const nested = { secretValue: value };
    return approval ? { approval: { id: [nested], status: nested } } : {
      secret: {
        id: nested, secretKey: [nested], secretComment: nested, environment: false, secretPath: [nested],
        type: nested, version: nested, updatedAt: nested,
        tags: [{ slug: nested }, { slug: [value] }, { slug: "web" }],
      },
    };
  }
  if (kind === "echo") {
    const echo = `before ${encode(value)} after`;
    return approval ? { approval: { id: echo, status: echo }, secret: safe } : {
      secret: {
        ...safe, id: echo, secretKey: echo, secretComment: echo, environment: echo, secretPath: echo,
        type: echo, tags: [{ slug: echo }], updatedAt: echo,
      },
    };
  }
  return approval ? { approval: { id: "a1", status: "open" }, secret: safe } : { secret: safe };
}

function expectedFor(testCase: Case, approval: boolean) {
  if (testCase.kind === "control" && testCase.value.length >= 8) return approval ? { pendingApproval: { id: "a1", status: "open" } } : {
    secret: {
      id: "id1", key: "API_KEY", comment: "Rotated by the application team", environment: "prod", path: "/apps",
      type: "shared", version: 9, tags: ["web"], updatedAt: "2026-10-08T12:00:00Z",
    },
  };
  return {
    ...(approval ? { pendingApproval: {} } : {
      secret: {
        ...((testCase.kind === "echo" || testCase.kind === "control") && testCase.value !== "9" ? { version: 9 } : {}),
        tags: testCase.kind === "nested" && testCase.value.length >= 8 ? ["web"] : [],
      },
    }),
    metadataOmitted: true,
  };
}

let clientCounter = 0;
/** Mocked operational HTTP only. The same matrix drives MCP and real QuickJS exits. */
export async function checkInfisicalWriteResult(testCase: Case, tool: string, approval: boolean, executor?: Executor) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  await vault.setAll("infisical", { clientId: `result-client-${++clientCounter}`, clientSecret: "synthetic-client-secret-12345" }, "operator");
  const connector = infisical("infisical", { purpose: "write result security tests" });
  const args = { projectId: "project-1", environment: "prod", secretName: "API_KEY", secretPath: "/apps", secretValue: testCase.value };
  const expected = expectedFor(testCase, approval);
  const dispatched: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (String(input).endsWith("/login")) return Response.json({ accessToken: "synthetic-access-token-12345", expiresIn: 3600 });
    dispatched.push(init!);
    return Response.json(responseFor(testCase, approval));
  }));
  const deployment = createTestConnecta({
    storage, vault, connectors: [connector], logger: silentLogger, trust: "trusted",
    ...(executor ? { executor: { execute: executor.execute.bind(executor) } } : {}),
  });
  try {
    if (executor) {
      const rpc = await readJsonRpc(await mcpRpc(deployment, "tools/call", {
        name: "execute_code",
        arguments: {
          code: `async () => {
            const result = await connecta.call("infisical.${tool}", ${JSON.stringify(args)});
            console.log(JSON.stringify(result));
            return result;
          }`,
        },
      }));
      expect(rpc.result.isError, JSON.stringify(rpc.result)).toBeFalsy();
      const envelope = JSON.parse(rpc.result.content[0].text);
      const guestResult = { data: expected, format: "json" };
      expect(envelope.result).toEqual(guestResult);
      expect(envelope.logs).toBe(JSON.stringify(guestResult));
      expect(rpc.result.structuredContent).toEqual(envelope);
    } else {
      // Pin the provider itself before the request-level redactor can mask a bad projection.
      const direct = await connector.callTool(tool, args, {
        baseUrl: "https://connecta.test", logger: silentLogger, storage,
        credential: { get: async () => null, getAll: async () => ({ clientId: "direct-result-client-12345", clientSecret: "synthetic-client-secret-12345" }) },
      });
      expect(direct).toEqual(expected);
      for (const resultMode of ["mcp", "value"] as const) {
        const rpc = await readJsonRpc(await mcpRpc(deployment, "tools/call", {
          name: "call_destructive_tool", arguments: { address: `infisical.${tool}`, args, resultMode },
        }));
        expect(rpc.result.isError).toBeFalsy();
        const parsed = JSON.parse(rpc.result.content[0].text);
        expect(resultMode === "value" ? parsed.data : parsed).toEqual(expected);
        if (resultMode === "value") expect(rpc.result.structuredContent).toEqual(parsed);
      }
    }
    expect(dispatched).toHaveLength(executor ? 1 : 3);
    for (const request of dispatched) {
      expect(request.method).toBe(tool === "create_secret" ? "POST" : "PATCH");
      expect(JSON.parse(String(request.body)).secretValue).toBe(testCase.value);
    }
  } finally {
    await deployment.close();
  }
}
