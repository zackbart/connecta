// Node-only: uses real Eve's definition kernel, checkpointed memos and replay guard.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { DynamicSentinel } from "eve/connections";
import { ContextContainer } from "../node_modules/eve/dist/src/context/container.js";
import { SessionIdKey } from "../node_modules/eve/dist/src/context/keys.js";
import { renderSystem } from "../node_modules/eve/dist/src/definitions/definition.js";
import { dynamicConnectionVersions } from "../node_modules/eve/dist/src/definitions/connections.js";
import { DefinitionFailedError } from "../node_modules/eve/dist/src/definitions/kernel.js";
import { slotsOf } from "../node_modules/eve/dist/src/definitions/state.js";
import { evaluateValues, stepDraft } from "../node_modules/eve/dist/src/definitions/step.js";
import { dynamicEvaluate } from "../node_modules/eve/dist/src/dynamic/definition.js";
import { stepProjection } from "../node_modules/eve/dist/src/harness/session-machine/current.js";
import { changedSinceOffered } from "../node_modules/eve/dist/src/harness/approval-outcome.js";
import { createConnectionInstanceId } from "../node_modules/eve/dist/src/runtime/connections/instance-identity.js";
import { BundleKey, type CompiledBundle } from "../node_modules/eve/dist/src/runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "../node_modules/eve/dist/src/runtime/types.js";
import {
  connectaConnection,
  connectaInstructions,
  connectaSkill,
  gateConnectaWrites,
  type ConnectaPoolSelector,
} from "../src/index.js";

afterEach(() => vi.useRealTimers());

// Only the authored module rows are fixtures. Eve itself builds the definitions,
// session frames, memo scopes, installed slots and parked-call versions.
function eveSession(definitions: {
  connection?: DynamicSentinel;
  instructions?: DynamicSentinel;
  skill?: DynamicSentinel;
}) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, randomUUID());
  const row = (kind: string, folder: string, definition: DynamicSentinel | undefined) =>
    definition
      ? [
          {
            kind,
            slug: "connecta",
            sourceId: folder,
            sourceKind: "module",
            logicalPath: `agent/${folder}/connecta.ts`,
            evaluate: dynamicEvaluate(definition),
          },
        ]
      : [];
  ctx.set(BundleKey, {
    resolvedAgent: {
      definitions: [
        ...row("skill", "skills", definitions.skill),
        ...row("connection", "connections", definitions.connection),
        ...row("instructions", "instructions", definitions.instructions),
      ],
    },
    turnAgent: {},
    graph: { nodesByNodeId: new Map() },
    toolRegistry: { toolsByName: new Map() },
    subagentRegistry: { subagentsByName: new Map(), dynamicResolvers: [] },
  } as unknown as CompiledBundle);
  const projection = stepProjection(ctx, undefined);
  const step = { config: { tools: new Map() }, ctx, finalReplyOnly: false, session: { rootSessionId: "" } };
  const draft = () => stepDraft(step as unknown as Parameters<typeof stepDraft>[0]);
  let currentTurn: string | undefined;
  return {
    async evaluate(turn = "turn_1", abortSignal = new AbortController().signal) {
      if (turn !== currentTurn) {
        projection.record({
          type: "turn.started",
          data: { turnId: turn, cause: { policy: "test" }, follows: currentTurn ?? null },
        } as unknown as Parameters<typeof projection.record>[0]);
        currentTurn = turn;
      }
      await evaluateValues(ctx, { conversation: [], abortSignal });
      const sections = await (await draft()).system();
      return sections
        .filter((section) => section.key.startsWith("instructions:"))
        .map((section) => section.text)
        .join("\n");
    },
    /** The system prompt Eve hands the model for this step. */
    async system() {
      return renderSystem(await (await draft()).system());
    },
    async skills() {
      return Object.fromEntries((await (await draft()).tools()).skills);
    },
    connection() {
      const [connection] = (slotsOf(ctx, "connection")[0]?.live ?? []) as readonly ResolvedConnectionDefinition[];
      if (!connection) throw new Error("Missing installed connection");
      return connection;
    },
    version() {
      return dynamicConnectionVersions(ctx).get("connecta")!;
    },
  };
}

