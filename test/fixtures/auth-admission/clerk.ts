import { createConnecta, customExecutor } from "../../../src/index.js";
import { operatorUi } from "../../../src/ui.js";
import { clerkAuth } from "../../../src/auth/clerk.js";

// The production bundled SDK and transport run in native separate requests.
// Only outbound routing changes: Miniflare sends real TCP to the fixture.
const app = createConnecta({
  ui: operatorUi(),
  readOnly: true, logger: "silent", connectors: [],
  maintainers: [{ namespace: "clerk", id: "alice" }],
  executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
  auth: clerkAuth({ publishableKey: `pk_test_${btoa("clerk.example.test$")}`, secretKey: "sk_test_fake" }),
});
export default {
  async fetch(request: Request, _env: unknown, ctx: { waitUntil(pending: Promise<unknown>): void }) {
    try { return await app.fetch(request, undefined, ctx); }
    catch { return new Response(null, { status: 499 }); }
  },
};
