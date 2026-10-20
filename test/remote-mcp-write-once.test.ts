import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { seedGrant } from "./fixtures/oauth.js";
import { makeRegistry } from "./helpers.js";

// Remote MCP writes through the real SDK client and transport against a real
// MCP server: a write leaves once whatever answers it (INV-9), and a read may
// be sent again after a refresh.

const BASE = "https://connecta.test";
const STALE = "STALE_ACCESS_CREDENTIAL";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Answer = "pass" | 401 | 502 | 503 | 504 | "reset" | "refused";

function setup(options: { oauth?: boolean; refresh?: "rotate" | "dead" | "outage" } = {}) {
  const applied: string[] = [];
  const downstream = httpDownstream((server) => {
    server.registerTool(
      "create_item",
      { inputSchema: z.object({ id: z.number() }), annotations: { readOnlyHint: false } },
      async ({ id }) => {
        applied.push(`create_item ${id}`);
        return { content: [{ type: "text", text: JSON.stringify({ created: id }) }] };
      },
    );
    server.registerTool("list_items", { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => {
      applied.push("list_items");
      return { content: [{ type: "text", text: "[]" }] };
    });
  });
  /** Every tools/call POST that left connecta, by tool name and bearer token. */
  const sent: Array<{ name: string; authorization: string | null }> = [];
  let refreshes = 0;
  /** How the next tools/call per tool is answered; "pass" lets it through. */
  const answers = new Map<string, Answer>();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: downstream.url, authorization_servers: ["https://auth.test"] });
    if (url.startsWith("https://auth.test/.well-known/"))
      return Response.json({
        issuer: "https://auth.test",
        authorization_endpoint: "https://auth.test/authorize",
        token_endpoint: "https://auth.test/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url === "https://auth.test/token") {
      refreshes++;
      if (options.refresh === "dead") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (options.refresh === "outage") return new Response("down", { status: 503 });
      return Response.json({
        access_token: `FRESH_ACCESS_${refreshes}`,
        refresh_token: `FRESH_REFRESH_${refreshes}`,
        token_type: "Bearer",
      });
    }
    const rpc =
      init?.method === "POST" && typeof init.body === "string"
        ? (JSON.parse(init.body) as { method?: string; params?: { name?: string } })
        : undefined;
    if (rpc?.method !== "tools/call") return downstream.fetch(input as string, init);
    const name = rpc.params!.name!;
    const authorization = new Headers(init?.headers).get("authorization");
    const answer = answers.get(name) ?? "pass";
    if (answer === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    sent.push({ name, authorization });
    if (answer === 401 && authorization === `Bearer ${STALE}`)
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${downstream.url.replace("/mcp", "")}/.well-known/oauth-protected-resource"`,
        },
      });
    // Everything else reaches the server, which acts on it, and then the
    // gateway or the connection fails the answer.
    const reply = await downstream.fetch(input as string, init);
    if (answer === "pass" || answer === 401) return reply;
    await reply.body?.cancel();
    if (answer === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return new Response("<html>bad gateway</html>", { status: answer, headers: { "content-type": "text/html" } });
  });
  const storage = memoryStorage();
  const connector = remoteMcp("svc", {
    url: downstream.url,
    versionNegotiation: "legacy",
    auth: options.oauth
      ? { type: "oauth" }
      : { type: "headers", headers: { Authorization: "Bearer HEADER_CREDENTIAL" } },
  });
  const registry = makeRegistry([connector], { storage });
  const tools = createMetaTools(registry, BASE);
  const seedOAuth = () =>
    seedGrant(
      storage,
      {
        issuer: "https://auth.test",
        client: {
          value: {
            client_id: "svc-client",
            redirect_uris: [`${BASE}/oauth/callback/svc`],
            token_endpoint_auth_method: "none",
          },
        },
        tokens: { access_token: STALE, refresh_token: "INITIAL_REFRESH", token_type: "Bearer" },
      },
      "v3:seeded",
      scopes.connector("svc"),
    );
  const outcome = async (tool: "create_item" | "list_items", args: Record<string, unknown> = {}) => {
    const address = `svc.${tool}`;
    const result =
      tool === "create_item"
        ? await tools.callDestructiveTool({ address, args })
        : await tools.callTool({ address, args });
    return JSON.parse(result.content[0]!.text) as {
      error?: { code: string; retryable: boolean; message: string; reconciliationRequired?: boolean };
    };
  };
  return {
    outcome,
    seedOAuth,
    applied,
    answers,
    sent: (name: string) => sent.filter((entry) => entry.name === name),
    refreshes: () => refreshes,
  };
}

