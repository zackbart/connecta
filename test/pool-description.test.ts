// A pool's `description` tells the model its endpoint's scope through the MCP
// instructions at /mcp/<pool> and /agent/<pool>; plain /mcp never shows it,
// and it changes nothing else a client caches.

import { describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { CONNECTA_INSTRUCTIONS } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { InboundAuth } from "../src/types.js";
import { modernRequest } from "./fixtures/client-identity.js";
import { readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";

const BASE = "https://connecta.test";
const NAMESPACE = "https://identity.test";
const TEAM = "Team tier: shared tools only. For someone's own mail or files, ask them to message you one-on-one.";

/** `Bearer alice` is the maintainer; `Bearer bob` is a pool member. */
function people(): InboundAuth {
  return {
    kind: "test-users",
    interactiveOperator: true,
    activityActorNamespace: NAMESPACE,
    authorize: (request: Request) => {
      const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
      return user
        ? { ok: true as const, userId: user, subjectId: user }
        : { ok: false as const, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    },
  };
}

const crm = () =>
  api("crm", {
    description: "CRM",
    tools: [
      {
        name: "search",
        description: "Search customers",
        annotations: { readOnlyHint: true },
        handler: async () => ({ ok: true }),
      },
    ],
  });

function deployment(pools: Record<string, { description?: unknown }> = {}) {
  const storage = memoryStorage();
  return {
    storage,
    connecta: createTestConnecta({
      connectors: [crm()],
      auth: people(),
      maintainers: ["alice"],
      agents: ["assistant"],
      pools: {
        team: { tools: ["crm"], members: ["bob", "agent:assistant"], description: TEAM },
        plain: { tools: ["crm"], members: ["bob", "agent:assistant"] },
        ...(pools as Record<string, never>),
      },
      publicUrl: BASE,
      logger: silentLogger,
      storage,
      accessTokens: accessTokens(storage),
    }),
  };
}

function post(path: string, token: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pool-test", version: "0" } },
};

type Fetcher = { fetch(request: Request): Promise<Response> };

async function initialized(c: Fetcher, path: string, token: string): Promise<string> {
  const body = await readJsonRpc(await c.fetch(post(path, token, INITIALIZE)));
  return body.result.instructions as string;
}

async function discovered(c: Fetcher, path: string, token: string): Promise<string> {
  const modern = modernRequest("server/discover");
  const headers = new Headers(modern.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const request = new Request(`${BASE}${path}`, { method: "POST", headers, body: await modern.text() });
  const body = await readJsonRpc(await c.fetch(request));
  expect(body.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: "private" });
  return body.result.instructions as string;
}

describe("pool description", () => {
  it("INV-11: refuses a description that is not 1 to 500 characters of one-line text at construction", () => {
    for (const description of ["", 3, "x".repeat(501), "Team\ntier"]) {
      expect(
        () => deployment({ bad: { tools: ["crm"], members: ["bob"], description } as never }),
        String(description),
      ).toThrow("ConnectaConfig.pools.bad.description must be text of 1 to 500 characters");
    }
    expect(() =>
      deployment({ edge: { tools: ["crm"], members: ["bob"], description: "é".repeat(500) } as never }),
    ).not.toThrow();
  });

  it("adds the trimmed description to the instructions at /mcp/<pool> and /agent/<pool>", async () => {
    const { connecta, storage } = deployment({
      padded: { tools: ["crm"], members: ["bob"], description: `  ${TEAM}  ` } as never,
    });
    try {
      const token = await issueAgentToken(storage, "assistant");
      const expected = `${CONNECTA_INSTRUCTIONS} This endpoint: ${TEAM}`;
      expect(await initialized(connecta, "/mcp/team", "bob")).toBe(expected);
      expect(await initialized(connecta, "/agent/team", token)).toBe(expected);
      expect(await initialized(connecta, "/mcp/padded", "bob")).toBe(expected);
      expect(await discovered(connecta, "/mcp/team", "bob")).toBe(expected);
      expect(await discovered(connecta, "/agent/team", token)).toBe(expected);
      expect(connecta.describeConfig().pools.find((pool) => pool.name === "padded")?.description).toBe(TEAM);
    } finally {
      await connecta.close();
    }
  });
});
