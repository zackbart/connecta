// A dispatched write is a known failure only on refusal provenance recorded
// where the evidence was observed (#902 round 11): the ledger shows it never
// left, or the downstream served a refusing HTTP status (a 4xx other than
// 408). An error code thrown after dispatch (a mapper's rate_limited, an
// output validator's invalid_args, a JSON-RPC -32602) is never that evidence,
// on direct and served calls and in program accounting alike. Nor is an
// operation hint: only an idempotency key the vendor honors makes a direct
// write repeatable. Round 12: a custom connector, an input_required
// suspension, and a provider that reads a refusing status as `unavailable`
// prove nothing either. Round 13: refusal evidence holds only for its whole
// logical call, and a write's MCP isError is no evidence at all. Round 14:
// the identities that decide a logical call are captured when they run.
// Round 15: they are invoked with Reflect.apply and bound to the objects that
// own them, so a function's own `call` or a copy of a boundary borrows nothing.
// Round 16: key-reuse advice holds only when its key protects the whole
// logical call: one boundary, one write sent, carrying that key.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { Effect, Schema } from "effect";
import { guardedClient } from "../src/http/client.js";
import { resultSafety } from "../src/http/safety.js";
import { write } from "../src/http/tools.js";
import { connect, vendor, get, post } from "../src/http/vendor.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { CatalogService } from "../src/catalog-service.js";
import { recordRecovery } from "../src/call-recovery.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError, resendAdvice } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { InvocationService } from "../src/invocation.js";
import { delegatesEachCall, tracksEveryRequest } from "../src/provider-call.js";
import { github } from "../src/providers/github/index.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import { sheets } from "../src/providers/sheets/index.js";
import { hatch } from "../src/http/hatch.js";
import { STRIPE_VERDICTS, stripeBinding, stripeConnection, stripeIndex } from "../src/providers/stripe/api.js";
import { stripe } from "../src/providers/stripe/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, Executor } from "../src/types.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { writeStateOf } from "../src/program-writes.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { googleOptions } from "./fixtures/provider-options.js";
import { PRIVATE_KEY } from "./fixtures/rsa.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.example";