describe("remote MCP OAuth writes after a 401", () => {
  it("INV-9: sends an ordinary write once, refreshes the grant, and lets a deliberate repeat use it", async () => {
    const flow = setup({ oauth: true });
    await flow.seedOAuth();
    flow.answers.set("create_item", 401);

    const failed = await flow.outcome("create_item", { id: 1 });
    expect(failed.error).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failed.error!.message).toBe(
      `Connector "svc"'s MCP server answered this write with HTTP 401. The credential is renewed for the next ` +
        "call, but the write was not sent again, so whether it took effect is unknown: check the target before repeating it.",
    );
    expect(flow.sent("create_item")).toEqual([{ name: "create_item", authorization: `Bearer ${STALE}` }]);
    expect(flow.refreshes()).toBe(1);
    expect(flow.applied).toEqual([]);

    // The explicit repeat is one new call on the refreshed grant.
    expect((await flow.outcome("create_item", { id: 1 })).error).toBeUndefined();
    expect(flow.sent("create_item").map((entry) => entry.authorization)).toEqual([
      `Bearer ${STALE}`,
      "Bearer FRESH_ACCESS_1",
    ]);
    expect(flow.applied).toEqual(["create_item 1"]);
    expect(flow.refreshes()).toBe(1);
  });

  it("INV-9: refreshes and sends a read again once", async () => {
    const flow = setup({ oauth: true });
    await flow.seedOAuth();
    flow.answers.set("list_items", 401);
    expect((await flow.outcome("list_items")).error).toBeUndefined();
    expect(flow.sent("list_items").map((entry) => entry.authorization)).toEqual([
      `Bearer ${STALE}`,
      "Bearer FRESH_ACCESS_1",
    ]);
    expect(flow.refreshes()).toBe(1);
  });

  it.each(["dead", "outage"] as const)(
    "INV-9: a write whose grant cannot be refreshed (%s) is sent once and never advertised as retryable",
    async (refresh) => {
      const flow = setup({ oauth: true, refresh });
      await flow.seedOAuth();
      flow.answers.set("create_item", 401);
      const failed = await flow.outcome("create_item", { id: 1 });
      expect(failed.error).toMatchObject({
        code: "downstream_oauth_required",
        retryable: false,
        reconciliationRequired: true,
      });
      expect(flow.sent("create_item")).toHaveLength(1);
      expect(flow.refreshes()).toBe(1);
    },
  );
});

describe("remote MCP writes after an ambiguous failure", () => {
  it.each([502, 503, 504, "reset"] as const)(
    "INV-9: a write answered %s after the server acted is an unknown outcome, never retryable; a read stays retryable",
    async (answer) => {
      const flow = setup();
      flow.answers.set("create_item", answer);
      const write = await flow.outcome("create_item", { id: 1 });
      expect(write.error).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(write.error!.message).toContain('Whether the write took effect at connector "svc" is unknown');
      expect(flow.sent("create_item")).toHaveLength(1);
      expect(flow.applied).toEqual(["create_item 1"]);

      flow.answers.set("list_items", answer);
      const read = await flow.outcome("list_items");
      expect(read.error).toMatchObject({
        code: answer === "reset" ? "unavailable" : "connector_call_failed",
        retryable: true,
      });
    },
  );

  it("INV-9: a write whose connection was refused before sending stays retryable", async () => {
    const flow = setup();
    flow.answers.set("create_item", "refused");
    const write = await flow.outcome("create_item", { id: 1 });
    expect(write.error).toMatchObject({ code: "unavailable", retryable: true });
    expect(flow.applied).toEqual([]);
  });
});
