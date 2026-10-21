import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
vi.mock("../src/auth/clerk-transport.js", () => ({
  createByteReadingClerkClient: () => ({ authenticateRequest: mocks.authenticateRequest }),
}));
import { clerkAuth } from "../src/auth/clerk.js";
import { createTestConnecta } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

it("INV-7: admits before SDK-owned authentication, including opaque-token verification on listens", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.authenticateRequest.mockImplementation(async () => {
    await blocked;
    return { status: "signed-out", toAuth: () => null };
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const app = createTestConnecta({
    connectors: [],
    logger: "silent",
    maintainers: [{ namespace: "clerk", id: "alice" }],
    auth: clerkAuth({ publishableKey: `pk_test_${btoa("clerk.example.test$")}`, secretKey: "sk_test_fake" }),
  });
  let busy = 0;
  const pending = Array.from({ length: 64 }, () => {
    const req = mcpRpc("subscriptions/listen", {}, { token: "oat_opaque" });
    req.headers.set("Mcp-Method", "subscriptions/listen");
    return app.fetch(req).then(async (res) => {
      if (res.status === 503) {
        expect(await res.json()).toMatchObject({ error: { code: "authentication_busy", retryable: true } });
        busy++;
      } else await res.text();
    });
  });
  try {
    await vi.waitFor(() => expect(busy).toBe(48));
    expect(mocks.authenticateRequest).toHaveBeenCalledTimes(16);
  } finally {
    release();
    await Promise.all(pending);
    warn.mockRestore();
    await app.close();
  }
});
