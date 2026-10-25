import { Context, Effect } from "effect";
import { hasAuthProgram, authCall, authInvoke, authMethod } from "../../src/auth/native.js";
import { catalogClientOptions } from "../../src/catalog-cache.js";
import { remoteMcp } from "../../src/connectors/remote-mcp.js";
import { readNegotiation } from "../../src/connectors/negotiation-cache.js";
import { callEntry } from "../../src/runtime/call-entry.js";
import { callFromContext, contextView, openRequest, viewServices } from "../../src/runtime/call.js";
import { registerNativeStorage } from "../../src/runtime/native-storage.js";
import { RequestScope, requestOwner } from "../../src/runtime/request-scope.js";
import { runEdge } from "../../src/runtime/run.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector, ConnectorContext, KVStorage } from "../../src/types.js";
import { httpDownstream } from "./downstream-mcp.js";

export async function runRemoteBundleSmoke() {
  const request = {}, backing = memoryStorage();
  let promiseStorageCalls = 0, nativeStorageReads = 0, canonicalRequestScope = true, calls = 0;
  const refused = () => { promiseStorageCalls++; throw new Error("Promise storage shell entered"); };
  const storage: KVStorage = { capabilities: backing.capabilities, get: refused, set: refused, delete: refused, list: refused, compareAndSet: refused };
  registerNativeStorage(storage, {
    get: (key) => Effect.gen(function* () { nativeStorageReads++; const scope = yield* Effect.serviceOption(RequestScope);
        canonicalRequestScope &&= scope._tag === "Some" && scope.value === requestOwner(request); return yield* Effect.tryPromise({ try: () => backing.get(key), catch: (error) => error }); }),
    set: (key, value, options) => Effect.tryPromise({ try: () => backing.set(key, value, options), catch: (error) => error }),
    delete: (key) => Effect.tryPromise({ try: () => backing.delete(key), catch: (error) => error }),
    list: (key) => Effect.tryPromise({ try: () => backing.list(key), catch: (error) => error }),
    compareAndSet: (key, expected, next, options) => Effect.tryPromise({ try: () => backing.compareAndSet(key, expected, next, options), catch: (error) => error }),
  });
  const downstream = httpDownstream((server) => { server.registerTool("read", { annotations: { readOnlyHint: true } }, async () => { calls++; return { content: [{ type: "text", text: "read" }] }; }); });
  const connector = remoteMcp("crm", { url: downstream.url, _transportFactory: downstream.transport });
  const ctx: ConnectorContext = { storage, logger: { debug() {}, info() {}, warn() {}, error() {} }, baseUrl: "https://connecta.test", requestScope: request };
  const lease = callFromContext(ctx, "read", { admitted: true });
  const view = contextView(lease, ctx), services = viewServices(view);
  const saved = connector.callTool, entry = callEntry(connector, saved);
  if (!entry) throw new Error("Missing native remote entry after minification");
  try {
    await runEdge(entry("read", {}, { definition: { name: "read", annotations: { readOnlyHint: true } } }).pipe(Effect.provideContext(services)));
    let decorators = 0;
    connector.callTool = (...args) => { decorators++; return saved(...args); };
    if (callEntry(connector, connector.callTool)) throw new Error("Decorator inherited native proof");
    await connector.callTool("read", {}, view);
    const inherited = Object.create(connector) as Connector;
    inherited.callTool = (...args) => { decorators++; return saved(...args); };
    await inherited.callTool("read", {}, view);
    const custom = async () => "custom";
    connector.callTool = custom;
    if (callEntry(connector, custom)) throw new Error("Replacement inherited native proof");
    const customResult = await runEdge(authCall(custom, []));
    await runEdge(Effect.gen(function* () {
      const cache = yield* authCall<Awaited<ReturnType<typeof catalogClientOptions>>>(catalogClientOptions, [view, "crm", "fixture", "grant"]);
      yield* authInvoke(cache, "withListing", [view, authMethod(() => authCall(readNegotiation, [view, "fixture"]))]);
    }).pipe(Effect.provideContext(services)));
    const registered = hasAuthProgram(readNegotiation) && hasAuthProgram(catalogClientOptions);
    const owner = Context.get(services, RequestScope);
    owner.close();
    let closedOwnerRefused = false;
    try { await saved("read", {}, view); } catch { closedOwnerRefused = true; }
    return { registered, canonicalRequestScope, nativeStorageReads, promiseStorageCalls, calls, decorators, customResult, closedOwnerRefused };
  } finally { lease.close(); openRequest(request).close(); }
}
