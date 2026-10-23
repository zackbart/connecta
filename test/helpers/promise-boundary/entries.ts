import { grantFromOAuth } from "../../../src/http/oauth.js";
import { defineApiProvider } from "../../../src/http/provider.js";
import { get, vendor } from "../../../src/http/vendor.js";
import { Refusal } from "../../../src/http/errors.js";
import { Context, Effect, Schema } from "effect";
import { optionsOf } from "../../../src/config-schema.js";
import { PROVIDER_COMMON, type ProviderOptions } from "../../../src/provider.js";
import { expect, vi } from "vitest";
import { z } from "zod";
import { api, type ApiHandlerContext } from "../../../src/connectors/api.js";
import { guardedFetch, oauthBearer } from "../../../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../../../src/connectors/remote-mcp.js";
import { CredentialVault } from "../../../src/credentials.js";
import { CatalogService } from "../../../src/catalog-service.js";
import { deriveContext } from "../../../src/derived-context.js";
import { createMetaTools } from "../../../src/meta-tools.js";
import { providerCallContext, providerFetch } from "../../../src/provider-call.js";
import { Credentials, openRequest, operationContext, viewLease, viewServices } from "../../../src/runtime/call.js";
import { callEntry } from "../../../src/runtime/call-entry.js";
import { runEdge } from "../../../src/runtime/run.js";
import { scopes } from "../../../src/storage/keys.js";
import type { Connector, ConnectorContext } from "../../../src/types.js";
import { httpDownstream } from "../../fixtures/downstream-mcp.js";
import { deferred } from "../../fixtures/misc.js";
import { seedGrant } from "../../fixtures/oauth.js";
import { drainOAuthStartResets } from "../../../src/auth/oauth-start-reset.js";
import { storedGrant } from "../../fixtures/oauth.js";
import { makeRegistry } from "../../helpers.js";
import { HeldSeam, ownerOf, type Completion, type Fixture, type Owner, type Seam } from "./harness.js";

const BASE = "https://connecta.example";
const ORIGIN = "https://tickets.example";
const SECRET = "promise-boundary-credential-value";
const KEY = btoa("k".repeat(32));
const OAUTH = {
  authorizationEndpoint: `${ORIGIN}/authorize`,
  tokenEndpoint: `${ORIGIN}/token`,
  clientId: "fixture-client",
  apiOrigins: [ORIGIN],
};
const TOOL = { name: "read", description: "Read a record.", annotations: { readOnlyHint: true as const } };

export interface Entry {
  name: string;
  seams: readonly Seam[];
  create(held: HeldSeam, owner: Owner): Promise<Fixture>;
  owners?: readonly Owner[];
  reviewer?: boolean;
  completions?: readonly Completion[];
}

function view(connector: Connector, held: HeldSeam, owner: Owner, credentialVault?: CredentialVault) {
  const scope = {};
  const registry = makeRegistry([connector], {
    storage: held.storage,
    ...(credentialVault ? { credentialVault } : {}),
  });
  const operation = registry.contextFor(connector.id, BASE, scope);
  expect(operation.signal).toBeUndefined();
  // Request rows deliberately have no AbortSignal: only the structural
  // operation/request association can cancel them.
  const ctx = owner === "call" ? providerCallContext(operation, "read") : operation;
  return { registry, scope, operation, ctx };
}

function direct(ctx: ConnectorContext, start: () => Promise<unknown>, cleanup?: () => Promise<void>): Fixture {
  const owner = ownerOf(ctx);
  return {
    ...owner,
    start,
    cleanup: async () => {
      await owner.cleanup();
      await cleanup?.();
    },
  };
}

async function cryptoWork(held: HeldSeam): Promise<void> {
  if (held.name === "crypto.sign") {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("assertion"));
  } else await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SECRET));
}

async function dependency(held: HeldSeam, ctx: ConnectorContext): Promise<void> {
  if (held.name === "storage.get") await ctx.storage.get("fixture");
  else if (held.name === "storage.put") await ctx.storage.set("fixture", "submitted");
  else if (held.name === "storage.CAS") await ctx.storage.compareAndSet("fixture", null, "submitted");
  else if (held.name.startsWith("crypto.")) await cryptoWork(held);
  else await held.at(held.name, undefined);
}

