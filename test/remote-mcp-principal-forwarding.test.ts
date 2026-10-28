// Principal forwarding and a custom transport for remoteMcp() (#1103).
//
// What this pins: request auth sees the admitted principal only when the
// deployment opts in, only from the admitting authorization (never arguments,
// programs or headers), and only for admitted people unless agents are
// explicitly accepted. A principal is part of the client's identity, so no
// client, connection or token crosses principals. A custom fetch carries every
// MCP request, nothing reaches global fetch, and the configured URL's
// cleartext, redirect and origin rules still apply.
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { remoteMcp, type RemoteMcpOptions } from "../src/connectors/remote-mcp.js";
import { closeConnectorScope } from "../src/connector-scope.js";
import type { ConnectorCaller } from "../src/connector-caller.js";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import type { UiConnector } from "../src/operator-ui/model.js";
import { memoryStorage } from "../src/storage/memory.js";
import { accessTokens } from "../src/access-tokens.js";
import type { PrincipalRequestToken, RequestPrincipal, RequestToken } from "../src/request-token.js";
import type { AuthenticatedIdentity, InboundAuth, KVStorage, Logger } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, deferred, scriptedExecutor } from "./fixtures/misc.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";

const URL_ = "https://notes.example.com/mcp";
const BASE = "https://connecta.test";
const NAMESPACE = "https://identity.test";
const TOKEN_SENTINEL = "tok-SECRET-SENTINEL";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Global fetch must never carry this connector's traffic. */
function forbidGlobalFetch() {
  const global = vi.fn(async () => {
    throw new Error("global fetch used");
  });
  vi.stubGlobal("fetch", global);
  return global;
}

interface Exchange {
  url: string;
  method: string;
  rpc?: string;
  authorization: string | null;
  args?: Record<string, unknown>;
}

/** An MCP downstream served through a custom fetch that records each request. */
function notes(respond?: (exchange: Exchange) => Response | undefined) {
  const wire: Exchange[] = [];
  const downstream = httpDownstream(
    (server) => {
      server.registerTool(
        "whoami",
        {
          description: "Echo the arguments",
          inputSchema: z.object({}).passthrough(),
          annotations: { readOnlyHint: true },
        },
        async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
      );
      server.registerTool(
        "save_note",
        { description: "Save a note", inputSchema: z.object({}).passthrough() },
        async () => ({ content: [{ type: "text", text: "saved" }] }),
      );
    },
    { url: URL_ },
  );
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    let rpc: { method?: string; params?: { arguments?: Record<string, unknown> } } | undefined;
    if (request.method === "POST") {
      try {
        rpc = (await request.clone().json()) as typeof rpc;
      } catch {}
    }
    const exchange: Exchange = {
      url: request.url,
      method: request.method,
      ...(rpc?.method ? { rpc: rpc.method } : {}),
      authorization: request.headers.get("authorization"),
      ...(rpc?.params?.arguments ? { args: rpc.params.arguments } : {}),
    };
    wire.push(exchange);
    return respond?.(exchange) ?? (await downstream.fetch(input, init));
  });
  return { wire, fetch, calls: () => wire.filter((exchange) => exchange.rpc === "tools/call") };
}

const tokenFor = (principal: RequestPrincipal) =>
  principal.kind === "human"
    ? `${TOKEN_SENTINEL}-${principal.namespace}-${principal.id}`
    : `${TOKEN_SENTINEL}-agent-${principal.name}-${principal.pool}`;

function resolver<P extends RequestPrincipal = RequestPrincipal>(mint: (principal: P) => string = tokenFor) {
  const token = vi.fn(async (_ctx: unknown, { principal }: { principal: P }) => mint(principal));
  return token as typeof token & PrincipalRequestToken<P>;
}

function person(id: string): AuthenticatedIdentity {
  const reference = { namespace: NAMESPACE, id };
  return {
    actor: { kind: "test-users", id, namespace: NAMESPACE },
    subject: reference,
    principal: reference,
    interactive: true,
  };
}

function people(): InboundAuth {
  return {
    kind: "test-users",
    interactiveOperator: true,
    activityActorNamespace: NAMESPACE,
    authorize(request) {
      const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
      return user
        ? { ok: true, userId: user, subjectId: user }
        : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    },
  };
}

/** One request's context, scoped to the admitted caller as core builds it. */
function scoped(connector: ReturnType<typeof remoteMcp>, caller: ConnectorCaller | undefined, requestScope = {}) {
  const registry = makeRegistry([connector]);
  return registry
    .scoped({ connectorIds: "all", ...(caller ? { caller } : {}) })
    .contextFor(connector.id, BASE, requestScope);
}

