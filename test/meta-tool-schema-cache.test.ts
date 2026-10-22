// Meta-tool descriptions follow deployment configuration and each identity's
// scoped view, while input schemas remain shared.

import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import type { Connector, Executor, InboundAuth } from "../src/types.js";
import { calcApi, makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";

const TOKEN = "test-token-123";

const stubExecutor: Executor = {
  execute: async () => ({ result: null }),
};

type ListedTool = { name: string; description: string; inputSchema: unknown };
type Listing = Record<
  "skills" | "search_tools" | "call_tool" | "call_destructive_tool" | "authorize_connector" | "execute_code",
  ListedTool
>;

async function listTools(deployment: Parameters<typeof mcpRpc>[0], token = TOKEN, pool?: string): Promise<Listing> {
  const body = await readJsonRpc(await mcpRpc(deployment, "tools/list", {}, { token, ...(pool ? { pool } : {}) }));
  return Object.fromEntries((body.result.tools as ListedTool[]).map((tool) => [tool.name, tool])) as Listing;
}

function schemasOf(tools: Listing) {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, tool.inputSchema]));
}

function guided(id: string): Connector {
  return api(id, {
    description: id,
    usageGuide: `Read ${id} records newest first.`,
    tools: [],
  });
}

describe("meta-tool input schema rendering", () => {
  it("keeps per-deployment and per-identity descriptions while sharing one rendering", async () => {
    const plain = makeDeployment({ executor: stubExecutor });
    const tuned = makeDeployment({
      executor: stubExecutor,
      connectors: [calcApi(), guided("notes")],
      execute: { maxHostCalls: 7 },
    });
    const users: InboundAuth = {
      kind: "test-users",
      activityActorNamespace: "connecta:test-users",
      authorize(request) {
        const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
        return user
          ? { ok: true, userId: user, subjectId: user }
          : { ok: false, response: new Response(null, { status: 401 }) };
      },
    };
    const scoped = makeDeployment({
      executor: stubExecutor,
      connectors: [calcApi(), guided("notes")],
      auth: users,
      // Alice maintains the whole deployment; Bob reaches only the calc pool (#837).
      maintainers: [{ namespace: "connecta:test-users", id: "alice" }],
      pools: { calc: { tools: ["calc"], members: [{ namespace: "connecta:test-users", id: "bob" }] } },
    });

    const base = await listTools(plain);
    const variant = await listTools(tuned);
    const alice = await listTools(scoped, "alice");
    const bob = await listTools(scoped, "bob", "calc");

    // Deployment configuration reaches descriptions...
    expect(base.skills.description).not.toContain("connector guides");
    expect(variant.skills.description).toContain("connector guides");
    expect(base.execute_code.description).not.toContain("7 host calls");
    expect(variant.execute_code.description).toContain("7 host calls");
    expect(variant.execute_code.description).toContain("notes");
    // ...and so does the identity's scoped view, request by request.
    expect(alice.search_tools.description).toContain("guideRequired");
    expect(bob.search_tools.description).not.toContain("guideRequired");
    expect(alice.execute_code.description).toContain("notes");
    expect(bob.execute_code.description).not.toContain("notes");
    // Bob's view matches a deployment that never had the guided connector.
    expect(bob.call_destructive_tool.description).toBe(base.call_destructive_tool.description);

    // Input schemas never vary, so all four share the one rendering.
    for (const tools of [variant, alice, bob]) {
      expect(schemasOf(tools)).toStrictEqual(schemasOf(base));
    }
    await Promise.all([plain.close(), tuned.close(), scoped.close()]);
  });
});
