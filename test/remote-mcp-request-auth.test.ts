import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { apiFixture, context, SENTINEL } from "./fixtures/github-api.js";
import { deferred } from "./fixtures/misc.js";
import { createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";

beforeEach(() => {
  installOwnedTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("INV-7: request auth binds each scope to its own token and forwards only declared catalog headers", async () => {
  const fixture = apiFixture();
  const first = context();
  const second = context();
  const callback = vi.fn(async (ctx) => (ctx === first ? "ghs_first" : "ghs_second"));
  const connector = remoteMcp("github", {
    url: "https://api.githubcopilot.com/mcp/",
    auth: { type: "request", token: callback, headers: { "X-MCP-Tools": "get_file_contents" } },
  });
  try {
    await Promise.all([
      connector.callTool("get_file_contents", { owner: "acme", repo: "one" }, first),
      connector.callTool("get_file_contents", { owner: "other", repo: "one" }, second),
    ]);
    const calls = fixture.requests.filter((request) => request.body?.method === "tools/call");
    expect(calls.map((request) => request.headers.get("authorization")).sort()).toEqual([
      "Bearer ghs_first",
      "Bearer ghs_second",
    ]);
    for (const request of calls) expect(request.headers.get("X-MCP-Tools")).toBe("get_file_contents");
    expect(callback).toHaveBeenCalledWith(first);
    expect(callback).toHaveBeenCalledWith(second);
    const app = createTestConnecta({
      connectors: [connector],
      logger: silentLogger,
      publicUrl: "https://connecta.test",
    });
    try {
      const config = JSON.stringify(app.describeConfig());
      expect(config).toContain('"mode":"request"');
      expect(config).not.toContain("ghs_first");
      expect(config).not.toContain("ghs_second");
    } finally {
      await app.close();
    }
  } finally {
    await connector.closeScope?.(first);
    await connector.closeScope?.(second);
  }
});

it("INV-7: request auth cannot start a transport after cancellation or scope close", async () => {
  const fixture = apiFixture();
  const pending = deferred<string>();
  const controller = new AbortController();
  const ctx = context({ signal: controller.signal });
  const connector = remoteMcp("github", {
    url: "https://api.githubcopilot.com/mcp/",
    auth: { type: "request", token: () => pending.promise },
  });
  const call = connector.callTool("get_file_contents", {}, ctx).catch((error) => error);
  controller.abort(new Error("cancelled"));
  await connector.closeScope?.(ctx);
  pending.resolve("ghs_cancelled");
  expect(await call).toBeDefined();
  expect(fixture.fetchStub).not.toHaveBeenCalled();
});

it("INV-5: malformed request tokens and resolver errors are refused without rendering secret text", async () => {
  const fixture = apiFixture();
  for (const token of [
    async () => `${SENTINEL}\n`,
    async () => {
      throw new Error(SENTINEL);
    },
  ]) {
    const connector = remoteMcp("github", {
      url: "https://api.githubcopilot.com/mcp/",
      auth: { type: "request", token },
    });
    const ctx = context();
    try {
      await expect(connector.listTools(ctx)).rejects.toSatisfy(
        (error: any) => error.code === "auth_required" && !error.message.includes(SENTINEL),
      );
    } finally {
      await connector.closeScope?.(ctx);
    }
  }
  expect(fixture.fetchStub).not.toHaveBeenCalled();
});

for (const mode of ["request", "principal"] as const) {
  it.each([
    { failure: "empty token", token: async () => "", state: "auth_required" },
    {
      failure: "typed auth failure",
      token: async () => {
        throw new ConnectorCallError("auth_required", SENTINEL);
      },
      state: "auth_required",
    },
    ...(["unavailable", "provider_permission_denied"] as const).map((code) => ({
      failure: code,
      token: async () => {
        throw new ConnectorCallError(code, SENTINEL);
      },
      state: "error",
    })),
    {
      failure: "untyped resolver failure",
      token: async () => {
        throw new Error(SENTINEL);
      },
      state: "error",
    },
  ])(
    `INV-6 INV-10: ${mode} resolver status classifies $failure without dispatch or resolver text`,
    async ({ token, state }) => {
      const fixture = apiFixture();
      const resolve = vi.fn(token);
      const connector = remoteMcp("github", {
        url: "https://api.githubcopilot.com/mcp/",
        auth:
          mode === "request"
            ? { type: "request", token: resolve }
            : { type: "request", principal: { accept: "human", token: resolve } },
      });
      const principal = { namespace: "test-users", id: "alice" };
      const ctx = makeRegistry([connector])
        .scoped({
          connectorIds: "all",
          caller: {
            authenticated: true,
            identity: { actor: { kind: "test-users", ...principal }, principal, interactive: true },
          },
        })
        .contextFor(connector.id, "https://connecta.test", {});
      try {
        const status = await connector.status!(ctx);
        expect(resolve).toHaveBeenCalledOnce();
        expect(fixture.fetchStub).not.toHaveBeenCalled();
        expect(status.state).toBe(state);
        if (state === "auth_required") {
          expect(status.message).toBe("Authorization required — open the URL to connect.");
        }
        expect(JSON.stringify(status)).not.toContain(SENTINEL);
      } finally {
        await connector.closeScope?.(ctx);
      }
    },
  );
}

it("INV-11: request auth rejects personal ownership, callback/header mistakes and cleartext origins", () => {
  const options = {
    url: "https://api.githubcopilot.com/mcp/",
    auth: { type: "request" as const, token: async () => "ghs_fixture" },
  };
  expect(() => remoteMcp("github", { ...options, authScope: "personal" })).toThrow("shared authScope");
  expect(() => remoteMcp("github", { ...options, auth: { type: "request", token: "bad" as never } })).toThrow(
    "callback",
  );
  expect(() =>
    remoteMcp("github", { ...options, auth: { ...options.auth, headers: { Authorization: SENTINEL } } }),
  ).toThrow("without Authorization");
  expect(() => remoteMcp("github", { ...options, url: "http://github.example/mcp" })).toThrow("not https");
});
