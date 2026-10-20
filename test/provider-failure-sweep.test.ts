// The catalog is the inventory: adding an API provider or tool requires a
// dispatchable example here, and every dispatched failure must use core's
// decision. Argument examples come from the independent #900 fixtures.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractFixture } from "./fixtures/provider-contract.js";
import { providerFixtures } from "./providers.generated.js";
import argumentsByProvider from "./fixtures/provider-failure-arguments.json";
import { googleOptions } from "./fixtures/provider-options.js";
import { apiFixture, SCOPES } from "./fixtures/github-api.js";
import { AppAuth } from "../src/providers/github/auth.js";
import { restConnector } from "../src/providers/github/rest.js";
import { parseScopes, ScopePolicy } from "../src/providers/github/scope.js";
import { CredentialVault } from "../src/credentials.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import { callClassification } from "../src/call-classification.js";
import * as outcomes from "../src/write-outcome.js";
import type { Connector } from "../src/types.js";
import { makeRegistry } from "./helpers.js";

const fixtures: readonly ContractFixture[] = providerFixtures;
const BASE = "https://connecta.example";
const argumentsTable: Record<string, Record<string, Record<string, unknown>>> = argumentsByProvider;
const GOOGLE = new Set(["gmail", "drive", "docs", "sheets", "slides", "forms"]);
const REMOTE_ONLY = ["basecamp", "intercom", "linear", "revenuecat", "wispr-flow"];
// These catalog tools consult deployment-owned metadata/indexes and never
// dispatch. They are still enumerated and checked, rather than silently skipped.
const LOCAL = new Set([
  "github.list_scopes",
  ...["cloudflare", "mixpanel", "notion", "stripe", "vercel"].flatMap((name) => [
    `${name}.${name}_api_search`,
    `${name}.${name}_api_details`,
  ]),
]);

function create(fixture: ContractFixture): Connector {
  if (fixture.name === "github") {
    const policy = new ScopePolicy(
      parseScopes(
        SCOPES.map((scope) => (scope.access === "read-write" ? { ...scope, workflows: "write" as const } : scope)),
      ),
    );
    return restConnector(
      "github",
      new AppAuth({ appId: "12345", privateKey: googleOptions.serviceAccount.privateKey }, policy),
      policy,
    );
  }
  if (GOOGLE.has(fixture.name)) return fixture.create(fixture.name, { subject: "alice@example.com" });
  if (fixture.name === "mixpanel") return fixture.create(fixture.name, { defaultProjectId: 99 });
  return fixture.create(fixture.name);
}

const providers = fixtures
  .filter((fixture) => !REMOTE_ONLY.includes(fixture.name))
  .map((fixture) => ({
    name: fixture.name,
    create: () => create(fixture),
    catalog: create(fixture).staticTools!,
  }));

