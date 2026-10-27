// Node-only: uses real Eve 0.84's reaction runner, checkpointed memos and replay guard.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { DynamicSentinel } from "eve/connections";
import { ContextContainer } from "../node_modules/eve/dist/src/context/container.js";
import { SessionIdKey } from "../node_modules/eve/dist/src/context/keys.js";
import { stepProjection } from "../node_modules/eve/dist/src/harness/session-machine/current.js";
import { changedSinceOffered } from "../node_modules/eve/dist/src/harness/approval-outcome.js";
import { dynamicConnectionVersions } from "../node_modules/eve/dist/src/reactions/kinds/connection.js";
import { dynamicInstructionMessages } from "../node_modules/eve/dist/src/reactions/kinds/instructions.js";
import { evaluateValues, ReactionFailedError } from "../node_modules/eve/dist/src/reactions/runner.js";
import { slotsOf } from "../node_modules/eve/dist/src/reactions/state.js";
import { createConnectionInstanceId } from "../node_modules/eve/dist/src/runtime/connections/instance-identity.js";
import { BundleKey, type CompiledBundle } from "../node_modules/eve/dist/src/runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "../node_modules/eve/dist/src/runtime/types.js";
import {
  connectaConnection,
  connectaInstructions,
  gateConnectaWrites,
  type ConnectaPoolSelector,
} from "../src/index.js";

afterEach(() => vi.useRealTimers());

// Only the authored module rows are fixtures. Eve itself builds the reactions,
// session frames, memo scopes, installed slots and parked-call versions.
function eveSession(definitions: { connection?: DynamicSentinel; instructions?: DynamicSentinel }) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, randomUUID());
  const resolver = (kind: string, definition: DynamicSentinel) => ({
    slug: "connecta",
    sourceId: kind,
    sourceKind: "module",
    logicalPath: `agent/${kind}/connecta.ts`,
    evaluate: definition.evaluate,
  });
  ctx.set(BundleKey, {
    resolvedAgent: {
      hooks: [],
      memories: [],
      dynamicToolResolvers: [],
      dynamicSkillResolvers: [],
      dynamicConnectionResolvers: definitions.connection ? [resolver("connections", definitions.connection)] : [],
      dynamicInstructionsResolvers: definitions.instructions
        ? [resolver("instructions", definitions.instructions)]
        : [],
    },
    turnAgent: {},
    toolRegistry: { toolsByName: new Map() },
    subagentRegistry: { subagentsByName: new Map(), dynamicResolvers: [] },
  } as unknown as CompiledBundle);
  const projection = stepProjection(ctx, undefined);
  let currentTurn: string | undefined;
  return {
    async evaluate(turn = "turn_1", abortSignal = new AbortController().signal) {
      if (turn !== currentTurn) {
        projection.record({
          type: "turn.started",
          data: { turnId: turn, cause: { policy: "test" }, follows: currentTurn ?? null },
        });
        currentTurn = turn;
      }
      await evaluateValues(ctx, { conversation: [], abortSignal });
      return dynamicInstructionMessages(ctx)
        .map((message) => message.content)
        .join("\n");
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
  expect(await session.evaluate()).toBe(`Connecta guidance:\n${url}/agent/notes_alice`);
  pool = "assistant";
  expect(await session.evaluate()).toBe(`Connecta guidance:\n${url}/agent/assistant`);
  expect(session.connection().url).toBe(`${url}/agent/assistant`);
  pool = "notes_alice";
  expect(await session.evaluate()).toBe(`Connecta guidance:\n${url}/agent/notes_alice`);
  expect(fetched).toEqual([`${url}/agent/notes_alice`, `${url}/agent/assistant`]);
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
      await expect(session.evaluate()).rejects.toBeInstanceOf(ReactionFailedError);
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
