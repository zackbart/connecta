import { describe, expect, it } from "vitest";
import { CatalogService, flatSearchResult, type CatalogSearchArgs } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import type { RegistryView } from "../src/registry.js";
import type { Connector, ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, textOf, type SearchResult } from "./fixtures/meta-tools.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

function service(id: string, tools: ToolDef[], title?: string): Connector {
  return connectorWith({ id, ...(title ? { title } : {}), tools });
}

async function searchBoth(registry: RegistryView, args: CatalogSearchArgs) {
  const top = textOf(await createMetaTools(registry, BASE).searchTools(args)) as SearchResult;
  const providers = await buildSandboxProviders(registry, BASE, silentLogger);
  const guest = required(providers.find((provider) => provider.name === "connecta"));
  const program = await required(guest.fns.search)(args) as SearchResult;
  expect(program).toEqual(top);
  expect(top).not.toHaveProperty("connectors");
  expect(Object.keys(top)[0]).toBe("catalogErrors");
  return top;
}

describe("Phase 2 discovery usage-history regressions (#706, #703)", () => {
  it.each(["json", "compact", "typescript"] as const)("returns one flat page from both search paths with %s schemas", async (includeSchemas) => {
    const registry = makeRegistry([
      service("linear", [{ name: "get_issue", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }], "Linear Work"),
      service("mixpanel", [{ name: "get_report" }], "Mixpanel Production"),
    ]);
    const first = await searchBoth(registry, { limit: 1, includeSchemas });
    expect(first).toMatchObject({ catalogErrors: [], total: 2, offset: 0, limit: 1, hasMore: true, nextOffset: 1 });
    expect(first.tools[0]).toMatchObject({ address: "linear.get_issue", connectorTitle: "Linear Work", schemaFormat: includeSchemas === "json" ? "json" : "text" });
    const last = await searchBoth(registry, { limit: 1, offset: required(first.nextOffset), includeSchemas });
    expect(last).toMatchObject({ total: 2, hasMore: false });
    expect(last.tools[0]).toMatchObject({ address: "mixpanel.get_report" });
  });

  it.each(["get_issue", "get issue", "please get_issue for the current project"])("ranks get_issue above get_issue_status for %s", async (query) => {
    const registry = makeRegistry([service("linear", [
      { name: "get_issue_status", description: "Get issue status for the current project, issue details and issue metadata" },
      { name: "get_issue", description: "Read one ticket" },
      { name: "list_issues", description: "Get issue details for the current project" },
    ])]);
    const page = await searchBoth(registry, { query, limit: 1, includeSchemas: "json" });
    expect(page.tools[0]?.address).toBe("linear.get_issue");
  });

  it("ranks a whole tool name or canonical address above its shorter name phrase", async () => {
    const registry = makeRegistry([service("linear", [
      { name: "get_issue", description: "Get issue status and get issue status details" },
      { name: "get_issue_status" },
    ])]);
    for (const query of ["get_issue_status", "linear.get_issue_status"]) {
      const page = await searchBoth(registry, { query, limit: 1, includeSchemas: "json" });
      expect(page.tools[0]?.address).toBe("linear.get_issue_status");
    }
  });

  it("ranks exact connector IDs and titles above cross-service description matches", async () => {
    const registry = makeRegistry([
      service("linear-preview", [{ name: "get_issue" }], "Linear Preview"),
      service("metrics", [{ name: "get_issue", description: "Linear get issue integration details and status" }]),
      service("linear", [{ name: "get_issue_status" }, { name: "get_issue" }], "Linear Production"),
    ]);
    for (const query of ["linear get_issue", "Linear Production get_issue"]) {
      const page = await searchBoth(registry, { query, limit: 1, includeSchemas: "json" });
      expect(page.tools[0]?.address).toBe("linear.get_issue");
    }
    const browse = await searchBoth(registry, { query: "Linear Production", includeSchemas: "json" });
    expect(browse.tools.map((tool) => tool.address)).toEqual(["linear.get_issue_status", "linear.get_issue"]);
  });

  it.each(["GitHub get issue", "github list repos", "GitHub pull request status"])("answers an absent service instead of Linear/Mixpanel/Supabase lookalikes for %s", async (query) => {
    const registry = makeRegistry([
      service("linear", [{ name: "get_issue", description: "Get issue details" }]),
      service("mixpanel", [{ name: "list_projects", description: "List projects and request status" }]),
      service("supabase", [{ name: "list_repos", description: "Get project status" }]),
    ]);
    const page = await searchBoth(registry, { query, includeSchemas: "json" });
    expect(page).toMatchObject({ tools: [], total: 0, hasMore: false, catalogErrors: [], absence: {
      service: "GitHub", message: 'No connector for "GitHub" is configured for this endpoint.', configuredConnectors: ["linear", "mixpanel", "supabase"],
    } });
  });

  it("recognizes a configured service under a custom id and display title", async () => {
    const registry = makeRegistry([service("source", [{ name: "get_issue" }], "GitHub Engineering")]);
    const page = await searchBoth(registry, { query: "GitHub get_issue", includeSchemas: "json" });
    expect(page.absence).toBeUndefined();
    expect(page.tools[0]?.address).toBe("source.get_issue");
  });

  it("INV-4: absences and auth failures reveal only the pool and grant intersection", async () => {
    let hiddenProbes = 0;
    const hidden = connectorWith({ id: "github", title: "GitHub Secret", tools: async () => {
      hiddenProbes++;
      throw new ConnectorCallError("downstream_oauth_required", "Hidden catalog needs auth");
    } });
    const registry = makeRegistry([hidden, service("linear", [{ name: "get_issue" }, { name: "delete_issue" }])]);
    const scoped = registry.scoped({ connectorIds: ["linear"], toolAccess: new Map([["linear", new Set(["get_issue"])]]) });
    for (const args of [{ query: "GitHub get_issue" }, { connector: "github", query: "get_issue" }, { connector: "custom-service", query: "get_issue" }]) {
      const page = await searchBoth(scoped, { ...args, includeSchemas: "json" });
      expect(page).toMatchObject({ tools: [], catalogErrors: [], absence: { configuredConnectors: ["linear"] } });
      expect(JSON.stringify(page)).not.toContain("GitHub Secret");
      expect(JSON.stringify(page)).not.toContain("Hidden catalog");
    }
    expect(hiddenProbes).toBe(0);
    const visible = await searchBoth(scoped, { includeSchemas: "json" });
    expect(visible.tools.map((tool) => tool.address)).toEqual(["linear.get_issue"]);
  });

  it("INV-10: puts catalog credential and permission failures first with recovery, without starting auth", async () => {
    let authStarts = 0;
    const failing = (id: string, code: ConstructorParameters<typeof ConnectorCallError>[0], oauth = false) => connectorWith({
      id, tools: async () => { throw new ConnectorCallError(code, `${id} catalog failed`); },
      ...(oauth ? { startAuth: async () => { authStarts++; return { state: "ok" as const }; } } : {}),
    });
    const registry = makeRegistry([
      failing("outage", "unavailable"), failing("oauth", "downstream_oauth_required", true),
      failing("credential", "auth_required"), failing("permission", "provider_permission_denied"),
      service("healthy", [{ name: "get_issue" }]),
    ]);
    const page = await searchBoth(registry, { query: "get issue", includeSchemas: "json" });
    expect(page.tools[0]?.address).toBe("healthy.get_issue");
    expect(page.catalogErrors.map((error) => error.connector)).toEqual(["oauth", "credential", "permission", "outage"]);
    expect(page.catalogErrors[0]).toMatchObject({ code: "downstream_oauth_required", retryable: false, recovery: "oauth", nextAction: { tool: "authorize_connector", arguments: { connector: "oauth" } } });
    expect(page.catalogErrors[1]).toMatchObject({ code: "auth_required", recovery: "unavailable", nextAction: { tool: "authorize_connector", arguments: { connector: "credential" } } });
    expect(page.catalogErrors[2]).toMatchObject({ code: "provider_permission_denied", retry: expect.stringContaining("resource owner") });
    expect(page.catalogErrors[2]).not.toHaveProperty("nextAction");
    expect(authStarts).toBe(0);
  });

  it("defaults program search and describe to JSON and labels compact schemas as text", async () => {
    const inputSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
    const registry = makeRegistry([service("linear", [{ name: "get_issue", inputSchema }])]);
    const providers = await buildSandboxProviders(registry, BASE, silentLogger);
    const guest = required(providers.find((provider) => provider.name === "connecta"));
    const page = await required(guest.fns.search)({ query: "get_issue" }) as SearchResult;
    expect(page.tools[0]).toMatchObject({ inputSchema, schemaFormat: "json", requiredInputKeys: ["id"] });
    const described = await required(guest.fns.describe)({ address: "linear.get_issue" }) as { tools: { inputSchema: unknown; schemaFormat: string }[] };
    expect(described.tools[0]).toMatchObject({ inputSchema, schemaFormat: "json" });
    const compact = flatSearchResult(await new CatalogService(registry, BASE).search({ includeSchemas: "compact" }));
    expect(compact.tools[0]).toMatchObject({ schemaFormat: "text", inputSchema: "{ id: string }" });
  });
});
