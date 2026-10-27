// Node-only: exercises the pinned Eve 0.84 runtime reactions and memo implementation.
import { afterEach, expect, it, vi } from "vitest";
import type { DynamicContext } from "eve/connections";
import { connectaConnection, connectaInstructions } from "../src/index.js";
import { dynamicSession } from "./eve-runtime.js";

afterEach(() => vi.useRealTimers());
const url = "https://connecta.example.com";

it("selects the connection URL and instanceKey with real Eve evaluation and rotating auth", async () => {
  let pool = "notes_alice";
  let token = "cta_first";
  const selector = vi.fn((ctx: DynamicContext) => {
    expect(ctx.turn?.id).toBe("turn_1");
    expect(ctx).not.toHaveProperty("ctx");
    return pool;
  });
  const connection = connectaConnection({ url, pool: selector, description: "Notes", getToken: () => token });
  const evaluate = dynamicSession(connection, "connection");
  const first = await evaluate("turn_1");
  expect(first.result).toMatchObject({ url: `${url}/agent/notes_alice`, instanceKey: "notes_alice" });
  expect(first.contribution.value).toMatchObject([{ url: `${url}/agent/notes_alice`, principalType: "app" }]);
  const auth = first.result?.auth;
  if (!auth || typeof auth === "function" || !("getToken" in auth) || !auth.getToken) throw Error("Missing auth");
  const context = { principal: { type: "app" as const }, connection: { url: `${url}/agent/notes_alice` } };
  expect(await auth.getToken(context)).toMatchObject({ token: "cta_first" });
  token = "cta_rotated";
  expect(await auth.getToken(context)).toMatchObject({ token: "cta_rotated" });
  pool = "assistant";
  const second = await evaluate("turn_1");
  expect(second.result).toMatchObject({ url: `${url}/agent/assistant`, instanceKey: "assistant" });
  expect(second.contribution.value).not.toEqual(first.contribution.value);
  expect((await evaluate("turn_1")).contribution.value).toEqual(second.contribution.value);
  expect(selector).toHaveBeenCalledTimes(3);
});

it("follows pool changes within a turn and keeps TTL and failure backoff per endpoint", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let pool = "notes_alice";
  let fail = false;
  const requests: string[] = [];
  const selector = vi.fn(async () => pool);
  const instructions = connectaInstructions({
    url,
    pool: selector,
    getToken: () => "cta_agent",
    ttlMs: 100,
    fetch: async (endpoint) => {
      requests.push(String(endpoint));
      if (fail) throw Error("Unavailable");
      return Response.json({ result: { instructions: `${pool} guidance ${requests.length}` } });
    },
  });
  const evaluate = dynamicSession(instructions, "instructions");
  const content = async (id: string) => (await evaluate(id)).contribution.value;
  expect(await content("turn_1")).toEqual({ role: "system", content: "Connecta guidance:\nnotes_alice guidance 1" });
  vi.setSystemTime(Date.now() + 101);
  // The same endpoint keeps the turn's result after its TTL expires.
  expect(await content("turn_1")).toMatchObject({ content: "Connecta guidance:\nnotes_alice guidance 1" });
  pool = "assistant";
  expect(await content("turn_1")).toMatchObject({ content: "Connecta guidance:\nassistant guidance 2" });
  // A new turn still uses assistant's own fresh cache.
  expect(await content("turn_2")).toMatchObject({ content: "Connecta guidance:\nassistant guidance 2" });
  pool = "notes_alice";
  fail = true;
  expect(await content("turn_2")).toMatchObject({ content: "Connecta guidance:\nnotes_alice guidance 1" });
  pool = "assistant";
  vi.setSystemTime(Date.now() + 101);
  fail = false;
  expect(await content("turn_3")).toMatchObject({ content: "Connecta guidance:\nassistant guidance 4" });
  pool = "notes_alice";
  expect(await content("turn_3")).toMatchObject({ content: "Connecta guidance:\nnotes_alice guidance 1" });
  vi.setSystemTime(Date.now() + 29_899);
  expect(await content("turn_4")).toMatchObject({ content: "Connecta guidance:\nnotes_alice guidance 5" });
  expect(requests).toEqual(
    ["notes_alice", "assistant", "notes_alice", "assistant", "notes_alice"].map((p) => `${url}/agent/${p}`),
  );
  expect(selector).toHaveBeenCalledTimes(8);
});

