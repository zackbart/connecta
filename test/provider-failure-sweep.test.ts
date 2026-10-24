// The catalog is the inventory: adding an API provider or tool requires a
// dispatchable example here, and every dispatched failure must use core's
// decision. Argument examples come from the independent #900 fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callClassification } from "../src/call-classification.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch, oauthBearer } from "../src/connectors/guarded-fetch.js";
import { CredentialVault } from "../src/credentials.js";
import { deriveContext } from "../src/derived-context.js";
import { ConnectorCallError, type CallErrorDetails } from "../src/errors.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { providerRequests, readRequest, tracksEveryRequest, tracksRequests } from "../src/provider-call.js";
import { AppAuth } from "../src/providers/github/lib/auth.js";
import { restConnector } from "../src/providers/github/tools.js";
import { parseScopes, ScopePolicy } from "../src/providers/github/lib/scope.js";
import { memoryStorage } from "../src/storage/memory.js";
import { classifyTool } from "../src/tool-safety.js";
import type { Connector } from "../src/types.js";
import * as outcomes from "../src/write-outcome.js";
import { apiFixture, SCOPES } from "./fixtures/github-api.js";
import type { ContractFixture } from "./fixtures/provider-contract.js";
import argumentsByProvider from "./fixtures/provider-failure-arguments.json";
import { googleOptions } from "./fixtures/provider-options.js";
import { makeRegistry } from "./helpers.js";
import { providerFixtures } from "./providers.generated.js";

const fixtures: readonly ContractFixture[] = providerFixtures;
const BASE = "https://connecta.example";
const argumentsTable: Record<string, Record<string, Record<string, unknown>>> = argumentsByProvider;
const GOOGLE = new Set(["gmail", "drive", "docs", "sheets", "slides", "forms"]);
const UNREADABLE_WRITES: Record<string, Record<string, unknown>> = {
  "stripe.stripe_api_write": { method: "POST", path: "/v1/refunds", body: { payment_intent: "pi_fixture" } },
  "cloudflare.cloudflare_api_write": {
    method: "PATCH",
    path: "/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records/r1",
    body: { ttl: 300 },
  },
  "vercel.vercel_api_write": {
    method: "PATCH",
    path: "/v9/projects/web/env/env_fixture",
    body: { value: "new-value" },
  },
  "vercel.update_project_env_var": { projectId: "web", envVarId: "env_fixture", value: "new-value" },
  "breeze.breeze_api_write": { method: "GET", path: "/people/add", query: { first: "Alice", last: "Example" } },
  "ccb.ccb_api_write": { method: "POST", path: "/individuals/42/notes", body: { note: "Visited" } },
  "planning-center.pco_api_write": {
    method: "POST",
    path: "/people/v2/people",
    body: { data: { type: "Person", attributes: { first_name: "Alice", last_name: "Example" } } },
  },
  "tithely.tithely_api_write": { method: "POST", path: "/refunds/ch_fixture" },
};
// These catalog tools consult deployment-owned metadata/indexes and never
// dispatch. They are still enumerated and checked, rather than silently skipped.
const LOCAL = new Set([
  "github.list_scopes",
  "sheets.sheets_api_search",
  "sheets.sheets_api_details",
  "planning-center.pco_api_search",
  "docs.docs_api_search",
  "docs.docs_api_details",
  "planning-center.pco_api_details",
  ...[
    "breeze",
    "ccb",
    "cloudflare",
    "drive",
    "forms",
    "github",
    "gmail",
    "overflow",
    "stripe",
    "tithely",
    "vercel",
    "slides",
  ].flatMap((name) => [`${name}.${name}_api_search`, `${name}.${name}_api_details`]),
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
  return fixture.create(fixture.name);
}

const providers = fixtures.map((fixture) => ({
  name: fixture.name,
  create: () => create(fixture),
  catalog: create(fixture).staticTools!,
}));

/** Fold Sheets' new hatch routes into the existing representative failure cases. */
async function sweepSheetsHatch(provider: (typeof providers)[number], named: string, failure: string) {
  if (provider.name !== "sheets") return;
  const hatch =
    named === "get_spreadsheet" ? "sheets_api_read" : named === "update_values" ? "sheets_api_write" : undefined;
  if (!hatch) return;
  const classification = hatch === "sheets_api_read" ? "read" : "write";
  const sent: string[] = [];
  const result = await sweepCall(
    provider,
    hatch,
    `sheets.${hatch}`,
    argumentsTable.sheets![hatch],
    classification,
    (request) => {
      sent.push(`${request.method} ${request.url}`);
      if (failure === "network-after-send")
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      const status = failure === "401" ? 401 : 503;
      return Response.json({ error: { code: status, message: "Refused" } }, { status });
    },
    HANDOFFS,
  );
  expect(sent).toHaveLength(classification === "read" && failure === "401" ? 2 : 1);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: {
      retryable: classification === "read" && failure !== "401",
      ...(classification === "write" ? { writeOutcome: "unknown" } : {}),
    },
  });
  const error = (result.structuredContent as { error: CallErrorDetails }).error;
  if (classification === "read") expect(error).not.toHaveProperty("writeOutcome");
  if (failure === "401")
    expect(error).toMatchObject({ code: "auth_required", nextAction: { tool: "authorize_connector" } });
}