async function deployment(
  connector: ReturnType<typeof remoteMcp>,
  options: {
    executor?: Parameters<typeof createTestConnecta>[0]["executor"];
    auth?: InboundAuth;
    logger?: Logger;
    storage?: KVStorage;
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const connecta = createTestConnecta({
    connectors: [connector],
    auth: options.auth ?? people(),
    maintainers: ["alice", "bob"],
    agents: ["assistant"],
    accessTokens: accessTokens(storage),
    storage,
    pools: { team: { tools: ["notes"], members: ["alice", "bob", "agent:assistant"] } },
    ...(options.executor ? { executor: options.executor } : {}),
    logger: options.logger ?? silentLogger,
  });
  return { connecta, assistant: await issueAgentToken(storage, "assistant") };
}

async function callOver(
  connecta: { fetch(request: Request): Promise<Response> },
  token: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const request = mcpRpc(
    "tools/call",
    { name, arguments: args },
    { token, ...(token.startsWith("cta_") ? { agentPool: "team" } : { pool: "team" }) },
  );
  for (const [header, value] of Object.entries(headers)) request.headers.set(header, value);
  return (await readJsonRpc(await connecta.fetch(request))).result;
}

it("INV-3 INV-4: forwards each admitted person, whatever arguments, programs and headers say", NODE, async () => {
  forbidGlobalFetch();
  const downstream = notes();
  const token = resolver<Extract<RequestPrincipal, { kind: "human" }>>();
  const connector = remoteMcp("notes", {
    url: URL_,
    fetch: downstream.fetch,
    auth: { type: "request", principal: { accept: "human", token } },
  });
  const forged = { principal: { kind: "human", namespace: NAMESPACE, id: "bob" }, who: "alice" };
  const { connecta } = await deployment(connector, {
    executor: scriptedExecutor(async (fns) => fns.call!("notes.whoami", { ...forged, from: "program" })),
  });
  try {
    const headers = { "X-Connecta-Principal": "bob", "X-Forwarded-User": "bob", "X-Notes-Principal": "bob" };
    const [alice, bob] = await Promise.all([
      callOver(connecta, "alice", "call_tool", { address: "notes.whoami", args: forged }, headers),
      callOver(connecta, "bob", "call_tool", { address: "notes.whoami", args: { who: "bob" } }),
    ]);
    expect(alice.isError).toBeFalsy();
    expect(bob.isError).toBeFalsy();
    const program = await callOver(connecta, "alice", "execute_code", { code: "return 1" }, headers);
    expect(program.isError).toBeFalsy();

    const principals = token.mock.calls.map(([, input]) => input.principal);
    expect(new Set(principals.map((principal) => JSON.stringify(principal)))).toEqual(
      new Set([
        JSON.stringify({ kind: "human", namespace: NAMESPACE, id: "alice" }),
        JSON.stringify({ kind: "human", namespace: NAMESPACE, id: "bob" }),
      ]),
    );
    for (const principal of principals) expect(Object.isFrozen(principal)).toBe(true);
    const calls = downstream.calls();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const who = call.args?.from === "program" || call.args?.who === "alice" ? "alice" : "bob";
      expect(call.authorization).toBe(`Bearer ${TOKEN_SENTINEL}-${NAMESPACE}-${who}`);
    }
  } finally {
    await connecta.close();
  }
});

it("INV-4: refuses agents with a typed error unless the deployment accepts them", NODE, async () => {
  forbidGlobalFetch();
  for (const accept of ["human", "human-or-agent"] as const) {
    const downstream = notes();
    const token = resolver();
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      auth: { type: "request", principal: accept === "human" ? { accept, token } : { accept, token } },
    });
    const { connecta, assistant } = await deployment(connector);
    try {
      const result = await callOver(connecta, assistant, "call_tool", {
        address: "notes.whoami",
        args: { principal: { kind: "human", namespace: NAMESPACE, id: "alice" } },
      });
      if (accept === "human") {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("auth_required");
        expect(JSON.stringify(result)).toContain("refuses agents");
        expect(token).not.toHaveBeenCalled();
        expect(downstream.wire).toEqual([]);
      } else {
        expect(result.isError).toBeFalsy();
        // Resolved before connecting and before reusing the client, always as the agent.
        expect(token).toHaveBeenCalled();
        for (const [, input] of token.mock.calls)
          expect(input.principal).toEqual({ kind: "agent", name: "assistant", pool: "team" });
        expect(downstream.calls().map((call) => call.authorization)).toEqual([
          `Bearer ${TOKEN_SENTINEL}-agent-assistant-team`,
        ]);
      }
    } finally {
      await connecta.close();
    }
  }
});

