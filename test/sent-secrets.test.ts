import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { buildSandboxProviders } from "../src/execute.js";
import { InvocationService } from "../src/invocation.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, spyLogger } from "./fixtures/misc.js";
import { activitySink, makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const SECRET = "sent-secret/+with=encoding";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function diagnostic(secret: string): string {
  return `Permission refused: ${secret}; ${encodeURIComponent(secret)}; ${btoa(secret)}.\nAuthorization: Bearer ${secret}\nCookie: session=opaque\nRetry after checking permissions.`;
}

async function exercise(connector: Connector, options: Parameters<typeof makeRegistry>[1] = {}) {
  const logger = spyLogger();
  const registry = makeRegistry([connector], { ...options, logger: logger.logger });
  const activity = activitySink();
  const invocation = new InvocationService(registry, new CatalogService(registry, BASE), activity.activity);
  const outcome = await invocation.invoke(`${connector.id}.read`, {}, { source: "call_tool" });
  const providers = await buildSandboxProviders(registry, BASE, silentLogger);
  const host = providers.find((provider) => provider.name === "connecta")!;
  let failure: any;
  try { await host.fns.call!(`${connector.id}.read`, {}); }
  catch (error) { failure = error; }
  expect(outcome).toMatchObject({ ok: false });
  expect(failure).toBeInstanceOf(Error);
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
  expect(failure.message).not.toContain(SECRET);
  expect(JSON.stringify(failure)).not.toContain(SECRET);
  expect(JSON.stringify(failure.cause) ?? "").not.toContain(SECRET);
  expect(JSON.stringify(activity.events)).not.toContain(SECRET);
  expect(logger.warnings().join(" ")).not.toContain(SECRET);
  return { outcome, failure };
}

describe("call-scoped sent credentials", () => {
  it("INV-5: copies nested error data and causes without raw, prefixed, encoded or Basic credentials", () => {
    const secrets = new SentSecrets();
    secrets.header(`Basic ${btoa(`account:${SECRET}`)}`);
    const cause = new Error(diagnostic(SECRET));
    const error = Object.assign(new ConnectorCallError("invalid_args", diagnostic(SECRET), { cause }), {
      data: { nested: diagnostic(SECRET), [SECRET]: [cause] },
    });
    const redacted = secrets.redact(error);
    expect(redacted).toBeInstanceOf(ConnectorCallError);
    expect(redacted).not.toBe(error);
    expect(redacted.cause).not.toBe(cause);
    for (const text of [redacted.message, redacted.stack, (redacted.cause as Error).message, JSON.stringify(redacted)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(encodeURIComponent(SECRET));
      expect(text).not.toContain(btoa(SECRET));
      expect(text).not.toContain("session=opaque");
    }
    expect(redacted.message).toContain("Permission refused");
    expect(redacted.message).toContain("Retry after checking permissions");
    expect(error.message).toContain(SECRET);
  });

  it("INV-5: ordinary diagnostics and results keep their text and identity", () => {
    const secrets = new SentSecrets(); secrets.add(SECRET);
    const error = new ConnectorCallError("invalid_args", "The token field requires an ordinary repository name.");
    const result = { content: [{ type: "text", text: "Bearer authentication refused for this repository." }] };
    expect(secrets.redact(error)).toBe(error);
    expect(secrets.redact(result)).toBe(result);
  });

  it("INV-5: short credentials cannot rewrite an inserted or existing placeholder", () => {
    const secrets = new SentSecrets(); secrets.add("a");
    expect(secrets.text("a [redacted]")).toBe("[redacted] [redacted]");
    expect(secrets.text(secrets.text("Bearer a"))).toBe("[redacted]");
  });

  it.each(["rpc", "http", "isError", "success"])("INV-5 INV-6: generic remoteMcp headers auth redacts %s echoes before agents and guest calls", async (kind) => {
    const server = httpDownstream((mcp) => mcp.registerTool("read", { description: "Read", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "ordinary result" }] })));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? await request.clone().json() as any : undefined;
      if (body?.method === "tools/call") {
        expect(request.headers.get("x-api-key")).toBe(SECRET);
        const message = diagnostic(SECRET);
        if (kind === "http") return Response.json({ message }, { status: 403 });
        if (kind === "rpc") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message, data: { echoed: message } } });
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", isError: kind === "isError", content: [{ type: "text", text: message }], structuredContent: { echoed: message } } });
      }
      return server.fetch(input instanceof Request ? input.url : input, init);
    });
    const connector = remoteMcp("remote", { url: server.url, auth: { type: "headers", headers: { "X-API-Key": SECRET } } });
    const ctx = connectorContext();
    try {
      if (kind === "success") {
        const registry = makeRegistry([connector]);
        const result = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke("remote.read", {}, { source: "call_tool" });
        expect(result).toMatchObject({ ok: true });
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).toContain("[redacted]");
      } else {
        const { outcome } = await exercise(connector);
        if (!outcome.ok) expect(outcome.error.message).toContain("[redacted]");
      }
      const raw = await connector.callTool("read", {}, ctx).catch((error) => error);
      expect(JSON.stringify(raw)).not.toContain(SECRET);
      expect(String(raw)).not.toContain(SECRET);
      if (raw instanceof Error) {
        expect(JSON.stringify(Object.getOwnPropertyDescriptors(raw))).not.toContain(SECRET);
      }
    } finally { await connector.closeScope?.(ctx); }
  });

  it.each(["http", "rpc"])("INV-5 INV-6: api credential slots redact %s diagnostics and query-key echoes", async (kind) => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.set("api", SECRET, "test-user");
    vi.stubGlobal("fetch", async (input: string | URL) => {
      expect(new URL(input).searchParams.get("api_key")).toBe(SECRET);
      return Response.json(kind === "http" ? { message: diagnostic(SECRET) } : { error: { code: -32603, message: diagnostic(SECRET), data: { echoed: SECRET } } }, { status: 400 });
    });
    const connector = api("api", {
      credential: { label: "API key" },
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => {
        const key = (await ctx.credential!.getAll())!.value!;
        const url = new URL("https://api.test/read"); url.searchParams.set("api_key", key);
        const response = await fetch(url);
        const body = await response.json() as any;
        throw new ConnectorCallError("invalid_args", body.message ?? body.error.message, { cause: new Error(JSON.stringify(body)) });
      } }],
    });
    const { outcome } = await exercise(connector, { storage, credentialVault: vault });
    if (!outcome.ok) expect(outcome.error.message).toContain("[redacted]");
    const ctx = connectorContext();
    ctx.credential = { get: async () => SECRET, getAll: async () => ({ value: SECRET }) };
    await expect(connector.callTool("read", {}, ctx)).rejects.toSatisfy((error: Error) =>
      !error.message.includes(SECRET) && !(error.cause as Error).message.includes(SECRET));
  });

  it.each(["oauth", "request", "credential", "basic"] as const)("INV-5: remoteMcp %s auth redacts actual sent credentials on a cached connection", async (mode) => {
    const server = httpDownstream((mcp) => mcp.registerTool("read", { description: "Read", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "ok" }] })));
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
      if (body?.method === "tools/call") {
        const authorization = new Headers(init?.headers).get("authorization")!;
        expect(authorization).toBe(mode === "basic" ? `Basic ${btoa(`account:${SECRET}`)}` : `Bearer ${SECRET}`);
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: diagnostic(SECRET), data: { authorization } } });
      }
      return server.fetch(input, init);
    });
    const auth = mode === "basic" ? { type: "headers" as const, headers: { Authorization: `Basic ${btoa(`account:${SECRET}`)}` } } :
      mode === "request" ? { type: "request" as const, token: async () => SECRET } : { type: mode };
    const connector = remoteMcp("remote", { url: server.url, auth });
    const scope = {}; const ctx = { ...connectorContext(), requestScope: scope };
    if (mode === "credential") ctx.credential = { get: async () => SECRET, getAll: async () => ({ value: SECRET }) };
    if (mode === "oauth") await ctx.storage.set("oauth:tokens", JSON.stringify({ connectaOAuthVersion: 2, generation: "legacy", issuer: "https://authorization.test", value: { access_token: SECRET, token_type: "bearer" } }));
    try {
      await connector.listTools(ctx);
      // Distinct call contexts share the transport, never the secret set.
      for (let call = 0; call < 2; call++) {
        const error = await connector.callTool("read", {}, { ...ctx }).catch((error) => error);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error("Expected a downstream failure");
        expect(error.message).toContain("[redacted]");
        expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(SECRET);
      }
    } finally { await connector.closeScope?.(ctx); }
  });

  it("INV-5: api OAuth registers both tokens when a call refreshes its grant", async () => {
    const tokenEndpoint = "https://oauth.api.test/token";
    const rotated = `${SECRET}-rotated`;
    let refused = false;
    const storage = memoryStorage();
    await storage.set("conn:api:oauth:tokens", JSON.stringify({ connectaOAuthVersion: 2, generation: "legacy", issuer: tokenEndpoint, value: { access_token: SECRET, refresh_token: "refresh-credential", token_type: "bearer" } }));
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (String(input) === tokenEndpoint) return Response.json({ access_token: rotated, token_type: "bearer" });
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === `Bearer ${SECRET}`) { refused = true; return new Response("", { status: 401 }); }
      expect(bearer).toBe(`Bearer ${rotated}`);
      const message = `${refused ? `${diagnostic(SECRET)}\n` : ""}${diagnostic(rotated)}`;
      refused = false;
      return Response.json({ message }, { status: 400 });
    });
    const connector = api("api", { oauth: { authorizationEndpoint: "https://oauth.api.test/authorize", tokenEndpoint, clientId: "client", apiOrigins: ["https://api.test"] }, tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => {
      const response = await ctx.oauth!.fetch("https://api.test/read");
      const body = await response.json() as { message: string };
      throw new ConnectorCallError("invalid_args", body.message);
    } }] });
    const { outcome } = await exercise(connector, { storage });
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("[redacted]");
      expect(outcome.error.message).not.toContain(rotated);
      expect(outcome.error.message).not.toContain("refresh-credential");
    }
  });

  it("INV-5: calls sharing a request scope do not inherit another call's slot values", async () => {
    const connector = api("api", { credential: { label: "Key" }, tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (args, ctx) => {
      if (args.authenticate) await ctx.credential!.get();
      throw new ConnectorCallError("invalid_args", SECRET);
    } }] });
    const scope = {};
    const first: ConnectorContext = { ...connectorContext(), requestScope: scope, credential: { get: async () => SECRET, getAll: async () => ({ value: SECRET }) } };
    const second = { ...first };
    await expect(connector.callTool("read", { authenticate: true }, first)).rejects.toThrow("[redacted]");
    await expect(connector.callTool("read", {}, second)).rejects.toThrow(SECRET);
  });
});