beforeEach(() => {
  installOwnedTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function failure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("an error code after dispatch is no refusal (round 11)", () => {
  it("INV-9: a direct guarded POST answered 200 whose mapper throws rate_limited is unknown, each time", async () => {
    let sent = 0;
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => {
        sent++;
        return Response.json({ created: sent });
      },
    });
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await failure(
        send({ method: "POST", path: "/items" }, ctx, () => {
          throw new ConnectorCallError("rate_limited", "Later quota check failed");
        }),
      );
      expect(classifyCallError(error)).toEqual({
        code: "rate_limited",
        message: "Later quota check failed",
        retryable: false,
        writeOutcome: "unknown",
      });
    }
    expect(sent).toBe(2);
  });

  it("INV-9: only a complete call's auxiliary-only failure rules out a write, including a reported timeout", async () => {
    let sent = 0;
    const deadline = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => {
        sent++;
        return Response.json({}, { status: 408 });
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send",
            annotations: { readOnlyHint: false },
            handler: (_args, ctx) =>
              deadline({ method: "POST", path: "/items" }, ctx, () => {
                throw new ConnectorCallError("timeout", "The request timed out");
              }),
          },
        ],
      }),
    );
    const error = await failure(connector.callTool("send", {}, makeRegistry([connector]).contextFor("tickets", BASE)));
    expect(sent).toBe(1);
    expect(classifyCallError(error)).toMatchObject({ code: "timeout", retryable: false, writeOutcome: "unknown" });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("unknown");

    for (const code of ["auth_required", "timeout", "unavailable"] as const) {
      for (const ownership of ["auxiliary", "call-owned"] as const) {
        for (const tracking of ["complete", "untracked", "wrapper", "no-ledger", "explicit-marker"] as const) {
          const explicitMarker = tracking === "explicit-marker";
          if (explicitMarker && (ownership !== "auxiliary" || code === "timeout")) continue;
          const label = `${code}, ${ownership}, ${tracking}`;
          const requests: string[] = [];
          const request = guardedFetch({
            provider: "Tickets",
            baseUrl: "https://tickets.test",
            authenticate: () => ({}),
            maxResponseBytes: 1024,
            fetch: async (_input, init) => {
              requests.push(init?.method ?? "GET");
              return Response.json({}, { status: code === "auth_required" ? 401 : code === "timeout" ? 408 : 503 });
            },
          });
          const send = (ctx: ConnectorContext) =>
            request(
              {
                method: ownership === "auxiliary" ? "GET" : "POST",
                path: "/items",
                auxiliary: ownership === "auxiliary",
                classification: ownership === "auxiliary" ? "read" : "write",
              },
              ctx,
              () => {
                throw resendAdvice(
                  new ConnectorCallError(code, "The request failed.", {
                    retryable: code === "unavailable",
                    ...(explicitMarker ? { writeOutcome: "unknown" } : {}),
                  }),
                  "Retry this call later.",
                );
              },
            );
          let boundary = api("tickets", {
            tools: [
              {
                name: "send",
                description: "Look up, then send",
                annotations: { readOnlyHint: false },
                handler: (_args, ctx) => send(ctx),
              },
            ],
          });
          if (tracking !== "untracked") boundary = tracksEveryRequest(boundary);
          const target: Connector =
            tracking === "no-ledger"
              ? { ...boundary, callTool: (_name, _args, ctx) => send(ctx) }
              : tracking === "wrapper"
                ? { ...boundary }
                : boundary;
          const registry = makeRegistry([target]);
          const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
            "tickets.send",
            {},
            { source: "call_destructive_tool" },
          );
          expect(requests, label).toEqual([ownership === "auxiliary" ? "GET" : "POST"]);
          if (served.ok) throw new Error(`expected failure: ${label}`);
          const noWrite = ownership === "auxiliary" && tracking === "complete";
          expect(served.answered, label).toBe(noWrite || (explicitMarker && code === "unavailable"));
          expect(classifyWriteOutcome(served), label).toBe(noWrite ? "failed" : "unknown");
          if (noWrite) expect(served.error.writeOutcome, label).toBeUndefined();
          else if (code !== "timeout") expect(served.error.writeOutcome, label).toBe("unknown");
          expect(served.error.code, label).toBe(
            code === "timeout" && !noWrite
              ? "write_outcome_unknown"
              : code === "unavailable" && (ownership === "call-owned" || tracking === "untracked")
                ? "connector_call_failed"
                : code,
          );
          if (code === "timeout" && !noWrite) expect(served.error.uncertainCall, label).toBeDefined();
          else expect(served.error.uncertainCall, label).toBeUndefined();
          if (code === "auth_required") {
            expect(served.error.reconciliationRequired, label).toBe(noWrite ? undefined : true);
            expect(served.error.retry, label).toBe(
              noWrite
                ? "Retry tickets.send after the operator completes recovery."
                : "This write may have partially run. Reconcile its target before retrying after the operator completes recovery.",
            );
          }
          if (code === "unavailable") {
            expect(served.error.retryable, label).toBe(noWrite);
            expect(served.error.message.includes("Retry this call later."), label).toBe(noWrite);
          }
          if (explicitMarker) {
            const program = await catchingProgram(registry, "tickets.send");
            expect(program.structuredContent, label).toMatchObject({
              error: {
                retryable: false,
                writes: { succeeded: 0, failed: 0, unknown: 1 },
                ...(code === "auth_required" ? { reconciliationRequired: true } : {}),
              },
            });
            expect(JSON.stringify(program.structuredContent), label).not.toContain("Retry this call later.");
            expect(requests, label).toEqual(["GET", "GET"]);
          }
        }
      }
    }

    // A kit auxiliary POST (or method override) is physical write work even
    // though its declaration calls it a read. Non-timeout failures agree too.
    for (const method of ["POST", "override"] as const) {
      for (const status of [503, 400]) {
        const sends: string[] = [];
        vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
          sends.push(init?.method ?? "GET");
          return Response.json({}, { status: sends.length % 2 === 1 ? 200 : status });
        });
        const connection = connect(
          vendor("tickets", get("lookup", "/lookup"), post("send", "/items")),
          guardedClient({
            provider: "Tickets",
            baseUrl: "https://tickets.test",
            maxResponseBytes: 1024,
            authenticate: Effect.succeed({}),
          }),
          {
            errors: {
              provider: "Tickets",
              facts: () => ({}),
              detail: ({ status }) => `Tickets returned HTTP ${status}.`,
              unreadable: "Tickets returned an unreadable response.",
              statuses: {
                400: () => ({ code: "unavailable", retryable: true }),
                401: () => ({ code: "auth_required" }),
                403: () => ({ code: "provider_permission_denied" }),
                404: () => ({ code: "not_found" }),
              },
            },
            safety: resultSafety({
              review: "Fixture responses contain no credentials.",
              sensitiveFields: { names: [], choice: "drop" },
            }),
          },
        );
        const tool = write(connection, {
          name: "send",
          description: "Look up, then send an auxiliary-labelled request.",
          destructive: false,
          input: Schema.Struct({}),
          output: Schema.Unknown,
          writeSteps: { lookup: "once", write: "once" },
          run: () =>
            connection
              .sendPath({ method: "GET", path: "/lookup", template: "/lookup" }, { effect: "read", step: "lookup" })
              .pipe(
                Effect.flatMap(() =>
                  connection.sendPath(
                    method === "POST"
                      ? { method: "POST", path: "/items", template: "/items" }
                      : {
                          method: "GET",
                          path: "/lookup",
                          template: "/lookup",
                          headers: { "X-HTTP-Method-Override": "POST" },
                        },
                    { effect: "read", step: "write" },
                  ),
                ),
              ),
        });
        const registry = makeRegistry([tracksEveryRequest(api("tickets", { tools: [tool] }))]);
        const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
          "tickets.send",
          {},
          { source: "call_destructive_tool" },
        );
        if (served.ok) throw new Error("Expected an auxiliary write failure.");
        expect(served.error).toMatchObject({
          code: "connector_call_failed",
          retryable: false,
          writeOutcome: "unknown",
        });
        expect(classifyWriteOutcome(served)).toBe("unknown");
        const program = await catchingProgram(registry, "tickets.send");
        expect(program.structuredContent).toMatchObject({ error: { writes: { succeeded: 0, failed: 0, unknown: 1 } } });
        expect(sends).toEqual(["GET", method === "POST" ? "POST" : "GET", "GET", method === "POST" ? "POST" : "GET"]);
      }
    }

    // A proven auth refusal of the call's own write stays failed in both
    // the direct recovery advice and program accounting.
    for (const complete of [true, false]) {
      const untracked: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        untracked.push(String(input));
        return Response.json({ applied: true });
      });
      const authRefusal = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.test",
        authenticate: () => ({}),
        maxResponseBytes: 1024,
        fetch: async () => Response.json({}, { status: 403 }),
      });
      const boundary = api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send",
            annotations: { readOnlyHint: false },
            handler: async (_args, ctx) => {
              // This untracked write makes the following refused resource request
              // only part of the call: it cannot prove the whole call failed.
              if (!complete) await fetch("https://untracked.test/items", { method: "POST" });
              return authRefusal({ method: "POST", path: "/items" }, ctx, () => {
                throw new ConnectorCallError("auth_required", "Credential refused.");
              });
            },
          },
        ],
      });
      const refused = complete ? tracksEveryRequest(boundary) : boundary;
      const refusedRegistry = makeRegistry([refused]);
      const refusal = await new InvocationService(refusedRegistry, new CatalogService(refusedRegistry, BASE)).invoke(
        "tickets.send",
        {},
        { source: "call_destructive_tool" },
      );
      if (refusal.ok) throw new Error("Expected an auth refusal.");
      expect(classifyWriteOutcome(refusal)).toBe(complete ? "failed" : "unknown");
      expect(refusal.error.reconciliationRequired).toBe(complete ? undefined : true);
      expect(refusal.error.retry).toBe(
        complete
          ? "Fix the credentials, then retry tickets.send."
          : "This write may have partially run. Reconcile its target before retrying after the operator completes recovery.",
      );
      const refusedProgram = await catchingProgram(refusedRegistry, "tickets.send");
      if (complete) {
        expect(writeStateOf(refusal)).toBe("failed");
        expect(refusedProgram.structuredContent).toMatchObject({
          result: "caught and continued",
          hostCalls: { failed: 1 },
        });
        expect(refusedProgram.structuredContent).not.toHaveProperty("error");
        expect(untracked).toEqual([]);
      } else {
        expect(refusedProgram.structuredContent).toMatchObject({
          error: {
            reconciliationRequired: true,
            writes: { succeeded: 0, failed: 0, unknown: 1 },
          },
        });
        expect(untracked).toHaveLength(2);
      }
    }

    // A token POST alone supplies no auxiliary-read proof. Its direct auth
    // handoff and the caught program must both report an uncertain write.
    const token = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => Response.json({}, { status: 401 }),
    });
    const tokenBoundary = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Authenticate, then send",
            annotations: { readOnlyHint: false },
            handler: (_args, ctx) =>
              token({ method: "POST", path: "/token", auxiliary: true, classification: "write" }, ctx, () => {
                throw new ConnectorCallError("auth_required", "Token refused.");
              }),
          },
        ],
      }),
    );
    const tokenRegistry = makeRegistry([tokenBoundary]);
    const tokenFailure = await new InvocationService(tokenRegistry, new CatalogService(tokenRegistry, BASE)).invoke(
      "tickets.send",
      {},
      { source: "call_destructive_tool" },
    );
    expect(tokenFailure).toMatchObject({
      ok: false,
      answered: false,
      error: { code: "auth_required", retryable: false, reconciliationRequired: true },
    });
    expect(classifyWriteOutcome(tokenFailure)).toBe("unknown");
    expect((await catchingProgram(tokenRegistry, "tickets.send")).structuredContent).toMatchObject({
      error: { reconciliationRequired: true, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });

    // Maintained providers supply the same auxiliary-only evidence as the
    // synthetic rows: GitHub installation discovery and an unpinned zone's
    // ownership lookup both fail before the resource write can depart.
    for (const scenario of ["github-401", "cloudflare-401", "cloudflare-503"] as const) {
      const githubLookup = scenario === "github-401";
      const status = scenario === "cloudflare-503" ? 503 : 401;
      const zone = "023e105f4ecef8ad9ca31a8372d0c353";
      const path = githubLookup ? "/app/installations" : `/client/v4/zones/${zone}`;
      const requests: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json(
          githubLookup
            ? { message: "Lookup refused." }
            : { success: false, errors: [{ code: 10000, message: "Lookup refused." }] },
          { status },
        );
      });
      const connector = githubLookup
        ? github("tickets", {
            purpose: "Review",
            app: { appId: "12345", privateKey: PRIVATE_KEY },
            scopes: [{ org: "acme", access: "read-write" }],
          })
        : cloudflare("tickets", {
            purpose: "Review",
            auth: { type: "apiToken" },
            pin: { accountIds: ["0123456789abcdef0123456789abcdef"] },
          });
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, btoa("k".repeat(32)));
      await vault.set("tickets", "cf_7z9ob83m4p6x2q0l", "fixture");
      const registry = makeRegistry([connector], { storage, credentialVault: vault });
      const address = githubLookup ? "tickets.github_api_write" : "tickets.cloudflare_api_write";
      const args = githubLookup
        ? { method: "POST", path: "/repos/acme/one/releases", body: { tag_name: "v1.2.0" } }
        : { method: "PATCH", path: `/zones/${zone}/dns_records/r1`, body: { ttl: 300 } };
      const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(address, args, {
        source: "call_destructive_tool",
      });
      if (served.ok) throw new Error(`expected lookup failure: ${scenario}`);
      expect(served.answered, scenario).toBe(true);
      expect(classifyWriteOutcome(served), scenario).toBe("failed");
      expect(served.error, scenario).toMatchObject({
        code: status === 401 ? "auth_required" : "unavailable",
        retryable: status === 503,
        ...(status === 401 ? { retry: `Retry ${address} after the operator completes recovery.` } : {}),
      });
      expect(served.error, scenario).not.toHaveProperty("writeOutcome");
      expect(served.error, scenario).not.toHaveProperty("reconciliationRequired");
      // Fail after catching so program accounting renders its failed count.
      const program = await catchingProgram(registry, address, args, true);
      expect(program.structuredContent, scenario).toMatchObject({
        error: { writes: { succeeded: 0, failed: 1, unknown: 0 } },
      });
      expect(requests, scenario).toEqual([`GET ${path}`, `GET ${path}`]);
    }

    // Without complete auxiliary-read proof, a custom entry's declaration
    // and recovery facts cannot prove that a timed-out write never left.
    for (const entry of ["custom", "api", "declared-api", "declared-auth", "declared-override"] as const) {
      const declared = entry.startsWith("declared-");
      const sent: string[] = [];
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(init?.method ?? "GET");
        return Response.json({ id: "created" });
      });
      const lookup = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.test",
        authenticate: () => ({}),
        maxResponseBytes: 1024,
      });
      const run = async (ctx: ConnectorContext) => {
        recordRecovery(ctx, { idempotencyKey: "recorded-before-deadline" });
        if (entry === "api")
          await lookup({ method: "GET", path: "/items", auxiliary: true, classification: "read" }, ctx, (response) =>
            response.json(),
          );
        if (entry === "declared-auth")
          await lookup({ method: "POST", path: "/token", auxiliary: true, classification: "write" }, ctx, (response) =>
            response.json(),
          );
        if (entry === "declared-override")
          await lookup(
            {
              method: "GET",
              path: "/items",
              auxiliary: true,
              classification: "read",
              headers: { "X-HTTP-Method-Override": "POST" },
            },
            ctx,
            (response) => response.json(),
          );
        if (!declared) await fetch("https://tickets.test/items", { method: "POST" });
        throw new ConnectorCallError("timeout", "Lost reply.");
      };
      const boundary = api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send",
            annotations: { readOnlyHint: false },
            handler: (_args, ctx) => run(ctx),
          },
        ],
      });
      const target: Connector =
        entry === "custom"
          ? { ...boundary, callTool: (_name, _args, ctx) => run(ctx) }
          : declared
            ? tracksEveryRequest(boundary)
            : boundary;
      const registry = makeRegistry([target]);
      const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
        "tickets.send",
        {},
        { source: "call_destructive_tool" },
      );
      if (served.ok) throw new Error(`expected a timeout: ${entry}`);
      expect(served.error, entry).toMatchObject({
        code: "write_outcome_unknown",
        retryable: false,
        uncertainCall: { recovery: { idempotencyKey: "recorded-before-deadline" } },
      });
      expect(classifyWriteOutcome(served), entry).toBe("unknown");
      expect(served.error.retry, entry).not.toContain("cannot repeat the write");
      const program = await catchingProgram(registry, "tickets.send");
      expect(program.structuredContent, entry).toMatchObject({
        error: { code: "write_outcome_unknown", writes: { succeeded: 0, failed: 0, unknown: 1 } },
      });
      expect(sent, entry).toEqual(
        entry === "declared-api"
          ? []
          : entry === "api"
            ? ["GET", "POST", "GET", "POST"]
            : entry === "declared-override"
              ? ["GET", "GET"]
              : ["POST", "POST"],
      );
    }
  });
});

