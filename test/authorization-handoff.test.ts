import { afterEach, expect, it, vi } from "vitest";
import { AUTH_PROGRAM, HANDOFF_BASE, handoffFixture } from "./fixtures/authorization-handoff.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { fixture as stripeFixture } from "../src/providers/stripe/fixtures.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";

const apps: ReturnType<typeof handoffFixture>["app"][] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(options: Parameters<typeof handoffFixture>[0] = {}) {
  const flow = handoffFixture(options);
  apps.push(flow.app);
  return flow;
}

it.each(["direct", "search"])(
  "INV-4 INV-5 INV-10: %s auth errors carry an unforced handoff that completes OAuth",
  async (surface) => {
    const flow = setup({ catalogAuth: surface === "search" });
    const response =
      surface === "direct"
        ? await flow.rpc("call_tool", { address: "service.read" })
        : await flow.rpc("search_tools", { connector: "service" });
    const error = surface === "direct" ? response.structuredContent.error : response.structuredContent.catalogErrors[0];
    expect(error).toMatchObject({
      recovery: "oauth",
      nextAction: {
        url: expect.stringContaining(`${HANDOFF_BASE}/connect/service?h=v3.`),
        purpose: expect.any(String),
      },
      authorizationUrl: expect.stringContaining(`${HANDOFF_BASE}/connect/service?h=v3.`),
      instructions: expect.any(String),
    });
    // The link goes on as it is, so what the agent passes along is what was signed.
    expect(error.nextAction.url).toBe(error.authorizationUrl);
    expect(error.nextAction.purpose).toBe(
      "Give this link to the user, unchanged, then stop. Retry after they confirm.",
    );
    expect(error.instructions).toMatch(/^For the person opening this link: /);
    expect(new URL(error.nextAction.url).searchParams.has("force")).toBe(false);
    expect(flow.sign).toHaveBeenCalledOnce();
    expect(flow.connector.startAuth).not.toHaveBeenCalled();
    if (surface === "search") expect(JSON.stringify(response)).not.toContain("PRIVATE_");
    await flow.complete(error.authorizationUrl);
  },
);

it("INV-4 INV-7: repeated and concurrent program and catalog errors reuse one handoff per connector per run", async () => {
  const flow = setup({ catalogAuth: true });
  const run = async () => (await flow.rpc("execute_code", { code: AUTH_PROGRAM })).structuredContent.result;
  const first = await run();
  const url = first.calls[0].data.authorizationUrl;
  for (const call of first.calls) expect(call.data.authorizationUrl).toBe(url);
  expect(first.search.catalogErrors[0].authorizationUrl).toBe(url);
  expect(first.search.queryAnalysis.catalogError.authorizationUrl).toBe(url);
  for (const tool of first.describe.tools) expect(tool.errorDetails.authorizationUrl).toBe(url);
  expect(flow.sign).toHaveBeenCalledOnce();
  const second = await run();
  expect(second.calls[0].data.authorizationUrl).not.toBe(url);
  expect(flow.sign).toHaveBeenCalledTimes(2);
});

