import { expect, vi } from "vitest";
import { api } from "../../src/connectors/api.js";
import { CredentialVault } from "../../src/credentials.js";
import { infisical } from "../../src/providers/infisical/index.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Executor } from "../../src/types.js";
import { createTestConnecta, silentLogger } from "../helpers.js";
import { mcpRpc, readJsonRpc } from "./http.js";

const id = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";
const marker = 'r4-existing-secret-value/+"marker-8361927';
const projectName = "r5-careless-secret-value-9438267";
const target = { projectId: "project-1", environment: "prod", secretName: "API_KEY", secretPath: "/apps" };
const identifiers = {
  id, key: "API_KEY", environment: "prod", path: "/apps", type: "shared", version: 9,
  tags: ["web"], createdAt: "2026-10-08T12:00:00Z", updatedAt: "2026-10-08T12:00:00Z",
};
const secret = {
  id, secretKey: identifiers.key, secretValue: marker, environment: identifiers.environment,
  secretPath: identifiers.path, type: identifiers.type, version: identifiers.version,
  tags: [{ slug: "web" }], createdAt: identifiers.createdAt, updatedAt: identifiers.updatedAt,
};

type Case = { name: string; tool: string; args: Record<string, unknown>; response: unknown; expected: unknown; coreWithheld?: boolean; read?: boolean };
export const infisicalResultCases: Case[] = [];
infisicalResultCases.push({
  name: "list_projects default slug derived from a free-text name", tool: "list_projects", args: {},
  response: { projects: [{ id, name: projectName, slug: `${projectName}-abcd`, type: "secret-manager",
    environments: [{ id: approvalId, slug: "prod" }] }] },
  expected: { projects: [{ id, type: "secret-manager", environments: [{ id: approvalId, slug: "prod" }] }], metadataOmitted: true },
});
for (const kind of ["free text", "nested objects", "invalid identifiers", "wrong scalar types", "invalid container", "valid identifiers"] as const) {
  let responseSecret: Record<string, unknown> = { ...secret };
  let projected: Record<string, unknown> = { ...identifiers };
  if (kind === "free text") responseSecret = {
    ...responseSecret, secretComment: marker, secretReminderNote: marker,
    description: marker, tags: [{ slug: "web", name: marker }],
  };
  if (kind === "nested objects") {
    responseSecret = { ...responseSecret, id: { secretValue: marker }, secretComment: marker,
      environment: { secretValue: marker }, tags: [{ slug: { secretValue: marker } }, { slug: "web" }] };
    delete projected.id;
    delete projected.environment;
  }
  if (kind === "invalid identifiers") {
    responseSecret = { ...responseSecret, id: "a free form ID", secretKey: "KEY with spaces", environment: "prod\n",
      secretPath: "/apps/../private", type: "unknown", version: "9", tags: [{ slug: "a free form tag" }],
      createdAt: "yesterday", updatedAt: "2026-99-99T99:99:99Z" };
    projected = { tags: [] };
  }
  if (kind === "wrong scalar types") {
    responseSecret = { id: 42, secretKey: [marker], secretValue: marker, environment: false,
      secretPath: { secretValue: marker }, type: ["shared"], version: { secretValue: marker },
      tags: { slug: marker }, createdAt: 42, updatedAt: false };
    projected = { tags: [] };
  }
  const responseValue = kind === "invalid container" ? [marker] : responseSecret;
  if (kind === "invalid container") projected = { tags: [] };
  const omitted = kind === "valid identifiers" ? {} : { metadataOmitted: true };
  for (const [tool, args] of [
    ["create_secret", { ...target, secretValue: marker }],
    ["update_secret", { ...target, secretValue: marker }],
    ["update_secret", { ...target, secretComment: "Comment-only update" }],
    ["delete_secret", target],
  ] as const) infisicalResultCases.push({
    name: `${tool}${tool === "update_secret" && !("secretValue" in args) ? " comment-only" : ""} ${kind}`,
    tool, args, response: { secret: responseValue }, expected: { secret: projected, ...omitted },
  });
  const listArgs = { projectId: target.projectId, environment: target.environment };
  const nestedImport = kind === "nested objects";
  infisicalResultCases.push({
    name: `default list and imports ${kind}`, tool: "list_secrets", args: listArgs,
    response: { secrets: [responseValue], imports: [{
      environment: nestedImport ? { secretValue: marker } : "prod", secretPath: nestedImport ? { secretValue: marker } : "/shared", secrets: [responseValue],
    }] },
    expected: { secrets: [projected], imports: [{ ...(nestedImport ? {} : { environment: "prod" }),
      ...(nestedImport ? {} : { path: "/shared" }), secrets: [projected] }], ...omitted },
  });
}