it("INV-3 INV-10: fails closed before the resolver when no admitted person is present", NODE, async () => {
  forbidGlobalFetch();
  const downstream = notes();
  const token = resolver();
  const connector = remoteMcp("notes", {
    url: URL_,
    fetch: downstream.fetch,
    auth: { type: "request", principal: { accept: "human-or-agent", token } },
  });
  const machine: AuthenticatedIdentity = {
    actor: { kind: "access_token", id: "robot" },
    subject: { namespace: "connecta:test-machine", id: "robot" },
    interactive: false,
  };
  const agentWithoutPool: AuthenticatedIdentity = {
    actor: { kind: "access_token", id: "assistant" },
    subject: { namespace: "connecta:agent", id: "assistant" },
    agent: "assistant",
    interactive: false,
  };
  const callers: (ConnectorCaller | undefined)[] = [
    undefined,
    { identity: { actor: { kind: "anonymous" }, interactive: false }, authenticated: false },
    { identity: person("alice"), authenticated: false },
    { identity: machine, authenticated: true },
    { identity: agentWithoutPool, authenticated: true },
    { identity: { ...person("alice"), principal: { namespace: "", id: "alice" } }, authenticated: true },
  ];
  for (const caller of callers) {
    const ctx = scoped(connector, caller);
    try {
      await expect(connector.listTools(ctx)).rejects.toMatchObject({
        code: "auth_required",
        message: expect.stringContaining("acts as the admitted caller"),
      });
      await expect(connector.callTool("whoami", {}, ctx)).rejects.toMatchObject({ code: "auth_required" });
      if (caller?.authenticated) expect((await connector.status!(ctx)).state).toBe("auth_required");
    } finally {
      await connector.closeScope?.(ctx);
    }
  }
  // A background check has no admitted caller: it reports a non-error state.
  const probe = scoped(connector, undefined);
  const status = await connector.status!(probe);
  await connector.closeScope?.(probe);
  expect(status).toMatchObject({
    state: "per_caller",
    message: "Authenticates as each caller; verified on use.",
  });
  expect(token).not.toHaveBeenCalled();
  expect(downstream.wire).toEqual([]);
});

it(
  "INV-7: a principal change replaces the client, and concurrent principals never share a credential",
  NODE,
  async () => {
    forbidGlobalFetch();
    for (const mint of [tokenFor, () => `${TOKEN_SENTINEL}-shared`]) {
      const downstream = notes();
      const token = resolver(mint);
      const connector = remoteMcp("notes", {
        url: URL_,
        fetch: downstream.fetch,
        // Every connect performs a handshake on the wire, so a rebuild is visible.
        versionNegotiation: "legacy",
        auth: { type: "request", principal: { accept: "human", token } },
      });
      // One request scope, as when two callers' operations meet in one isolate.
      const scope = {};
      const ctx = (who: string) => scoped(connector, { identity: person(who), authenticated: true }, scope);
      const call = async (who: string) =>
        (await connector.callTool("whoami", { who }, ctx(who))) as { content: { text: string }[] };
      try {
        for (const who of ["alice", "alice", "bob", "alice"]) {
          expect(JSON.parse((await call(who)).content[0]!.text)).toEqual({ who });
        }
        // Alice's client served her second call; each change of principal reconnected.
        expect(downstream.wire.filter((exchange) => exchange.rpc === "initialize")).toHaveLength(3);
        const settled = await Promise.allSettled(
          Array.from({ length: 8 }, (_, index) => call(index % 2 ? "bob" : "alice")),
        );
        for (const [index, outcome] of settled.entries()) {
          if (outcome.status === "fulfilled") {
            expect(JSON.parse(outcome.value.content[0]!.text)).toEqual({ who: index % 2 ? "bob" : "alice" });
            // A displaced connect fails its waiters; it never hands them another principal's client.
          } else expect(outcome.reason).toBeInstanceOf(Error);
        }
        // Every call on the wire carries its own caller's credential.
        for (const exchange of downstream.calls()) {
          const who = String(exchange.args?.who);
          expect(exchange.authorization).toBe(`Bearer ${mint({ kind: "human", namespace: NAMESPACE, id: who })}`);
        }
      } finally {
        await connector.closeScope?.(ctx("alice"));
      }
    }
  },
);

