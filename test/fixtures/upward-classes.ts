import { Context, Effect } from "effect";
import { authInvoke, authMethod, hasAuthProgram, registerAuth } from "../../src/auth/native.js";
import { CatalogService, type CatalogSearchPage } from "../../src/catalog-service.js";
import { InvocationService, type InvocationOutcome } from "../../src/invocation.js";
import { Registry } from "../../src/registry.js";
import { requestOwner } from "../../src/runtime/request-scope.js";
import { runEdge } from "../../src/runtime/run.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector } from "../../src/types.js";

class CompositionProbe extends Context.Service<CompositionProbe, true>()("test/upward/CompositionProbe") {}

/** A Promise shell starts a new edge and loses this test-only ambient service. */
export async function upwardClassSmoke() {
  const report: Record<string, { catalog: boolean; invocation: boolean }> = {};
  for (const mode of ["base", "inherited", "decorated", "custom", "restored"] as const) {
    let catalogContext = false;
    const definitions = [{ name: "read", annotations: { readOnlyHint: true } }];
    const connector: Connector = {
      id: "probe",
      listTools: async () => definitions,
      callTool: async () => "reply",
    };
    registerAuth(connector.listTools, () => Effect.gen(function* () {
      catalogContext = (yield* Effect.serviceOption(CompositionProbe))._tag === "Some";
      return definitions;
    }));
    const registry = new Registry([connector], {
      storage: memoryStorage(), logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const Catalog = mode === "inherited" ? class extends CatalogService {} : CatalogService;
    const Invocation = mode === "inherited" ? class extends InvocationService {} : InvocationService;
    const catalog = new Catalog(registry, "https://connecta.test");
    const invocation = new Invocation(registry, catalog);
    const originalSearch = catalog.search;
    const originalInvoke = invocation.invoke;
    if (["decorated", "custom", "restored"].includes(mode)) {
      Object.assign(catalog, { search: (...args: unknown[]) => Reflect.apply(originalSearch, catalog, args) });
      Object.assign(invocation, { invoke: (...args: unknown[]) => Reflect.apply(originalInvoke, invocation, args) });
      if (mode === "custom") {
        Object.assign(catalog, { search: async (...args: unknown[]) => Reflect.apply(originalSearch, catalog, args) });
        Object.assign(invocation, { invoke: async (...args: unknown[]) => Reflect.apply(originalInvoke, invocation, args) });
      }
      if (mode === "restored") { catalog.search = originalSearch; invocation.invoke = originalInvoke; }
    }
    try {
      if (!hasAuthProgram(originalSearch) || !hasAuthProgram(originalInvoke)) throw new Error("Missing class registration");
      const page = await runEdge(authInvoke<CatalogSearchPage>(catalog, "search", [{ connector: "probe" }]).pipe(Effect.provideService(CompositionProbe, true)));
      if (page.entries.length !== 1) throw new Error("Incomplete native class catalog");
      const catalogNative = catalogContext;
      const result = await runEdge(authInvoke<InvocationOutcome<{ probe: boolean }>>(invocation, "invoke", ["probe.read", {}, {
        source: "call_tool",
        processResult: authMethod(() => Effect.map(Effect.serviceOption(CompositionProbe), (probe) => ({ probe: probe._tag === "Some" }))),
      }]).pipe(Effect.provideService(CompositionProbe, true)));
      if (!result.ok) throw new Error("Native class invocation refused");
      report[mode] = { catalog: catalogNative, invocation: result.value.probe };
    } finally { requestOwner(catalog.requestScope).close(); }
  }
  return report;
}