function credential(name: string): Record<string, string> {
  return {
    value: name === "stripe" ? "sk_test_fixture" : "fixture-token",
    applicationId: "fixture-application",
    secret: "fixture-secret",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    apiKey: "fixture-key",
    publicKey: "pub_fixture",
    privateKey: "pri_fixture",
  };
}

// Kit providers (Tithe.ly) send writes through the owned transport listen() installs on Node.
beforeEach(() => {
  installOwnedTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API provider failure sweep", () => {
  it("INV-9: inventories every API surface and catalog tool, including local tools", async () => {
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
      for (const connector of modes.filter(({ kind }) => kind === "api"))
        expect(tracksRequests(connector), `${provider.name}: its ledger sees every request`).toBe(true);
      expect(
        provider.catalog.map(({ name }) => name).sort(),
        `${provider.name}: cover tools from every API mode`,
      ).toEqual(tools);
      expect(Object.keys(argumentsTable[provider.name]!).sort(), provider.name).toEqual(tools);
      // Forms hatches share the existing admission/transport boundary; fold
      // their cases here without multiplying the exhaustive status matrix.
      if (provider.name === "forms")
        for (const name of ["forms_api_search", "forms_api_details", "forms_api_read", "forms_api_write"]) {
          const remote = name === "forms_api_read" || name === "forms_api_write";
          const requests: string[] = [];
          const result = await sweepCall(
            provider,
            name,
            `forms.${name}`,
            argumentsTable.forms![name],
            name === "forms_api_write" ? "write" : "read",
            (request) => {
              requests.push(request.url);
              return Response.json({ error: { code: 503 } }, { status: 503 });
            },
          );
          expect(requests).toHaveLength(remote ? 1 : 0);
          if (remote) expect(result.isError).toBe(true);
          else expect(result.isError).toBeFalsy();
          if (remote)
            expect(result.structuredContent).toMatchObject({
              ok: false,
              error:
                name === "forms_api_write"
                  ? { retryable: false, writeOutcome: "unknown" }
                  : { code: "unavailable", retryable: true },
            });
        }
      // Fold offline hatch coverage here: injected remote failures
      // cannot affect metadata that sends no request.
      if (["github", "gmail", "docs", "sheets", "slides"].includes(provider.name))
        for (const name of [`${provider.name}_api_search`, `${provider.name}_api_details`]) {
          const result = await sweepCall(
            provider,
            name,
            `${provider.name}.${name}`,
            argumentsTable[provider.name]![name],
            "read",
            () => {
              throw new Error("An offline indexed hatch dispatched a request.");
            },
          );
          expect(result.isError).toBeFalsy();
        }
      if (provider.name === "drive") {
        for (const name of ["drive_api_search", "drive_api_details"]) {
          const result = await sweepCall(provider, name, `drive.${name}`, argumentsTable.drive![name], "read", () => {
            throw new Error("Offline Drive discovery dispatched.");
          });
          expect(result.isError).toBeFalsy();
        }
        for (const [name, classification] of [
          ["drive_api_read", "read"],
          ["drive_api_write", "write"],
        ] as const) {
          for (const status of [401, 503]) {
            const sent: string[] = [];
            const result = await sweepCall(
              provider,
              name,
              `drive.${name}`,
              argumentsTable.drive![name],
              classification,
              (request) => {
                sent.push(request.method);
                return Response.json({ error: { code: status } }, { status });
              },
            );
            expect(result.isError).toBe(true);
            expect(sent.length).toBe(classification === "read" && status === 401 ? 2 : 1);
            const error = (result.structuredContent as { error: CallErrorDetails }).error;
            if (classification === "write") expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
            else expect(error).not.toHaveProperty("writeOutcome");
          }
        }
      }
    }
    expect(typeof outcomes.providerCallFailure).toBe("function");
  });

  for (const provider of providers) {
    describe(provider.name, () => {
      const examples = provider.catalog
        .filter(
          (tool) =>
            !(
              ["github", "gmail", "slides"].includes(provider.name) &&
              [`${provider.name}_api_search`, `${provider.name}_api_details`].includes(tool.name)
            ) &&
            !(
              ["docs", "drive", "forms", "sheets"].includes(provider.name) &&
              tool.name.startsWith(`${provider.name}_api_`)
            ),
        )
        .flatMap((tool) => [
          { tool, args: argumentsTable[provider.name]?.[tool.name], suffix: "" },
          ...(provider.name === "github" && tool.name === "list_scopes"
            ? [{ tool, args: { owner: "acme" }, suffix: " (owner lookup)" }]
            : []),
        ]);
      for (const { tool, args, suffix } of examples) {
        const address = `${provider.name}.${tool.name}`;
        // Sweep every tool at its declared verdict; shared contract cases below
        // exercise forced classifications without multiplying each provider tool.
        for (const classification of [classifyTool(tool)]) {
          // Network loss crosses the same transport boundary for every tool.
          // Keep one probe per provider/verdict alongside every tool's HTTP refusals.
          it.each(
            provider.catalog.find(
              (candidate) =>
                !LOCAL.has(`${provider.name}.${candidate.name}`) &&
                !(provider.name === "forms" && candidate.name.startsWith("forms_api_")) &&
                classifyTool(candidate) === classification,
            )?.name === tool.name
              ? (["503", "network-after-send"] as const)
              : (["503"] as const),
          )(`INV-9: ${address}${suffix} served ${classification} → %s`, async (failure) => {
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
                { error: { code: 503, message: "Service unavailable" }, errors: [{ message: "Service unavailable" }] },
                { status: 503 },
              );
            };
            const result = await sweepCall(provider, tool.name, address, args, classification, fail);
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
            if (GOOGLE.has(provider.name) && failure === "503") expect(message).toContain("Service unavailable.");
            if (/so its outcome is unknown|may or may not have been applied/.test(message))
              expect(message).not.toContain("Whether the write took effect at");
            if (decision) {
              expect(
                decision.mock.calls.some(
                  ([ctx, , , facts]) => facts.dispatched && callClassification(ctx) === classification,
                ),
              ).toBe(true);
              // The declaration is what lets an empty ledger prove a write
              // unsent: the call's ledger recorded every resource request.
              const finals = decision.mock.calls.filter(([, , , facts]) => facts.finalize === true);
              expect(finals).toHaveLength(1);
              expect(
                providerRequests(finals[0]![0])!.filter((request) => request.dispatched && !request.auxiliary),
              ).toHaveLength(requests.length);
            }
            const unreadableArgs = UNREADABLE_WRITES[address];
            if (failure === "503" && unreadableArgs) {
              for (const [body, type] of [
                ["<html>ok</html>", "text/html"],
                ["{broken", "application/json"],
              ]) {
                const sent: string[] = [];
                const unreadable = await sweepCall(provider, tool.name, address, unreadableArgs, "write", (request) => {
                  sent.push(request.method);
                  return new Response(body, { status: 200, headers: { "content-type": type! } });
                });
                expect(sent).toEqual([unreadableArgs["method"] ?? "PATCH"]);
                expect(unreadable.structuredContent).toMatchObject({
                  ok: false,
                  error: {
                    code: "connector_call_failed",
                    retryable: false,
                    writeOutcome: "unknown",
                    message: expect.stringContaining(
                      "Whether the write took effect is unknown; check the target before repeating it.",
                    ),
                  },
                });
              }
            }
            if (failure === "503" && address === "gmail.update_draft") {
              const sent: string[] = [];
              const lookup = await sweepCall(
                provider,
                tool.name,
                address,
                args,
                "write",
                (request) => {
                  sent.push(request.method);
                  return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
                },
                {},
                { failAuxiliary: true },
              );
              expect(sent).toEqual(["GET"]);
              expect(lookup.structuredContent).toMatchObject({
                ok: false,
                error: {
                  code: "connector_call_failed",
                  retryable: false,
                  message: "Gmail returned unexpected text/HTML for a JSON response.",
                },
              });
              expect((lookup.structuredContent as { error: CallErrorDetails }).error).not.toHaveProperty(
                "writeOutcome",
              );
            }
            await sweepSheetsHatch(provider, tool.name, failure);
            await docsHatchFailure(provider, tool.name, classification, failure);
          });
          // A write answered 401 is an unknown outcome unless its provider
          // declares reviewed authBeforeExecution evidence; a read keeps its
          // refusal. Either way authorization is still needed, so the handoff
          // stays, and a renewal that succeeded never resends a write.
          it(`INV-9: ${address}${suffix} served ${classification} → 401`, async () => {
            const requests: string[] = [];
            let oneAttempt = false;
            const fail = (request: Request): Response => {
              requests.push(`${request.method} ${request.url}`);
              oneAttempt ||= !readRequest({ classification, method: request.method }, request.headers);
              // Stripe's API stamps every answer with a Request-Id, which its
              // reviewed evidence requires.
              return Response.json(
                { error: { code: 401, message: "Unauthorized" }, errors: [{ message: "Unauthorized" }] },
                { status: 401, headers: { "request-id": "req_sweep" } },
              );
            };
            const result = await sweepCall(provider, tool.name, address, args, classification, fail, HANDOFFS);
            if (LOCAL.has(address) && !suffix) {
              expect(requests).toEqual([]);
              return;
            }
            const error = (result.structuredContent as { error: CallErrorDetails }).error;
            const context = JSON.stringify(error);
            expect(result.structuredContent, context).toMatchObject({ ok: false, error: { retryable: false } });
            if (oneAttempt) {
              // Sent once each: no renewal resends a write (INV-9).
              expect(new Set(requests).size, requests.join("\n")).toBe(requests.length);
              expect(requests.length, context).toBe(
                address === "planning-center.get_plan"
                  ? 3
                  : ["forms.list_responses", "forms.get_response"].includes(address)
                    ? 2
                    : 1,
              );
            }
            if (classification === "write" && AUTH_BEFORE_EXECUTION.has(provider.name)) {
              // Reviewed evidence: the vendor refused before acting, so the
              // handoff may say to retry the original call.
              expect(error, context).toMatchObject({
                code: expect.stringMatching(/^(auth_required|downstream_oauth_required)$/),
                nextAction: { tool: "authorize_connector", arguments: { connector: provider.name } },
              });
              expect(error).not.toHaveProperty("writeOutcome");
              expect(error.instructions, context).toContain("retry the original call");
            } else if (oneAttempt && RENEWS.has(provider.name)) {
              // The actual request can be a write inside a served read (POST
              // search). Renewal leaves its original 401, with no handoff.
              expect(error).toMatchObject({ code: "connector_call_failed", writeOutcome: "unknown" });
              expect(error.message).toContain(
                "The credential is renewed for the next call, but the write was not sent again",
              );
              expect(error).not.toHaveProperty("nextAction");
            } else if (classification === "write") {
              expect(error, context).toMatchObject({
                code: expect.stringMatching(/^(auth_required|downstream_oauth_required)$/),
                writeOutcome: "unknown",
                reconciliationRequired: true,
                nextAction: { tool: "authorize_connector", arguments: { connector: provider.name } },
              });
              expect(error).not.toHaveProperty("retryAfterMs");
              expect(error.retry).not.toMatch(/^Retry /);
              // The outcome-aware handoff: authorize, then reconcile, never retry the original call.
              expect(error.instructions, context).toContain(
                "re-read the target of the write that failed to check whether it took effect before any fresh call",
              );
              expect(error.instructions).not.toContain("retry the original call");
            } else {
              expect(error, context).toMatchObject({
                code: expect.stringMatching(/^(auth_required|downstream_oauth_required)$/),
                nextAction: { tool: "authorize_connector", arguments: { connector: provider.name } },
                retry: `Retry ${address} after the operator completes recovery.`,
              });
              expect(error).not.toHaveProperty("writeOutcome");
              expect(error).not.toHaveProperty("reconciliationRequired");
              expect(error.instructions ?? "", context).not.toContain("re-read the target");
            }
            // Program accounting reads the explicit outcome before any code.
            if (classification === "write" && !AUTH_BEFORE_EXECUTION.has(provider.name))
              expect(outcomes.classifyWriteOutcome({ ok: false, dispatched: true, answered: false, error })).toBe(
                "unknown",
              );
            if (["gmail.update_draft", "drive.move_file"].includes(address)) {
              const sent: string[] = [];
              const lookup = await sweepCall(
                provider,
                tool.name,
                address,
                args,
                "write",
                (request) => {
                  sent.push(request.method);
                  return Response.json({ error: { code: 401, message: "Unauthorized" } }, { status: 401 });
                },
                HANDOFFS,
                { failAuxiliary: true },
              );
              expect(sent).toEqual(["GET"]);
              const auxiliary = (lookup.structuredContent as { error: CallErrorDetails }).error;
              expect(auxiliary).toMatchObject({
                code: "auth_required",
                retry: `Retry ${address} after the operator completes recovery.`,
              });
              expect(auxiliary).not.toHaveProperty("writeOutcome");
              expect(auxiliary).not.toHaveProperty("reconciliationRequired");
            }
            await sweepSheetsHatch(provider, tool.name, "401");
            await docsHatchFailure(provider, tool.name, classification, "401");
          });
        }
      }
    });
  }

  it("INV-9: the authBeforeExecution table matches every maintained provider's declaration", () => {
    const declaring = Object.entries(providerSources)
      .filter(([, source]) => /\bauthBeforeExecution\s*:/.test(source))
      .map(([path]) => /\/providers\/([^/]+)\//.exec(path)![1]!);
    expect([...new Set(declaring)].sort()).toEqual([...AUTH_BEFORE_EXECUTION].sort());
  });
});

