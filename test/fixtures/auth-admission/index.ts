import { cloudflareAccessAuth } from "../../../src/auth/cloudflare-access.js";
import { accessTokens } from "../../../src/access-tokens.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { createConnecta, customExecutor } from "../../../src/index.js";

// Collection evidence, as in entry.ts: sentinels reachable only through a
// fetch cancelled with its invocation, and garbage that drives V8 to collect.
const finalized = new Set<string>();
const sentinels = new FinalizationRegistry<string>((name) => finalized.add(name));

// Native separate requests share only Connecta's plain admission counter.
// Every adapter fetch, controller, response, and body belongs to its caller.
const app = createConnecta({
  readOnly: true, logger: "silent", connectors: [],
  maintainers: [{ namespace: "fixture", id: "alice" }],
  executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
  auth: {
    kind: "fixture", interactiveOperator: true,
    async authorize(request) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      let response: Response | undefined;
      try {
        response = await fetch(request.headers.get("X-Auth-Upstream")!, { signal: controller.signal });
        await response.text();
        return { ok: false, response: new Response(null, { status: 401 }) };
      } finally {
        controller.abort();
        request.signal.removeEventListener("abort", abort);
        await response?.body?.cancel().catch(() => {});
      }
    },
  },
});
export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/__sentinel") {
        const name = url.searchParams.get("name")!;
        const sentinel = { name };
        sentinels.register(sentinel, name);
        const held = fetch(request.headers.get("X-Auth-Upstream")!)
          .then((response) => response.text())
          .then(() => sentinel);
        ctx.waitUntil(Promise.race([held, new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get("ms") ?? 500)))]));
        return new Response("{}");
      }
      if (url.pathname === "/__pressure") {
        let allocated = 0;
        for (let i = 0; i < Number(url.searchParams.get("mb") ?? 32); i++) {
          allocated += Array.from({ length: 131_072 }).fill(i).length;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ finalized: [...finalized], allocated });
      }
      const kind = request.headers.get("X-Binding-Kind");
      if (kind) {
        // A binding-contract fixture: fetch deliberately receives no signal,
        // as with native Access/D1 operations with no cancellation argument.
        const lookup = async () => {
          const response = await fetch(request.headers.get("X-Auth-Upstream")!);
          await response.text();
        };
        const storage = memoryStorage();
        storage.get = async () => {
          await lookup();
          return null;
        };
        const binding = createConnecta({
          readOnly: true,
          logger: "silent",
          connectors: [{ id: "notes", kind: "api", listTools: async () => [], callTool: async () => null }],
          maintainers: [{ namespace: "cloudflare-access", id: "alice" }],
          executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
          auth: cloudflareAccessAuth(),
          ...(kind === "agent"
            ? {
                accessTokens: accessTokens(storage),
                agents: ["assistant"],
                pools: { team: { tools: ["notes"], members: ["agent:assistant"] } },
              }
            : {}),
        });
        // Production cancels an invocation, and all its I/O, once waitUntil
        // has run its course after the response; Miniflare never does. With
        // this header the fixture enforces such a window: when it closes,
        // every waitUntil promise is settled and workerd ends the
        // invocation, dropping its unfinished operations.
        const window = Number(request.headers.get("X-Wait-Until-Window") ?? NaN);
        let closeWindow!: () => void;
        const windowClosed = new Promise<void>((resolve) => {
          closeWindow = resolve;
        });
        try {
          const response = await binding.fetch(request, undefined, {
            waitUntil: (pending: Promise<unknown>) =>
              ctx.waitUntil(Number.isFinite(window) ? Promise.race([pending, windowClosed]) : pending),
            access: {
              aud: "app",
              getIdentity: async () => {
                await lookup();
                return { user_uuid: "alice" };
              },
            },
          });
          if (Number.isFinite(window)) setTimeout(closeWindow, window);
          return response;
        } finally {
          await binding.close();
        }
      }
      return await app.fetch(request, undefined, ctx);
    } catch {
      // A disconnected service-binding caller has no response to receive.
      return new Response(null, { status: 499 });
    }
  },
};
