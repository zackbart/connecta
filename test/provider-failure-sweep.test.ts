// Focused fault probes for composite sends, auxiliary failures and late work.
// Shared HTTP journeys and required eval outcomes own ordinary provider failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch, oauthBearer } from "../src/connectors/guarded-fetch.js";
import { CredentialVault } from "../src/credentials.js";
import { deriveContext } from "../src/derived-context.js";
import { ConnectorCallError } from "../src/errors.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { InvocationService } from "../src/invocation.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { AppAuth } from "../src/providers/github/lib/auth.js";
import { restConnector } from "../src/providers/github/tools.js";
import { parseScopes, ScopePolicy } from "../src/providers/github/lib/scope.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import * as outcomes from "../src/write-outcome.js";
import { apiFixture, SCOPES } from "./fixtures/github-api.js";
import type { ContractFixture } from "./fixtures/provider-contract.js";
import { googleOptions } from "./fixtures/provider-options.js";
import { makeRegistry } from "./helpers.js";
import { providerFixtures } from "./providers.generated.js";

const BASE = "https://connecta.example";
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
  if (["gmail", "drive", "docs", "sheets", "slides", "forms"].includes(fixture.name))
    return fixture.create(fixture.name, { subject: "alice@example.com" });
  return fixture.create(fixture.name);
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
  return create(providerFixtures.find((fixture) => fixture.name === name)!);
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

// Failures that a single-request outcome cannot reproduce.
describe("composite and auxiliary failures", () => {
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
      const result = await invoke(provider("planning-center"), "get_plan", classification, {
        "serviceTypeId": "10",
        "planId": "20",
      });
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
      const result = await invoke(provider("github"), "github_api_write", "write", {
        "method": "PATCH",
        "path": "/repos/acme/one/releases/501",
        "body": { "draft": false },
      });
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
    const result = await invoke(provider("tithely"), "tithely_api_write", "write", {
      "method": "POST",
      "path": "/charges",
      "body": {
        "account_id": "user_jane",
        "pm_id": "pm_9",
        "organization_id": "org_1",
        "amount": 2555,
        "giving_type": "Tithe",
      },
    });
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
describe("in-flight and untracked write faults", () => {
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
      { "serviceTypeId": "10", "planId": "20" },
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
    const result = await invoke(provider("planning-center"), "get_plan", "write", {
      "serviceTypeId": "10",
      "planId": "20",
    });
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