it(
  "INV-9: the custom fetch carries every MCP request, writes included, and nothing reaches global fetch",
  WORKERS,
  async () => {
    const global = forbidGlobalFetch();
    const downstream = notes();
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      auth: { type: "request", token: async () => TOKEN_SENTINEL },
    });
    const ctx = connectorContext();
    try {
      expect((await connector.listTools(ctx)).map((tool) => tool.name).sort()).toEqual(["save_note", "whoami"]);
      await connector.callTool("whoami", { who: "alice" }, ctx);
      // No owned transport is installed: the deployment's fetch owns the write.
      await connector.callTool("save_note", { text: "hello" }, ctx);
    } finally {
      await connector.closeScope?.(ctx);
    }
    expect(global).not.toHaveBeenCalled();
    const methods = downstream.wire.map((exchange) => exchange.rpc ?? exchange.method);
    expect(methods).toEqual(expect.arrayContaining(["server/discover", "tools/list", "tools/call"]));
    expect(downstream.calls().map((call) => call.args)).toEqual([{ who: "alice" }, { text: "hello" }]);
    for (const exchange of downstream.wire) {
      expect(new URL(exchange.url).origin).toBe("https://notes.example.com");
      expect(exchange.authorization).toBe(`Bearer ${TOKEN_SENTINEL}`);
    }
    // Each write was handed over once, never replayed through the owned sender.
    const owned = installOwnedTransport();
    const write = connectorContext();
    try {
      await connector.callTool("save_note", { text: "again" }, write);
    } finally {
      await connector.closeScope?.(write);
    }
    expect(owned.send).not.toHaveBeenCalled();
    expect(downstream.calls().filter((call) => call.args?.text === "again")).toHaveLength(1);
  },
);

it("INV-11: the configured URL's cleartext and OAuth rules still apply with a custom fetch", WORKERS, () => {
  const fetch = vi.fn(async () => new Response(null, { status: 500 }));
  const request = { type: "request" as const, token: async () => "token" };
  expect(() => remoteMcp("notes", { url: "http://notes.internal/mcp", fetch, auth: request })).toThrow("not https");
  expect(() =>
    remoteMcp("notes", {
      url: "http://notes.internal/mcp",
      fetch,
      requireHttps: true,
      auth: { type: "headers", headers: {} },
    }),
  ).toThrow("not https");
  expect(() => remoteMcp("notes", { url: URL_, fetch, auth: { type: "oauth" } })).toThrow("without OAuth");
  expect(() => remoteMcp("notes", { url: URL_, fetch: "binding" as never, auth: request })).toThrow(
    "must be a function",
  );
  expect(() => remoteMcp("notes", { url: "file:///notes", fetch, auth: request })).toThrow("http(s)");
  expect(fetch).not.toHaveBeenCalled();
});

it("INV-5: redirects through a custom fetch stay on the configured origin", WORKERS, async () => {
  const global = forbidGlobalFetch();
  for (const [redirects, location] of [
    ["none", "/elsewhere"],
    ["same-origin", "https://attacker.example/mcp"],
    ["same-origin", "http://notes.example.com/mcp"],
  ] as const) {
    const downstream = notes((exchange) =>
      exchange.rpc === "initialize" || exchange.rpc === "server/discover"
        ? new Response(null, { status: 307, headers: { Location: location } })
        : undefined,
    );
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      redirects,
      auth: { type: "request", token: async () => TOKEN_SENTINEL },
    });
    const ctx = connectorContext();
    try {
      await expect(connector.listTools(ctx)).rejects.toMatchObject({ code: "connector_call_failed" });
    } finally {
      await connector.closeScope?.(ctx);
    }
    expect(downstream.wire.map((exchange) => new URL(exchange.url).href)).toEqual(downstream.wire.map(() => URL_));
  }
  // A same-origin redirect is followed through the same custom fetch.
  let redirected = false;
  const downstream = notes((exchange) => {
    if (redirected || exchange.method !== "POST") return undefined;
    redirected = true;
    return new Response(null, { status: 307, headers: { Location: "/mcp" } });
  });
  const connector = remoteMcp("notes", {
    url: "https://notes.example.com/old",
    fetch: downstream.fetch,
    redirects: "same-origin",
    auth: { type: "request", token: async () => TOKEN_SENTINEL },
  });
  const ctx = connectorContext();
  try {
    await expect(connector.listTools(ctx)).resolves.toHaveLength(2);
  } finally {
    await connector.closeScope?.(ctx);
  }
  expect(downstream.wire.slice(0, 2).map((exchange) => new URL(exchange.url).pathname)).toEqual(["/old", "/mcp"]);
  expect(global).not.toHaveBeenCalled();
});

