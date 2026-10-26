import { upwardClassSmoke } from "./upward-classes.js";
import { hasAuthProgram } from "../../src/auth/native.js";
import { nativeToolName } from "../../src/native-tools.js";
import { Effect } from "effect";
import { createConnecta, customExecutor } from "../../src/index.js";
import { registerAuth } from "../../src/auth/native.js";
import { RequestScope, requestOwner } from "../../src/runtime/request-scope.js";
import { runEdge } from "../../src/runtime/run.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector, ConnectorContext, ToolDef } from "../../src/types.js";

export async function runUpwardBundleSmoke() {
  let nativeListings = 0, promiseListings = 0, decoratedListings = 0, writes = 0;
  const owners = new Set<object>();
  const definitions: Array<ToolDef & { description: string }> = [
    { name: "read", description: "Read the fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "write", description: "Write the fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  ];
  const connector: Connector = {
    id: "crm",
    listTools: async () => definitions,
    callTool: async (name) => {
      if (name === "write") writes++;
      return { answered: name };
    },
  };
  const nativeList = (ctx: ConnectorContext) => Effect.gen(function* () {
    const context = yield* Effect.serviceOption(RequestScope);
    if (context._tag !== "Some") throw new Error("Missing request Context");
    const owner = context.value;
    if (!owner.open || owner.identity !== ctx.requestScope) throw new Error("Wrong request Context");
    owners.add(owner);
    nativeListings++;
    return definitions;
  });
  const original = connector.listTools = (ctx) => { promiseListings++; return runEdge(nativeList(ctx).pipe(Effect.provideService(RequestScope, requestOwner(ctx.requestScope ?? ctx)))); };
  registerAuth(original, nativeList);
  const app = createConnecta({
    connectors: [connector], storage: memoryStorage(), readOnly: false, logger: "silent",
    executor: customExecutor({ execute: async () => ({ result: 42 }) }, { lifecycle: "self-managed" }),
  });
  const exchange = async (modern: boolean, address: string) => {
    const name = address === "skills" ? "skills" : address.endsWith("write") ? "call_destructive_tool" : "call_tool";
    const response = await app.fetch(new Request("https://connecta.test/mcp", {
      method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-06-18",
        ...(modern ? { "Mcp-Method": "tools/call", "Mcp-Name": name, ...(name === "skills" ? {} : { "Mcp-Param-Address": address }) } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: name === "skills" ? {} : { address, args: {}, resultMode: "value" }, ...(modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } }),
    }));
    const body = await response.json() as { result?: { isError?: boolean; structuredContent?: { data?: unknown; skills?: unknown[] } }; error?: unknown };
    if (response.status !== 200 || body.error || body.result?.isError) throw new Error("Upward exchange failed: " + JSON.stringify({ modern, address, status: response.status, body }));
    return name === "skills" ? (body.result?.structuredContent?.skills?.length ?? 0) > 0 : body.result?.structuredContent?.data;
  };
  try {
    const modern = await exchange(true, "crm.read"), legacy = await exchange(false, "crm.write");
    const nativePromiseListings = promiseListings;
    const skills = await exchange(true, "skills");
    connector.listTools = (...args) => { decoratedListings++; return original(...args); };
    await exchange(true, "crm.read");
    connector.listTools = original;
    await exchange(false, "crm.read");
    return { classes: await upwardClassSmoke(), modern, legacy, skills, registeredNames: hasAuthProgram(nativeToolName), nativePromiseListings, promiseListings, nativeListings, decoratedListings, writes, requestOwners: owners.size, allOwnersClosed: [...owners].every((owner) => !(owner as { open: boolean }).open) };
  } finally { await app.close(); }
}