const url = "https://connecta.example.com";
// What the helper prepends when a server advertises no endpoint facts.
const guided = (text: string) =>
  `Connecta guidance:\nConnecta tools are deferred: call eve__tool({ name: "connecta__<tool>", input }). Names in this guidance and in nextAction omit the "connecta__" prefix.\n${text}`;

it("evaluates the pool every model call and fences a parked call when its connection changes", async () => {
  let pool = "notes_alice";
  let selections = 0;
  let token = "cta_first";
  const session = eveSession({
    connection: connectaConnection({
      url,
      description: "Notes",
      pool: () => {
        selections++;
        return pool;
      },
      getToken: () => token,
      gateWrites: true,
    }),
  });
  await session.evaluate();
  const first = session.connection();
  expect(first.url).toBe(`${url}/agent/notes_alice`);
  expect(first.instanceId).toBe(
    createConnectionInstanceId({
      connectionName: "connecta",
      sourceId: "connections",
      protocol: "mcp",
      url: first.url,
      instanceKey: "notes_alice",
    }),
  );
  expect(first.approval).toBe(gateConnectaWrites);
  const parked = { version: session.version() };
  await session.evaluate();
  expect(changedSinceOffered(parked, { version: session.version() })).toBe(false);
  pool = "assistant";
  await session.evaluate();
  expect(selections).toBe(3);
  expect(session.connection().url).toBe(`${url}/agent/assistant`);
  expect(session.connection().instanceId).not.toBe(first.instanceId);
  expect(changedSinceOffered(parked, { version: session.version() })).toBe(true);
  // Rebuilding a connection does not capture its bearer token.
  const auth = session.connection().authorization;
  if (!auth || typeof auth === "function" || !auth.getToken) throw new Error("Missing auth");
  const request = { principal: { type: "app" as const }, connection: { url: session.connection().url } };
  expect(await auth.getToken(request)).toMatchObject({ token: "cta_first" });
  token = "cta_rotated";
  expect(await auth.getToken(request)).toMatchObject({ token: "cta_rotated" });
});

it("follows a pool change within a turn without reusing another endpoint's memo", async () => {
  let pool = "notes_alice";
  const fetched: string[] = [];
  const session = eveSession({
    connection: connectaConnection({ url, description: "Notes", pool: () => pool }),
    instructions: connectaInstructions({
      url,
      pool: () => pool,
      getToken: () => "cta_agent",
      fetch: async (endpoint) => {
        fetched.push(String(endpoint));
        return Response.json({ result: { instructions: String(endpoint) } });
      },
    }),
  });
  expect(await session.evaluate()).toBe(guided(`${url}/agent/notes_alice`));
  pool = "assistant";
  expect(await session.evaluate()).toBe(guided(`${url}/agent/assistant`));
  expect(session.connection().url).toBe(`${url}/agent/assistant`);
  pool = "notes_alice";
  expect(await session.evaluate()).toBe(guided(`${url}/agent/notes_alice`));
  expect(fetched).toEqual([`${url}/agent/notes_alice`, `${url}/agent/assistant`]);
});

