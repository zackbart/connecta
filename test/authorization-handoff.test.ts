import { afterEach, expect, it, vi } from "vitest";
import { AUTH_PROGRAM, HANDOFF_BASE, handoffFixture } from "./fixtures/authorization-handoff.js";

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
      nextAction: { tool: "authorize_connector", arguments: { connector: "service" } },
      authorizationUrl: expect.stringContaining(`${HANDOFF_BASE}/connect/service?h=v3.`),
      instructions: expect.any(String),
    });
    expect(error.nextAction.arguments).not.toHaveProperty("force");
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

it("INV-4: refuses OAuth error links when the admitted identity cannot manage auth", async () => {
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
});