for (const value of ["", "q", "1234567", "Production"]) infisicalResultCases.push({
  name: `create_secret keeps identifiers independent of value length ${value.length}`, tool: "create_secret",
  args: { ...target, secretValue: value }, response: { secret: { ...secret, secretValue: value, secretComment: value } },
  expected: { secret: identifiers, metadataOmitted: true }, coreWithheld: value.length < 8,
});

for (const tool of ["create_secret", "update_secret", "delete_secret", "create_folder"]) {
  const args = tool === "create_folder" ? { projectId: target.projectId, environment: "prod", name: "apps" }
    : tool === "delete_secret" ? target : { ...target, secretValue: marker };
  for (const kind of ["free text", "nested objects", "unknown status", "valid identifiers"] as const) {
    const approval = kind === "nested objects" ? { id: { secretValue: marker }, status: { secretValue: marker } }
      : { id: approvalId, status: kind === "unknown status" ? marker : "open",
        ...(kind === "free text" ? { commitMessage: marker, bypassReason: marker } : {}) };
    infisicalResultCases.push({
      name: `${tool} approval ${kind}`, tool, args, response: { approval, secret },
      expected: { pendingApproval: kind === "nested objects" ? {} : {
        id: approvalId, ...(kind === "unknown status" ? {} : { status: "open" }),
      }, ...(kind === "valid identifiers" ? {} : { metadataOmitted: true }) },
    });
  }
}
for (const tool of ["list_projects", "list_folders", "create_folder"]) {
  const project = tool === "list_projects";
  const fields = project ? { id, slug: "app", type: "secret-manager", name: marker, description: marker,
    environments: [{ id: approvalId, slug: "prod", name: marker }] }
    : { id, name: "apps", description: marker, secretReminderNote: marker, relativePath: "/apps" };
  const args = project ? {} : { projectId: target.projectId, environment: "prod", ...(tool === "create_folder" ? { name: "apps" } : {}) };
  infisicalResultCases.push({
    name: `${tool} free text`, tool, args,
    response: project ? { projects: [fields] } : tool === "list_folders" ? { folders: [fields] } : { folder: fields },
    expected: { ...(project ? { projects: [{ id, type: "secret-manager", environments: [{ id: approvalId, slug: "prod" }] }] }
      : tool === "list_folders" ? { folders: [{ id, path: "/apps" }] } : { folder: { id, path: "/apps" } }), metadataOmitted: true },
  });
}
for (const tool of ["get_secret", "list_secrets"]) infisicalResultCases.push({
  name: `${tool} explicit value and comment read`, tool, read: true,
  args: tool === "get_secret" ? target : { projectId: target.projectId, environment: "prod", includeValues: true },
  response: tool === "get_secret" ? { secret: { ...secret, secretComment: marker } }
    : { secrets: [{ ...secret, secretComment: marker }], imports: [{ environment: "prod", secretPath: "/shared", secrets: [{ ...secret, secretComment: marker }] }] },
  expected: tool === "get_secret" ? { secret: { ...identifiers, value: marker, comment: marker } }
    : { secrets: [{ ...identifiers, value: marker, comment: marker }], imports: [{ environment: "prod", path: "/shared", secrets: [{ ...identifiers, value: marker, comment: marker }] }] },
});