function apiHandler(
  name:
    | "api.callTool"
    | "api.EffectEntry"
    | "ctx.fetch"
    | "ctx.fetch.derivedSignal"
    | "api.testCredential"
    | "api.testCredentials",
): Entry["create"] {
  return async (held, owner) => {
    held.installCrypto();
    const provided = deferred<ApiHandlerContext>();
    const leaveHandler = deferred<void>();
    const connector = api("tickets", {
      credential: { label: "Token" },
      testCredential: async (_value, ctx) => {
        await dependency(held, ctx);
        return { ok: true };
      },
      testCredentials: async (_values, ctx) => {
        await dependency(held, ctx);
        return { ok: true };
      },
      tools: [
        {
          ...TOOL,
          handler: async (_, ctx) => {
            if (name.startsWith("ctx.fetch")) {
              provided.resolve(ctx);
              await leaveHandler.promise;
              return {};
            }
            await dependency(held, ctx);
            // A late user handler may resume; its retained capability may not send.
            return ctx.fetch(`${ORIGIN}/items`);
          },
        },
      ],
    });
    const { ctx, operation } = view(connector, held, owner);
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => held.response(init));
    if (name === "api.testCredential") return direct(ctx, () => connector.testCredential!(SECRET, ctx));
    if (name === "api.testCredentials") return direct(ctx, () => connector.testCredentials!({ value: SECRET }, ctx));
    if (name === "api.EffectEntry") {
      // Use the internal entry that the published invocation actually selects;
      // merely calling connector.callTool would miss this Effect/Promise edge.
      const call = owner === "call" ? ctx : providerCallContext(operation, "read");
      const entry = callEntry(connector, connector.callTool)!;
      return direct(call, () => runEdge(entry("read", {}, undefined).pipe(Effect.provideContext(viewServices(call)))));
    }
    if (name === "ctx.fetch" || name === "ctx.fetch.derivedSignal") {
      const outer = connector.callTool("read", {}, ctx).catch(() => {});
      const handler = await provided.promise;
      const source = new AbortController();
      const derived = name.endsWith("derivedSignal") ? deriveContext(handler, { signal: source.signal }) : handler;
      const fetch = name.endsWith("derivedSignal")
        ? providerFetch(derived, "tickets", false, globalThis.fetch)
        : handler.fetch;
      return direct(
        derived,
        () => fetch(`${ORIGIN}/items`),
        async () => {
          leaveHandler.resolve();
          await outer;
        },
      );
    }
    return direct(ctx, () => connector.callTool("read", {}, ctx));
  };
}

function credential(name: "ctx.credential.get" | "ctx.credential.getAll" | "Credentials.values"): Entry["create"] {
  return async (held, owner) => {
    const vault = new CredentialVault(held.storage, KEY);
    await vault.set("tickets", SECRET, "fixture");
    const connector = api("tickets", { credential: { label: "Token" }, tools: [] });
    const { ctx, operation } = view(connector, held, owner, vault);
    const call = name === "Credentials.values" && owner === "request" ? providerCallContext(operation, "read") : ctx;
    return direct(call, () =>
      name === "Credentials.values"
        ? runEdge(Context.get(viewServices(call), Credentials).values)
        : name.endsWith("getAll")
          ? call.credential!.getAll()
          : call.credential!.get(),
    );
  };
}

