import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import type { OAuthStateSealer } from "../src/oauth-sealing.js";
import { CredentialVault } from "../src/credentials.js";
import { grantFromOAuth } from "../src/http/oauth.js";
import { runEdge } from "../src/runtime/run.js";
import { providerCallContext } from "../src/provider-call.js";
import { openRequest, viewLease } from "../src/runtime/call.js";
import { oauthGrantKeys, oauthV2Keys, scopes } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ApiHandlerContext } from "../src/connectors/api-connector.js";
import type { KVStorage } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { deferred } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { makeRegistry } from "./helpers.js";

const ISSUER = "https://auth.example";
const TOKEN = `${ISSUER}/token`;
const tokens = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };

async function promptly<T>(promise: Promise<T>): Promise<T | "still waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"still waiting">((resolve) => {
        timer = setTimeout(() => resolve("still waiting"), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function snapshot(storage: KVStorage) {
  return Object.fromEntries(
    await Promise.all((await storage.list("")).map(async (key) => [key, await storage.get(key)])),
  );
}

afterEach(() => vi.unstubAllGlobals());

const grantEntries = ["facade", "grant token", "grant refresh"] as const;
const grantPreparationCases = grantEntries.flatMap((entry) =>
  (entry === "facade" ? (["storage", "sealer"] as const) : (["sealer"] as const)).flatMap((seam) =>
    (["call", "request", ...(entry === "facade" ? ["fetch" as const] : [])] as const).map((boundary) => ({
      entry,
      seam,
      boundary,
    })),
  ),
);

it.each(grantPreparationCases)(
  "INV-7: $entry at $seam refuses on $boundary closure without releasing preparation",
  async ({ entry, seam, boundary }) => {
    const backing = memoryStorage();
    await seedGrant(backing, { issuer: TOKEN, tokens }, "v3:seeded", scopes.connector("tickets"));
    if (seam === "sealer") {
      const key = `${scopes.connector("tickets")}${oauthGrantKeys.grant}`;
      const raw = JSON.parse((await backing.get(key))!);
      raw.sealed = JSON.stringify(raw.body);
      delete raw.body;
      await backing.set(key, JSON.stringify(raw));
    }
    const before = await snapshot(backing);
    const entered = deferred<void>();
    const release = deferred<void>();
    let armed = false;
    let writes = 0;
    const storage: KVStorage = {
      ...backing,
      async get(key) {
        if (armed && seam === "storage" && key.endsWith(oauthGrantKeys.grant)) {
          entered.resolve();
          await release.promise;
        }
        return backing.get(key);
      },
      compareAndSet(...args) {
        writes++;
        return backing.compareAndSet(...args);
      },
    };
    const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    vault.seal = async (_id, _key, value) => value;
    vault.open = async (_id, _key, value) => {
      if (armed) {
        entered.resolve();
        await release.promise;
      }
      return value;
    };
    let view: ApiHandlerContext | undefined;
    let pending: Promise<unknown> | undefined;
    const abort = new AbortController();
    const scope = {};
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const connector = api("tickets", {
      oauth: {
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: TOKEN,
        clientId: "fixture-client",
        apiOrigins: [ISSUER],
      },
      tools: [
        {
          name: "read",
          description: "Read",
          annotations: { readOnlyHint: true },
          async handler(_, ctx) {
            view = ctx;
            armed = true;
            const grant = grantFromOAuth(ctx.oauth!);
            pending = (
              entry === "facade"
                ? ctx.oauth!.fetch(`${ISSUER}/notes`, { signal: abort.signal })
                : runEdge(entry === "grant token" ? grant.token : grant.refresh(tokens.access_token))
            ).catch((error: unknown) => error);
            await pending;
            return {};
          },
        },
      ],
    });
    const call = createMetaTools(
      makeRegistry([connector], { storage, ...(seam === "sealer" ? { credentialVault: vault } : {}) }),
      "https://connecta.test",
      {
        requestScope: scope,
      },
    ).callTool({ address: "tickets.read" });
    try {
      await entered.promise;
      if (boundary === "fetch") abort.abort(new Error("fetch ended"));
      else if (boundary === "call") viewLease(view!)!.close();
      else openRequest(scope).close();
      const result = await promptly(pending!);
      expect(result).not.toBe("still waiting");
      expect(result).toBeInstanceOf(Error);
      expect(fetch).not.toHaveBeenCalled();
      expect(writes).toBe(0);
      // Every retained Grant method guards its whole Promise, including the
      // synchronous request-scope rejection latch.
      if (boundary !== "fetch") {
        const grant = grantFromOAuth(view!.oauth!);
        for (const kept of [grant.token, grant.refresh(tokens.access_token), grant.rejected])
          await expect(runEdge(kept)).rejects.toBeInstanceOf(Error);
      }
    } finally {
      release.resolve();
      await pending;
      await call;
      openRequest(scope).close();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toBe(0);
    expect(await snapshot(backing)).toEqual(before);
  },
);

it.each(["call", "request"] as const)(
  "INV-7: a real remote session's catalog epoch wait refuses on %s closure with no operation signal",
  async (boundary) => {
    const backing = memoryStorage();
    const downstream = httpDownstream((server) => {
      server.registerTool(
        "read_items",
        { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => ({ content: [] }),
      );
    });
    await seedGrant(
      backing,
      {
        issuer: ISSUER,
        client: { value: { client_id: "fixture-client", token_endpoint_auth_method: "none" } },
        tokens,
        discovery: {
          authorizationServerUrl: ISSUER,
          resourceMetadata: { resource: downstream.url, authorization_servers: [ISSUER] },
          authorizationServerMetadata: {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: TOKEN,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
          },
        },
      },
      "v3:seeded",
      scopes.connector("tickets"),
    );
    let armed = false;
    let reads = 0;
    let writes = 0;
    const entered = deferred<void>();
    const release = deferred<void>();
    const storage: KVStorage = {
      ...backing,
      async get(key) {
        if (armed && key.endsWith(oauthGrantKeys.grant) && ++reads === 1) {
          entered.resolve();
          await release.promise;
        }
        return backing.get(key);
      },
      compareAndSet(...args) {
        if (armed) writes++;
        return backing.compareAndSet(...args);
      },
    };
    const fetch = vi.fn(downstream.fetch);
    vi.stubGlobal("fetch", fetch);
    const connector = remoteMcp("tickets", {
      url: downstream.url,
      versionNegotiation: "legacy",
      auth: { type: "oauth" },
    });
    const scope = {};
    const operation = makeRegistry([connector], { storage }).contextFor("tickets", "https://connecta.test", scope);
    expect(operation.signal).toBeUndefined();
    const opener = providerCallContext(operation, "read");
    await connector.listTools(opener);
    viewLease(opener)!.close();
    const view = boundary === "call" ? providerCallContext(operation, "read") : operation;
    const before = await snapshot(backing);
    fetch.mockClear();
    armed = true;
    const pending = connector.listTools(view).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await entered.promise;
      if (boundary === "call") viewLease(view)!.close();
      else openRequest(scope).close();
      const result = await promptly(pending);
      expect(result).not.toBe("still waiting");
      expect(result).toHaveProperty("error");
      expect(writes).toBe(0);
    } finally {
      release.resolve();
      await pending;
      // Call closure leaves the request's shared provider/session usable.
      if (boundary === "call") expect(await connector.listTools(operation)).toHaveLength(1);
      openRequest(scope).close();
      await connector.closeScope?.(operation);
    }
    expect(writes).toBe(0);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.body?.toString().includes('"method":"tools/list"')),
    ).toHaveLength(0);
    expect(await snapshot(backing)).toEqual(before);
  },
);