let clientCounter = 0;
async function setup(executor?: Executor, extraConnectors: ReturnType<typeof api>[] = [], trust: "trusted" | "read-only" = "trusted", hostCallTimeoutMs?: number) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  await vault.setAll("infisical", { clientId: `result-client-${++clientCounter}`, clientSecret: "synthetic-client-secret-12345" }, "operator");
  const connector = infisical("infisical", { purpose: "result security tests" });
  const deployment = createTestConnecta({
    storage, vault, connectors: [connector, ...extraConnectors], logger: silentLogger, trust,
    ...(hostCallTimeoutMs ? { execute: { hostCallTimeoutMs } } : {}),
    ...(executor ? { executor: { execute: executor.execute.bind(executor) } } : {}),
  });
  return { storage, connector, deployment };
}

/** Mocked operational HTTP only. The same matrix drives MCP and real QuickJS exits. */
export async function checkInfisicalResult(testCase: Case, executor?: Executor) {
  const { storage, connector, deployment } = await setup(executor);
  const dispatched: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (String(input).endsWith("/login")) return Response.json({ accessToken: "synthetic-access-token-12345", expiresIn: 3600 });
    dispatched.push(init!);
    return Response.json(testCase.response);
  }));
  try {
    if (executor) {
      const rpc = await readJsonRpc(await mcpRpc(deployment, "tools/call", {
        name: "execute_code", arguments: { code: `async () => {
          const result = await connecta.call("infisical.${testCase.tool}", ${JSON.stringify(testCase.args)});
          console.log(JSON.stringify(result));
          return result;
        }` },
      }));
      expect(rpc.result.isError, JSON.stringify(rpc.result)).toBeFalsy();
      const envelope = JSON.parse(rpc.result.content[0].text);
      const guestResult = { data: testCase.coreWithheld ? "[redacted]" : testCase.expected, format: testCase.coreWithheld ? "text" : "json" };
      expect(envelope.result).toEqual(guestResult);
      expect(JSON.parse(envelope.logs)).toEqual(guestResult);
      expect(rpc.result.structuredContent).toEqual(envelope);
      if (!testCase.read) {
        expect(JSON.stringify(rpc.result)).not.toContain(marker);
        expect(JSON.stringify(rpc.result)).not.toContain(projectName);
      }
    } else {
      const direct = await connector.callTool(testCase.tool, testCase.args, {
        baseUrl: "https://connecta.test", logger: silentLogger, storage,
        credential: { get: async () => null, getAll: async () => ({ clientId: "direct-result-client-12345", clientSecret: "synthetic-client-secret-12345" }) },
      });
      expect(direct).toEqual(testCase.expected);
      for (const resultMode of ["mcp", "value"] as const) {
        const rpc = await readJsonRpc(await mcpRpc(deployment, "tools/call", {
          name: /^(list|get)_/.test(testCase.tool) ? "call_tool" : "call_destructive_tool",
          arguments: { address: `infisical.${testCase.tool}`, args: testCase.args, resultMode },
        }));
        expect(rpc.result.isError).toBeFalsy();
        const parsed = JSON.parse(rpc.result.content[0].text);
        expect(resultMode === "value" ? parsed.data : parsed).toEqual(testCase.coreWithheld ? "[redacted]" : testCase.expected);
        if (resultMode === "value") expect(rpc.result.structuredContent).toEqual(parsed);
        if (!testCase.read) {
          expect(JSON.stringify(rpc.result)).not.toContain(marker);
          expect(JSON.stringify(rpc.result)).not.toContain(projectName);
        }
      }
    }
    expect(dispatched).toHaveLength(executor ? 1 : 3);
    for (const request of dispatched) if ("secretValue" in testCase.args)
      expect(JSON.parse(String(request.body)).secretValue).toBe(testCase.args.secretValue);
  } finally { await deployment.close(); }
}