/**
 * A remote MCP server whose create_item runs (counted in `applied`) and then
 * fails on the way back: `output` lists an output schema its result breaks,
 * `invalidParams` has the server answer a malformed result the client
 * rejects as -32602.
 */
function brokenResult(mode: "output" | "invalidParams") {
  const state = { applied: 0 };
  const downstream = httpDownstream((server) => {
    server.registerTool(
      "create_item",
      { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
      async () => {
        state.applied++;
        return { content: [{ type: "text", text: "created" }], structuredContent: { id: "not-a-number" } };
      },
    );
    server.registerTool("list_items", { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
      content: [{ type: "text", text: "[]" }],
    }));
    if (mode === "invalidParams")
      server.server.setRequestHandler("tools/call", async () => {
        state.applied++;
        return { content: [{ type: "text", text: 17 as unknown as string }] };
      });
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: unknown; method?: string }) : {};
    const response = await downstream.fetch(String(input), init);
    if (mode === "output" && rpc.method === "tools/list") {
      await response.body?.cancel();
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [
            {
              name: "create_item",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false },
              outputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            },
          ],
        },
      });
    }
    return response;
  });
  const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
  const registry = makeRegistry([connector]);
  return { state, connector, registry };
}

describe("a remote MCP write that was sent: no JSON-RPC error or output verdict is a refusal (round 11)", () => {
  it.each([
    ["a failed output validation", "output"],
    ["a server's -32602 for a malformed result", "invalidParams"],
  ] as const)("INV-9: %s is unknown on the direct, served, and program paths", async (_label, mode) => {
    const { state, connector, registry } = brokenResult(mode);
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);

    const direct = await failure(connector.callTool("create_item", {}, ctx));
    expect(state.applied).toBe(1);
    expect(classifyCallError(direct)).toMatchObject({
      code: "invalid_args",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: direct as never })).toBe("unknown");

    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state.applied).toBe(2);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({ code: "invalid_args", retryable: false, writeOutcome: "unknown" });
    expect(served.error.retry).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("unknown");

    // A program that catches the failure still reports the unknown write.
    const executor: Executor = {
      async execute(_code, providers) {
        try {
          await providers.find((provider) => provider.name === "connecta")!.fns["call"]!("tickets.create_item", {});
        } catch {
          /* caught by the guest */
        }
        return { result: "caught and continued" };
      },
    };
    const execute = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false });
    const program = await execute({ code: "async () => null" });
    expect(state.applied).toBe(3);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
    await connector.closeScope?.(ctx);
  });

  it("INV-9: control: a refusal before the tools/call is sent stays a known failure, direct and served", async () => {
    const downstream = httpDownstream((server) => {
      server.registerTool(
        "create_item",
        { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
        async () => ({ content: [{ type: "text", text: "created" }] }),
      );
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: unknown; method?: string }) : {};
      if (rpc.method) calls.push(rpc.method);
      const response = await downstream.fetch(String(input), init);
      if (rpc.method !== "tools/list") return response;
      await response.body?.cancel();
      // A task-only tool: refused before its tools/call reaches fetch.
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [
            {
              name: "create_item",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false },
              execution: { taskSupport: "required" },
            },
          ],
        },
      });
    });
    const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
    const registry = makeRegistry([connector]);
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);
    const direct = await failure(connector.callTool("create_item", {}, ctx));
    expect(classifyCallError(direct).writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: direct as never })).toBe("failed");
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error.writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("failed");
    expect(calls).not.toContain("tools/call");
    await connector.closeScope?.(ctx);

    // Hold the warmed catalog, then force reconnect inside callTool to
    // receive a 401 before tools/call. An empty ledger supplies no auth proof.
    let deny = false;
    const authCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : {};
      if (deny) {
        if (rpc.method) authCalls.push(rpc.method);
        return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
      }
      return downstream.fetch(String(input), init);
    });
    const authConnector = remoteMcp("auth_tickets", { url: downstream.url, versionNegotiation: "legacy" });
    const authRegistry = makeRegistry([authConnector], { toolCacheTtlSeconds: 3600 });
    Object.assign(authConnector, {
      staticTools: await authConnector.listTools(authRegistry.contextFor("auth_tickets", BASE)),
    });
    await authConnector.closeScope?.(authRegistry.contextFor("auth_tickets", BASE));
    deny = true;
    const authFailure = await new InvocationService(authRegistry, new CatalogService(authRegistry, BASE)).invoke(
      "auth_tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    if (authFailure.ok) throw new Error("Expected a reconnect auth failure.");
    expect(authFailure.dispatched, JSON.stringify(authFailure)).toBe(true);
    expect(authFailure.error).toMatchObject({
      writeOutcome: "unknown",
      retryable: false,
      reconciliationRequired: true,
    });
    expect(classifyWriteOutcome(authFailure)).toBe("unknown");
    const authProgram = await catchingProgram(authRegistry, "auth_tickets.create_item");
    expect(authProgram.structuredContent).toMatchObject({ error: { writes: { succeeded: 0, failed: 0, unknown: 1 } } });
    expect(authCalls).not.toContain("tools/call");
    await authConnector.closeScope?.(authRegistry.contextFor("auth_tickets", BASE));
  });

  it("INV-9: control: an HTTP 4xx refusal of the tools/call stays known; a 408 is unknown", async () => {
    for (const [status, state] of [
      [422, "failed"],
      [408, "unknown"],
    ] as const) {
      let dispatched = 0;
      const downstream = httpDownstream((server) => {
        server.registerTool(
          "create_item",
          { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
          async () => ({ content: [{ type: "text", text: "created" }] }),
        );
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : {};
        if (rpc.method === "tools/call") {
          dispatched++;
          return new Response("refused", { status });
        }
        return downstream.fetch(String(input), init);
      });
      const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
      const ctx = makeRegistry([connector]).contextFor("tickets", BASE);
      await connector.listTools(ctx);
      const error = await failure(connector.callTool("create_item", {}, ctx));
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe(state);
      expect(classifyCallError(error).retryable).toBe(false);
      const registry = makeRegistry([connector]);
      const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
        "tickets.create_item",
        {},
        { source: "call_destructive_tool" },
      );
      if (served.ok) throw new Error("expected the remote MCP request to fail");
      expect(classifyWriteOutcome(served)).toBe(state);
      expect(served.error.retryable).toBe(false);
      expect(dispatched).toBe(2);
      if (status === 408) {
        expect(served.error).toMatchObject({
          code: "write_outcome_unknown",
          uncertainCall: { address: "tickets.create_item" },
        });
        const program = await catchingProgram(registry, "tickets.create_item");
        expect(program.structuredContent).toMatchObject({
          error: { code: "write_outcome_unknown", writes: { succeeded: 0, failed: 0, unknown: 1 } },
        });
        expect(dispatched).toBe(3);
      }
      await connector.closeScope?.(ctx);
    }
  });
});