/** Fold Docs hatch 503/network/401 coverage into the matching named endpoint's
 * existing sweep rows, without duplicating collected tests for the same route. */
async function docsHatchFailure(
  provider: (typeof providers)[number],
  original: string,
  classification: "read" | "write",
  failure: "503" | "network-after-send" | "401",
) {
  if (provider.name !== "docs") return;
  const name =
    original === "get_document" ? "docs_api_read" : original === "batch_update_document" ? "docs_api_write" : undefined;
  if (!name) return;
  let sent = 0;
  const result = await sweepCall(
    provider,
    name,
    `docs.${name}`,
    argumentsTable.docs![name],
    classification,
    () => {
      sent++;
      if (failure === "network-after-send") throw new TypeError("fetch failed");
      return Response.json({ error: { code: Number(failure) } }, { status: Number(failure) });
    },
    HANDOFFS,
  );
  expect(sent).toBe(classification === "read" && failure === "401" ? 2 : 1);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: {
      code: failure === "401" ? "auth_required" : classification === "read" ? "unavailable" : "connector_call_failed",
      retryable: classification === "read" && failure !== "401",
      ...(classification === "write" ? { writeOutcome: "unknown" } : {}),
    },
  });
}

/** Every maintained provider's source, to find reviewed `authBeforeExecution` declarations. */
const providerSources = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../src/providers/*/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ).filter(([path]) => !path.endsWith(".test.ts")),
);

/**
 * Providers whose transport declares reviewed `authBeforeExecution` evidence
 * (cited beside the declaration and as a manual check in `drift.json`), so a
 * write answered 401 is a known refusal. Only Stripe documents that it
 * authenticates a request before acting on it.
 */
