import { cloudflareAccessAuth } from "../../../src/auth/cloudflare-access.js";
import { accessTokens } from "../../../src/access-tokens.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { createConnecta, customExecutor } from "../../../src/index.js";

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
  async fetch(request: Request, _env: unknown, ctx: { waitUntil(pending: Promise<unknown>): void }) {
    try {
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
        try {
          return await binding.fetch(request, undefined, {
            waitUntil: ctx.waitUntil.bind(ctx),
            access: {
              aud: "app",
              getIdentity: async () => {
                await lookup();
                return { user_uuid: "alice" };
              },
            },
          });
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
