// One fixture table for the two Phase C transports; transport-specific verdict
// code is exercised at each edge, and the physical core ledger must agree.
import { Context, Effect } from "effect";
import * as Body from "effect/http/HttpBody";
import * as Request from "effect/http/HttpClientRequest";
import { afterEach, expect, it, vi } from "vitest";
import { guardedFetch, type GuardedRequest } from "../src/connectors/guarded-fetch.js";
import { guardedClient } from "../src/http/client.js";
import { RequestRefused, toConnectorCallError, type VendorErrors } from "../src/http/errors.js";
import { Dispatches, IdempotencyKey, fromConnectorContext } from "../src/http/services.js";
import { configureGuardedTransport, guardedTransport } from "../src/guarded-transport.js";
import { retryAfterMs } from "../src/http-policy.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { providerCallContext, providerRequests, closeProviderCall } from "../src/provider-call.js";
import { runEdge } from "../src/runtime/run.js";
import { sentSecretsForRequest } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";

const provider = "Tickets";
const baseUrl = "https://tickets.example/v1";
const headers = { Accept: "application/json", "x-order": "constant" };
const auth = { Authorization: "Bearer token-123456789" };
const errors: VendorErrors = {
  provider,
  facts: () => ({}),
  detail: () => "HTTP failure",
  unreadable: "Unreadable JSON.",
  statuses: {
    401: () => ({ code: "auth_required" }),
    403: () => ({ code: "provider_permission_denied" }),
    404: () => ({ code: "not_found" }),
  },
};
interface Fixture {
  name: string;
  request?: Partial<GuardedRequest>;
  response?: () => Response;
  fail?: string;
  admit?: boolean;
}
const fixtures: Fixture[] = [
  ...["/../escape", "/%2e%2e/escape", "relative", "/items?secret=x", "/items#x"].map((path) => ({
    name: path,
    request: { path },
  })),
  {
    name: "precedence and query",
    request: {
      headers: { "x-order": "request" },
      query: { ids: ["a b", "c+d"], absent: undefined, api_key: "query-123456789" },
    },
  },
  { name: "case-insensitive precedence", request: { headers: { "X-Order": "request" } } },
  { name: "auth collision", request: { headers: { authorization: "caller" } } },
  { name: "case-insensitive auth collision", request: { headers: { Authorization: "caller" } } },
  { name: "visible collision", request: { visibleHeaders: { "x-order": "duplicate" } } },
  { name: "admit", request: { query: { account: "other" } }, admit: true },
  { name: "json", request: { method: "POST", body: { id: "😀" } } },
  {
    name: "form",
    request: {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      rawBody: "password=form-123456789",
    },
  },
  { name: "raw", request: { method: "POST", rawBody: "unframed" } },
  ...[301, 302, 303, 307, 308].map((status) => ({
    name: `redirect ${status}`,
    response: () => new Response(null, { status, headers: { location: "https://outside.example" } }),
  })),
  { name: "declared ceiling", response: () => new Response("{}", { headers: { "content-length": "1000" } }) },
  {
    name: "HEAD declared ceiling",
    request: { method: "HEAD" },
    response: () => new Response(null, { headers: { "content-length": "1000" } }),
  },
  ...[204, 205, 304].map((status) => ({ name: `bodiless ${status}`, response: () => new Response(null, { status }) })),
  {
    name: "streamed ceiling",
    response: () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(40));
            c.enqueue(new Uint8Array(40));
          },
          cancel() {},
        }),
      ),
  },
  {
    name: "broken stream",
    response: () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("private body"));
          },
        }),
      ),
  },
  {
    name: "buffer fallback",
    response: () => {
      const response = new Response('{"ok":"😀"}');
      Object.defineProperty(response, "body", { value: null });
      return response;
    },
  },
  {
    name: "buffer fallback ceiling",
    response: () => {
      const response = new Response("x".repeat(65));
      Object.defineProperty(response, "body", { value: null });
      return response;
    },
  },
  { name: "not JSON", response: () => new Response("not JSON") },
  { name: "empty", response: () => new Response("") },
  ...["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].map((fail) => ({ name: fail, fail })),
  ...["2.5", "-1", "junk", "Wed, 01 Jan 2020 00:00:00 GMT"].map((value) => ({
    name: `Retry-After ${value}`,
    response: () => Response.json({}, { headers: { "retry-after": value } }),
  })),
];
afterEach(() => {
  vi.unstubAllGlobals();
  configureGuardedTransport(undefined);
});