const AUTH_BEFORE_EXECUTION: ReadonlySet<string> = new Set(["stripe"]);

/** Providers that renew the credential after a 401 within the call, and whose renewal the sweep lets succeed. */
const RENEWS: ReadonlySet<string> = new Set(["ccb"]);

/** Recovery the handoff can describe, so its outcome-aware words show. */
const HANDOFFS = {
  canManageAuth: () => true,
  credentialHandoffUrl: `${BASE}/connections`,
  oauthConnectUrl: async () => `${BASE}/oauth/start`,
};

/** One sweep call: every downstream resource request reaches `fail`; token and login endpoints answer. */
async function sweepCall(
  provider: (typeof providers)[number],
  tool: string,
  address: string,
  args: Record<string, unknown> | undefined,
  classification: "read" | "write",
  fail: (request: Request) => Response,
  handoffs: Parameters<typeof createMetaTools>[2] = {},
  options: { failAuxiliary?: boolean } = {},
) {
  if (provider.name === "github") {
    const fake = apiFixture();
    fake.respond((request) => {
      if (request.url.pathname === "/app/installations" || request.url.pathname.endsWith("/access_tokens"))
        return undefined;
      if (request.url.pathname === "/installation/repositories" && tool !== "list_scopes") return undefined;
      if (tool === "merge_pull_request" && request.method === "GET" && !options.failAuxiliary)
        return Response.json({
          head: { sha: args!.sha, repo: { full_name: `${args!.owner}/${args!.repo}` } },
          base: { repo: { full_name: `${args!.owner}/${args!.repo}` } },
        });
      return fail(new Request(request.url, { method: request.method }));
    });
  } else {
    // Each login and refresh mints a token the vendor has not seen, as real
    // ones do: only a different credential renews a 401 (Q8).
    let minted = 0;
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
            accessToken: `fixture-machine-token-${++minted}`,
            expiresIn: 3600,
            tokenType: "Bearer",
          });
        if (url.pathname === "/oauth/token")
          return Response.json({
            access_token: `fixture-oauth-token-${++minted}`,
            refresh_token: "fixture-refresh-token",
            token_type: "bearer",
            expires_in: 7200,
            scope: "read:individuals",
          });
        if (provider.name === "drive" && tool === "move_file" && !options.failAuxiliary && request.method === "GET")
          return Response.json({ parents: ["old-1"] });
        if (provider.name === "gmail" && tool === "update_draft" && !options.failAuxiliary) {
          // Let the auxiliary lookup succeed so the sweep refuses the draft
          // replacement itself, rather than a write that was never sent.
          if (request.method === "GET")
            return Response.json({
              id: "d1",
              message: {
                id: "m1",
                payload: {
                  mimeType: "text/plain",
                  headers: [{ name: "To", value: "bob@example.com" }],
                  body: { data: "T2xk" },
                },
              },
            });
          expect(request.method).toBe("PUT");
        }
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
    classification: { [connector.id]: { [tool]: classification } },
  });
  if (provider.name === "ccb") {
    const ctx = registry.contextFor(connector.id, BASE);
    const started = await connector.startAuth!(ctx);
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    expect(await connector.verifyState!(state, ctx)).toBe(true);
    await connector.finishAuth!("fixture-code", ctx, new URLSearchParams({ code: "fixture-code", state }));
  }
  expect(args, `Missing dispatch example for ${address}`).toBeDefined();
  const meta = createMetaTools(registry, BASE, handoffs);
  const invoke = classification === "write" ? meta.callDestructiveTool : meta.callTool;
  return invoke({ address, args: args! });
}