it("INV-11: principal forwarding is explicit, closed and unchanged when absent", NODE, async () => {
  const token = resolver();
  const refused: RemoteMcpOptions["auth"][] = [
    { type: "request", token: async () => "token", principal: { accept: "human", token } } as never,
    { type: "request", principal: { accept: "agent", token } } as never,
    { type: "request", principal: { accept: "human", token: "token" } } as never,
    { type: "request", principal: { accept: "human", token, owner: "alice" } } as never,
    { type: "request", principal: "human" } as never,
    { type: "headers", headers: {}, principal: { accept: "human", token } } as never,
  ];
  for (const auth of refused) expect(() => remoteMcp("notes", { url: URL_, ...(auth ? { auth } : {}) })).toThrow();
  // The published type refuses the combination before startup does.
  expect(() =>
    remoteMcp("notes", {
      url: URL_,
      // @ts-expect-error token and principal are mutually exclusive
      auth: { type: "request", token: async () => "token", principal: { accept: "human", token } },
    }),
  ).toThrow();
  expect(() =>
    remoteMcp("notes", {
      url: URL_,
      authScope: "personal",
      auth: { type: "request", principal: { accept: "human", token } },
    }),
  ).toThrow("shared authScope");

  // Without the option, a request resolver still receives the context alone,
  // even when an admitted person is present.
  installOwnedTransport();
  const downstream = notes();
  vi.stubGlobal("fetch", downstream.fetch);
  const plain = vi.fn(async () => TOKEN_SENTINEL) as ReturnType<typeof vi.fn> & RequestToken;
  const connector = remoteMcp("notes", { url: URL_, auth: { type: "request", token: plain } });
  const ctx = scoped(connector, { identity: person("alice"), authenticated: true });
  try {
    await connector.callTool("whoami", {}, ctx);
  } finally {
    await connector.closeScope?.(ctx);
  }
  expect(plain.mock.calls.length).toBeGreaterThan(0);
  for (const args of plain.mock.calls) expect(args).toHaveLength(1);
  expect(downstream.calls().map((call) => call.authorization)).toEqual([`Bearer ${TOKEN_SENTINEL}`]);
});

it(
  "INV-5 INV-6: the forwarded principal and its token stay out of describe, status, logs and storage",
  NODE,
  async () => {
    forbidGlobalFetch();
    const rejected = `${TOKEN_SENTINEL}-${NAMESPACE}-bob`;
    const downstream = notes((exchange) =>
      exchange.authorization === `Bearer ${rejected}` && exchange.rpc === "tools/call"
        ? Response.json({ error: `bad token ${rejected}` }, { status: 401 })
        : undefined,
    );
    const invalidate = vi.fn(async () => {});
    const token = Object.assign(resolver(), { invalidate });
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      auth: { type: "request", principal: { accept: "human", token } },
    });
    const lines: unknown[] = [];
    const logger: Logger = {
      debug: (...args) => lines.push(args),
      info: (...args) => lines.push(args),
      warn: (...args) => lines.push(args),
      error: (...args) => lines.push(args),
    };
    const inner = memoryStorage();
    const writes: string[] = [];
    const storage: KVStorage = {
      ...inner,
      async set(key, value, opts) {
        writes.push(key, value);
        return inner.set(key, value, opts);
      },
    };
    const { connecta } = await deployment(connector, { logger, storage });
    try {
      const alice = await callOver(connecta, "alice", "call_tool", { address: "notes.whoami", args: {} });
      expect(alice.isError).toBeFalsy();
      const bob = await callOver(connecta, "bob", "call_tool", { address: "notes.whoami", args: {} });
      expect(bob.isError).toBe(true);
      expect(JSON.stringify(bob)).toContain("auth_required");
      expect(invalidate).toHaveBeenCalledWith(rejected, expect.anything(), {
        principal: { kind: "human", namespace: NAMESPACE, id: "bob" },
      });
      const described = JSON.stringify([connector.describe?.(), connecta.describeConfig()]);
      const status = JSON.stringify(await connector.status!(scoped(connector, undefined)));
      const rendered = [
        described,
        status,
        JSON.stringify(lines),
        JSON.stringify(writes),
        JSON.stringify(alice),
        JSON.stringify(bob),
      ];
      for (const text of rendered) expect(text).not.toContain(TOKEN_SENTINEL);
      // Nothing renders or stores the forwarded principal's own form either.
      // (describeConfig lists configured members; the connector's description does not.)
      for (const text of [
        JSON.stringify(connector.describe?.()),
        status,
        JSON.stringify(lines),
        JSON.stringify(writes),
      ]) {
        expect(text).not.toContain('"kind":"human"');
        expect(text).not.toContain(NAMESPACE);
      }
      expect(described).toContain('"mode":"request"');
    } finally {
      await connecta.close();
    }
  },
);

// A real service binding on workerd: the identity entrypoint is reachable only
// through the binding, and the forwarded principal crosses it.
const bindings = await (async () => {
  try {
    const module = "cloudflare:test";
    return ((await import(/* @vite-ignore */ module)) as { env: Record<string, Fetcher> }).env;
  } catch {
    return undefined;
  }
})();
const binding = bindings?.NOTES_MCP;