it("INV-4 INV-5 INV-10: auth handoffs preserve management boundaries and stateless credential recovery", async () => {
  // A pool member who is not a maintainer cannot manage a shared connector (#837).
  const flow = setup({ manage: false, catalogAuth: true, authScope: "shared" });
  const result = (await flow.rpc("execute_code", { code: AUTH_PROGRAM })).structuredContent.result;
  for (const error of [
    ...result.calls.map((call: { data: unknown }) => call.data),
    ...result.search.catalogErrors,
    ...result.describe.tools.map((tool: { errorDetails: unknown }) => tool.errorDetails),
  ]) {
    expect(error).toMatchObject({
      recovery: "unavailable",
      instructions: "Your identity is not permitted to manage authentication for this connection.",
    });
    expect(error).not.toHaveProperty("authorizationUrl");
  }
  expect(flow.sign).not.toHaveBeenCalled();
  // Each tools/call is a fresh HTTP request: the explicit handoff cannot
  // depend on the previous request's auth-failure scope (#994, #998 B1).
  const generic: Connector = {
    id: "service",
    kind: "api",
    authScope: "shared",
    credential: { label: "Service token", fields: [{ name: "apiKey", label: "API key" }] },
    listTools: async () => [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
    callTool: async () => {
      throw new ConnectorCallError("auth_required", "The key was rejected");
    },
  };
  for (const connector of [generic, stripeFixture.create("payments")]) {
    for (const withUi of [true, false]) {
      const storage = memoryStorage();
      const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
      const secret = connector === generic ? "evk_rejected_0000" : "not-a-stripe-key-0000";
      await vault.setAll(
        connector.id,
        Object.fromEntries(
          (connector.credential?.fields?.map((field) => field.name) ?? ["value"]).map((field) => [field, secret]),
        ),
        "user_1",
      );
      const app = createTestConnecta({
        connectors: [connector],
        storage,
        vault,
        publicUrl: HANDOFF_BASE,
        logger: "silent",
        auth: fakeClerkAuth({ token: "alice", userId: "alice" }),
        ...(withUi ? {} : { ui: undefined }),
      });
      apps.push(app);
      const rpc = async (name: string, args: Record<string, unknown>) =>
        (await readJsonRpc(await app.fetch(mcpRpc("tools/call", { name, arguments: args }, { token: "alice" })))).result
          .structuredContent;
      const called = await rpc("call_tool", {
        address: connector === generic ? "service.read" : "payments.stripe_api_read",
        ...(connector === generic ? {} : { args: { path: "/v1/refunds" } }),
      });
      expect(called.error).toMatchObject({
        code: "auth_required",
        recovery: withUi ? "operator_config" : "unavailable",
        nextAction: withUi
          ? { url: called.error?.operatorUrl, purpose: expect.stringContaining("for the operator to open") }
          : { action: "contact_operator", purpose: expect.stringContaining("the operator must fix this connector") },
      });
      // The error says one thing to do; no route text still points at authorize_connector.
      expect(called.error.message).not.toContain("authorize_connector");
      if (connector !== generic) expect(called.error.message).toContain("not a Stripe secret");
      const authorized = await rpc("authorize_connector", { connector: connector.id });
      expect(authorized).toMatchObject({
        connector: connector.id,
        recovery: "ready",
        message: expect.stringContaining(
          "If a call to it just failed with an authentication or operator-configuration error",
        ),
      });
      expect(authorized.message).toContain("otherwise proceed with the call");
      if (withUi) {
        expect(authorized).toMatchObject({
          operatorUrl: called.error.operatorUrl,
          credential: called.error.credential,
          instructions: called.error.instructions,
        });
      } else
        expect(authorized.message).toContain(
          "If recovery is needed: Credential recovery needs both a vault and the optional UI. Configure vault and ui in deployment code, then call authorize_connector again.",
        );
      expect(JSON.stringify(authorized)).not.toContain(secret);
    }
  }
});

it("INV-4 INV-8 INV-10: native without code discovers recovery, completes consent and lists the repaired catalog", async () => {
  const flow = setup({ native: true, catalogAuth: true });
  const list = async () =>
    (
      await readJsonRpc(
        await flow.app.fetch(new Request(`${HANDOFF_BASE}/mcp/team`, mcpRpc("tools/list", {}, { token: "alice" }))),
      )
    ).result.tools;
  const before = await list();
  expect(before.map((tool: { name: string }) => tool.name).sort()).toEqual([
    "authorize_connector",
    "read_result",
    "skills",
  ]);
  expect(before.find((tool: { name: string }) => tool.name === "authorize_connector").description).toContain(
    "Granted: service.",
  );
  expect(JSON.stringify(before)).not.toContain("outside");
  expect(flow.sign).not.toHaveBeenCalled();
  expect(flow.connector.startAuth).not.toHaveBeenCalled();
  const denied = await flow.rpc("authorize_connector", { connector: "outside" });
  expect(JSON.stringify(denied)).not.toContain("authorizationUrl");
  expect(flow.sign).not.toHaveBeenCalled();
  const handoff = (await flow.rpc("authorize_connector", { connector: "service" })).structuredContent;
  expect(handoff).toMatchObject({ recovery: "oauth", authorizationUrl: expect.stringContaining("/connect/service") });
  expect(flow.sign).toHaveBeenCalledOnce();
  expect(flow.connector.startAuth).not.toHaveBeenCalled();
  await flow.complete(handoff.authorizationUrl);
  expect((await list()).map((tool: { name: string }) => tool.name)).toContain("service__read");
});
