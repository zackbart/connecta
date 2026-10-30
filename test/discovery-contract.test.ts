import { describe, expect, it } from "vitest";
import {
  CATALOG_SEARCH_RESULT_SCHEMA,
  CatalogService,
  flatSearchResult,
  type CatalogSearchArgs,
} from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { buildSandboxProviders } from "../src/execute.js";
import { Validator, type Schema } from "../src/json-schema.js";
import { createMetaTools } from "../src/meta-tools.js";
import type { RegistryView } from "../src/registry.js";
import type { Connector, ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, textOf, type SearchResult } from "./fixtures/meta-tools.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const searchValidator = new Validator(CATALOG_SEARCH_RESULT_SCHEMA as Schema);

function service(id: string, tools: ToolDef[], title?: string): Connector {
  return connectorWith({ id, ...(title ? { title } : {}), tools });
}

async function searchBoth(registry: RegistryView, args: CatalogSearchArgs) {
  const top = textOf(await createMetaTools(registry, BASE).searchTools(args)) as SearchResult;
  const providers = await buildSandboxProviders(registry, BASE, silentLogger);
  const guest = required(providers.find((provider) => provider.name === "connecta"));
  const program = (await required(guest.fns.search)(args)) as SearchResult;
  expect(program).toEqual(top);
  // Connector facts are hoisted once per page, only for connectors with a row on it.
  const onPage = new Set(top.tools.map((tool) => tool.address.split(".")[0]!));
  for (const id of Object.keys(top.connectors ?? {})) expect(onPage.has(id), id).toBe(true);
  for (const tool of top.tools) expect(tool).not.toHaveProperty("connectorTitle");
  expect(Object.keys(top)[0]).toBe("catalogErrors");
  const validation = searchValidator.validate(top);
  expect(validation.errors).toEqual([]);
  return top;
}