it.skipIf(!binding)("forwards the admitted person over a Workers service binding", WORKERS, async () => {
  const global = forbidGlobalFetch();
  const token = resolver<Extract<RequestPrincipal, { kind: "human" }>>((principal) => `${principal.id}.signed`);
  const connector = remoteMcp("notes", {
    url: URL_,
    fetch: (input, init) => binding!.fetch(input, init),
    auth: { type: "request", principal: { accept: "human", token } },
  });
  const ctx = scoped(connector, { identity: person("alice"), authenticated: true });
  try {
    const result = (await connector.callTool("whoami", {}, ctx)) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe("alice");
  } finally {
    await connector.closeScope?.(ctx);
  }
  expect(global).not.toHaveBeenCalled();
  // The same Worker's public route never accepts the forwarded identity.
  const publicRoute = await bindings!.NOTES_PUBLIC!.fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer alice.signed" },
  });
  expect(publicRoute.status).toBe(403);
  await publicRoute.body?.cancel();
});

it.skipIf(!bindings?.NOTES_RPC)(
  "INV-7: operator config and details dispose service-binding RPC responses",
  WORKERS,
  async () => {
    const rpc = bindings!.NOTES_RPC as unknown as {
      request(url: string, init?: RequestInit): Promise<Response & Disposable>;
    };
    const results: ReturnType<typeof vi.fn>[] = [];
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: async (input, init) => {
        const { signal: _signal, ...rpcInit } = init ?? {};
        const response = await rpc.request(String(input), rpcInit);
        const dispose = response[Symbol.dispose].bind(response);
        const disposed = vi.fn(dispose);
        Object.defineProperty(response, Symbol.dispose, { value: disposed });
        results.push(disposed);
        return response;
      },
      auth: { type: "request", token: async () => "alice.signed" },
    });
    const { connecta } = await deployment(connector);
    try {
      for (const path of ["/ui/api/config", "/ui/connectors/notes"]) {
        const response = await connecta.fetch(new Request(BASE + path, { headers: { Authorization: "Bearer alice" } }));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(JSON.stringify(body)).toContain("whoami");
      }
    } finally {
      await connecta.close();
    }
    expect(results.length).toBeGreaterThan(0);
    for (const disposed of results) expect(disposed).toHaveBeenCalledOnce();
  },
);

it.skipIf(!bindings?.NOTES_RPC)(
  "INV-7: a late RPC response is disposed without extending a cancelled probe",
  WORKERS,
  async () => {
    const received = deferred<void>();
    const release = deferred<void>();
    const disposed = vi.fn();
    const rpc = bindings!.NOTES_RPC as unknown as {
      request(url: string, init?: RequestInit): Promise<Response & Disposable>;
    };
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: async (input, init) => {
        const { signal: _signal, ...rpcInit } = init ?? {};
        const response = await rpc.request(String(input), rpcInit);
        const dispose = response[Symbol.dispose].bind(response);
        Object.defineProperty(response, Symbol.dispose, {
          value: () => {
            disposed();
            dispose();
          },
        });
        received.resolve();
        await release.promise;
        return response;
      },
      auth: { type: "request", token: async () => "alice.signed" },
    });
    const ctx = scoped(connector, undefined);
    const pending = connector.status!(ctx);
    try {
      await received.promise;
      await closeConnectorScope(connector, ctx);
      // Cancellation settles the probe before the custom fetch returns.
      await pending;
      expect(disposed).not.toHaveBeenCalled();
      release.resolve();
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    } finally {
      release.resolve();
      await closeConnectorScope(connector, ctx);
    }
  },
);
||||||| parent of 3b4b9f2d (Report principal-forwarding connectors truthfully on the operator page (#1150))

it.each(["human", "human-or-agent"] as const)(
  "operator status verifies the real downstream as the admitted human (%s)",
  NODE,
  async (accept) => {
    forbidGlobalFetch();
    const downstream = notes();
    const token = resolver();
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      versionNegotiation: "legacy",
      auth: { type: "request", principal: { accept, token } },
    });
    const { connecta } = await deployment(connector);
    try {
      for (const id of ["alice", "bob"]) {
        const headers = { Authorization: `Bearer ${id}`, "X-Connecta-Principal": id === "alice" ? "bob" : "alice" };
        const response = await connecta.fetch(new Request(`${BASE}/ui/api/config`, { headers }));
        expect(response.status).toBe(200);
        const contract = (await response.json()) as OperatorUiContractV2;
        expect(contract.live.connectors[0]).toMatchObject({ status: "ok" });
        expect(contract.live.connectors[0]!.problem).toBeUndefined();
        const detail = (await (
          await connecta.fetch(new Request(`${BASE}/ui/connectors/notes`, { headers }))
        ).json()) as UiConnector;
        expect(detail).toMatchObject({ status: "ok", toolCount: 2 });
        expect(detail.problem).toBeUndefined();
        expect(detail.tools.map((t) => t.name)).toContain("whoami");
      }
      expect(
        token.mock.calls.map(([, input]) =>
          input.principal.kind === "human" ? input.principal.id : input.principal.name,
        ),
      ).toEqual(expect.arrayContaining(["alice", "bob"]));
      for (const id of ["alice", "bob"]) {
        const wire = downstream.wire.filter(
          (e) => e.authorization === `Bearer ${tokenFor({ kind: "human", namespace: NAMESPACE, id })}`,
        );
        expect(wire.map((e) => e.rpc)).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
      }
    } finally {
      await connecta.close();
    }
  },
);