/** The provider probe's Effect work is also covered at its outer Promise edge. */
function providerProbe(named: boolean): Entry["create"] {
  return async (held, owner) => {
    held.installCrypto();
    const probe = get("probe", "/items", { success: Schema.Unknown });
    const connector = defineApiProvider({
      name: "tickets",
      title: "Tickets",
      skill: { content: "Read tickets.", instructionsHeading: "Workspace instructions" },
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      vendor: vendor("tickets", probe),
      baseUrl: () => ORIGIN,
      maxResponseBytes: 1024,
      credential: { label: "Token" },
      authenticate: Effect.gen(function* () {
        const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
        yield* Effect.promise(async () => {
          if (held.name === "storage.get") await held.storage.get("fixture");
          else if (held.name === "storage.put") await held.storage.set("fixture", "submitted");
          else if (held.name === "storage.CAS") await held.storage.compareAndSet("fixture", null, "submitted");
          else if (held.name.startsWith("crypto.")) await cryptoWork(held);
          else await held.at("authenticate", undefined);
        });
        return { Authorization: `Bearer ${values?.["value"]}` };
      }),
      errors: {
        provider: "Tickets",
        facts: () => ({}),
        detail: () => "Tickets refused the probe.",
        statuses: {
          401: () => ({ code: "auth_required" }),
          403: () => ({ code: "provider_permission_denied" }),
          404: () => ({ code: "not_found" }),
        },
        unreadable: "Tickets returned unreadable JSON.",
      },
      safety: () => ({ review: "Fixture replies contain no secrets.", sensitiveFields: { names: [], choice: "drop" } }),
      result: (body) =>
        Effect.promise(async () => {
          await held.at("mapper", undefined);
          return body;
        }),
      probe: { operation: probe, request: {}, describe: () => "Candidate accepted." },
      guide: () => ({ context: [] }),
      tools: () => [],
    })("tickets", { purpose: "Read tickets" });
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => held.response(init));
    const { ctx } = view(connector, held, owner);
    return direct(ctx, () =>
      named ? connector.testCredentials!({ value: SECRET }, ctx) : connector.testCredential!(SECRET, ctx),
    );
  };
}

function guarded(auxiliary = false, operationCredential = false): Entry["create"] {
  return async (held) => {
    held.installCrypto();
    const vault = operationCredential ? new CredentialVault(held.storage, KEY) : undefined;
    if (vault) await vault.set("tickets", SECRET, "fixture");
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => held.response(init));
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: ORIGIN,
      maxResponseBytes: 1024,
      auxiliary,
      authenticate: async (ctx) => {
        if (operationCredential) {
          await operationContext(ctx).credential!.get();
          return {};
        }
        if (
          ["authenticate", "storage.get", "storage.put", "storage.CAS", "crypto.digest", "crypto.sign"].includes(
            held.name,
          )
        )
          await dependency(held, ctx);
        return {};
      },
    });
    let ctx!: ConnectorContext;
    let pending!: Promise<unknown>;
    let outer: Promise<unknown> | undefined;
    const connector = api("tickets", {
      ...(operationCredential ? { credential: { label: "Token" } } : {}),
      tools: [
        {
          ...TOOL,
          handler: async (_, handler) => {
            ctx = handler;
            if (operationCredential) held.armed = true;
            pending = send({ method: "GET", path: "/items" }, handler, async (response) => {
              await held.at("mapper", undefined);
              return response.json();
            });
            // Observe the helper directly, independently of api/Effect outer races.
            await pending.catch(() => {});
            return {};
          },
        },
      ],
    });
    const scope = {};
    const registry = makeRegistry([connector], { storage: held.storage, ...(vault ? { credentialVault: vault } : {}) });
    return {
      start: () => {
        // The invocation's credential preflight is a different entry. Hold
        // only the helper's operation-owned credential read in this row.
        if (operationCredential) held.armed = false;
        outer = createMetaTools(registry, BASE, { requestScope: scope }).callTool({ address: "tickets.read" });
        // The invocation starts asynchronously, so follow the published helper
        // only once its declared seam proves the handler has assigned it.
        return held.entered.promise.then(() => pending);
      },
      close: (owner) => ownerOf(ctx).close(owner),
      cleanup: async () => {
        openRequest(scope).close();
        await outer;
      },
      requestOwned: auxiliary,
    };
  };
}