describe("Phase 2 discovery usage-history regressions (#706, #703)", () => {
  it.each(["json", "compact", "typescript"] as const)(
    "returns one flat page from both search paths with %s schemas",
    async (includeSchemas) => {
      const registry = makeRegistry([
        service(
          "linear",
          [
            {
              name: "get_issue",
              inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            },
          ],
          "Linear Work",
        ),
        service("posthog", [{ name: "get_report" }], "PostHog Production"),
      ]);
      const first = await searchBoth(registry, { limit: 1, includeSchemas });
      expect(first).toMatchObject({ catalogErrors: [], total: 2, offset: 0, limit: 1, hasMore: true, nextOffset: 1 });
      expect(first.tools[0]).toMatchObject({
        address: "linear.get_issue",
        schemaFormat: includeSchemas === "json" ? "json" : "text",
      });
      expect(first.connectors).toEqual({ linear: { title: "Linear Work" } });
      const last = await searchBoth(registry, { limit: 1, offset: required(first.nextOffset), includeSchemas });
      expect(last).toMatchObject({ total: 2, hasMore: false });
      expect(last.tools[0]).toMatchObject({ address: "posthog.get_report" });
    },
  );

  it("ranks a whole tool name or canonical address above its shorter name phrase", async () => {
    const registry = makeRegistry([
      service("linear", [
        { name: "get_issue", description: "Get issue status and get issue status details" },
        { name: "get_issue_status" },
      ]),
    ]);
    for (const query of ["get_issue_status", "linear.get_issue_status"]) {
      const page = await searchBoth(registry, { query, limit: 1, includeSchemas: "json" });
      expect(page.tools[0]?.address).toBe("linear.get_issue_status");
    }
  });

  it.each(["linear", "Linear Work"])(
    "INV-4: browses granted tools for exact connector identity %s despite description mentions",
    async (query) => {
      const registry = makeRegistry([
        service(
          "linear",
          [
            { name: "search_issues", description: "Search Linear Work issues" },
            { name: "get_issue", description: "Read one ticket" },
            { name: "delete_issue", description: "Delete one ticket" },
          ],
          "Linear Work",
        ),
        service("metrics", [{ name: "report", description: "Linear Work issue statistics" }]),
      ]);
      const scoped = registry.scoped({
        connectorIds: ["linear", "metrics"],
        toolAccess: new Map([["linear", new Set(["search_issues", "get_issue"])]]),
      });
      const page = await searchBoth(scoped, { query, limit: 1, includeSchemas: "json" });
      expect(page.tools[0]?.address).toBe("linear.search_issues");
      const next = await searchBoth(scoped, {
        query,
        limit: 1,
        offset: required(page.nextOffset),
        includeSchemas: "json",
      });
      expect(next.tools[0]?.address).toBe("linear.get_issue");
      expect(page.total).toBe(3);
    },
  );

  it.each(["auth_required", "downstream_oauth_required", "provider_permission_denied", "unavailable"] as const)(
    "INV-6: withholds catalog error text for %s on both search paths",
    async (code) => {
      const registry = makeRegistry([
        connectorWith({
          id: "private",
          tools: async () => {
            throw new ConnectorCallError(code, "DOWNSTREAM_PRIVATE_SENTINEL");
          },
        }),
      ]);
      for (const connector of [undefined, "private"]) {
        const page = await searchBoth(registry, {
          query: "get issue",
          ...(connector ? { connector } : {}),
          includeSchemas: "json",
        });
        expect(JSON.stringify(page)).not.toContain("DOWNSTREAM_PRIVATE_SENTINEL");
        expect(page.catalogErrors[0]).toMatchObject({
          connector: "private",
          code,
          message: expect.stringContaining('Connector "private"'),
        });
        if (connector)
          expect(page.queryAnalysis?.catalogError).toEqual(
            expect.objectContaining({ code, message: page.catalogErrors[0]?.message }),
          );
      }
    },
  );

  it.each(["GitHub get issue", "github list repos", "GitHub pull request status"])(
    "answers an absent service instead of Linear/PostHog/Supabase lookalikes for %s",
    async (query) => {
      const registry = makeRegistry([
        service("linear", [{ name: "get_issue", description: "Get issue details" }]),
        service("posthog", [{ name: "list_projects", description: "List projects and request status" }]),
        service("supabase", [{ name: "list_repos", description: "Get project status" }]),
      ]);
      const page = await searchBoth(registry, { query, includeSchemas: "json" });
      expect(page).toMatchObject({
        tools: [],
        total: 0,
        hasMore: false,
        catalogErrors: [],
        absence: {
          service: "GitHub",
          message: 'No connector for "GitHub" is configured for this endpoint.',
          configuredConnectors: ["linear", "posthog", "supabase"],
        },
      });
    },
  );

  it("INV-4: absences and auth failures reveal only the pool and grant intersection", async () => {
    let hiddenProbes = 0;
    const hidden = connectorWith({
      id: "github",
      title: "GitHub Secret",
      tools: async () => {
        hiddenProbes++;
        throw new ConnectorCallError("downstream_oauth_required", "Hidden catalog needs auth");
      },
    });
    const registry = makeRegistry([hidden, service("linear", [{ name: "get_issue" }, { name: "delete_issue" }])]);
    const scoped = registry.scoped({
      connectorIds: ["linear"],
      toolAccess: new Map([["linear", new Set(["get_issue"])]]),
    });
    for (const args of [
      { query: "GitHub get_issue" },
      { connector: "github", query: "get_issue" },
      { connector: "custom-service", query: "get_issue" },
    ]) {
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
    const failing = (id: string, code: ConstructorParameters<typeof ConnectorCallError>[0], oauth = false) =>
      connectorWith({
        id,
        tools: async () => {
          throw new ConnectorCallError(code, `${id} catalog failed`);
        },
        ...(oauth
          ? {
              startAuth: async () => {
                authStarts++;
                return { state: "ok" as const };
              },
            }
          : {}),
      });
    const registry = makeRegistry([
      failing("outage", "unavailable"),
      failing("oauth", "downstream_oauth_required", true),
      failing("credential", "auth_required"),
      failing("permission", "provider_permission_denied"),
      service("healthy", [{ name: "get_issue" }]),
    ]);
    const page = await searchBoth(registry, { query: "get issue", includeSchemas: "json" });
    expect(page.tools[0]?.address).toBe("healthy.get_issue");
    expect(page.catalogErrors.map((error) => error.connector)).toEqual(["oauth", "credential", "permission", "outage"]);
    expect(page.catalogErrors[0]).toMatchObject({
      code: "downstream_oauth_required",
      retryable: false,
      recovery: "oauth",
      nextAction: { tool: "authorize_connector", arguments: { connector: "oauth" } },
    });
    expect(page.catalogErrors[1]).toMatchObject({
      code: "auth_required",
      recovery: "unavailable",
      nextAction: { tool: "authorize_connector", arguments: { connector: "credential" } },
    });
    expect(page.catalogErrors[2]).toMatchObject({
      code: "provider_permission_denied",
      retry: expect.stringContaining("resource owner"),
    });
    expect(page.catalogErrors[2]).not.toHaveProperty("nextAction");
    expect(authStarts).toBe(0);
  });

  it("defaults program search to TypeScript, describe to JSON, and labels compact schemas as text", async () => {
    const inputSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
    const registry = makeRegistry([service("linear", [{ name: "get_issue", inputSchema }])]);
    const providers = await buildSandboxProviders(registry, BASE, silentLogger);
    const guest = required(providers.find((provider) => provider.name === "connecta"));
    const page = (await required(guest.fns.search)({ query: "get_issue" })) as SearchResult;
    expect(page.tools[0]).toMatchObject({
      signature: "(args: { id: string }) => Promise<unknown>",
      schemaFormat: "text",
      requiredInputKeys: ["id"],
    });
    expect(page.tools[0]).not.toHaveProperty("inputSchema");
    const exact = (await required(guest.fns.search)({ query: "get_issue", includeSchemas: "json" })) as SearchResult;
    expect(exact.tools[0]).toMatchObject({ inputSchema, schemaFormat: "json" });
    const described = (await required(guest.fns.describe)({ address: "linear.get_issue" })) as {
      tools: { inputSchema: unknown; schemaFormat: string }[];
    };
    expect(described.tools[0]).toMatchObject({ inputSchema, schemaFormat: "json" });
    const compact = flatSearchResult(await new CatalogService(registry, BASE).search({ includeSchemas: "compact" }));
    expect(compact.tools[0]).toMatchObject({ schemaFormat: "text", inputSchema: "{ id: string }" });
  });
});