it("operator status preserves downstream failures instead of diagnosing a missing secret", NODE, async () => {
  forbidGlobalFetch();
  for (const status of [401, 503]) {
    const downstream = notes(() => new Response(null, { status }));
    const token = resolver();
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      auth: { type: "request", principal: { accept: "human", token } },
    });
    const { connecta } = await deployment(connector);
    try {
      const detail = (await (
        await connecta.fetch(
          new Request(`${BASE}/ui/connectors/notes`, {
            headers: { Authorization: "Bearer alice" },
          }),
        )
      ).json()) as UiConnector;
      expect(detail).toMatchObject(
        status === 401
          ? { status: "auth_required", problem: "caller_refused" }
          : { status: "error", problem: "connector_unavailable" },
      );
      expect(token).toHaveBeenCalled();
      expect(downstream.wire.length).toBeGreaterThan(0);
    } finally {
      await connecta.close();
    }
  }
});

it(
  "status enforces the call's accept policy and never shares a client's principal, even with the same token",
  NODE,
  async () => {
    forbidGlobalFetch();
    const downstream = notes();
    const token = resolver(() => TOKEN_SENTINEL);
    const connector = remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      versionNegotiation: "legacy",
      auth: { type: "request", principal: { accept: "human", token } },
    });
    const requestScope = {};
    const ctx = (caller: ConnectorCaller) => scoped(connector, caller, requestScope);
    const alice = ctx({ identity: person("alice"), authenticated: true });
    const bob = ctx({ identity: person("bob"), authenticated: true });
    try {
      for (const context of [alice, alice, bob, alice]) expect((await connector.status!(context)).state).toBe("ok");
      expect(downstream.wire.filter((e) => e.rpc === "initialize")).toHaveLength(3);
      const before = downstream.wire.length;
      const agent = ctx({
        identity: { actor: { kind: "access_token", id: "assistant" }, agent: "assistant", interactive: false },
        authenticated: true,
        pool: "team",
      });
      expect(await connector.status!(agent)).toMatchObject({
        state: "auth_required",
        message: expect.stringContaining("refuses agents"),
      });
      await expect(connector.callTool("whoami", {}, agent)).rejects.toMatchObject({
        code: "auth_required",
        message: expect.stringContaining("refuses agents"),
      });
      expect(downstream.wire).toHaveLength(before);
    } finally {
      await connector.closeScope?.(alice);
    }
  },
);

it("an operator API with no person reports per_caller without downstream work or warning logs", NODE, async () => {
  forbidGlobalFetch();
  const downstream = notes();
  const token = resolver();
  const connector = remoteMcp("notes", {
    url: URL_,
    fetch: downstream.fetch,
    auth: { type: "request", principal: { accept: "human", token } },
  });
  const warn = vi.fn();
  const connecta = createTestConnecta({ connectors: [connector], logger: { ...silentLogger, warn } });
  try {
    warn.mockClear();
    const detail = (await (await connecta.fetch(new Request(`${BASE}/ui/connectors/notes`))).json()) as UiConnector;
    expect(detail).toMatchObject({ status: "per_caller", toolCount: 0, overlay: { status: "per_caller" } });
    expect(detail.problem).toBeUndefined();
    const registryStatus = await makeRegistry([connector]).statusFor("notes", BASE);
    expect(registryStatus).toMatchObject({
      state: "per_caller",
      message: "Authenticates as each caller; verified on use.",
    });
    expect(token).not.toHaveBeenCalled();
    expect(downstream.wire).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    await connecta.close();
  }
});