/** One call through the invocation layer; `read` may hold the nth credential read back. */
async function invoke(
  connector: Connector,
  tool: string,
  classification: "read" | "write",
  args = {},
  read?: (index: number) => Promise<void>,
) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  const values = credential(connector.id);
  await vault.setAll(connector.id, values, "fixture");
  vi.spyOn(vault, "get").mockImplementation(async (_id, field = "value") => values[field] ?? null);
  let reads = 0;
  vi.spyOn(vault, "getAll").mockImplementation(async () => {
    await read?.(++reads);
    return values;
  });
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

function googleFetch(resource: (request: Request) => Response | Promise<Response>) {
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

// Whole-call failures, beyond the first resource request covered above.
describe("round-5 whole-call failure sweep", () => {
  it.each([
    ["single refusal", false, false, "rate_limited", 429, false],
    // Round 12: a refusing status the provider reads as `unavailable` is not proof.
    ["refusing status read as unavailable", false, false, "unavailable", 404, true],
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
      const connector = tracksEveryRequest(
        api("tickets", {
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
        }),
      );
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
    const connector = tracksEveryRequest(
      api("tickets", {
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
      }),
    );
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
    const connector = tracksEveryRequest(
      api("tickets", {
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
      }),
    );
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
        const connector = tracksEveryRequest(
          api("tickets", {
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
          }),
        );
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
          // A typed code after a 200 is no refusal provenance (round 11).
        ).toBe("unknown");
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
        // POST is never replayed, even when deployment policy serves this tool as a read (0010 B.2).
        expect(requests.map((r) => r.method)).toEqual(["POST", "POST"]);
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
      const connector = provider("forms");
      const registry = makeRegistry([connector], { classification: { forms: { get_form: classification } } });
      const ctx = registry.contextFor("forms", BASE);
      const { boundCursor } = await import("../src/http/paging.js");
      const { runEdge } = await import("../src/runtime/run.js");
      const { fromConnectorContext } = await import("../src/http/services.js");
      const { Effect } = await import("effect");
      const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["get_form", "form-1"]))),
      );
      const b64url = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const lease = fromConnectorContext(ctx, classification);
      const cursor = await runEdge(
        boundCursor
          .encode(
            "get_form",
            { formId: "form-1" },
            JSON.stringify({ d: b64url(String.fromCharCode(...bytes.subarray(0, 16))), i: 0, q: 0, r: "old" }),
          )
          .pipe(Effect.provideContext(lease.services)),
      );
      const result = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
        "forms.get_form",
        { formId: "form-1", cursor },
        { source: classification === "write" ? "call_destructive_tool" : "call_tool" },
      );
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
        "github_api_write",
        "write",
        argumentsTable.github!["github_api_write"]!,
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
      "tithely_api_write",
      "write",
      argumentsTable.tithely!["tithely_api_write"]!,
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

