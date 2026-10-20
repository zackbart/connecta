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
import { api } from "../src/connectors/api.js";
import { guardedFetch, oauthBearer } from "../src/connectors/guarded-fetch.js";
import { ConnectorCallError } from "../src/errors.js";
import { deriveContext } from "../src/derived-context.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
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
              // One unknown-outcome advice: a provider's own is never followed by the shared one.
              const { message } = (result.structuredContent as { error: { message: string } }).error;
              if (/so its outcome is unknown|may or may not have been applied/.test(message))
                expect(message).not.toContain("Whether the write took effect at");
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

// Whole-call failures, beyond the first resource request covered above.
describe("round-5 whole-call failure sweep", () => {
  async function invoke(connector: Connector, tool: string, classification: "read" | "write", args = {}) {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    const values = credential(connector.id);
    await vault.setAll(connector.id, values, "fixture");
    vi.spyOn(vault, "get").mockImplementation(async (_id, field = "value") => values[field] ?? null);
    vi.spyOn(vault, "getAll").mockResolvedValue(values);
    const registry = makeRegistry([connector], {
      storage,
      credentialVault: vault,
      classification: { [connector.id]: { [tool]: classification } },
    });
    return new InvocationService(registry, new CatalogService(registry, BASE)).invoke(`${connector.id}.${tool}`, args, {
      source: classification === "write" ? "call_destructive_tool" : "call_tool",
    });
  }

  function provider(name: string) {
    return providers.find((p) => p.name === name)!.create();
  }
  function googleFetch(resource: (request: Request) => Response) {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "oauth2.googleapis.com")
          return Response.json({ access_token: "fixture-token", expires_in: 3600, token_type: "Bearer" });
        requests.push(request);
        return resource(request);
      }),
    );
    return requests;
  }

  it.each([
    ["single refusal", false, false, "rate_limited", 429, false],
    ["generic refusal", false, false, "unavailable", 404, false],
    ["auxiliary preflight then refusal", true, false, "rate_limited", 429, false],
    ["resource success then auxiliary refusal", false, true, "rate_limited", 429, true],
  ] as const)(
    "INV-9: whole-call ledger distinguishes %s",
    async (_name, earlyAuxiliary, lateAuxiliary, code, status, unknown) => {
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.example",
        authenticate: () => ({ Authorization: "Bearer fixture-secret" }),
        maxResponseBytes: 1024,
        fetch: async (url) => Response.json({}, { status: url.endsWith("/first") ? 200 : status }),
      });
      const connector = api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send a ticket",
            annotations: { readOnlyHint: false },
            handler: async (_args, ctx) => {
              if (earlyAuxiliary || lateAuxiliary)
                await send({ method: "POST", path: "/first", auxiliary: earlyAuxiliary }, ctx, (r) => r.json());
              return send({ method: "POST", path: "/last", auxiliary: lateAuxiliary }, ctx, () => {
                throw new ConnectorCallError(code, "Refused fixture-secret", { retryAfterMs: 1000 });
              });
            },
          },
        ],
      });
      const result = await invoke(connector, "send", "write");
      expect(result).toMatchObject({ ok: false, error: { retryable: !unknown, retryAfterMs: 1000 } });
      if (result.ok) throw new Error("expected failure");
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expect(result.error.writeOutcome).toBe(unknown ? "unknown" : undefined);
      expect(
        outcomes.classifyWriteOutcome({
          ok: false,
          dispatched: result.dispatched,
          answered: result.answered === true,
          error: result.error,
        }),
      ).toBe(unknown ? "unknown" : "failed");
    },
  );

  it("INV-9: concurrent direct calls sharing an origin keep separate ledgers", async () => {
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async (url) => Response.json({}, { status: url.endsWith("/refused") ? 429 : 200 }),
    });
    const connector = api("tickets", {
      tools: [
        {
          name: "send",
          description: "Send a ticket",
          annotations: { readOnlyHint: false },
          handler: async (args, ctx) => {
            await send(
              { method: "POST", path: args.refused ? "/refused" : "/accepted" },
              deriveContext(ctx, {}),
              async (r) => {
                if (!r.ok) throw new ConnectorCallError("rate_limited", "Vendor refusal");
                return r.json();
              },
            );
            throw new ConnectorCallError("unavailable", "Handler failed");
          },
        },
      ],
    });
    const ctx = makeRegistry([connector]).contextFor("tickets", BASE);
    const [accepted, refused] = await Promise.all([
      connector.callTool("send", {}, ctx).catch((e: unknown) => e),
      connector.callTool("send", { refused: true }, ctx).catch((e: unknown) => e),
    ]);
    expect(accepted).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(refused).toMatchObject({ code: "rate_limited", retryable: true, writeOutcome: undefined });
  });

  it("INV-9: OAuth preflight without a grant never dispatches a guarded resource write", async () => {
    const requests = googleFetch(() => Response.json({}));
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      maxResponseBytes: 1024,
      ...oauthBearer("Tickets"),
    });
    const connector = api("tickets", {
      oauth: {
        authorizationEndpoint: "https://tickets.example/authorize",
        tokenEndpoint: "https://tickets.example/token",
        clientId: "fixture-client",
        apiOrigins: ["https://tickets.example"],
      },
      tools: [
        {
          name: "send",
          description: "Send a ticket",
          annotations: { readOnlyHint: false },
          handler: (_args, ctx) => send({ method: "POST", path: "/tickets" }, ctx, (r) => r.json()),
        },
      ],
    });
    const error = await connector
      .callTool("send", {}, makeRegistry([connector]).contextFor("tickets", BASE))
      .catch((e: unknown) => e);
    expect(requests).toHaveLength(0);
    expect(error).toMatchObject({ code: "downstream_oauth_required", writeOutcome: undefined });
  });

  it("INV-9: typed handler failure after a plain ctx.fetch send is unknown", async () => {
    const requests = googleFetch(() => Response.json({}));
    const connector = api("tickets", {
      tools: [
        {
          name: "send",
          description: "Send a ticket",
          annotations: { readOnlyHint: false },
          handler: async (_args, ctx) => {
            await ctx.fetch("https://tickets.example/tickets", { method: "POST" });
            throw new ConnectorCallError("unavailable", "Handler failed");
          },
        },
      ],
    });
    const result = await invoke(connector, "send", "write");
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { retryable: false, writeOutcome: "unknown" } });
  });

  for (const classification of ["write", "read"] as const) {
    it.each(["unavailable", "conflict"] as const)(
      `INV-9: typed handler %s after a successful guarded send served ${classification}`,
      async (code) => {
        const requests = googleFetch(() => Response.json({ ok: true }));
        const send = guardedFetch({
          provider: "Tickets",
          baseUrl: "https://tickets.example",
          authenticate: () => ({}),
          maxResponseBytes: 1024,
        });
        const connector = api("tickets", {
          tools: [
            {
              name: "send",
              description: "Send a ticket",
              annotations: { readOnlyHint: false },
              handler: async (_args, ctx) => {
                await send({ method: "POST", path: "/tickets" }, deriveContext(ctx, {}), (r) => r.json());
                throw new ConnectorCallError(code, "Handler could not complete.");
              },
            },
          ],
        });
        const result = await invoke(connector, "send", classification);
        expect(requests).toHaveLength(1);
        expect(result).toMatchObject({
          ok: false,
          error: classification === "write" ? { retryable: false, writeOutcome: "unknown" } : { code },
        });
        if (result.ok) throw new Error("expected failure");
        expect(
          outcomes.classifyWriteOutcome({
            ok: false,
            dispatched: true,
            answered: result.answered === true,
            error: result.error,
          }),
        ).toBe(classification === "write" ? "unknown" : code === "conflict" ? "failed" : "unknown");
      },
    );

    it.each([401, 429, 503])(
      `INV-9: Docs create with initial text then %s served ${classification}`,
      async (status) => {
        const requests = googleFetch((request) =>
          new URL(request.url).pathname === "/v1/documents"
            ? Response.json({ documentId: "doc-1", title: "Fixture" })
            : Response.json({ error: { code: status, message: "Request refused" } }, { status }),
        );
        const result = await invoke(provider("docs"), "create_document", classification, {
          title: "Fixture",
          text: "Initial text",
        });
        expect(requests.map((r) => r.method)).toEqual(
          classification === "read" && status === 401 ? ["POST", "POST", "POST"] : ["POST", "POST"],
        );
        expect(result).toMatchObject({
          ok: false,
          error:
            classification === "write"
              ? { retryable: false, writeOutcome: "unknown", ...(status === 401 ? { code: "auth_required" } : {}) }
              : { retryable: status !== 401, ...(status === 401 ? { code: "auth_required" } : {}) },
        });
        if (!result.ok && classification === "read") expect(result.error).not.toHaveProperty("writeOutcome");
      },
    );

    it(`INV-9: Planning Center early successes then refusal served ${classification}`, async () => {
      const requests = googleFetch((request) =>
        new URL(request.url).pathname.endsWith("/team_members")
          ? Response.json({ errors: [{ status: "429", title: "Too many requests" }] }, { status: 429 })
          : Response.json({ data: [] }),
      );
      const result = await invoke(
        provider("planning-center"),
        "get_plan",
        classification,
        argumentsTable["planning-center"]!["get_plan"]!,
      );
      expect(requests).toHaveLength(3);
      expect(new Set(requests.map((r) => r.url)).size).toBe(3);
      expect(result).toMatchObject({
        ok: false,
        error:
          classification === "write"
            ? { retryable: false, writeOutcome: "unknown" }
            : { code: "rate_limited", retryable: true },
      });
    });

    it(`INV-9: Forms cursor conflict after HTTP 200 served ${classification}`, async () => {
      const requests = googleFetch(() => Response.json({ formId: "form-1", revisionId: "new", items: [] }));
      const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["get_form", "form-1"]))),
      );
      const b64url = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const cursor = b64url(
        JSON.stringify({ d: b64url(String.fromCharCode(...bytes.subarray(0, 16))), i: 0, q: 0, r: "old" }),
      );
      const result = await invoke(provider("forms"), "get_form", classification, { formId: "form-1", cursor });
      expect(requests).toHaveLength(1);
      expect(result).toMatchObject({
        ok: false,
        error:
          classification === "write"
            ? { code: "conflict", retryable: false, writeOutcome: "unknown" }
            : { code: "conflict" },
      });
    });
  }

  it.each(["/app/installations", "/app/installations/11/access_tokens", "/installation/repositories"])(
    "INV-9: GitHub preflight %s fails before resource dispatch and keeps retry advice",
    async (path) => {
      const fake = apiFixture();
      fake.respond((request) => (request.url.pathname === path ? Response.json({}, { status: 503 }) : undefined));
      const result = await invoke(
        provider("github"),
        "update_release",
        "write",
        argumentsTable.github!["update_release"]!,
      );
      expect(fake.requests.some((r) => r.url.pathname === path)).toBe(true);
      expect(
        fake.requests.every((r) =>
          ["/app/installations", "/app/installations/11/access_tokens", "/installation/repositories"].includes(
            r.url.pathname,
          ),
        ),
      ).toBe(true);
      expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
      if (!result.ok) expect(result.error).not.toHaveProperty("writeOutcome");
    },
  );

  it("INV-9: Tithe.ly single write's generic 404 is a known refusal", async () => {
    const requests = googleFetch(() => Response.json({ error: "Unknown or inaccessible" }, { status: 404 }));
    const result = await invoke(
      provider("tithely"),
      "tithely_api_mutate",
      "write",
      argumentsTable.tithely!["tithely_api_mutate"]!,
    );
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { code: "connector_call_failed", retryable: false } });
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).not.toHaveProperty("writeOutcome");
    expect(
      outcomes.classifyWriteOutcome({
        ok: false,
        dispatched: result.dispatched,
        answered: result.answered === true,
        error: result.error,
      }),
    ).toBe("failed");
  });
});