it.each(["request", "credential", "headers", "oauth"] as const)(
  "operator and background status keep existing %s auth behavior",
  NODE,
  async (mode) => {
    const downstream = notes();
    if (mode === "oauth") vi.stubGlobal("fetch", downstream.fetch);
    else forbidGlobalFetch();
    const auth: RemoteMcpOptions["auth"] =
      mode === "request"
        ? { type: "request", token: async () => TOKEN_SENTINEL }
        : mode === "credential"
          ? { type: "credential" }
          : mode === "headers"
            ? { type: "headers", headers: { Authorization: `Bearer ${TOKEN_SENTINEL}` } }
            : { type: "oauth" };
    const connector = remoteMcp("notes", {
      url: URL_,
      versionNegotiation: "legacy",
      auth,
      ...(mode === "oauth" ? {} : { fetch: downstream.fetch }),
    });
    const expected = mode === "credential" || mode === "oauth" ? "auth_required" : "ok";
    const context = connectorContext();
    try {
      expect((await connector.status!(context)).state).toBe(expected);
      const { connecta } = await deployment(connector);
      try {
        const response = await connecta.fetch(
          new Request(`${BASE}/ui/connectors/notes`, { headers: { Authorization: "Bearer alice" } }),
        );
        const detail = (await response.json()) as UiConnector;
        expect(detail.status).toBe(mode === "credential" ? "credential_required" : expected);
        if (mode === "credential") expect(detail.problem).toBe("credential_required");
        if (mode === "oauth") expect(detail.problem).toBe("oauth_required");
      } finally {
        await connecta.close();
      }
    } finally {
      await connector.closeScope?.(context);
    }
  },
);

it("operator authentication is the admission fact, independent of the provider's kind label", NODE, async () => {
  forbidGlobalFetch();
  const downstream = notes();
  const token = resolver();
  const connector = remoteMcp("notes", {
    url: URL_,
    fetch: downstream.fetch,
    auth: { type: "request", principal: { accept: "human", token } },
  });
  const { connecta } = await deployment(connector, { auth: { ...people(), kind: "anonymous" } });
  try {
    const response = await connecta.fetch(
      new Request(`${BASE}/ui/connectors/notes`, { headers: { Authorization: "Bearer alice" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", toolCount: 2 });
    expect(token.mock.calls[0]![1].principal).toEqual({ kind: "human", namespace: NAMESPACE, id: "alice" });
  } finally {
    await connecta.close();
  }
});

it("operator observations and opaque viewer keys never cross admitted principals (#1150)", NODE, async () => {
  forbidGlobalFetch();
  const downstream = notes((exchange) =>
    exchange.authorization?.endsWith("-bob") ? new Response(null, { status: 401 }) : undefined,
  );
  const storage = memoryStorage();
  const make = () =>
    remoteMcp("notes", {
      url: URL_,
      fetch: downstream.fetch,
      versionNegotiation: "legacy",
      auth: { type: "request", principal: { accept: "human", token: resolver() } },
    });
  let aliceKey: string | undefined;
  // Reconstructing the deployment with the same storage also keeps the opaque
  // key stable: Workers may serve adjacent requests from different isolates.
  for (let instance = 0; instance < 2; instance++) {
    const { connecta } = await deployment(make(), { storage: { ...storage } });
    const read = async <T = OperatorUiContractV2>(id: string, path: string): Promise<T> => {
      const response = await connecta.fetch(
        new Request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${id}`, "X-Connecta-Viewer": "forged" } }),
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<T>;
    };
    try {
      const alice = await read("alice", "/ui/api/config");
      const key = alice.you.viewerKey;
      expect(key).toEqual(expect.any(String));
      expect(key.length).toBeGreaterThanOrEqual(32);
      for (const identity of ["alice", "bob", NAMESPACE, "forged"]) expect(key).not.toContain(identity);
      if (aliceKey) expect(key).toBe(aliceKey);
      aliceKey = key;
      expect(alice.live.connectors[0]).toMatchObject({ status: "ok" });
      const aliceDetail = await read<UiConnector>("alice", "/ui/connectors/notes");
      expect(aliceDetail).toMatchObject({ viewerKey: key, status: "ok", toolCount: 2 });
      const bob = await read("bob", "/ui/api/config?live=cached");
      expect(bob.you.viewerKey).toEqual(expect.any(String));
      expect(bob.you.viewerKey).not.toBe(key);
      expect(bob.live.connectors).toEqual([]);
      expect(await read("bob", "/ui/data")).toMatchObject({
        viewerKey: bob.you.viewerKey,
        connectors: [{ status: "loading", tools: [] }],
      });
      const bobDetail = await read<UiConnector>("bob", "/ui/connectors/notes");
      expect(bobDetail.catalogAccess).toBeUndefined();
      expect(bobDetail.overlay?.catalogAgeMs).toBeNull();
      expect(bobDetail).toMatchObject({
        viewerKey: bob.you.viewerKey,
        status: "auth_required",
        problem: "caller_refused",
        tools: [],
        overlay: { status: "auth_required", tools: [] },
      });
      const bobLive = await read("bob", "/ui/api/config");
      expect(bobLive.you.viewerKey).toBe(bob.you.viewerKey);
      expect(bobLive.live.connectors[0]).toMatchObject({ status: "auth_required", tools: [] });
      expect(downstream.wire.some((exchange) => exchange.authorization?.endsWith("-bob"))).toBe(true);
    } finally {
      await connecta.close();
    }
  }
});