describe("an operation hint grants no retry credit (round 11)", () => {
  it("INV-9: two direct Sheets update_values writes that time out after delivery are each unknown", async () => {
    const id = crypto.randomUUID();
    const origin = `${inject("evidenceHttpServer")}/${id}`;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "https://oauth2.googleapis.com/token"
        ? Promise.resolve(Response.json({ access_token: "fixture", expires_in: 3599 }))
        : real(`${origin}/hold`, init),
    );
    const connector = sheets("sheets", { ...googleOptions, subject: "alice@example.com", purpose: "Review" });
    const registry = makeRegistry([connector]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = registry.contextFor("sheets", BASE, undefined, { signal: AbortSignal.timeout(300) });
      const error = await failure(
        connector.callTool(
          "update_values",
          { spreadsheetId: "sheet-1", range: "Sheet1!A1", values: [["changed"]], valueInputOption: "RAW" },
          ctx,
        ),
      );
      expect(classifyCallError(error)).toMatchObject({ code: "timeout", retryable: false, writeOutcome: "unknown" });
    }
    const received = (await (await real(`${origin}/exchanges`)).json()) as Array<{ method: string }>;
    expect(received.map((exchange) => exchange.method)).toEqual(["POST", "POST"]);
  });
});

/** A program that calls `address` once, catches its failure, and returns. */
function catchingProgram(
  registry: ReturnType<typeof makeRegistry>,
  address: string,
  args: Record<string, unknown> = {},
  failAfterCatch = false,
) {
  const executor: Executor = {
    async execute(_code, providers) {
      try {
        await providers.find((provider) => provider.name === "connecta")!.fns["call"]!(address, args);
      } catch {
        /* caught by the guest */
      }
      return failAfterCatch
        ? { result: undefined, error: "Stopped after the caught call." }
        : { result: "caught and continued" };
    },
  };
  return createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
    code: "async () => null",
  });
}

describe("a served write's unknown outcome is final before any advice (round 12)", () => {
  /**
   * A custom connector (neither api() nor remoteMcp()) that applies each
   * call, counted in `applied`, and then throws `failure`.
   */
  function custom(failure: () => ConnectorCallError) {
    const state = { applied: 0 };
    const connector = {
      id: "tickets",
      kind: "api" as const,
      description: "Tickets",
      async listTools() {
        return [
          { name: "create_item", description: "Create", annotations: { readOnlyHint: false }, inputSchema: {} },
          { name: "list_items", description: "List", annotations: { readOnlyHint: true }, inputSchema: {} },
        ];
      },
      async callTool() {
        state.applied++;
        throw failure();
      },
    };
    const registry = makeRegistry([connector]);
    return { state, registry, invoke: new InvocationService(registry, new CatalogService(registry, BASE)) };
  }

  it.each([
    ["rate_limited", () => new ConnectorCallError("rate_limited", "A check after applying the write failed")],
    [
      "provider_permission_denied",
      () => new ConnectorCallError("provider_permission_denied", "A check after applying the write failed"),
    ],
    [
      "invalid_args with findings",
      () =>
        new ConnectorCallError("invalid_args", "A check after applying the write failed", {
          validation: { issues: [{ path: "/name", code: "type", expected: "string" }] },
        }),
    ],
  ] as const)(
    "INV-9: a custom connector's %s after entry is unknown, never retryable, with no retry advice",
    async (_label, failure) => {
      const { state, registry, invoke } = custom(failure);
      const served = await invoke.invoke("tickets.create_item", {}, { source: "call_destructive_tool" });
      expect(state.applied).toBe(1);
      if (served.ok) throw new Error("expected the served write to fail");
      expect(served.error).toMatchObject({ code: failure().code, retryable: false, writeOutcome: "unknown" });
      expect(served.error.retry).toBeUndefined();
      expect(served.error.nextAction).toBeUndefined();
      expect(classifyWriteOutcome(served)).toBe("unknown");

      const program = await catchingProgram(registry, "tickets.create_item");
      expect(state.applied).toBe(2);
      expect(program.structuredContent).toMatchObject({
        error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
      });
    },
  );
});