type RemoteName = "listTools" | "callTool" | "readResource" | "skills.list" | "skills.read" | "testCredential";
function remote(name: RemoteName, credentialAuth = false, warm = false): Entry["create"] {
  return async (held, owner) => {
    if (!credentialAuth) held.getKey = (key) => key.endsWith("minted-token");
    const skills = name.startsWith("skills.");
    const downstream = httpDownstream((server) => {
      server.registerTool("read", { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
        content: [],
      }));
      server.registerResource("fixture", "fixture://items", {}, async (uri) => ({
        contents: [{ uri: uri.href, text: "fixture" }],
      }));
    });
    let vault: CredentialVault | undefined;
    if (credentialAuth) {
      vault = new CredentialVault(held.storage, KEY);
      await vault.set("tickets", SECRET, "fixture");
    }
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      held.effects.push("fetch");
      if (held.armed && init?.signal) held.signals.push(init.signal);
      await held.at("fetch", undefined);
      if (skills) {
        const request = new Request(input, init);
        const rpc = (await request.json()) as { id: string | number; method: string; params?: { uri?: string } };
        const fields =
          rpc.method === "server/discover"
            ? {
                supportedVersions: ["2026-07-28"],
                capabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } },
                _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
              }
            : rpc.method === "skills/list"
              ? { skills: [] }
              : { contents: [{ uri: rpc.params!.uri, text: "fixture" }] };
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { resultType: "complete", ttlMs: 60_000, cacheScope: "private", ...fields },
        });
      }
      return downstream.fetch(input instanceof Request ? input.url : input, init);
    });
    const connector = remoteMcp("tickets", {
      url: downstream.url,
      versionNegotiation: skills ? "auto" : "legacy",
      skills: true,
      auth: credentialAuth
        ? { type: "credential" }
        : {
            type: "request",
            token: async (ctx) => {
              await held.at("request-token.resolve", undefined);
              // The request-token callback awaits storage directly at this Promise edge.
              await ctx.storage.get("minted-token");
              return "request-token-fixture";
            },
          },
    });
    const { ctx, operation } = view(connector, held, owner, vault);
    if (warm || skills) {
      const opener = providerCallContext(operation, "read");
      if (skills) await connector.downstreamSkills!.list(opener);
      else await connector.listTools(opener);
      viewLease(opener)!.close();
    }
    held.installCrypto((data) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new TextDecoder().decode(bytes) === SECRET;
    });
    return direct(
      ctx,
      () => {
        if (name === "callTool") return connector.callTool("read", {}, ctx);
        if (name === "readResource") return connector.readResource!("fixture://items", ctx);
        if (name === "skills.list") return connector.downstreamSkills!.list(ctx);
        if (name === "skills.read") return connector.downstreamSkills!.read("fixture://items", ctx);
        if (name === "testCredential") return connector.testCredential!(SECRET, ctx);
        return connector.listTools(ctx);
      },
      () => connector.closeScope!(operation),
    );
  };
}

function catalog(
  name:
    | "registry.getTools"
    | "registry.statusFor"
    | "CatalogService.loadConnector"
    | "CatalogService.search"
    | "CatalogService.describe"
    | "CatalogService.resolveTool",
): Entry["create"] {
  return async (held) => {
    const connector: Connector = {
      id: "tickets",
      kind: "mcp",
      listTools: async (ctx) => {
        await dependency(held, ctx);
        return [TOOL];
      },
      status: async (ctx) => {
        await dependency(held, ctx);
        return { state: "ok" };
      },
      callTool: async () => ({}),
    };
    const { registry, scope, ctx } = view(connector, held, "request");
    const service = new CatalogService(registry, BASE, { requestScope: scope });
    return direct(ctx, () =>
      name === "registry.getTools"
        ? registry.getTools("tickets", BASE, scope)
        : name === "registry.statusFor"
          ? registry.statusFor("tickets", BASE, scope)
          : name === "CatalogService.loadConnector"
            ? service.loadConnector("tickets")
            : name === "CatalogService.search"
              ? service.search({ query: "read", connector: "tickets" })
              : name === "CatalogService.resolveTool"
                ? service.resolveTool("tickets.read")
                : service.describe({ addresses: ["tickets.read"] }),
    );
  };
}