function credential(name: string): Record<string, string> {
  return {
    value:
      name === "stripe" ? "sk_test_fixture" : name === "mixpanel" ? "fixture-user:fixture-secret" : "fixture-token",
    applicationId: "fixture-application",
    secret: "fixture-secret",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    apiKey: "fixture-key",
    publicKey: "pub_fixture",
    privateKey: "pri_fixture",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API provider failure sweep", () => {
  it("INV-9: inventories every API surface and catalog tool, including local tools", () => {
    const actual = fixtures
      .filter(
        (fixture) =>
          create(fixture).kind === "api" ||
          fixture.cases.some((scenario) => fixture.create(fixture.name, scenario.options).kind === "api"),
      )
      .map((fixture) => fixture.name)
      .sort();
    expect(providers.map(({ name }) => name).sort()).toEqual(actual);
    expect(Object.keys(argumentsTable).sort()).toEqual(actual);
    for (const provider of providers) {
      const fixture = fixtures.find(({ name }) => name === provider.name)!;
      const modes = [
        provider.create(),
        ...fixture.cases.map((scenario) => fixture.create(provider.name, scenario.options)),
      ];
      const tools = [
        ...new Set(
          modes
            .filter((connector) => connector.kind === "api")
            .flatMap((connector) => connector.staticTools!.map(({ name }) => name)),
        ),
      ].sort();
      expect(
        provider.catalog.map(({ name }) => name).sort(),
        `${provider.name}: cover tools from every API mode`,
      ).toEqual(tools);
      expect(Object.keys(argumentsTable[provider.name]!).sort(), provider.name).toEqual(tools);
    }
    expect(typeof outcomes.providerCallFailure).toBe("function");
  });

  for (const provider of providers) {
    describe(provider.name, () => {
      const examples = provider.catalog.flatMap((tool) => [
        { tool, args: argumentsTable[provider.name]?.[tool.name], suffix: "" },
        ...(provider.name === "github" && tool.name === "list_scopes"
          ? [{ tool, args: { owner: "acme" }, suffix: " (owner lookup)" }]
          : []),
      ]);
      for (const { tool, args, suffix } of examples) {
        const address = `${provider.name}.${tool.name}`;
        for (const classification of ["write", "read"] as const) {
          it.each(["503", "network-after-send"] as const)(
            `INV-9: ${address}${suffix} served ${classification} → %s`,
            async (failure) => {
              const decision =
                typeof outcomes.providerCallFailure === "function"
                  ? vi.spyOn(outcomes, "providerCallFailure")
                  : undefined;
              const requests: string[] = [];
              const fail = (request: Request): Response => {
                requests.push(`${request.method} ${request.url}`);
                if (failure === "network-after-send")
                  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
                return Response.json(
                  { error: { code: 503 }, errors: [{ message: "Service unavailable" }] },
                  { status: 503 },
                );
              };
              if (provider.name === "github") {
                const fake = apiFixture();
                fake.respond((request) => {
                  if (request.url.pathname === "/app/installations" || request.url.pathname.endsWith("/access_tokens"))
                    return undefined;
                  if (request.url.pathname === "/installation/repositories" && tool.name !== "list_scopes")
                    return undefined;
                  return fail(new Request(request.url, { method: request.method }));
                });
              } else {
                vi.stubGlobal(
                  "fetch",
                  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const request = new Request(input, init);
                    const url = new URL(request.url);
                    if (url.hostname === "oauth2.googleapis.com")
                      return Response.json({
                        access_token: "fixture-delegated-token",
                        expires_in: 3600,
                        token_type: "Bearer",
                      });
                    if (url.pathname.endsWith("/auth/universal-auth/login"))
                      return Response.json({
                        accessToken: "fixture-infisical-token",
                        expiresIn: 3600,
                        tokenType: "Bearer",
                      });
                    if (url.pathname === "/oauth/token")
                      return Response.json({
                        access_token: "fixture-oauth-token",
                        refresh_token: "fixture-refresh-token",
                        token_type: "bearer",
                        expires_in: 7200,
                        scope: "read:individuals",
                      });
                    return fail(request);
                  }),
                );
              }
              const connector = provider.create();
              const storage = memoryStorage();
              const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
              const values = credential(provider.name);
              await vault.setAll(connector.id, values, "fixture");
              // Keep parallel request preparation deterministic. Encryption
              // has its own tests; this sweep must not leave sibling vault
              // decryptions running after Promise.all rejects its first call.
              vi.spyOn(vault, "get").mockImplementation(async (_id, field = "value") => values[field] ?? null);
              vi.spyOn(vault, "getAll").mockResolvedValue(values);
              const registry = makeRegistry([connector], {
                storage,
                credentialVault: vault,
                classification: { [connector.id]: { [tool.name]: classification } },
              });
              if (provider.name === "ccb") {
                const ctx = registry.contextFor(connector.id, BASE);
                const started = await connector.startAuth!(ctx);
                const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
                expect(await connector.verifyState!(state, ctx)).toBe(true);
                await connector.finishAuth!("fixture-code", ctx, new URLSearchParams({ code: "fixture-code", state }));
              }
              expect(args, `Missing dispatch example for ${address}`).toBeDefined();
              const meta = createMetaTools(registry, BASE);
              const invoke = classification === "write" ? meta.callDestructiveTool : meta.callTool;
              const result = await invoke({ address, args: args! });
              if (LOCAL.has(address) && !suffix) {
                expect(requests).toEqual([]);
                expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
                return;
              }
              expect(requests.length, JSON.stringify(result.structuredContent)).toBe(
                address === "planning-center.get_plan"
                  ? 3
                  : ["forms.list_responses", "forms.get_response"].includes(address)
                    ? 2
                    : 1,
              );
              // Composite tools may send independent requests concurrently (e.g.
              // get_plan). Every request, including the first, must leave once.
              expect(new Set(requests).size, requests.join("\n")).toBe(requests.length);
              expect(result.structuredContent).toMatchObject({
                ok: false,
                error: classification === "write" ? { retryable: false, writeOutcome: "unknown" } : { retryable: true },
              });
              if (classification === "read")
                expect((result.structuredContent as { error: object }).error).not.toHaveProperty("writeOutcome");
              if (decision)
                expect(
                  decision.mock.calls.some(
                    ([ctx, , , facts]) => facts.dispatched && callClassification(ctx) === classification,
                  ),
                ).toBe(true);
            },
          );
        }
      }
    });
  }
});