describe("a write's input_required suspension is no proof the handler never ran (round 12)", () => {
  /** A real SDK server whose tools suspend for input after `create_item` applied. */
  function suspending() {
    const state = { applied: 0 };
    const downstream = httpDownstream((server) => {
      server.registerTool("create_item", { annotations: { readOnlyHint: false } }, async () => {
        state.applied++;
        return { resultType: "input_required", requestState: "write-already-applied" } as never;
      });
      server.registerTool("list_items", { annotations: { readOnlyHint: true } }, async () => {
        return { resultType: "input_required", requestState: "read-state" } as never;
      });
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => downstream.fetch(String(input), init));
    const connector = remoteMcp("tickets", { url: downstream.url });
    const registry = makeRegistry([connector]);
    return { state, connector, registry };
  }

  it("INV-9: a served write suspended for input is unknown, told to reconcile, and counted unknown by a program", async () => {
    const { state, connector, registry } = suspending();
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state.applied).toBe(1);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({
      code: "input_required_unsupported",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(served.error.nextAction).toBeUndefined();
    expect(served.error.retry).toMatch(/^Do not resend this write\. Re-read its target/);
    expect(classifyWriteOutcome(served)).toBe("unknown");

    const program = await catchingProgram(registry, "tickets.create_item");
    expect(state.applied).toBe(2);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
    await connector.closeScope?.(ctx);
  });
});

describe("refusal evidence holds only for its whole logical call (round 13)", () => {
  const stripeWrite = (id: string) => ({ method: "DELETE", path: `/v1/customers/${id}` });

  /** A Stripe connection whose odd-numbered requests delete and even-numbered ones are refused 429. */
  async function billing() {
    const state = { sent: 0, applied: 0 };
    vi.stubGlobal("fetch", async () => {
      state.sent++;
      if (state.sent % 2 === 1) {
        state.applied++;
        return Response.json({ id: "cus_1", deleted: true });
      }
      return Response.json({ error: { type: "rate_limit_error", message: "Rate limit" } }, { status: 429 });
    });
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    return { state, connector, storage, vault };
  }

  /** A custom connector whose one tool composes `run` over the Stripe connection. */
  function composite(inner: Connector, run: (inner: Connector, ctx: ConnectorContext) => Promise<unknown>): Connector {
    return {
      id: "billing",
      kind: "api",
      ...(inner.credential ? { credential: inner.credential } : {}),
      description: "Composite operation",
      async listTools() {
        return [
          { name: "delete_pair", description: "Delete two", annotations: { readOnlyHint: false }, inputSchema: {} },
        ];
      },
      callTool: (_name, _args, ctx) => run(inner, ctx),
    };
  }

  it("INV-9: a composite's second Stripe DELETE refused 429 after its first applied is unknown, served and in a program", async () => {
    const { state, connector, storage, vault } = await billing();
    const wrapper = composite(connector, async (inner, ctx) => {
      await inner.callTool("stripe_api_write", stripeWrite("cus_1"), ctx);
      return await inner.callTool("stripe_api_write", stripeWrite("cus_2"), ctx);
    });
    const registry = makeRegistry([wrapper], { storage, credentialVault: vault });
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.delete_pair",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state).toEqual({ sent: 2, applied: 1 });
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.answered).toBe(false);
    expect(served.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    // Stripe's own back-off advice held only for the refused request.
    expect(served.error.message).toBe("Stripe rate_limit_error: Rate limit");
    expect(served.error.retry).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("unknown");

    const program = await catchingProgram(registry, "billing.delete_pair");
    expect(state).toEqual({ sent: 4, applied: 2 });
    expect(program.isError).toBe(true);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
  });

  it("INV-9: an untracked wrapper that sends on its own before one refused Stripe call never inherits the refusal", async () => {
    const { state, connector, storage, vault } = await billing();
    const wrapper = composite(connector, async (inner, ctx) => {
      await fetch("https://side.example/apply", { method: "POST" });
      return await inner.callTool("stripe_api_write", stripeWrite("cus_2"), ctx);
    });
    const registry = makeRegistry([wrapper], { storage, credentialVault: vault });
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.delete_pair",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state).toEqual({ sent: 2, applied: 1 });
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(classifyWriteOutcome(served)).toBe("unknown");
  });

  it("INV-9: control: Stripe's own single DELETE refused 429 stays a known failure with its advice", async () => {
    const { state, connector, storage, vault } = await billing();
    state.sent = 1; // The next request is refused.
    const registry = makeRegistry([connector], { storage, credentialVault: vault });
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.stripe_api_write",
      stripeWrite("cus_2"),
      { source: "call_destructive_tool" },
    );
    expect(state).toEqual({ sent: 2, applied: 0 });
    if (served.ok) throw new Error("expected the refusal");
    expect(served.answered).toBe(true);
    expect(served.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(served.error.writeOutcome).toBeUndefined();
    expect(served.error.message).toMatch(/Back off before retrying\.$/);
    expect(classifyWriteOutcome(served)).toBe("failed");
    state.sent++; // The direct request is refused too.
    const direct = classifyCallError(
      await failure(connector.callTool("stripe_api_write", stripeWrite("cus_4"), registry.contextFor("billing", BASE))),
    );
    expect(direct).toMatchObject({ code: "rate_limited", retryable: true });
    expect(direct.message).toMatch(/Back off before retrying\.$/);
  });
});

describe("a logical call's identities are captured when they run (round 14)", () => {
  const stripeWrite = { method: "DELETE", path: "/v1/customers/cus_2" };

  /** Stripe, behind a vault, whose odd-numbered requests apply and even-numbered ones are refused 429. */
  async function billing() {
    const state = { sent: 0, applied: 0 };
    vi.stubGlobal("fetch", async () => {
      state.sent++;
      if (state.sent % 2 === 1) {
        state.applied++;
        return Response.json({ id: "cus_1", deleted: true });
      }
      return Response.json({ error: { type: "rate_limit_error", message: "Rate limit" } }, { status: 429 });
    });
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    return { state, connector, storage, vault };
  }

  /** A custom write whose `run` gets the connector itself, so it can reassign its own callTool. */
  function wrapping(inner: Connector, run: (self: Connector, ctx: ConnectorContext) => Promise<unknown>): Connector {
    const self: Connector = {
      id: "billing",
      kind: "api",
      ...(inner.credential ? { credential: inner.credential } : {}),
      description: "Composite operation",
      async listTools() {
        return [
          { name: "delete_pair", description: "Delete two", annotations: { readOnlyHint: false }, inputSchema: {} },
        ];
      },
      callTool: (_name, _args, ctx) => run(self, ctx),
    };
    return self;
  }

  async function served(registry: ReturnType<typeof makeRegistry>) {
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.delete_pair",
      {},
      { source: "call_destructive_tool" },
    );
    if (outcome.ok) throw new Error("expected the served write to fail");
    return outcome;
  }

  it("INV-9: a wrapper that sends, reassigns its callTool to a declared delegator's, then rethrows a Stripe refusal is unknown", async () => {
    const delegator = github("github", {
      purpose: "Review",
      app: { appId: "12345", privateKey: PRIVATE_KEY },
      scopes: [{ org: "acme", access: "read-write" }],
    });
    const { state, connector, storage, vault } = await billing();
    const wrapper = wrapping(connector, async (self, ctx) => {
      await fetch("https://side.example/apply", { method: "POST" });
      self.callTool = delegator.callTool;
      return await connector.callTool("stripe_api_write", stripeWrite, ctx);
    });
    const initial = wrapper.callTool;
    const registry = makeRegistry([wrapper], { storage, credentialVault: vault });
    const outcome = await served(registry);
    expect(state).toEqual({ sent: 2, applied: 1 });
    expect(outcome.answered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(outcome.error.message).toBe("Stripe rate_limit_error: Rate limit");
    expect(classifyWriteOutcome(outcome)).toBe("unknown");

    wrapper.callTool = initial;
    const program = await catchingProgram(registry, "billing.delete_pair");
    expect(state).toEqual({ sent: 4, applied: 2 });
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
  });

  it("INV-9: a wrapper that reassigns the boundary's callTool to its own before entering it never passes for that boundary", async () => {
    let applied = 0;
    vi.stubGlobal("fetch", async () => {
      applied++;
      return Response.json({ ok: true });
    });
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => Response.json({}, { status: 429 }),
    });
    const boundary = tracksEveryRequest(
      api("billing", {
        tools: [
          {
            name: "create_item",
            description: "Create",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object" },
            handler: (_args, ctx) =>
              send({ method: "POST", path: "/items" }, ctx, () => {
                throw new ConnectorCallError("rate_limited", "Tickets is throttling.");
              }),
          },
        ],
      }),
    );
    const own = boundary.callTool;
    const wrapper = wrapping(boundary, async (self, ctx) => {
      await fetch("https://side.example/apply", { method: "POST" });
      boundary.callTool = self.callTool;
      return await own.call(boundary, "create_item", {}, ctx);
    });
    const outcome = await served(makeRegistry([wrapper]));
    expect(applied).toBe(1);
    expect(outcome.answered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(classifyWriteOutcome(outcome)).toBe("unknown");
  });

  it("INV-9: a declared delegator's verdict is unaffected by reassigning its callTool after dispatch", async () => {
    let sent = 0;
    const boundary = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "create_item",
            description: "Create",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object" },
            // Refused before anything left: the ledger is empty.
            handler: async () => {
              throw new ConnectorCallError("invalid_args", "Tickets refused the item before sending it.");
            },
          },
        ],
      }),
    );
    const delegator: Connector = delegatesEachCall({
      id: "tickets",
      kind: "api",
      description: "Tickets",
      async listTools() {
        return [{ name: "create_item", description: "Create", annotations: { readOnlyHint: false }, inputSchema: {} }];
      },
      async callTool(name, args, ctx, options) {
        delegator.callTool = async () => {
          sent++;
          throw new Error("never invoked by this call");
        };
        return await boundary.callTool(name, args, ctx, options);
      },
    });
    const registry = makeRegistry([delegator]);
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(sent).toBe(0);
    if (outcome.ok) throw new Error("expected the refusal");
    expect(outcome.answered).toBe(true);
    expect(outcome.error.code).toBe("invalid_args");
    expect(outcome.error.writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome(outcome)).toBe("failed");
  });
});

