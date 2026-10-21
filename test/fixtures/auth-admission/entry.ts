import { accessTokens } from "../../../src/access-tokens.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { createConnecta, customExecutor } from "../../../src/index.js";

interface Env {
  ORIGIN: string;
  // service_binding_extra_handlers: runs this Worker's real scheduled event.
  SELF: { scheduled(options: { cron: string }): Promise<unknown> };
}

// Production ends an invocation, cancelling its I/O, once waitUntil has run
// its course after the response; Miniflare never does. With a window set,
// every ExecutionContext in this isolate settles each waitUntil promise that
// long after it was registered, so workerd ends the invocation and drops its
// unfinished operations. Each context stays the event's own object.
let windowMs: number | undefined;
let enforcing = false;
function enforceWindow(ctx: ExecutionContext) {
  if (enforcing) return;
  enforcing = true;
  const prototype = Object.getPrototypeOf(ctx) as ExecutionContext;
  const waitUntil = prototype.waitUntil;
  prototype.waitUntil = function (this: ExecutionContext, pending: Promise<unknown>) {
    const limit = windowMs;
    if (limit === undefined) return waitUntil.call(this, pending);
    waitUntil.call(this, Promise.race([pending, new Promise((resolve) => setTimeout(resolve, limit))]));
  };
}

// Collection evidence. A sentinel is reachable only through the continuation
// of a fetch that workerd cancels when its invocation ends (after `ms`), as a
// stalled charge's token is; once sentinels as old as the tokens under test
// are finalized, a collection that could have freed those tokens has run. Pressure allocates large garbage arrays, which drives
// V8 to collect; workerd exposes no gc() here. Without enable_weak_ref the
// twin Worker has no FinalizationRegistry at all.
const finalized = new Set<string>();
const sentinels =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<string>((name) => finalized.add(name))
    : undefined;
function pressure(megabytes: number) {
  let allocated = 0;
  for (let i = 0; i < megabytes; i++) allocated += Array.from({ length: 131_072 }).fill(i).length;
  return allocated;
}

// Agent-token reads deliberately take no signal, as with a native D1 or KV
// read: each holds one fixture connection until released or cancelled.
let origin = "";
let lookups = 0;
const storage = memoryStorage();
storage.get = async () => {
  const response = await fetch(`${origin}/binding/agent-${lookups++}`);
  await response.text();
  return null;
};
let app: Connecta | undefined;
type Connecta = ReturnType<typeof createConnecta>;
function connecta(env: Env): Connecta {
  origin = env.ORIGIN;
  app ??= createConnecta({
    readOnly: true,
    logger: "silent",
    connectors: [{ id: "notes", kind: "api", listTools: async () => [], callTool: async () => null }],
    maintainers: [{ namespace: "fixture", id: "alice" }],
    executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
    auth: {
      kind: "fixture",
      interactiveOperator: true,
      // A human adapter honoring its signal, with no answer of its own until
      // the upstream does.
      async authorize(request) {
        const response = await fetch(request.headers.get("X-Auth-Upstream")!, { signal: request.signal });
        await response.text();
        return { ok: false, response: new Response(null, { status: 401 }) };
      },
    },
    accessTokens: accessTokens(storage),
    agents: ["assistant"],
    pools: { team: { tools: ["notes"], members: ["agent:assistant"] } },
  });
  return app;
}

// The plain Worker export, exactly as the example writes it.
const handler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    enforceWindow(ctx);
    return connecta(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

const agentRequest = () =>
  new Request("https://connecta.test/agent/team", {
    method: "POST",
    headers: { "Mcp-Method": "subscriptions/listen", Authorization: `Bearer cta_${"a".repeat(43)}` },
  });
let scheduled: { statuses?: number[]; done?: boolean } = {};

export default {
  ...handler,
  // A cron job calling Connecta with its own ExecutionContext, consuming each
  // answer and then running on: its charges count while it runs.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const answered = await Promise.all([
      connecta(env).fetch(agentRequest(), env, ctx),
      connecta(env).fetch(agentRequest(), env, ctx),
    ]);
    scheduled.statuses = await Promise.all(answered.map(async (response) => (await response.text(), response.status)));
    await (await fetch(`${env.ORIGIN}/binding/scheduled-hold`)).text();
    scheduled.done = true;
  },
} satisfies ExportedHandler<Env>;

// Ordinary Promise-chain middleware around the handler: it leaves no caller
// frame, consumes Connecta's response, then keeps its invocation running on
// another fetch before answering.
let after = 0;
export const middleware = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return Promise.resolve()
      .then(handler.fetch.bind(undefined, request, env, ctx))
      .then(async (response) => {
        const body = await response.text();
        if (new URL(request.url).pathname !== "/health") {
          await (await fetch(`${env.ORIGIN}/binding/after-${after++}`)).text();
        }
        return new Response(body, response);
      });
  },
} satisfies ExportedHandler<Env>;

export const control = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/window") {
      windowMs = url.searchParams.has("ms") ? Number(url.searchParams.get("ms")) : undefined;
    } else if (url.pathname === "/sentinel") {
      const name = url.searchParams.get("name")!;
      const sentinel = { name };
      sentinels?.register(sentinel, name);
      const held = fetch(`${env.ORIGIN}/binding/sentinel-${name}`)
        .then((response) => response.text())
        .then(() => sentinel);
      ctx.waitUntil(Promise.race([held, new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get("ms") ?? 500)))]));
    } else if (url.pathname === "/pressure") {
      const allocated = pressure(Number(url.searchParams.get("mb") ?? 32));
      // Finalizers run as their own tasks after a collection.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ finalized: [...finalized], allocated });
    } else if (url.pathname === "/scheduled") {
      scheduled = {};
      ctx.waitUntil(env.SELF.scheduled({ cron: "* * * * *" }));
    } else if (url.pathname === "/scheduled/result") {
      return Response.json(scheduled);
    }
    return new Response("{}");
  },
} satisfies ExportedHandler<Env>;
