import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { createExecuteTool } from "../src/execute.js";
import { classifyCallError, type CallErrorDetails } from "../src/errors.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { grantFromOAuth } from "../src/http/oauth.js";
import { createMetaTools } from "../src/meta-tools.js";
import { providerRequests, tracksEveryRequest, type ProviderRequest } from "../src/provider-call.js";
import { openRequest } from "../src/runtime/call.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import { OAUTH_CHALLENGE_MAX_BYTES } from "../src/auth/renewable-grant.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { makeRegistry, silentLogger } from "./helpers.js";
import { deferred, scriptedExecutor } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";
import { oauthTransports, staticOAuthRequest, type OAuthTransport } from "./fixtures/static-oauth-transport.js";

const BASE = "https://connecta.example";
const ORIGIN = "https://tickets.example";
const TOKEN = `${ORIGIN}/token`;
const old = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
const fresh = { access_token: "fresh-access", refresh_token: "fresh-refresh", token_type: "Bearer" };
const namespace = scopes.connector("tickets");
const scenarios = [
  "success",
  "permanent refusal",
  "throttle",
  "DNS",
  "outage",
  "cancellation",
  "declared ceiling",
  "stream ceiling",
  "broken body",
] as const;
type Scenario = (typeof scenarios)[number];
type Entry = "served read" | "served write" | "direct write" | "caught program" | "uncaught program";
type AccountingError = CallErrorDetails & { writes?: { succeeded: number; failed: number; unknown: number } };
let previous: ReturnType<typeof configureGuardedTransport>;

beforeEach(() => {
  previous = configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
});
afterEach(() => {
  configureGuardedTransport(previous);
  vi.unstubAllGlobals();
});