it.each(["invalid", "throws"])("fails dynamic evaluations when the selector %s", async (kind) => {
  const pool = () => {
    if (kind === "throws") throw Error("Policy unavailable");
    return "../mcp";
  };
  const fetcher = vi.fn<typeof fetch>();
  const definitions = [
    [connectaConnection({ url, pool, description: "Notes" }), "connection"],
    [connectaInstructions({ url, pool, fetch: fetcher }), "instructions"],
  ] as const;
  for (const [definition, type] of definitions) {
    await expect(dynamicSession<unknown>(definition, type)("turn_1")).rejects.toThrow(
      kind === "throws" ? "Policy unavailable" : "must match",
    );
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("resolves instruction tokens per request and names discovery and initialize clients", async () => {
  let token = "cta_first";
  const seen: Array<{ token: string | null; name: string }> = [];
  const instructions = connectaInstructions({
    url,
    pool: async () => "assistant",
    getToken: () => token,
    clientName: "assistant",
    fetch: async (_endpoint, init) => {
      const body = JSON.parse(String(init?.body));
      const modern = body.method === "server/discover";
      seen.push({
        token: new Headers(init?.headers).get("Authorization"),
        name: modern ? body.params._meta["io.modelcontextprotocol/clientInfo"].name : body.params.clientInfo.name,
      });
      token = "cta_rotated";
      return Response.json(modern ? { error: { code: -32601 } } : { result: { instructions: "Guidance" } });
    },
  });
  expect((await dynamicSession(instructions, "instructions")("turn_1")).contribution.value).toMatchObject({
    content: "Connecta guidance:\nGuidance",
  });
  expect(seen).toEqual([
    { token: "Bearer cta_first", name: "assistant" },
    { token: "Bearer cta_rotated", name: "assistant" },
  ]);
});

it("lets both factories call a selector that owns its per-turn memo", async () => {
  let pool = "notes_alice";
  const lookup = vi.fn(() => pool);
  const selector = vi.fn((ctx: DynamicContext) => ctx.memo(["pool", ctx.turn?.id ?? null], lookup));
  const connection = dynamicSession(connectaConnection({ url, pool: selector, description: "Notes" }), "connection");
  const instructions = dynamicSession(
    connectaInstructions({
      url,
      pool: selector,
      getToken: () => "cta_agent",
      fetch: async (endpoint) => Response.json({ result: { instructions: String(endpoint) } }),
    }),
    "instructions",
  );
  for (const evaluate of [connection, instructions]) {
    await evaluate("turn_1");
    await evaluate("turn_1");
  }
  expect(selector).toHaveBeenCalledTimes(4);
  // Eve's memo scopes belong to each definition, not to the selector function.
  expect(lookup).toHaveBeenCalledTimes(2);
  pool = "assistant";
  expect((await connection("turn_1")).result).toMatchObject({ instanceKey: "notes_alice" });
  expect((await connection("turn_2")).result).toMatchObject({ instanceKey: "assistant" });
  expect((await instructions("turn_2")).contribution.value).toMatchObject({
    content: `Connecta guidance:\n${url}/agent/assistant`,
  });
});

it("rethrows cancellation for the selected endpoint without caching or starting its backoff", async () => {
  let pool = "notes_alice";
  let started: () => void = () => {};
  let cancel = true;
  const requests: string[] = [];
  const instructions = connectaInstructions({
    url,
    pool: () => pool,
    getToken: () => "cta_agent",
    fetch: async (endpoint, init) => {
      requests.push(String(endpoint));
      if (cancel) {
        started();
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      }
      return Response.json({ result: { instructions: pool } });
    },
  });
  const evaluate = dynamicSession(instructions, "instructions");
  const controller = new AbortController();
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const aborted = evaluate("turn_1", controller.signal);
  await pending;
  controller.abort(Error("Cancelled"));
  await expect(aborted).rejects.toThrow("Cancelled");
  cancel = false;
  pool = "assistant";
  expect((await evaluate("turn_1")).contribution.value).toMatchObject({ content: "Connecta guidance:\nassistant" });
  pool = "notes_alice";
  expect((await evaluate("turn_1")).contribution.value).toMatchObject({ content: "Connecta guidance:\nnotes_alice" });
  expect(requests).toEqual(["notes_alice", "assistant", "notes_alice"].map((p) => `${url}/agent/${p}`));
});