const recoveryMarker = "r5-free-text-write-secret-9837261";
export const infisicalRecoveryCases = [
  { name: "create with value and comment", tool: "create_secret", args: { ...target, secretValue: recoveryMarker, secretComment: recoveryMarker }, publicArgs: target },
  { name: "update with value and comment", tool: "update_secret", args: { ...target, secretValue: recoveryMarker, secretComment: recoveryMarker }, publicArgs: target },
  { name: "comment-only update", tool: "update_secret", args: { ...target, secretComment: recoveryMarker }, publicArgs: target },
  { name: "folder create with description", tool: "create_folder", args: { projectId: target.projectId, environment: "prod", name: "apps", path: "/", description: recoveryMarker },
    publicArgs: { projectId: target.projectId, environment: "prod", name: "apps", path: "/" } },
];

/** Assert structural omission in refusals and uncertain writes, preserving dispatched inputs. */
export async function checkInfisicalRecovery(testCase: typeof infisicalRecoveryCases[number], executor?: Executor) {
  for (const failure of ["refusal", "timeout"] as const) {
    const witnessed: unknown[] = [];
    const witness = api("ordinary", { tools: [{
      name: "witness", description: "Record the caught recovery error.",
      inputSchema: { type: "object", properties: { error: { type: "object" } }, required: ["error"] },
      annotations: { readOnlyHint: true },
      handler: async (args: { error: unknown }) => { witnessed.push(args.error); return true; },
    }] });
    const { deployment } = await setup(executor, [witness], failure === "refusal" ? "read-only" : "trusted", 100);
    const dispatched: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/login")) return Response.json({ accessToken: "synthetic-access-token-12345", expiresIn: 3600 });
      dispatched.push(init!);
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }));
    const code = failure === "refusal" ? "destructive_tool_requires_approval" : "write_outcome_unknown";
    const check = (error: unknown) => {
      expect(error).toMatchObject({ code, ...(failure === "refusal"
        ? { nextAction: { arguments: { address: `infisical.${testCase.tool}`, args: testCase.publicArgs, argsRedacted: true } } }
        : { uncertainCall: { address: `infisical.${testCase.tool}`, args: testCase.publicArgs, argsRedacted: true }, retryable: false }) });
      const typed = error as { uncertainCall?: { args: unknown }; nextAction?: { arguments: { args: unknown } } };
      expect(typed.uncertainCall?.args ?? typed.nextAction?.arguments.args).toEqual(testCase.publicArgs);
      expect(JSON.stringify(error)).not.toContain(recoveryMarker);
    };
    try {
      if (executor) {
        for (const caught of [true, false]) {
          const before = dispatched.length;
          const call = `await connecta.call("infisical.${testCase.tool}", ${JSON.stringify(testCase.args)})`;
          const rpc = await readJsonRpc(await mcpRpc(deployment, "tools/call", {
            name: "execute_code", arguments: { code: caught ? `async () => {
              try { ${call}; } catch (error) { await connecta.call("ordinary.witness", { error: error.details }); return "caught"; }
            }` : `async () => ${call}` },
          }));
          const envelope = JSON.parse(rpc.result.content[0].text);
          expect(rpc.result.structuredContent).toEqual(envelope);
          if (caught) {
            expect(witnessed).toHaveLength(1);
            check(witnessed[0]);
          }
          if (!caught || failure === "timeout") {
            expect(rpc.result.isError).toBe(true);
            check(envelope.error);
          } else {
            expect(rpc.result.isError).toBeFalsy();
            expect(envelope.result).toBe("caught");
          }
          expect(JSON.stringify(rpc.result)).not.toContain(recoveryMarker);
          expect(dispatched.length - before).toBe(failure === "refusal" ? 0 : 1);
        }
      } else {
        for (const resultMode of ["mcp", "value"] as const) {
          const before = dispatched.length;
          const rpc = await readJsonRpc(await mcpRpc(deployment, "tools/call", {
            name: failure === "refusal" ? "call_tool" : "call_destructive_tool",
            arguments: { address: `infisical.${testCase.tool}`, args: testCase.args, timeoutMs: 100, resultMode },
          }));
          expect(rpc.result.isError).toBe(true);
          const envelope = JSON.parse(rpc.result.content[0].text);
          expect(rpc.result.structuredContent).toEqual(envelope);
          check(envelope.error);
          expect(JSON.stringify(rpc.result)).not.toContain(recoveryMarker);
          expect(dispatched.length - before).toBe(failure === "refusal" ? 0 : 1);
        }
      }
      expect(dispatched).toHaveLength(failure === "refusal" ? 0 : 2);
      for (const request of dispatched) {
        const expected = { ...testCase.args } as Record<string, unknown>;
        delete expected.secretName;
        expect(JSON.parse(String(request.body))).toEqual(expected);
      }
      expect(JSON.stringify(testCase.args)).toContain(recoveryMarker);
    } finally { await deployment.close(); }
  }
}