// A write is a known failure only on positive evidence: every scenario here
// once reported one without it.
describe("round-6 write evidence sweep", () => {
  /** Let every timer and microtask the released work schedules run out. */
  async function drained(): Promise<void> {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function stateOf(result: Awaited<ReturnType<typeof invoke>>) {
    if (result.ok) throw new Error("expected failure");
    return outcomes.classifyWriteOutcome({
      ok: false,
      dispatched: result.dispatched,
      answered: result.answered === true,
      error: result.error,
    });
  }

  it("INV-9: a write's early refusal closes the call, so siblings awaiting credentials never leave", async () => {
    const requests = googleFetch(() =>
      Response.json({ errors: [{ status: "429", title: "Too many requests" }] }, { status: 429 }),
    );
    // The three requests start together and each reads its credential
    // twice. The siblings' first reads (the 2nd and 3rd) wait, as a slow
    // credential read can, until after the outcome is reported.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const result = await invoke(
      provider("planning-center"),
      "get_plan",
      "write",
      argumentsTable["planning-center"]!["get_plan"]!,
      async (index) => {
        if (index === 2 || index === 3) await held;
      },
    );
    expect(requests).toHaveLength(1);
    // Nothing else left: the sole resource request's own refusal is known.
    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited", retryable: true } });
    if (result.ok) throw new Error("expected failure");
    expect(result.error).not.toHaveProperty("writeOutcome");
    expect(stateOf(result)).toBe("failed");
    release();
    await drained();
    expect(requests).toHaveLength(1);
  });

  it("INV-9: a write's early refusal with siblings still in flight is unknown, and nothing more leaves", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const requests = googleFetch(async () => {
      if (requests.length > 1) {
        await held;
        return Response.json({ data: [] });
      }
      return Response.json({ errors: [{ status: "429", title: "Too many requests" }] }, { status: 429 });
    });
    const result = await invoke(
      provider("planning-center"),
      "get_plan",
      "write",
      argumentsTable["planning-center"]!["get_plan"]!,
    );
    expect(requests).toHaveLength(3);
    expect(result).toMatchObject({ ok: false, error: { retryable: false, writeOutcome: "unknown" } });
    expect(stateOf(result)).toBe("unknown");
    release();
    await drained();
    expect(requests).toHaveLength(3);
  });

  it("INV-9: a request a handler starts after its call settled is refused before credential reads and send", async () => {
    const requests = googleFetch(() => Response.json({}));
    let later!: Promise<unknown>;
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send a ticket",
            annotations: { readOnlyHint: false },
            handler: async (_args, ctx) => {
              later = Promise.resolve().then(() => send({ method: "POST", path: "/late" }, ctx, (r) => r.json()));
              later.catch(() => {});
              throw new ConnectorCallError("invalid_args", "Refused before any request.");
            },
          },
        ],
      }),
    );
    const result = await invoke(connector, "send", "write");
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(later).rejects.toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("already ended"),
    });
    expect(requests).toHaveLength(0);
  });

  // No network failure proves a write unsent: one send can hide several
  // attempts (a 421 or HTTP/2 refused-stream resend, a retrying dispatcher).
  // Whatever the body, a refusal on the last attempt leaves the write unknown.
  function streamed(bytes: number): ReadableStream<Uint8Array> {
    let pulls = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new Uint8Array(bytes).fill(65));
          else controller.error(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        },
      },
      { highWaterMark: 0 },
    );
  }
  /** A Blob whose own stream() produces bytes, then fails like a connect. */
  function producingBlob(bytes: number): Blob {
    const blob = new Blob([new Uint8Array(bytes * 2)]);
    Object.defineProperty(blob, "stream", { value: () => streamed(bytes) });
    return blob;
  }
  const refusedErrno = () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });

  it.each([
    ["a streamed body pulled before its producer raised ECONNREFUSED", "pulled"],
    ["no body", "none"],
    ["a Blob whose stream() streamed bytes before ECONNREFUSED", "blob"],
  ] as const)("INV-9: a write refused at connect with %s is unknown", async (_name, body) => {
    const received: number[] = [];
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      // A runtime-shaped fetch: it streams what it pulls, then rejects with
      // the failure it met, as undici does with `duplex: "half"`.
      fetch: async (_url, init) => {
        if (body === "pulled") {
          const reader = (init.body as ReadableStream<Uint8Array>).getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              received.push(value.byteLength);
            }
          } catch (cause) {
            throw new TypeError("fetch failed", { cause });
          }
        }
        // Blobs are read through their stream().
        const blobs = init.body instanceof Blob ? [init.body] : [];
        for (const blob of blobs) {
          if (!(blob instanceof Blob)) continue;
          const reader = blob.stream().getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              received.push(value.byteLength);
            }
          } catch (cause) {
            throw new TypeError("fetch failed", { cause });
          }
        }
        throw refusedErrno();
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send a ticket",
            annotations: { readOnlyHint: false },
            handler: (_args, ctx) =>
              send(
                {
                  method: "POST",
                  path: "/tickets",
                  ...(body === "pulled"
                    ? { rawBody: streamed(20) }
                    : body === "blob"
                      ? { rawBody: producingBlob(20) }
                      : {}),
                },
                ctx,
                (r) => r.json(),
              ),
          },
        ],
      }),
    );
    const result = await invoke(connector, "send", "write");
    if (body === "pulled" || body === "blob") expect(received).toEqual([20]);
    expect(result).toMatchObject({ ok: false, error: { retryable: false, writeOutcome: "unknown" } });
    expect(stateOf(result)).toBe("unknown");
  });

  it.each([
    ["aborted with a refusal-shaped reason", "aborted"],
    ["rejected with an errno that is not fetch's network error", "untyped"],
  ] as const)("INV-9: a guarded write %s is unknown", async (_name, kind) => {
    const controller = new AbortController();
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => {
        if (kind === "untyped") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        // Native fetch rejects with the abort reason exactly as given.
        controller.abort(refusedErrno());
        throw controller.signal.reason;
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send a ticket",
            annotations: { readOnlyHint: false },
            handler: (_args, ctx) =>
              send({ method: "POST", path: "/tickets", body: { title: "Fixture" } }, ctx, (r) => r.json()),
          },
        ],
      }),
    );
    const registry = makeRegistry([connector]);
    const ctx = registry.contextFor("tickets", BASE, undefined, { signal: controller.signal });
    const error = await connector.callTool("send", {}, ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    const direct = await send({ method: "POST", path: "/t" }, registry.contextFor("tickets", BASE), (r) =>
      r.json(),
    ).catch((e: unknown) => e);
    if (kind === "untyped") expect(direct).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  });

  it("INV-9: a direct guarded write without a ledger is unknown after any refusal; a read stays retryable", async () => {
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async (_url, init) => {
        await new Response(init.body).arrayBuffer().catch((cause: unknown) => {
          throw new TypeError("fetch failed", { cause });
        });
        throw refusedErrno();
      },
    });
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    const pulled = await send({ method: "POST", path: "/t", rawBody: streamed(20) }, ctx, (r) => r.json()).catch(
      (e: unknown) => e,
    );
    expect(pulled).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    const bodiless = await send({ method: "POST", path: "/t" }, ctx, (r) => r.json()).catch((e: unknown) => e);
    expect(bodiless).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    const read = await send({ method: "GET", path: "/t", classification: "read" }, ctx, (r) => r.json()).catch(
      (e: unknown) => e,
    );
    expect(read).toMatchObject({ code: "unavailable", retryable: true, details: { code: "ECONNREFUSED" } });
    expect((read as ConnectorCallError).writeOutcome).toBeUndefined();
  });

  function custom(handler: (ctx: Parameters<Connector["callTool"]>[2]) => Promise<unknown>, tracked = false) {
    const connector = api("tickets", {
      tools: [
        {
          name: "send",
          description: "Send a ticket",
          inputSchema: { type: "object", properties: { title: { type: "string" } }, additionalProperties: false },
          annotations: { readOnlyHint: false },
          handler: (_args, ctx) => handler(ctx),
        },
      ],
    });
    return tracked ? tracksEveryRequest(connector) : connector;
  }

  it("INV-9: an untracked handler's successful global fetch, then a typed failure, is unknown", async () => {
    const requests = googleFetch(() => Response.json({ id: "ticket-1" }));
    const result = await invoke(
      custom(async () => {
        await globalThis.fetch("https://tickets.example/tickets", { method: "POST", body: "{}" });
        throw new ConnectorCallError("connector_call_failed", "Ticket follow-up failed.", { retryable: false });
      }),
      "send",
      "write",
    );
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { retryable: false, writeOutcome: "unknown" } });
    expect(stateOf(result)).toBe("unknown");
  });

  it.each([
    ["an untracked handler served write", false, "write", true],
    ["a tracked handler served write", true, "write", false],
    ["an untracked handler served read", false, "read", false],
  ] as const)("INV-9: %s refusing before any request", async (_name, tracked, classification, unknown) => {
    const requests = googleFetch(() => Response.json({}));
    const result = await invoke(
      custom(async () => {
        throw new ConnectorCallError("invalid_args", "Ticket title is required.");
      }, tracked),
      "send",
      classification,
    );
    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_args", retryable: false, ...(unknown ? { writeOutcome: "unknown" } : {}) },
    });
    if (!unknown && !result.ok) expect(result.error).not.toHaveProperty("writeOutcome");
    if (classification === "write") expect(stateOf(result)).toBe(unknown ? "unknown" : "failed");
  });

  it("INV-9: failures before an untracked handler runs stay known: argument validation and authorization", async () => {
    const requests = googleFetch(() => Response.json({}));
    const handler = vi.fn(async () => ({}));
    const invalid = await invoke(custom(handler), "send", "write", { title: 7 });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    if (invalid.ok) throw new Error("expected failure");
    expect(invalid.error).not.toHaveProperty("writeOutcome");
    expect(stateOf(invalid)).toBe("failed");
    const oauth = api("tickets", {
      oauth: {
        authorizationEndpoint: "https://tickets.example/authorize",
        tokenEndpoint: "https://tickets.example/token",
        clientId: "fixture-client",
        apiOrigins: ["https://tickets.example"],
      },
      tools: [{ name: "send", description: "Send a ticket", annotations: { readOnlyHint: false }, handler }],
    });
    const unauthorized = await invoke(oauth, "send", "write");
    expect(unauthorized).toMatchObject({ ok: false, error: { code: "downstream_oauth_required" } });
    if (unauthorized.ok) throw new Error("expected failure");
    expect(unauthorized.error).not.toHaveProperty("writeOutcome");
    expect(stateOf(unauthorized)).toBe("failed");
    expect(handler).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
});