it("gives each selected pool its own surface and roster under one named connection", async () => {
  let pool = "notes_alice";
  const session = eveSession({
    instructions: connectaInstructions({
      url,
      connection: "assistant_tools",
      pool: () => pool,
      getToken: () => "cta_agent",
      fetch: async (endpoint) =>
        Response.json({
          result: {
            instructions: "Server text.",
            capabilities: {
              extensions: {
                "dev.connecta/endpoint": String(endpoint).endsWith("/notes_alice")
                  ? { surface: "native", executeCode: false, connectors: [{ id: "notes" }] }
                  : { surface: "meta", executeCode: true, connectors: [{ id: "crm" }] },
              },
            },
          },
        }),
    }),
  });
  const alice = await session.evaluate();
  expect(alice).toContain('name: "assistant_tools__<connector>__<tool>"');
  expect(alice).toContain("Connectors: notes.");
  pool = "assistant";
  // Eve hands the model each dynamic instruction as its own system message.
  expect((await session.system()).at(-1)).toBe(alice);
  const shared = await session.evaluate();
  expect(shared).toContain("assistant_tools__execute_code");
  expect(shared).toContain("Reachable: crm.");
  expect(shared).not.toContain("notes");
});

it("keeps TTL and the 30-second failure backoff per endpoint", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let pool = "notes_alice";
  let failing = false;
  const fetches = new Map<string, number>();
  const session = eveSession({
    instructions: connectaInstructions({
      url,
      pool: () => pool,
      ttlMs: 1_000,
      getToken: () => "cta_agent",
      fetch: async (endpoint) => {
        const key = String(endpoint).split("/").at(-1)!;
        fetches.set(key, (fetches.get(key) ?? 0) + 1);
        if (key === "notes_alice" && failing) throw new Error("Offline");
        return Response.json({ result: { instructions: `${key} ${fetches.get(key)}` } });
      },
    }),
  });
  expect(await session.evaluate("turn_1")).toContain("notes_alice 1");
  vi.setSystemTime(Date.now() + 500);
  pool = "assistant";
  expect(await session.evaluate("turn_2")).toContain("assistant 1");
  vi.setSystemTime(Date.now() + 501);
  pool = "notes_alice";
  failing = true;
  expect(await session.evaluate("turn_3")).toContain("notes_alice 1");
  // Alice's expired guidance failed to refresh; assistant's TTL is still valid.
  pool = "assistant";
  expect(await session.evaluate("turn_4")).toContain("assistant 1");
  expect(fetches.get("assistant")).toBe(1);
  vi.setSystemTime(Date.now() + 501);
  expect(await session.evaluate("turn_5")).toContain("assistant 2");
  pool = "notes_alice";
  failing = false;
  vi.setSystemTime(Date.now() + 29_498);
  expect(await session.evaluate("turn_6")).toContain("notes_alice 1");
  expect(fetches.get("notes_alice")).toBe(2);
  vi.setSystemTime(Date.now() + 1);
  expect(await session.evaluate("turn_7")).toContain("notes_alice 3");
});

it("lets the selector memoize its own lifetime independently in each factory", async () => {
  let pool = "notes_alice";
  let lookups = 0;
  const selector: ConnectaPoolSelector = (ctx) =>
    ctx.memo(["pool", ctx.turn?.id ?? null], () => {
      lookups++;
      return pool;
    });
  const session = eveSession({
    connection: connectaConnection({ url, description: "Notes", pool: selector }),
    instructions: connectaInstructions({
      url,
      pool: selector,
      ttlMs: 0,
      getToken: () => "cta_agent",
      fetch: async (endpoint) => Response.json({ result: { instructions: String(endpoint) } }),
    }),
  });
  await session.evaluate();
  expect(lookups).toBe(2); // Eve memo scopes belong to each definition, not to the shared selector.
  pool = "assistant";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 1);
  expect(await session.evaluate()).toContain("notes_alice");
  expect(session.connection().url).toContain("notes_alice");
  expect(lookups).toBe(2);
  expect(await session.evaluate("turn_2")).toContain("assistant");
  expect(session.connection().url).toContain("assistant");
  expect(lookups).toBe(4);
});