async function run(
  transport: OAuthTransport,
  scenario: Scenario,
  entry: Entry,
  options: {
    built?: "read" | "write";
    method?: "GET" | "POST";
    override?: true;
    second401?: true;
    effect?: "read";
  } = {},
) {
  const storage = memoryStorage();
  await seedGrant(storage, { issuer: TOKEN, tokens: old }, "v3:seeded", namespace);
  const write = entry !== "served read";
  const built = options.built ?? (write ? "write" : "read");
  const method = options.method ?? (write ? "POST" : "GET");
  const resourceRequests: string[] = [];
  let tokenRequests = 0;
  let resourceEntries: readonly ProviderRequest[] = [];
  const tokenEntered = deferred<void>();
  const tokenReply = deferred<Response>();
  const tails: Promise<unknown>[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (String(input) === TOKEN) {
      tokenRequests++;
      tokenEntered.resolve();
      if (scenario === "cancellation") return tokenReply.promise;
      if (scenario === "permanent refusal") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (scenario === "throttle")
        return Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "Retry-After": "5" } });
      if (scenario === "DNS") throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      if (scenario === "outage") return new Response(null, { status: 503 });
      return Response.json(fresh);
    }
    resourceRequests.push(new Headers(init?.headers).get("authorization")!);
    if (resourceRequests.length > 1 && !options.second401) return Response.json({ ok: true });
    if (scenario === "declared ceiling")
      return new Response(null, { status: 401, headers: { "Content-Length": String(OAUTH_CHALLENGE_MAX_BYTES + 1) } });
    if (scenario === "stream ceiling")
      return new Response(new Uint8Array(OAUTH_CHALLENGE_MAX_BYTES + 1), { status: 401 });
    if (scenario === "broken body")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("untrusted body error"));
          },
        }),
        { status: 401 },
      );
    return new Response(null, { status: 401 });
  });
  const scope = {};
  const connector = tracksEveryRequest(
    api("tickets", {
      oauth: {
        authorizationEndpoint: `${ORIGIN}/authorize`,
        tokenEndpoint: TOKEN,
        clientId: "fixture-client",
        apiOrigins: [ORIGIN],
      },
      tools: [
        {
          name: "run",
          description: "Read or write tickets.",
          annotations: { readOnlyHint: built === "read" },
          async handler(_, ctx) {
            resourceEntries = providerRequests(ctx)!;
            return staticOAuthRequest(
              transport,
              ctx,
              ORIGIN,
              {
                method,
                path: "/notes",
                template: "/notes",
                ...(options.override ? { headers: { "X-HTTP-Method-Override": "DELETE" } } : {}),
              },
              built,
              options.effect,
            );
          },
        },
      ],
    }),
  );
  const registry = makeRegistry([connector], {
    storage,
    classification: { tickets: { run: write ? "write" : "read" } },
  });
  const requestOptions = { requestScope: scope, defer: (tail: Promise<unknown>) => tails.push(tail) };
  const meta = createMetaTools(registry, BASE, requestOptions);
  const call = (async (): Promise<{ error?: AccountingError; value?: unknown }> => {
    if (entry === "direct write") {
      try {
        return { value: await connector.callTool("run", {}, registry.contextFor("tickets", BASE, scope)) };
      } catch (error) {
        return { error: classifyCallError(error) };
      }
    }
    if (entry === "caught program" || entry === "uncaught program") {
      const execute = createExecuteTool(
        registry,
        BASE,
        scriptedExecutor(async (functions) => {
          try {
            await functions.call!("tickets.run", {});
          } catch (error) {
            if (entry === "uncaught program") throw error;
          }
          return "done";
        }),
        silentLogger,
        undefined,
        { ...requestOptions, readOnly: false },
      );
      return (await execute({ code: "async () => null" })).structuredContent as {
        error?: CallErrorDetails;
        value?: unknown;
      };
    }
    const result = await (write
      ? meta.callDestructiveTool({ address: "tickets.run" })
      : meta.callTool({ address: "tickets.run" }));
    return (result.structuredContent ?? {}) as { error?: CallErrorDetails; value?: unknown };
  })();
  try {
    if (scenario === "cancellation") {
      await tokenEntered.promise;
      openRequest(scope).close();
      // The caller must settle while the coordinator's token response is held.
      const timeout = Symbol("still pending");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            call,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(timeout), 250);
            }),
          ]),
        ).not.toBe(timeout);
      } finally {
        clearTimeout(timer);
      }
      tokenReply.resolve(Response.json(fresh));
    }
    const result = await call;
    await Promise.all(tails);
    if (options.second401) {
      const sent = resourceRequests.length;
      const again = await meta.callTool({ address: "tickets.run" });
      expect(again.structuredContent).toMatchObject({ error: { code: "downstream_oauth_required" } });
      expect(resourceRequests).toHaveLength(sent);
      expect(tokenRequests).toBe(1);
    }
    const error = result.error;
    const entries = resourceEntries.filter((request) => !request.auxiliary);
    return {
      error: error
        ? {
            code: error.code,
            retryable: error.retryable,
            writeOutcome: error.writeOutcome,
            handoff: error.nextAction && "tool" in error.nextAction ? error.nextAction.tool : undefined,
            writes: error.writes,
            outcome: classifyWriteOutcome({ ok: false, dispatched: entries.length > 0, answered: false, error }),
          }
        : undefined,
      entries: entries.map(({ status, renewed, method, auxiliary }) => ({ status, renewed, method, auxiliary })),
      resourceRequests,
      tokenRequests,
      rotated: (await storedGrant(storage, namespace))?.body?.tokens?.access_token === fresh.access_token,
    };
  } finally {
    tokenReply.resolve(Response.json(fresh));
    await call;
    await Promise.all(tails);
    openRequest(scope).close();
  }
}