describe("a logical call's identities are bound to the objects that own them (round 15)", () => {
  const stripeWrite = { method: "DELETE", path: "/v1/customers/cus_2" };

  /** Stripe behind a vault: side requests apply, every Stripe request is refused 429. */
  async function billing() {
    const state = { applied: 0, refused: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://side.example/")) {
        state.applied++;
        return Response.json({ id: "created" });
      }
      state.refused++;
      return Response.json({ error: { type: "rate_limit_error", message: "Rate limit" } }, { status: 429 });
    });
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    return { state, connector, storage, vault };
  }

  /** Give `fn` an own `call` that runs `replacement` instead; returns the undo. */
  function shadowCall(fn: Connector["callTool"], replacement: (...args: unknown[]) => unknown): () => void {
    Object.defineProperty(fn, "call", { configurable: true, value: replacement });
    return () => delete (fn as { call?: unknown }).call;
  }

  function invoke(registry: ReturnType<typeof makeRegistry>, address: string, args: unknown) {
    return new InvocationService(registry, new CatalogService(registry, BASE)).invoke(address, args, {
      source: "call_destructive_tool",
    });
  }

  it("INV-9: a wrapper holding a declared delegator's callTool, whose own `call` sends and rethrows a Stripe refusal, never runs it", async () => {
    const delegator = github("github", {
      purpose: "Review",
      app: { appId: "12345", privateKey: PRIVATE_KEY },
      scopes: [{ org: "acme", access: "read-write" }],
    });
    const { state, connector, storage, vault } = await billing();
    let shadowed = 0;
    const wrapper: Connector = {
      id: "billing",
      kind: "api",
      ...(connector.credential ? { credential: connector.credential } : {}),
      description: "Composite operation",
      async listTools() {
        return [
          { name: "delete_pair", description: "Delete two", annotations: { readOnlyHint: false }, inputSchema: {} },
        ];
      },
      callTool: delegator.callTool,
    };
    const undo = shadowCall(delegator.callTool, async (_receiver, _name, _args, ctx) => {
      shadowed++;
      await fetch("https://side.example/apply", { method: "POST" });
      return await connector.callTool("stripe_api_write", stripeWrite, ctx as ConnectorContext);
    });
    try {
      const registry = makeRegistry([wrapper], { storage, credentialVault: vault });
      const outcome = await invoke(registry, "billing.delete_pair", {});
      expect(shadowed).toBe(0);
      expect(state).toEqual({ applied: 0, refused: 0 });
      if (outcome.ok) throw new Error("expected the delegator's refusal");
      // GitHub's own function refused the unknown tool, but on a copy: no standing.
      expect(outcome.answered).toBe(false);
      expect(outcome.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      expect(classifyWriteOutcome(outcome)).toBe("unknown");
      expect(outcome.error.message).not.toMatch(/retry/i);

      const program = await catchingProgram(registry, "billing.delete_pair");
      expect(shadowed).toBe(0);
      expect(program.structuredContent).toMatchObject({
        error: { code: "write_outcome_unknown", writes: { succeeded: 0, failed: 0, unknown: 1 } },
      });
    } finally {
      undo();
    }
  });

  it("INV-9: a copied Stripe boundary shares its callTool but not its standing, and its function's own `call` never runs", async () => {
    const { state, connector, storage, vault } = await billing();
    const own = connector.callTool;
    const copied: Connector = Object.assign({ custom: true }, connector);
    expect(copied.callTool).toBe(own);
    let shadowed = 0;
    const undo = shadowCall(own, async (receiver, ...args) => {
      shadowed++;
      await fetch("https://side.example/apply", { method: "POST" });
      return Reflect.apply(own, receiver, args);
    });
    try {
      const registry = makeRegistry([copied], { storage, credentialVault: vault });
      const outcome = await invoke(registry, "billing.stripe_api_write", stripeWrite);
      expect(shadowed).toBe(0);
      expect(state).toEqual({ applied: 0, refused: 1 });
      if (outcome.ok) throw new Error("expected the refusal");
      expect(outcome.answered).toBe(false);
      expect(outcome.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
      expect(outcome.error.message).toBe("Stripe rate_limit_error: Rate limit");
      expect(classifyWriteOutcome(outcome)).toBe("unknown");

      // Control: the genuine boundary, shadow still in place, stays known with its advice.
      const genuine = await invoke(
        makeRegistry([connector], { storage, credentialVault: vault }),
        "billing.stripe_api_write",
        stripeWrite,
      );
      expect(shadowed).toBe(0);
      expect(state).toEqual({ applied: 0, refused: 2 });
      if (genuine.ok) throw new Error("expected the refusal");
      expect(genuine.answered).toBe(true);
      expect(genuine.error).toMatchObject({ code: "rate_limited", retryable: true });
      expect(genuine.error.writeOutcome).toBeUndefined();
      expect(genuine.error.message).toBe("Stripe rate_limit_error: Rate limit Back off before retrying.");
      expect(classifyWriteOutcome(genuine)).toBe("failed");
    } finally {
      undo();
    }
  });

  it("INV-9: a boundary whose callTool property was replaced after construction loses its standing", async () => {
    const { state, connector, storage, vault } = await billing();
    const own = connector.callTool;
    connector.callTool = async (name, args, ctx, options) => {
      await fetch("https://side.example/apply", { method: "POST" });
      return await own(name, args, ctx, options);
    };
    const outcome = await invoke(
      makeRegistry([connector], { storage, credentialVault: vault }),
      "billing.stripe_api_write",
      stripeWrite,
    );
    expect(state).toEqual({ applied: 1, refused: 1 });
    if (outcome.ok) throw new Error("expected the refusal");
    expect(outcome.answered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(outcome.error.message).toBe("Stripe rate_limit_error: Rate limit");
  });
});

describe("a write's MCP isError is a 2xx reply, never a known failure (round 13)", () => {
  /** A real SDK server whose write applies, then answers isError over HTTP 200. */
  function erroring() {
    const state = { applied: 0, statuses: [] as number[] };
    const downstream = httpDownstream((server) => {
      server.registerTool("create_item", { annotations: { readOnlyHint: false } }, async () => {
        state.applied++;
        return { isError: true, content: [{ type: "text", text: "Follow-up quota check failed." }] };
      });
      server.registerTool("list_items", { annotations: { readOnlyHint: true } }, async () => {
        return { isError: true, content: [{ type: "text", text: "No such list." }] };
      });
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await downstream.fetch(String(input), init);
      if (typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call")
        state.statuses.push(response.status);
      return response;
    });
    const registry = makeRegistry([remoteMcp("tickets", { url: downstream.url })]);
    return { state, registry, invoke: new InvocationService(registry, new CatalogService(registry, BASE)) };
  }

  it("INV-9: a served write answered isError over HTTP 200 is unknown, keeps its text, and a program reports it", async () => {
    const { state, registry, invoke } = erroring();
    const served = await invoke.invoke("tickets.create_item", {}, { source: "call_destructive_tool" });
    expect(state.applied).toBe(1);
    expect(state.statuses).toEqual([200]);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.answered).toBe(false);
    expect(served.error).toMatchObject({
      code: "connector_call_failed",
      message: "Follow-up quota check failed.",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(classifyWriteOutcome(served)).toBe("unknown");

    const program = await catchingProgram(registry, "tickets.create_item");
    expect(state.applied).toBe(2);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
  });
});

describe("key-reuse advice needs its key to protect the whole logical call (round 16)", () => {
  const KEY_ADVICE = /cannot repeat the write|Reusing it|recovery\.idempotencyKey/;
  const create = (name: string, idempotencyKey?: string) => ({
    method: "POST",
    path: "/v1/customers",
    body: { name },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

  interface Sent {
    method: string;
    url: string;
    key: string | null;
    name: string | null;
  }

  /**
   * Stripe behind a vault. Every request is recorded with its key; `answer`
   * decides each reply. A create applies once per key, as Stripe's do.
   */
  async function billing(answer: (request: Sent, applied: number) => Response | Promise<Response>) {
    const state = { sent: [] as Sent[], applied: new Map<string, number>(), ticketsApplied: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const name = request.method === "POST" ? new URLSearchParams(await request.text()).get("name") : null;
      const sent = { method: request.method, url: request.url, key: request.headers.get("idempotency-key"), name };
      state.sent.push(sent);
      if (request.url === "https://tickets.example/create") {
        state.ticketsApplied++;
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
      }
      const applied = name ?? request.url;
      if (request.method === "POST" && (sent.key === null || !state.sent.slice(0, -1).some((s) => s.key === sent.key)))
        state.applied.set(applied, (state.applied.get(applied) ?? 0) + 1);
      return answer(sent, state.applied.get(applied) ?? 0);
    });
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    return { state, connector, storage, vault };
  }

  const created = (sent: Sent) => Response.json({ id: `cus_${sent.name}`, name: sent.name });
  const lost = () => Response.json({ error: { type: "api_error", message: "Later result lost" } }, { status: 500 });
  const refused = () =>
    Response.json({ error: { type: "invalid_request_error", message: "No such thing" } }, { status: 400 });

  /** A custom connector whose one write runs `run` over the Stripe connection. */
  function wrapper(inner: Connector, run: (args: Record<string, unknown>, ctx: ConnectorContext) => Promise<unknown>) {
    return {
      id: "billing",
      kind: "api",
      ...(inner.credential ? { credential: inner.credential } : {}),
      description: "Composite operation",
      async listTools() {
        return [{ name: "create_pair", description: "Create", annotations: { readOnlyHint: false }, inputSchema: {} }];
      },
      callTool: (_name, args, ctx) => run(args as Record<string, unknown>, ctx),
    } satisfies Connector;
  }

  function invoke(
    registry: ReturnType<typeof makeRegistry>,
    address: string,
    args: unknown,
    timeoutMs?: number,
  ): ReturnType<InvocationService["invoke"]> {
    return new InvocationService(registry, new CatalogService(registry, BASE)).invoke(address, args, {
      source: "call_destructive_tool",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  /** A program that catches the call's failure, then reuses the key it was handed. */
  async function reusingProgram(registry: ReturnType<typeof makeRegistry>, address: string) {
    const seen: unknown[] = [];
    const executor: Executor = {
      async execute(_code, providers) {
        const call = providers.find((provider) => provider.name === "connecta")!.fns["call"]!;
        try {
          await call(address, {});
        } catch (error) {
          seen.push(error);
          const key = (error as { data?: { uncertainCall?: { recovery?: { idempotencyKey?: string } } } }).data
            ?.uncertainCall?.recovery?.idempotencyKey;
          try {
            await call(address, { idempotencyKey: key });
          } catch (again) {
            seen.push(again);
          }
        }
        return { result: "caught" };
      },
    };
    const program = await createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: "async () => null",
    });
    return { program, seen };
  }

  function expectNoKeyAdvice(error: { message: string; retry?: string }) {
    expect(error.message).not.toMatch(KEY_ADVICE);
    expect(error.retry ?? "").not.toMatch(KEY_ADVICE);
  }

  it("INV-9: an api() composite's keyed Stripe create grants no advice to the unkeyed ticket POST that lost its reply", async () => {
    const { state, connector, storage, vault } = await billing(created);
    const composite = api("billing", {
      credential: connector.credential!,
      tools: [
        {
          name: "create_pair",
          description: "Create a customer and a ticket",
          annotations: { readOnlyHint: false },
          inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" } } },
          async handler(args, ctx) {
            await connector.callTool("stripe_api_write", create("first", String(args["idempotencyKey"])), ctx);
            return (await ctx.fetch("https://tickets.example/create", { method: "POST", body: "create" })).json();
          },
        },
      ],
    });
    const registry = makeRegistry([composite], { storage, credentialVault: vault });
    const first = await invoke(registry, "billing.create_pair", { idempotencyKey: "stable-first" });
    if (first.ok) throw new Error("expected the composite to fail");
    expect(first.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expectNoKeyAdvice(first.error);
    // The key stays as a diagnostic.
    expect(first.error.uncertainCall?.recovery).toEqual({ idempotencyKey: "stable-first" });
    expect(classifyWriteOutcome(first)).toBe("unknown");
    // Why: the same arguments again create one customer and a second ticket.
    await invoke(registry, "billing.create_pair", { idempotencyKey: "stable-first" });
    expect(state.applied.get("first")).toBe(1);
    expect(state.ticketsApplied).toBe(2);
  });

  it("INV-9: two keyed Stripe creates in an api() composite grant the second's key no advice, served and in a program", async () => {
    const { state, connector, storage, vault } = await billing((sent) =>
      sent.name === "first" ? created(sent) : lost(),
    );
    const composite = api("billing", {
      credential: connector.credential!,
      tools: [
        {
          name: "create_pair",
          description: "Create two customers",
          annotations: { readOnlyHint: false },
          inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" } } },
          async handler(args, ctx) {
            await connector.callTool("stripe_api_write", create("first"), ctx);
            return await connector.callTool(
              "stripe_api_write",
              create("second", args["idempotencyKey"] as string | undefined),
              ctx,
            );
          },
        },
      ],
    });
    const registry = makeRegistry([composite], { storage, credentialVault: vault });
    const first = await invoke(registry, "billing.create_pair", { idempotencyKey: "stable-second" });
    if (first.ok) throw new Error("expected the composite to fail");
    expect(first.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expectNoKeyAdvice(first.error);
    expect(first.error.uncertainCall?.recovery).toEqual({ idempotencyKey: "stable-second" });
    await invoke(registry, "billing.create_pair", { idempotencyKey: "stable-second" });
    // The first create's generated key was never the one reused.
    expect(state.applied.get("first")).toBe(2);

    const { program, seen } = await reusingProgram(registry, "billing.create_pair");
    expect(seen).toHaveLength(2);
    for (const error of seen) expect(JSON.stringify(error)).not.toMatch(KEY_ADVICE);
    expect(program.isError).toBe(true);
    expect(JSON.stringify(program.structuredContent)).not.toMatch(KEY_ADVICE);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", writes: { succeeded: 0, failed: 0, unknown: 2 } },
    });
    expect(state.applied.get("first")).toBe(4);
  });

  it("INV-9: a custom wrapper around one keyed Stripe call has one boundary and one request, but no standing, so no advice", async () => {
    const { state, connector, storage, vault } = await billing(lost);
    const registry = makeRegistry(
      [wrapper(connector, (_args, ctx) => connector.callTool("stripe_api_write", create("only"), ctx))],
      { storage, credentialVault: vault },
    );
    const served = await invoke(registry, "billing.create_pair", {});
    expect(state.sent).toHaveLength(1);
    if (served.ok) throw new Error("expected the write to fail");
    expect(served.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expectNoKeyAdvice(served.error);
    // The generated key is still reported, as a diagnostic.
    const key = state.sent[0]!.key!;
    expect(served.error.message).toContain(`Idempotency-Key: ${key}.`);
    expect(served.error.uncertainCall?.recovery).toEqual({ idempotencyKey: key });
  });

  it("INV-9: a call interrupted after two dispatches grants no advice to the key it was sending", async () => {
    const { state, connector, storage, vault } = await billing((sent) =>
      sent.name === "first" ? created(sent) : new Promise<Response>(() => {}),
    );
    const registry = makeRegistry(
      [
        wrapper(connector, async (_args, ctx) => {
          await connector.callTool("stripe_api_write", create("first"), ctx);
          return await connector.callTool("stripe_api_write", create("second", "pending-key"), ctx);
        }),
      ],
      { storage, credentialVault: vault },
    );
    const served = await invoke(registry, "billing.create_pair", {}, 300);
    expect(state.sent.map((sent) => sent.name)).toEqual(["first", "second"]);
    if (served.ok) throw new Error("expected the deadline");
    expect(served.error).toMatchObject({ code: "write_outcome_unknown", retryable: false });
    expectNoKeyAdvice(served.error);
    expect(served.error.uncertainCall?.recovery).toEqual({ idempotencyKey: "pending-key" });
  });

  /** A tracked api() over Stripe's own write tool, which `before` precedes in the same call. */
  async function lookupThenCreate(before: (ctx: ConnectorContext & { fetch: typeof fetch }) => Promise<unknown>) {
    const setup = await billing((sent) => (sent.method === "GET" ? Response.json({ data: [] }) : lost()));
    const options = { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" } as const;
    const connection = stripeConnection(options);
    // Use the shipped hatch/binding's raw handler inside this one api()
    // boundary; nesting another connector call would change the provenance.
    const write = hatch({
      name: "stripe",
      index: stripeIndex,
      verdicts: STRIPE_VERDICTS,
      connection,
      binding: stripeBinding({ connection, options }),
      idempotency: { header: "Idempotency-Key", methods: ["POST"] },
    }).find((tool) => tool.name === "stripe_api_write");
    if (!write) throw new Error("The Stripe hatch fixture must contain its write tool.");
    const tracked = tracksEveryRequest(
      api("billing", {
        credential: setup.connector.credential!,
        tools: [
          {
            name: "create_pair",
            description: "Look up, then create",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object" },
            async handler(_args, ctx) {
              await before(ctx);
              return await write.handler(create("only"), ctx);
            },
          },
        ],
      }),
    );
    const registry = makeRegistry([tracked], { storage: setup.storage, credentialVault: setup.vault });
    return { ...setup, served: await invoke(registry, "billing.create_pair", {}) };
  }

  it("INV-9: a keyed write after a proven GET in the same call keeps its advice", async () => {
    const read = guardedFetch({
      provider: "Stripe",
      baseUrl: "https://api.stripe.com",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
    });
    const { state, served } = await lookupThenCreate((ctx) =>
      read(
        { method: "GET", path: "/v1/customers/search", query: { query: "name" }, classification: "read" },
        ctx,
        (response) => response.json(),
      ),
    );
    expect(state.sent.map((sent) => sent.method)).toEqual(["GET", "POST"]);
    if (served.ok) throw new Error("expected the write to fail");
    expect(served.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(served.error.uncertainCall?.recovery).toEqual({ idempotencyKey: state.sent[1]!.key });
    expect(served.error.retry).toContain("cannot repeat the write");
  });

  it("INV-9: a GET without positive read evidence gives a later write's key no advice", async () => {
    const { served, state } = await lookupThenCreate((ctx) =>
      ctx.fetch("https://api.stripe.com/v1/customers/search?query=name", { method: "GET" }),
    );
    if (served.ok) throw new Error("expected the write to fail");
    expectNoKeyAdvice(served.error);
    expect(state.sent).toHaveLength(2);
  });

  it("INV-9: control: Stripe's own single keyed POST keeps its advice, direct and served", async () => {
    let answer: () => Response = lost;
    const { state, connector, storage, vault } = await billing(() => answer());
    const registry = makeRegistry([connector], { storage, credentialVault: vault });
    // The socket-only suite also covers these inputs on Node. Keep the same
    // pre-dispatch and recovery guarantees under workerd's native Headers.
    for (const idempotencyKey of [" ", "a\nb"]) {
      const args = { ...create("invalid"), idempotencyKey };
      const direct = classifyCallError(
        await failure(connector.callTool("stripe_api_write", args, registry.contextFor("billing", BASE))),
      );
      expect(direct).toMatchObject({ code: "invalid_args", retryable: false });
      expect(direct.message).toContain(
        "The idempotency key is blank or holds a character an HTTP header cannot carry.",
      );
      const served = await invoke(registry, "billing.stripe_api_write", args);
      if (served.ok) throw new Error("expected the invalid key to be refused");
      expect(served.error).toMatchObject({ code: "invalid_args", retryable: false });
      expect(served.error).not.toHaveProperty("uncertainCall");
    }
    expect(state.sent).toEqual([]);
    // Served, outcome unknown: the retry names the recovery key.
    const unknown = await invoke(registry, "billing.stripe_api_write", create("a"));
    if (unknown.ok) throw new Error("expected the write to fail");
    expect(unknown.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(unknown.error.uncertainCall?.recovery).toEqual({ idempotencyKey: state.sent[0]!.key });
    expect(unknown.error.retry).toContain("cannot repeat the write");
    // Served, a known refusal: the generated key's advice joins the message.
    answer = refused;
    const known = await invoke(registry, "billing.stripe_api_write", create("b"));
    if (known.ok) throw new Error("expected the refusal");
    expect(known.answered).toBe(true);
    expect(known.error.message).toContain(`Idempotency-Key: ${state.sent[1]!.key}. Reusing it with the exact`);
    // Direct: the boundary's own failure carries the advice.
    answer = lost;
    const direct = classifyCallError(
      await failure(connector.callTool("stripe_api_write", create("c"), registry.contextFor("billing", BASE))),
    );
    expect(direct).toMatchObject({ retryable: true });
    expect(direct.message).toContain(`Idempotency-Key: ${state.sent[2]!.key}. Reusing it with the exact`);
  });

  it("INV-9: a generated key that was never sent keeps its diagnostic, with no reuse advice, direct or served", async () => {
    const { state, connector } = await billing(() => lost());
    // No credential is configured, so the write fails before any request leaves.
    const storage = memoryStorage();
    const registry = makeRegistry([connector], {
      storage,
      credentialVault: new CredentialVault(storage, btoa("k".repeat(32))),
    });
    const error = await failure(
      connector.callTool("stripe_api_write", create("a"), registry.contextFor("billing", BASE)),
    );
    const direct = classifyCallError(error);
    expect(direct.code).toBe("auth_required");
    expect(direct.message).toMatch(/Idempotency-Key: [0-9a-f-]{36}\.$/);
    expectNoKeyAdvice(direct);
    const served = await invoke(registry, "billing.stripe_api_write", create("b"));
    if (served.ok) throw new Error("expected the write to fail");
    expect(served.error.code).toBe("auth_required");
    expectNoKeyAdvice(served.error);
    expect(state.sent).toEqual([]);
  });
});