it("fails the turn for an invalid or throwing selector, even after cached guidance", async () => {
  let failure = "";
  const selector = async () => {
    if (failure === "throw") throw new Error("Pool lookup failed");
    return failure || "assistant";
  };
  for (const kind of ["connection", "instructions"] as const) {
    failure = "";
    const session = eveSession(
      kind === "connection"
        ? {
            connection: connectaConnection({ url, description: "Notes", pool: selector }),
          }
        : {
            instructions: connectaInstructions({
              url,
              pool: selector,
              getToken: () => "cta_agent",
              fetch: async () => Response.json({ result: { instructions: "Cached guidance" } }),
            }),
          },
    );
    await session.evaluate();
    for (const invalid of ["../notes_alice", " ", "throw"]) {
      failure = invalid;
      await expect(session.evaluate()).rejects.toBeInstanceOf(DefinitionFailedError);
    }
    // An empty selected name must not turn into a request to the base URL.
    const empty = eveSession(
      kind === "connection"
        ? {
            connection: connectaConnection({ url, description: "Notes", pool: () => "" }),
          }
        : { instructions: connectaInstructions({ url, pool: () => "" }) },
    );
    await expect(empty.evaluate()).rejects.toThrow("must match");
    // Neither may a selector that returns nothing at runtime.
    const missing = (() => undefined) as unknown as () => string;
    const absent = eveSession(
      kind === "connection"
        ? {
            connection: connectaConnection({ url, description: "Notes", pool: missing }),
          }
        : { instructions: connectaInstructions({ url, pool: missing }) },
    );
    await expect(absent.evaluate()).rejects.toThrow("must match");
  }
});

it("refreshes instruction tokens per request and names modern and legacy clients", async () => {
  let tokens = 0;
  const requests: Array<{ authorization: string | null; client: unknown }> = [];
  const session = eveSession({
    instructions: connectaInstructions({
      url,
      pool: async () => "assistant",
      clientName: "assistant-guidance",
      getToken: () => `cta_${++tokens}`,
      fetch: async (_endpoint, init) => {
        const rpc = JSON.parse(String(init?.body));
        requests.push({
          authorization: new Headers(init?.headers).get("Authorization"),
          client: rpc.params.clientInfo ?? rpc.params._meta["io.modelcontextprotocol/clientInfo"],
        });
        return Response.json({ result: rpc.method === "initialize" ? { instructions: "Legacy guidance" } : {} });
      },
    }),
  });
  expect(await session.evaluate()).toContain("Legacy guidance");
  expect(requests).toEqual([
    { authorization: "Bearer cta_1", client: { name: "assistant-guidance", version: "1" } },
    { authorization: "Bearer cta_2", client: { name: "assistant-guidance", version: "1" } },
  ]);
});

it("propagates Eve cancellation without caching a failed refresh or starting backoff", async () => {
  let started: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  let fetches = 0;
  const definition = connectaInstructions({
    url,
    pool: () => "assistant",
    getToken: () => "cta_agent",
    fetch: async (_endpoint, init) => {
      if (++fetches === 1) {
        started();
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      }
      return Response.json({ result: { instructions: "Recovered" } });
    },
  });
  const session = eveSession({ instructions: definition });
  const controller = new AbortController();
  const evaluating = session.evaluate("turn_1", controller.signal);
  await inFlight;
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await expect(evaluating).rejects.toThrow("Cancelled");
  expect(await eveSession({ instructions: definition }).evaluate()).toContain("Recovered");
  expect(await session.evaluate()).toContain("Recovered");
  expect(fetches).toBe(2);
});

it("gates guidance on every evaluation before token, pool and cached guidance access", async () => {
  let allowed = false;
  let fail = false;
  const fetch = vi.fn(async () => Response.json({ result: { instructions: "Allowed guidance" } }));
  const pool = vi.fn(() => "assistant");
  const getToken = vi.fn(() => "cta_agent");
  const when = vi.fn(async () => {
    if (fail) throw new Error("Policy unavailable");
    return allowed;
  });
  const session = eveSession({ instructions: connectaInstructions({ url, pool, getToken, fetch, when }) });
  expect(await session.evaluate()).toBe("");
  expect(pool).not.toHaveBeenCalled();
  expect(getToken).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  allowed = true;
  expect(await session.evaluate()).toBe(guided("Allowed guidance"));
  allowed = false;
  expect(await session.evaluate()).toBe("");
  allowed = true;
  fail = true;
  expect(await session.evaluate()).toBe("");
  fail = false;
  expect(await session.evaluate()).toBe(guided("Allowed guidance"));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(when).toHaveBeenCalledTimes(5);
});