it.each([
  "migration list",
  "migration read",
  "migration open",
  "cleanup list",
  "cleanup delete",
  "grant open",
  "grant seal",
] as const)(
  "INV-7: closing OAuth preparation at %s stops the inner read chain before another I/O or mutation",
  async (phase) => {
    const backing = memoryStorage();
    const v2 = oauthV2Keys.value(oauthV2Keys.field.tokens, "v2:old");
    const legacy = JSON.stringify({ connectaOAuthVersion: 2, generation: "v2:old", issuer: ISSUER, value: tokens });
    if (phase.startsWith("migration")) {
      await backing.set(oauthV2Keys.generation, "v2:old");
      await backing.set(
        v2,
        phase === "migration open" ? JSON.stringify({ connectaOAuthSealed: 1, sealed: legacy }) : legacy,
      );
    } else {
      await seedGrant(backing, { issuer: ISSUER, tokens });
      const raw = JSON.parse((await backing.get(oauthGrantKeys.grant))!);
      if (phase.startsWith("cleanup")) {
        raw.cleanupPending = true;
        await backing.set(v2, legacy);
      }
      if (phase === "grant open") {
        raw.sealed = JSON.stringify(raw.body);
        delete raw.body;
      }
      await backing.set(oauthGrantKeys.grant, JSON.stringify(raw));
    }
    const entered = deferred<void>();
    const release = deferred<void>();
    const operations: string[] = [];
    const at = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
      operations.push(label);
      if (label === phase) {
        entered.resolve();
        await release.promise;
      }
      return work();
    };
    const storage: KVStorage = {
      ...backing,
      get: (key) => at(key === v2 ? "migration read" : `get:${key}`, () => backing.get(key)),
      list: (prefix) =>
        at(phase.startsWith("migration") ? "migration list" : "cleanup list", () => backing.list(prefix)),
      delete: (key) => at("cleanup delete", () => backing.delete(key)),
      compareAndSet: (...args) => at("CAS", () => backing.compareAndSet(...args)),
    };
    const sealer: OAuthStateSealer = {
      open: (_label, value) => at(phase === "migration open" ? phase : "grant open", async () => value),
      seal: (_label, value) => at("grant seal", async () => value),
      warn: () => {},
    };
    const abort = new AbortController();
    const provider = new KvOAuthProvider(
      "tickets",
      storage,
      "https://connecta.test/oauth/callback/tickets",
      undefined,
      false,
      phase.includes("open") || phase.includes("seal") ? sealer : undefined,
      abort.signal,
    );
    const pending = provider.beginFlow().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let afterClose: string[] = [];
    try {
      await entered.promise;
      abort.abort(new Error("preparation ended"));
      const result = await promptly(pending);
      expect(result).not.toBe("still waiting");
      expect(result).toEqual({ error: abort.signal.reason });
      afterClose = [...operations];
    } finally {
      release.resolve();
      await pending;
      // Drain late custom-storage/sealer continuations before comparing I/O.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(operations).toEqual(afterClose);
    expect(operations).not.toContain("CAS");
  },
);
