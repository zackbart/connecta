import { accessTokens } from "../../../src/access-tokens.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { createConnecta, customExecutor, workerHandler, type Connecta } from "../../../src/index.js";

// Retirement compares Date.now() with an invocation's platform end. Tests
// move this isolate's clock instead of waiting out the 30-second window.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

interface Env {
  ORIGIN: string;
  // service_binding_extra_handlers: runs this Worker's real scheduled event.
  SELF: { scheduled(options: { cron: string }): Promise<unknown> };
}

// Production ends an invocation, cancelling its I/O, once waitUntil has run
// its course after the response; Miniflare never does. With a window set,
// every ExecutionContext in this isolate settles each waitUntil promise that
// long after it was registered, so workerd ends the invocation and drops the
// callbacks of its unfinished operations. Each context stays the event's own.
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
const handler = workerHandler((env: Env) => {
  origin = env.ORIGIN;
  app = createConnecta({
    readOnly: true,
    logger: "silent",
    connectors: [{ id: "notes", kind: "api", listTools: async () => [], callTool: async () => null }],
    maintainers: [{ namespace: "fixture", id: "alice" }],
    executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
    auth: {
      kind: "fixture",
      interactiveOperator: true,
      // A human adapter honoring its signal, with no answer of its own until
      // the upstream does: a connected caller's invocation has no end.
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
});

const agentRequest = () =>
  new Request("https://connecta.test/agent/team", {
    method: "POST",
    headers: { "Mcp-Method": "subscriptions/listen", Authorization: `Bearer cta_${"a".repeat(43)}` },
  });
const retirementOf = async (response: Response) =>
  ((await response.json()) as { admission: { authentication: { retirement: unknown } } }).admission.authentication
    .retirement;
let scheduled: { retirement?: unknown[]; statuses?: number[]; done?: boolean } = {};

// The handler itself, spread as the default export beside a cron handler.
export default {
  ...handler,
  // A cron job calling Connecta with its own ExecutionContext through both
  // entries, consuming each answer and then running on: nothing may retire.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const branded = await handler.fetch(new Request("https://connecta.test/health"), env, ctx);
    const direct = await app!.fetch(new Request("https://connecta.test/health"), env, ctx);
    scheduled.retirement = [await retirementOf(branded), await retirementOf(direct)];
    const answered = await Promise.all([handler.fetch(agentRequest(), env, ctx), app!.fetch(agentRequest(), env, ctx)]);
    scheduled.statuses = await Promise.all(answered.map(async (response) => (await response.text(), response.status)));
    await (await fetch(`${env.ORIGIN}/binding/scheduled-hold`)).text();
    scheduled.done = true;
  },
} satisfies ExportedHandler<Env>;

// Middleware around the handler: it consumes Connecta's response, then keeps
// its invocation running on another fetch before answering.
let after = 0;
export const middleware = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await handler.fetch(request, env, ctx);
    const body = await response.text();
    if (new URL(request.url).pathname !== "/health") {
      await (await fetch(`${env.ORIGIN}/binding/after-${after++}`)).text();
    }
    return new Response(body, { status: response.status, headers: response.headers });
  },
} satisfies ExportedHandler<Env>;

export const control = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    enforceWindow(ctx);
    const url = new URL(request.url);
    if (url.pathname === "/clock") {
      clockOffset = url.searchParams.has("reset") ? 0 : clockOffset + Number(url.searchParams.get("advance"));
    } else if (url.pathname === "/window") {
      windowMs = url.searchParams.has("ms") ? Number(url.searchParams.get("ms")) : undefined;
    } else if (url.pathname === "/scheduled") {
      scheduled = {};
      ctx.waitUntil(env.SELF.scheduled({ cron: "* * * * *" }));
    } else if (url.pathname === "/scheduled/result") {
      return Response.json(scheduled);
    }
    return new Response("{}");
  },
} satisfies ExportedHandler<Env>;