type OAuthName = "status" | "startAuth" | "disconnectAuth" | "verifyState" | "consumeAuthError" | "finishAuth";
function oauth(name: OAuthName, kind: "api" | "remote"): Entry["create"] {
  return async (held, owner) => {
    const connector =
      kind === "api"
        ? api("tickets", { oauth: OAUTH, tools: [] })
        : remoteMcp("tickets", { url: `${ORIGIN}/mcp`, auth: { type: "oauth" } });
    const { ctx, operation } = view(connector, held, owner);
    await seedGrant(
      held.backing,
      {
        issuer: kind === "api" ? OAUTH.tokenEndpoint : ORIGIN,
        client: { value: { client_id: "fixture-client", token_endpoint_auth_method: "none" } },
        discovery: {
          authorizationServerUrl: ORIGIN,
          resourceMetadata: { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] },
          authorizationServerMetadata: {
            issuer: ORIGIN,
            authorization_endpoint: `${ORIGIN}/authorize`,
            token_endpoint: OAUTH.tokenEndpoint,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
          },
        },
      },
      "v3:seeded",
      scopes.connector("tickets"),
    );
    vi.stubGlobal("fetch", async (input: string | URL, _init?: RequestInit) => {
      held.effects.push("fetch");
      await held.at("fetch", undefined);
      const url = String(input);
      if (kind === "remote") {
        if (url.includes("/.well-known/oauth-protected-resource"))
          return Response.json({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
        if (url.includes("/.well-known/"))
          return Response.json({
            issuer: ORIGIN,
            authorization_endpoint: `${ORIGIN}/authorize`,
            token_endpoint: OAUTH.tokenEndpoint,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          });
        if (url === `${ORIGIN}/mcp`)
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
            },
          });
      }
      return Response.json({ access_token: "fresh-token", token_type: "Bearer", refresh_token: "fresh-refresh" });
    });
    let state = "fixture-state";
    if (["verifyState", "consumeAuthError", "finishAuth"].includes(name)) {
      const started = await connector.startAuth!(operation);
      if (!started.authorizationUrl) throw new Error(`Matrix consent setup failed: ${JSON.stringify(started)}`);
      state = new URL(started.authorizationUrl!).searchParams.get("state")!;
      if (name === "consumeAuthError") await connector.verifyState!(state, ctx);
    }
    held.installCrypto();
    const fixture = direct(
      ctx,
      () => {
        if (name === "verifyState") return connector.verifyState!(state, ctx);
        if (name === "finishAuth")
          return connector.finishAuth!("fixture-code", ctx, new URLSearchParams({ code: "fixture-code", state }));
        return connector[name]!(ctx);
      },
      () => connector.closeScope?.(operation) ?? Promise.resolve(),
    );
    if (["verifyState", "consumeAuthError", "finishAuth"].includes(name)) fixture.requestOwned = true;
    if (name === "disconnectAuth")
      fixture.resetCompletion = async (completion) => {
        // Accepted operator ownership: DELETE must invalidate the grant even
        // when its browser leaves. These CASs belong to trackOAuthStartReset,
        // not the revoked call; no resource transport may resume with it.
        await drainOAuthStartResets(ctx.requestScope ?? ctx);
        expect(held.effects.filter((effect) => effect === "fetch")).toEqual([]);
        const grant = await storedGrant(held.backing, scopes.connector("tickets"));
        if (completion === "resolve") {
          expect(grant?.epoch).toMatch(/^disconnected:/);
          expect(grant?.body?.tokens).toBeUndefined();
          expect(held.effects.filter((effect) => effect.startsWith("CAS:"))).toHaveLength(2);
        } else expect(grant?.epoch).toBe("v3:seeded");
      };
    return fixture;
  };
}

function oauthFetch(auxiliary = false): Entry["create"] {
  return async (held, owner) => {
    let inner!: Promise<unknown>;
    let handler!: ConnectorContext;
    let outer: Promise<unknown> | undefined;
    const guarded = guardedFetch({
      provider: "Tickets",
      baseUrl: ORIGIN,
      maxResponseBytes: 1024,
      auxiliary: true,
      ...oauthBearer("Tickets"),
    });
    const connector = api("tickets", {
      oauth: OAUTH,
      tools: [
        {
          ...TOOL,
          handler: async (_, ctx) => {
            handler = ctx;
            inner = auxiliary
              ? guarded({ method: "GET", path: "/items" }, ctx, async (response) => response.json())
              : ctx.oauth!.fetch(`${ORIGIN}/items`);
            await inner.catch(() => {});
            return {};
          },
        },
      ],
    });
    const { ctx, operation } = view(connector, held, owner);
    await seedGrant(
      held.backing,
      { issuer: OAUTH.tokenEndpoint, tokens: { access_token: "fixture-access-token", token_type: "Bearer" } },
      "v3:seeded",
      scopes.connector("tickets"),
    );
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => held.response(init));
    return {
      start: () => {
        outer = connector.callTool("read", {}, ctx).catch(() => {});
        return held.entered.promise.then(() => inner);
      },
      close: (boundary) => ownerOf(owner === "call" ? handler : operation).close(boundary),
      cleanup: async () => {
        openRequest(operation.requestScope!).close();
        await outer;
      },
      requestOwned: auxiliary,
    };
  };
}

