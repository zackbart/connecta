import { cloudflareAccessAuth } from "../../../src/auth/cloudflare-access.js";
import { accessTokens } from "../../../src/access-tokens.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { createConnecta, customExecutor } from "../../../src/index.js";

// Retirement compares Date.now() with an invocation's platform end. Tests
// move this isolate's clock instead of waiting out the 30-second window.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

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
      if (url.pathname === "/__clock") {
        clockOffset = url.searchParams.has("reset") ? 0 : clockOffset + Number(url.searchParams.get("advance"));
        return new Response("{}");
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
        // invocation, dropping the callbacks of its unfinished operations.
        const window = Number(request.headers.get("X-Wait-Until-Window") ?? NaN);
        let closeWindow!: () => void;
        const windowClosed = new Promise<void>((resolve) => {
          closeWindow = resolve;
        });
        try {
          const response = await binding.fetch(request, undefined, {
            waitUntil: (pending: Promise<unknown>) =>
              ctx.waitUntil(Number.isFinite(window) ? Promise.race([pending, windowClosed]) : pending),
            passThroughOnException: ctx.passThroughOnException.bind(ctx),
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
