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

it.each(["direct", "program", "search", "describe"])(
  "INV-4 INV-5 INV-10: %s auth errors carry an unforced handoff that completes OAuth",
  async (surface) => {
    const flow = setup({ catalogAuth: surface === "search" || surface === "describe" });
    const response =
      surface === "direct"
        ? await flow.rpc("call_tool", { address: "service.read" })
        : surface === "program"
          ? await flow.rpc("execute_code", { code: AUTH_PROGRAM })
          : surface === "search"
            ? await flow.rpc("search_tools", { connector: "service" })
            : await flow.rpc("execute_code", { code: AUTH_PROGRAM });
    const error =
      surface === "direct"
        ? response.structuredContent.error
        : surface === "search"
          ? response.structuredContent.catalogErrors[0]
          : surface === "program"
            ? response.structuredContent.result.calls[0].data
            : response.structuredContent.result.describe.tools[0].errorDetails;
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
  const flow = setup({ manage: false, catalogAuth: true });
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

it("INV-4 INV-5: credential auth errors carry the explicit operator handoff and recover after a UI update", async () => {
  const flow = setup({ credential: true, catalogAuth: true });
  const direct = (await flow.rpc("call_tool", { address: "service.read" })).structuredContent.error;
  const result = (await flow.rpc("execute_code", { code: AUTH_PROGRAM })).structuredContent.result;
  const explicit = (await flow.rpc("authorize_connector", { connector: "service" })).structuredContent;
  expect(explicit).toMatchObject({
    recovery: "operator_config",
    operatorUrl: `${HANDOFF_BASE}/`,
    credential: { label: "Service token", fields: [{ name: "apiKey", guidance: "Enter the service API key." }] },
  });
  for (const error of [
    direct,
    result.calls[0].data,
    result.search.catalogErrors[0],
    result.describe.tools[0].errorDetails,
  ]) {
    for (const key of ["recovery", "operatorUrl", "instructions", "credential"])
      expect(error[key]).toEqual(explicit[key]);
    expect(error).not.toHaveProperty("authorizationUrl");
  }
  const saved = await flow.app.fetch(
    new Request(`${HANDOFF_BASE}/ui/credentials/service`, {
      method: "PUT",
      headers: { Cookie: "__session=alice", Origin: HANDOFF_BASE, "Content-Type": "application/json" },
      body: JSON.stringify({ values: { apiKey: "private-key" } }),
    }),
  );
  expect(saved.status).toBe(200);
  expect(
    (await flow.rpc("call_tool", { address: "service.read", resultMode: "value" })).structuredContent.data,
  ).toEqual({ connected: true });
  expect(flow.sign).not.toHaveBeenCalled();
});