/** Submitted data must never become a credential that changes future arguments. */
export async function checkInfisicalSequence(executor?: Executor) {
  const received: unknown[] = [];
  const ordinary = api("ordinary", {
    tools: [{ name: "echo", description: "Echo a label.", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      annotations: { readOnlyHint: true }, handler: async (args: { label: string }) => { received.push(args); return args; } }],
  });
  const scripted: Executor = {
    // Portable host-call control; the Node suite also executes the actual code in QuickJS.
    async execute(_code, providers) {
      const call = providers[0]!.fns["call"]!;
      const first = await call("infisical.create_secret", { ...target, secretName: "A", secretValue: "Production" });
      const ordinary = await call("ordinary.echo", { label: "Production" });
      const second = await call("infisical.create_secret", { ...target, secretName: "B", secretValue: "Production" });
      return { result: { first, ordinary, second }, logs: [JSON.stringify(ordinary)] };
    },
  };
  const { deployment } = await setup(executor ?? scripted, [ordinary]);
  const writes: unknown[] = [];
  const keys: string[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (String(input).endsWith("/login")) return Response.json({ accessToken: "synthetic-access-token-12345", expiresIn: 3600 });
    writes.push(JSON.parse(String(init?.body)));
    keys.push(decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!));
    return Response.json({ secret: { id, secretKey: "API_KEY", secretValue: "Production" } });
  }));
  try {
    const rpc = await readJsonRpc(await mcpRpc(deployment, "tools/call", {
      name: "execute_code", arguments: { code: `async () => {
        const first = await connecta.call("infisical.create_secret", ${JSON.stringify({ ...target, secretName: "A", secretValue: "Production" })});
        const ordinary = await connecta.call("ordinary.echo", { label: "Production" });
        const second = await connecta.call("infisical.create_secret", ${JSON.stringify({ ...target, secretName: "B", secretValue: "Production" })});
        console.log(JSON.stringify(ordinary));
        return { first, ordinary, second };
      }` },
    }));
    expect(rpc.result.isError, JSON.stringify(rpc.result)).toBeFalsy();
    expect(received).toEqual([{ label: "Production" }]);
    expect(keys).toEqual(["A", "B"]);
    expect(writes).toEqual([1, 2].map(() => ({ projectId: target.projectId, environment: "prod", secretPath: "/apps", secretValue: "Production" })));
    const envelope = JSON.parse(rpc.result.content[0].text);
    expect(envelope.result.ordinary).toEqual({ data: { label: "[redacted]" }, format: "json" });
    expect(envelope.logs).toBe(JSON.stringify(envelope.result.ordinary));
    expect(rpc.result.structuredContent).toEqual(envelope);
  } finally { await deployment.close(); }
}