describe("production static Grant and OAuth facade parity", () => {
  for (const entry of ["served read", "served write", "direct write", "caught program", "uncaught program"] as const) {
    const outcomes =
      entry === "served read" || entry === "served write"
        ? scenarios
        : (["success", "permanent refusal", "cancellation"] as const);
    it.each(outcomes)(
      `INV-7 INV-9: ${entry} preserves the resource verdict and accounting through %s`,
      async (scenario) => {
        const options =
          entry === "served read"
            ? { built: "write" as const, method: "GET" as const }
            : entry === "served write"
              ? { built: "read" as const, method: "GET" as const }
              : {};
        const facade = await run("facade", scenario, entry, options);
        const grant = await run("grant", scenario, entry, options);
        expect(grant).toEqual(facade);
        const oversized = scenario === "declared ceiling" || scenario === "stream ceiling";
        expect(grant.tokenRequests).toBe(oversized ? 0 : 1);
        const successfulRenewal = scenario === "success" || scenario === "broken body";
        expect(grant.entries[0]?.renewed).toBe(successfulRenewal ? true : undefined);
        expect(grant.resourceRequests).toHaveLength(entry === "served read" && successfulRenewal ? 2 : 1);
        if (entry === "served read" && successfulRenewal) expect(grant.error).toBeUndefined();
        if (entry !== "served read") {
          expect(grant.error).toMatchObject({
            code: successfulRenewal
              ? entry.includes("program")
                ? "write_outcome_unknown"
                : "connector_call_failed"
              : "downstream_oauth_required",
            retryable: false,
            writeOutcome: successfulRenewal && entry.includes("program") ? undefined : "unknown",
            outcome: "unknown",
          });
          if (entry.includes("program")) expect(grant.error?.writes).toEqual({ succeeded: 0, failed: 0, unknown: 1 });
        }
      },
    );
  }

  it.each(oauthTransports)("INV-9: %s never replays a request the core classifies as a write", async (transport) => {
    for (const options of [{ override: true as const }, { method: "POST" as const }]) {
      const result = await run(transport, "success", "served read", options);
      expect(result.resourceRequests).toHaveLength(1);
      expect(result.tokenRequests).toBe(1);
      expect(result.entries[0]?.renewed).toBe(true);
    }
  });

  it.each(oauthTransports)(
    "INV-7 INV-9: %s latches the request after the renewed read receives a second 401",
    async (transport) => {
      const result = await run(transport, "success", "served read", { second401: true });
      expect(result.resourceRequests).toEqual([`Bearer ${old.access_token}`, `Bearer ${fresh.access_token}`]);
      expect(result.error?.code).toBe("downstream_oauth_required");
    },
  );

  it("INV-9: an auxiliary POST uses core write classification and never replays", async () => {
    const result = await run("grant", "success", "served write", { effect: "read" });
    expect(result.resourceRequests).toHaveLength(1);
    expect(result.tokenRequests).toBe(1);
    expect(result.entries).toEqual([]);
  });

  it("INV-7: a static Grant adopts an already rotated token without another token request", async () => {
    const storage = memoryStorage();
    await seedGrant(storage, { issuer: TOKEN, tokens: old }, "v3:seeded", namespace);
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    const connector = api("tickets", {
      oauth: {
        authorizationEndpoint: `${ORIGIN}/authorize`,
        tokenEndpoint: TOKEN,
        clientId: "fixture-client",
        apiOrigins: [ORIGIN],
      },
      tools: [
        {
          name: "read",
          description: "Read.",
          annotations: { readOnlyHint: true },
          async handler(_, ctx) {
            const grant = grantFromOAuth(ctx.oauth!);
            expect(await runEdge(grant.token)).toBe(old.access_token);
            // Another request commits rotation before this caller reports its stale token.
            await seedGrant(storage, { issuer: TOKEN, tokens: fresh }, "v3:seeded", namespace);
            expect(await runEdge(grant.refresh(old.access_token))).toBe(fresh.access_token);
            expect(await runEdge(grant.token)).toBe(fresh.access_token);
            return { ok: true };
          },
        },
      ],
    });
    const result = await createMetaTools(makeRegistry([connector], { storage }), BASE).callTool({
      address: "tickets.read",
    });
    expect(result.isError).not.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});