/** The three new Grant capabilities use the same generated close/late-result matrix. */
function grantUse(name: "token" | "refresh" | "rejected"): Entry["create"] {
  return async (held, owner) => {
    held.installCrypto();
    const provided = deferred<ApiHandlerContext>();
    const leave = deferred<void>();
    const connector = api("tickets", {
      oauth: OAUTH,
      tools: [
        {
          ...TOOL,
          handler: async (_, ctx) => {
            provided.resolve(ctx);
            await leave.promise;
            return {};
          },
        },
      ],
    });
    const { ctx } = view(connector, held, owner);
    await seedGrant(
      held.backing,
      {
        issuer: OAUTH.tokenEndpoint,
        tokens: {
          access_token: "fixture-access-token",
          refresh_token: "fixture-refresh-token",
          token_type: "Bearer",
        },
      },
      "v3:seeded",
      scopes.connector("tickets"),
    );
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => held.response(init));
    const outer = connector.callTool("read", {}, ctx).catch(() => {});
    const handler = await provided.promise;
    const grant = grantFromOAuth(handler.oauth!);
    return direct(
      handler,
      () => runEdge(name === "refresh" ? grant.refresh("fixture-access-token") : grant[name]),
      async () => {
        leave.resolve();
        await outer;
      },
    );
  };
}

function closedEntry(
  name: "api.listTools" | "api.verifyCallbackIssuer" | "remote.verifyCallbackIssuer",
): Entry["create"] {
  return async (held, owner) => {
    const connector =
      name === "remote.verifyCallbackIssuer"
        ? remoteMcp("tickets", { url: `${ORIGIN}/mcp`, auth: { type: "oauth" } })
        : api("tickets", { oauth: OAUTH, tools: [] });
    const { ctx } = view(connector, held, owner);
    return direct(ctx, () =>
      name === "api.listTools" ? connector.listTools(ctx) : connector.verifyCallbackIssuer!(null, ctx),
    );
  };
}

