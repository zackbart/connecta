import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { buildSandboxProviders, createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { InvocationService } from "../src/invocation.js";
import { SentSecrets, sentSecretsFor, trackCredentialReads } from "../src/sent-secrets.js";
import { CredentialVault } from "../src/credentials.js";
import { artifacts, kvArtifactStore } from "../src/artifacts.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import { seedGrant } from "./fixtures/oauth.js";
import type { Connector, ConnectorContext, Executor } from "../src/types.js";
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

  it("INV-5: credentials shorter than eight characters and Basic usernames cannot corrupt ordinary text", () => {
    const secrets = new SentSecrets(); secrets.add("a");
    secrets.add("1234567");
    expect(secrets.text("a [redacted] 1234567")).toBe("a [redacted] 1234567");
    secrets.header(`Basic ${btoa(`a:${SECRET}`)}`);
    expect(secrets.text("a valid ordinary diagnostic")).toBe("a valid ordinary diagnostic");
    expect(secrets.text(`a:${SECRET}`)).toBe("[redacted]");
    secrets.add("12345678");
    expect(secrets.text("12345678 [redacted]")).toBe("[redacted] [redacted]");
    expect(secrets.text(secrets.text(`Bearer ${SECRET}`))).toBe("[redacted]");
  });

  it("INV-5: one cached matcher handles mixed JSON escapes, percent casing and new credentials", () => {
    const secrets = new SentSecrets();
    const token = 'credential/"with\\escapes';
    secrets.add(token);
    const unicode = token.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`).join("");
    const mixed = 'credential\\/\\"with\\\\escapes';
    const percent = encodeURIComponent(token).replace(/%[0-9A-F]{2}/g, (escape) => `%${escape[1]!.toLowerCase()}${escape[2]}`);
    for (const form of [token, unicode, mixed, percent]) expect(secrets.text(form)).toBe("[redacted]");
    expect(secrets.text(`Bearer ${token}`)).toBe("[redacted]");
    secrets.add("another-credential");
    expect(secrets.text("another-credential")).toBe("[redacted]");
    expect(secrets.text(JSON.stringify(unicode))).toBe('"[redacted]"');
  });

  it("INV-5: a vault-backed matcher handles 10,000 rows without recompiling for each string", async () => {
    const vault = new CredentialVault(memoryStorage(), KEY);
    const values = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, `${SECRET}-${i}`]));
    await vault.setAll("bench", values, "test-user");
    const ctx = connectorContext();
    ctx.credential = { get: async (field) => values[field ?? "key0"] ?? null, getAll: () => vault.getAll("bench") };
    trackCredentialReads(ctx);
    await ctx.credential.getAll();
    const secrets = sentSecretsFor(ctx);
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: i, text: `row ${i} ${values.key0}`, label: "ordinary row" }));
    const started = performance.now();
    const result = secrets.redact(rows);
    const elapsed = performance.now() - started;
    expect(result[9_999]!.text).toBe("row 9999 [redacted]");
    // Leave room for instrumented CI; the local benchmark is reported in the PR.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("INV-5 INV-8: finds twice-escaped credentials across bounded scanning windows", () => {
    const token = 'boundary/"credential';
    const secrets = new SentSecrets(); secrets.secret(token);
    const escaped = token.split("").map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    for (const encoded of [escaped, JSON.stringify(escaped).slice(1, -1)]) {
      const text = "\\u0000".repeat(10_920) + encoded + "\\u0000".repeat(20_000);
      expect(secrets.text(text)).toBe("\\u0000".repeat(10_920) + "[redacted]" + "\\u0000".repeat(20_000));
    }
  });

  it("INV-5: custom connector errors are redacted before classification truncates their diagnostic", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.set("custom", SECRET, "test-user");
    const escaped = SECRET.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const connector: Connector = {
      id: "custom", kind: "api", credential: { label: "Key" },
      listTools: async () => [{ name: "read", description: "Read", annotations: { readOnlyHint: true } }],
      callTool: async (_name, _args, ctx) => {
        await ctx.credential!.get();
        throw new ConnectorCallError("invalid_args", `Refused ${"x".repeat(460)} ${escaped}`);
      },
    };
    const { outcome, failure } = await exercise(connector, { storage, credentialVault: vault });
    expect(failure.message).toContain("[redacted]");
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("[redacted]");
      expect(outcome.error.message).not.toContain("\\u0073");
    }
  });

  it.each(["unicode", "split", "escaped"])("INV-5: %s MCP text is redacted after unwrapping, before paging, emits and artifact storage", async (form) => {
    const token = 'credential/"with-escapes';
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.set("remote", token, "test-user");
    const serialized = JSON.stringify({ echo: token, padding: "x".repeat(600) });
    const escaped = serialized.replace(token.replace(/"/g, '\\"'), token.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
    const content = form === "split"
      ? [{ type: "text", text: serialized.slice(0, 18) }, { type: "text", text: serialized.slice(18) }]
      : [{ type: "text", text: form === "unicode" ? escaped : serialized.replace(/\//g, "\\/") }];
    const connector: Connector = {
      id: "remote", kind: "mcp", credential: { label: "Key" },
      listTools: async () => [{ name: "read", description: "Read", annotations: { readOnlyHint: true } }],
      callTool: async (_name, _args, ctx) => {
        await ctx.credential!.get();
        return { content };
      },
    };
    const store = kvArtifactStore(memoryStorage());
    const registry = makeRegistry([connector, artifacts({ store }).connector], { storage, credentialVault: vault, maxResultBytes: 256 });
    const meta = createMetaTools(registry, BASE);
    const page = await meta.callTool({ address: "remote.read", resultMode: "value" });
    const notice = (page.structuredContent as any).data;
    expect(notice.truncated).toBe(true);
    let reconstructed = "";
    let offset = 0;
    for (;;) {
      const result = await meta.readResult({ id: notice.resultId, offset, maxBytes: 256 });
      const text = result.content[0]!.text;
      const newline = text.indexOf("\n");
      const header = JSON.parse(text.slice(0, newline));
      reconstructed += text.slice(newline + 1);
      if (!header.hasMore) break;
      offset = header.nextOffset;
    }
    expect(JSON.parse(reconstructed).echo).toBe("[redacted]");
    const executor: Executor = { execute: async (_code, providers) => {
      const host = providers[0]!.fns;
      const result = await host.call!("remote.read", {}) as { data: { echo: string }; format: string };
      expect(result.data.echo).toBe("[redacted]");
      await host.emit!({ type: "text", text: token });
      // Even a program reconstructing a sent value cannot write it to a page.
      await host.call!("artifacts.create_artifact", {
        id: "redacted", title: "Redacted", kind: "markdown", source: token,
        documents: { data: { echoed: token } },
      });
      return { result: { echoed: token }, logs: [token] };
    } };
    const run = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { trust: "trusted" });
    const result = await run({ code: "async () => {}" });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.structuredContent).toMatchObject({ result: { echoed: "[redacted]" }, logs: "[redacted]" });
    expect(result.content.at(-1)?.text).toBe("[redacted]");
    const head = (await store.head("redacted"))!.head;
    expect(await store.body(head.view.body!)).toBe("[redacted]");
    expect(JSON.parse((await store.body(head.documents.data!.body!))!)).toEqual({ echoed: "[redacted]" });
    const failed = createExecuteTool(registry, BASE, { execute: async (_code, providers) => {
      await providers[0]!.fns.call!("remote.read", {});
      return { result: undefined, error: token, logs: [token] };
    } }, silentLogger);
    const failure = await failed({ code: "async () => {}" });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(token);
    expect(failure.structuredContent).toMatchObject({
      error: { code: "program_error", message: "Program Error: [redacted]" },
      logs: "[redacted]",
    });
    expect(JSON.parse(failure.content[0]!.text)).toEqual(failure.structuredContent);
  });

  it.each(["api", "oauth", "remote"])("INV-5: %s final outgoing requests register auxiliary sensitive headers and query parameters", async (mode) => {
    const header = "auxiliary-header-credential";
    const query = "auxiliary-query-credential";
    const storage = memoryStorage();
    await seedGrant(storage, { issuer: "https://oauth.api.test/token", tokens: { access_token: SECRET, token_type: "bearer" } }, undefined, scopes.connector("api"));
    const server = httpDownstream((mcp) => mcp.registerTool("read", { description: "Read", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "ok" }] })));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = mode === "remote" && request.method === "POST" ? await request.clone().json() as any : undefined;
      if (mode !== "remote" || body?.method === "tools/call") {
        expect(request.headers.get("x-api-key")).toBe(header);
        expect(new URL(request.url).searchParams.get("custom_session_key")).toBe(query);
        const echo = { header, query };
        return mode === "remote" ? Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", content: [{ type: "text", text: JSON.stringify(echo) }], structuredContent: echo } }) : Response.json(echo);
      }
      return server.fetch(request.url, init);
    });
    const connector = mode === "remote" ? remoteMcp("api", { url: `${server.url}?custom_session_key=${query}`, auth: { type: "headers", headers: { "X-API-Key": header } } }) : api("api", {
      ...(mode === "oauth" ? { oauth: { authorizationEndpoint: "https://oauth.api.test/authorize", tokenEndpoint: "https://oauth.api.test/token", clientId: "client", apiOrigins: ["https://api.test"] } } : {}),
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => {
        const response = await (ctx.oauth?.fetch ?? ctx.fetch)(`https://api.test/read?custom_session_key=${query}`, { headers: { "X-API-Key": header, "Signature": header } });
        return response.json();
      } }],
    });
    const registry = makeRegistry([connector], { storage });
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke("api.read", {}, { source: "call_tool", unwrapResult: true });
    expect(outcome).toMatchObject({ ok: true, value: { header: "[redacted]", query: "[redacted]" } });
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
        if (!outcome.ok) {
          if (kind === "http") expect(outcome.error.code).toBe("provider_permission_denied");
          else expect(outcome.error.message).toContain("[redacted]");
        }
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
    if (mode === "oauth") await seedGrant(ctx.storage, { issuer: "https://authorization.test", tokens: { access_token: SECRET, token_type: "bearer" } });
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
    await seedGrant(storage, { issuer: tokenEndpoint, tokens: { access_token: SECRET, refresh_token: "refresh-credential", token_type: "bearer" } }, undefined, scopes.connector("api"));
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