it("INV-3 INV-5 INV-6 INV-9 INV-11: both transports preserve requests, registration, bounded reads, failures and core ledger facts", async () => {
  if (typeof WebSocketPair !== "undefined") expect(() => guardedTransport(true)).not.toThrow();
  for (const invalid of [
    "http://tickets.example",
    "https://u:p@tickets.example",
    "https://tickets.example?q=1",
    "https://tickets.example#x",
    "bad",
  ])
    for (const factory of [
      guardedFetch,
      (opts: Parameters<typeof guardedFetch>[0]) =>
        guardedClient({
          provider: opts.provider,
          baseUrl: opts.baseUrl,
          maxResponseBytes: opts.maxResponseBytes,
          authenticate: Effect.succeed({}),
        }),
    ])
      expect(() => factory({ provider, baseUrl: invalid, maxResponseBytes: 64, authenticate: () => ({}) })).toThrow();
  for (const fixture of fixtures) {
    const observations = [];
    for (const kind of ["promise", "effect"] as const) {
      const request: GuardedRequest = {
        method: "GET",
        path: "/items",
        ...fixture.request,
        ...(fixture.request?.visibleHeaders ? { idempotencyKey: "duplicate" } : {}),
      };
      const ctx = providerCallContext(
        { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example", requestScope: {} },
        "read",
      );
      const sent: unknown[] = [];
      let credentials = 0,
        cancelled = false,
        pulls = 0;
      vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
        sent.push({
          url: String(url),
          method: init.method,
          headers: Object.fromEntries(new Headers(init.headers)),
          body: init.body,
          redirect: init.redirect,
        });
        if (fixture.fail) throw Object.assign(new TypeError("secret request text"), { cause: { code: fixture.fail } });
        const answer =
          fixture.name === "streamed ceiling"
            ? new Response(
                new ReadableStream({
                  pull(c) {
                    pulls++;
                    c.enqueue(new Uint8Array(40));
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
              )
            : (fixture.response?.() ?? Response.json({ ok: "😀" }));
        answer.text = async () => {
          throw new Error("native text() must never be used");
        };
        return answer;
      });
      configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
      let result: unknown;
      try {
        if (kind === "promise") {
          const send = guardedFetch({
            provider,
            baseUrl,
            headers,
            maxResponseBytes: 64,
            authenticate: () => {
              credentials++;
              return auth;
            },
            ...(fixture.admit
              ? {
                  admit: () => {
                    throw new ConnectorCallError("invalid_args", "Pinned account.");
                  },
                }
              : {}),
          });
          result = await send(request, ctx, async (response) => {
            const parsed = await response.jsonResult();
            return {
              status: response.status,
              parsed: "value" in parsed ? parsed : { unreadable: true },
              retryAfterMs: retryAfterMs(response.headers),
            };
          });
        } else {
          const guarded = guardedClient({
            provider,
            baseUrl,
            headers,
            maxResponseBytes: 64,
            authenticate: Effect.sync(() => {
              credentials++;
              return auth;
            }),
            ...(fixture.admit ? { admit: () => Effect.fail(new RequestRefused({ message: "Pinned account." })) } : {}),
          });
          let built = Request.make(request.method)(request.path, {
            headers: request.headers as Record<string, string> | undefined,
            urlParams: request.query,
          });
          if (request.body !== undefined) built = Request.bodyJsonUnsafe(built, request.body);
          if (request.rawBody !== undefined)
            built = Request.setBody(
              built,
              Body.raw(request.rawBody, { contentType: request.headers?.["content-type"] }),
            );
          const lease = fromConnectorContext(ctx, "read");
          const dispatches = Context.get(lease.services, Dispatches);
          try {
            const reply = await runEdge(
              guarded.client.execute(built).pipe(
                Effect.flatMap(guarded.read),
                Effect.withSpan("parity"),
                Effect.provideService(
                  IdempotencyKey,
                  request.visibleHeaders
                    ? {
                        header: Object.keys(request.visibleHeaders)[0]!,
                        key: Object.values(request.visibleHeaders)[0]!,
                      }
                    : undefined,
                ),
                Effect.provideContext(lease.services),
              ),
            );
            let parsed: unknown;
            try {
              parsed = { value: reply.text?.trim() === "" ? undefined : JSON.parse(reply.text!) };
            } catch {
              parsed = { unreadable: true };
            }
            result = { status: reply.status, parsed, retryAfterMs: retryAfterMs(reply.headers) };
          } catch (failure) {
            throw toConnectorCallError(failure as never, errors, { classification: "read", dispatches });
          } finally {
            lease.close();
          }
        }
      } catch (error) {
        result = { error: classifyCallError(error) };
      }
      expect(pulls, fixture.name).toBeLessThanOrEqual(3);
      if (fixture.name === "streamed ceiling") expect(cancelled).toBe(true);
      const secrets = sentSecretsForRequest(ctx.requestScope!);
      const redacted = secrets.redact("token-123456789 query-123456789 form-123456789");
      observations.push({ sent, result, credentials, redacted, ledger: providerRequests(ctx)!.map((r) => ({ ...r })) });
      closeProviderCall(ctx);
    }
    expect(observations[1], fixture.name).toEqual(observations[0]);
  }
});