const HANDLER_SEAMS = ["handler", "storage.get", "storage.put", "storage.CAS", "crypto.digest", "crypto.sign"] as const;
const REMOTE_SEAMS = ["request-token.resolve", "storage.get", "fetch"] as const;
const CALLBACK_OWNERS = ["request"] as const;
// Explicit compatibility: adding an entry or a reachable seam is one table
// line. No impossible Cartesian product (e.g. API prompts) is manufactured.
export const ENTRIES: readonly Entry[] = [
  { name: "api.listTools", seams: ["closed-entry"], completions: ["resolve"], create: closedEntry("api.listTools") },
  {
    name: "api.verifyCallbackIssuer",
    seams: ["closed-entry"],
    completions: ["resolve"],
    owners: CALLBACK_OWNERS,
    create: closedEntry("api.verifyCallbackIssuer"),
  },
  {
    name: "remote.verifyCallbackIssuer",
    seams: ["closed-entry"],
    completions: ["resolve"],
    owners: CALLBACK_OWNERS,
    create: closedEntry("remote.verifyCallbackIssuer"),
  },
  { name: "api.callTool", seams: HANDLER_SEAMS, create: apiHandler("api.callTool") },
  { name: "api.EffectEntry", seams: HANDLER_SEAMS, create: apiHandler("api.EffectEntry") },
  { name: "ctx.fetch", seams: ["fetch"], create: apiHandler("ctx.fetch") },
  { name: "ctx.fetch.derivedSignal", seams: ["fetch"], create: apiHandler("ctx.fetch.derivedSignal") },
  { name: "api.testCredential", seams: HANDLER_SEAMS, create: apiHandler("api.testCredential") },
  { name: "api.testCredentials", seams: HANDLER_SEAMS, create: apiHandler("api.testCredentials") },
  {
    name: "defineApiProvider.testCredential",
    seams: ["authenticate", "fetch", "mapper", ...HANDLER_SEAMS.slice(1)],
    create: providerProbe(false),
  },
  {
    name: "defineApiProvider.testCredentials",
    seams: ["authenticate", "fetch", "mapper", ...HANDLER_SEAMS.slice(1)],
    create: providerProbe(true),
  },
  { name: "ctx.credential.get", seams: ["storage.get"], create: credential("ctx.credential.get") },
  { name: "ctx.credential.getAll", seams: ["storage.get"], create: credential("ctx.credential.getAll") },
  { name: "Credentials.values", seams: ["storage.get"], create: credential("Credentials.values") },
  { name: "Grant.token", seams: ["storage.get"], create: grantUse("token") },
  { name: "Grant.refresh", seams: ["storage.get", "crypto.digest"], create: grantUse("refresh") },
  { name: "Grant.rejected", seams: ["closed-entry"], completions: ["resolve"], create: grantUse("rejected") },
  { name: "ctx.oauth.fetch", seams: ["storage.get", "fetch"], create: oauthFetch() },
  { name: "guardedFetch.auxiliary.oauth", seams: ["storage.get", "fetch"], create: oauthFetch(true) },
  { name: "guardedFetch", seams: ["authenticate", "mapper", "fetch", ...HANDLER_SEAMS.slice(1)], create: guarded() },
  {
    name: "guardedFetch.cancel",
    seams: ["body.cancel.redirect", "body.cancel.size"],
    create: guarded(),
    reviewer: true,
  },
  { name: "guardedFetch.auxiliary", seams: ["authenticate", "mapper", "fetch"], create: guarded(true) },
  { name: "guardedFetch.auxiliary.operationCredential", seams: ["storage.get"], create: guarded(true, true) },
  {
    name: "guardedFetch.auxiliary.cancel",
    seams: ["body.cancel.redirect", "body.cancel.size"],
    create: guarded(true),
    owners: CALLBACK_OWNERS,
    reviewer: true,
  },
  { name: "remote.listTools.requestToken", seams: ["storage.get"], create: remote("listTools"), reviewer: true },
  {
    name: "remote.listTools.credentialDigest",
    seams: ["crypto.digest"],
    create: remote("listTools", true, true),
    reviewer: true,
  },
  { name: "remote.listTools", seams: ["request-token.resolve", "fetch"], create: remote("listTools") },
  { name: "remote.callTool", seams: REMOTE_SEAMS, create: remote("callTool") },
  { name: "remote.readResource", seams: REMOTE_SEAMS, create: remote("readResource") },
  { name: "remote.skills.list", seams: REMOTE_SEAMS, create: remote("skills.list") },
  { name: "remote.skills.read", seams: REMOTE_SEAMS, create: remote("skills.read") },
  { name: "remote.testCredential", seams: ["storage.get", "crypto.digest"], create: remote("testCredential", true) },
  ...(
    [
      "registry.getTools",
      "registry.statusFor",
      "CatalogService.loadConnector",
      "CatalogService.resolveTool",
      "CatalogService.search",
      "CatalogService.describe",
    ] as const
  ).map((name) => ({
    name,
    seams: ["handler", "storage.get"] as const,
    owners: CALLBACK_OWNERS,
    create: catalog(name),
  })),
  ...(["api", "remote"] as const).flatMap((kind) =>
    (["status", "startAuth", "disconnectAuth", "verifyState", "consumeAuthError", "finishAuth"] as const).map(
      (name) => ({
        name: `${kind}.${name}`,
        seams:
          name === "startAuth"
            ? (["storage.get", "storage.CAS", "crypto.digest"] as const)
            : (["storage.get"] as const),
        create: oauth(name, kind),
        ...(name === "consumeAuthError" || name === "verifyState" || name === "finishAuth"
          ? { owners: CALLBACK_OWNERS }
          : {}),
      }),
    ),
  ),
];