it("removes a gated connection on false or a throwing policy and restores it on true", async () => {
  let allowed = true;
  let fail = false;
  const pool = vi.fn(() => "assistant");
  const session = eveSession({
    connection: connectaConnection({
      url,
      description: "Notes",
      pool,
      when: () => {
        if (fail) throw new Error("Policy unavailable");
        return allowed;
      },
    }),
  });
  await session.evaluate();
  expect(session.connection().url).toBe(`${url}/agent/assistant`);
  allowed = false;
  await session.evaluate();
  expect(() => session.connection()).toThrow("Missing installed connection");
  allowed = true;
  fail = true;
  await session.evaluate();
  expect(() => session.connection()).toThrow("Missing installed connection");
  fail = false;
  await session.evaluate();
  expect(session.connection().url).toBe(`${url}/agent/assistant`);
  expect(pool).toHaveBeenCalledTimes(2);
});

it.each(["rejection", "malformed", "timeout"] as const)(
  "omits a skill after %s through real Eve and retries on a new turn",
  async (failure) => {
    let failing = true;
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (failing) {
        if (failure === "malformed") return new Response("{invalid");
        throw new DOMException("Unavailable", failure === "timeout" ? "TimeoutError" : "NetworkError");
      }
      return Response.json({ result: { content: [{ type: "text", text: "Recovered guide" }] } });
    });
    const session = eveSession({
      skill: connectaSkill({
        url,
        name: "connector:crm",
        description: "CRM conventions",
        getToken: () => "cta_agent",
        fetch: fetcher,
      }),
    });
    await session.evaluate();
    expect(await session.skills()).toEqual({});
    failing = false;
    await session.evaluate();
    expect(await session.skills()).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await session.evaluate("turn_2");
    expect(JSON.stringify(await session.skills())).toContain("Recovered guide");
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("retains a successful skill only within its turn memo and removes it after a failed new-turn fetch", async () => {
  let failing = false;
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (failing) throw new Error("Offline");
    return Response.json({ result: { content: [{ type: "text", text: "Original guide" }] } });
  });
  const session = eveSession({
    skill: connectaSkill({
      url,
      name: "connector:crm",
      description: "CRM conventions",
      getToken: () => "cta_agent",
      fetch: fetcher,
    }),
  });
  await session.evaluate();
  expect(JSON.stringify(await session.skills())).toContain("Original guide");
  failing = true;
  await session.evaluate();
  expect(JSON.stringify(await session.skills())).toContain("Original guide");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await session.evaluate("turn_2");
  expect(await session.skills()).toEqual({});
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves real Eve turn cancellation while fetching a skill", async () => {
  let started: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  let fetches = 0;
  const session = eveSession({
    skill: connectaSkill({
      url,
      name: "connector:crm",
      description: "CRM conventions",
      getToken: () => "cta_agent",
      fetch: async (_endpoint, init) => {
        if (++fetches === 1) {
          started();
          await new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
          );
        }
        return Response.json({ result: { content: [{ type: "text", text: "Recovered guide" }] } });
      },
    }),
  });
  const controller = new AbortController();
  const evaluating = session.evaluate("turn_1", controller.signal);
  await inFlight;
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await expect(evaluating).rejects.toThrow("Cancelled");
  await session.evaluate();
  expect(JSON.stringify(await session.skills())).toContain("Recovered guide");
  expect(fetches).toBe(2);
});
