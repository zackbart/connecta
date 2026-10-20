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
      return await app.fetch(request, undefined, ctx);
    } catch {
      // A disconnected service-binding caller has no response to receive.
      return new Response(null, { status: 499 });
    }
  },
};
