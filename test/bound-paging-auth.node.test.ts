// Node-only: measures real elapsed token-storage latency through the agent MCP route.
import { expect, it } from "vitest";
import { createConnecta, customExecutor } from "../src/index.js";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { resultKeys } from "../src/storage/keys.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";

it("INV-4: agent search paging bounds token reads per pass as dependencies grow", { timeout: 25_000 }, async () => {
  const inner = memoryStorage();
  let tokenReads = 0;
  let delayMs = 0;
  const storage = {
    ...inner,
    async get(key: string) {
      if (key.startsWith("access-token:")) {
        tokenReads++;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return inner.get(key);
    },
  };
  const token = (await new AccessTokenManager(storage, { agents: ["assistant"] }).rotate("assistant")).token;
  let work: (fns: Record<string, (...args: unknown[]) => Promise<unknown>>) => Promise<unknown>;
  const counts: number[] = [];
  for (const size of [1, 30]) {
    const app = createConnecta({
      readOnly: false,
      connectors: [
        {
          id: "notes",
          kind: "api",
          async listTools() {
            return Array.from({ length: size }, (_, index) => ({
              name: `read_${index}`,
              description: "Paging regression fixture",
              annotations: { readOnlyHint: true },
            }));
          },
          async callTool() {
            return {};
          },
        },
      ],
      storage,
      logger: "silent",
      agents: ["assistant"],
      accessTokens: accessTokens(storage),
      pools: { research: { tools: ["notes"], members: ["agent:assistant"] } },
      executor: customExecutor(
        scriptedExecutor((fns) => work(fns)),
        { lifecycle: "self-managed" },
      ),
    });
    const rpc = async () => {
      const response = await mcpRpc(
        app,
        "tools/call",
        { name: "execute_code", arguments: { code: "async () => null" } },
        { agentPool: "research", token },
      );
      expect(response.status).toBe(200);
      return (await readJsonRpc(response)).result;
    };
    try {
      delayMs = 0;
      work = async (fns) => {
        const search = (await fns.search!({
          connector: "notes",
          query: "paging",
          includeSchemas: "compact",
          limit: size,
        })) as { tools: unknown[] };
        expect(search.tools).toHaveLength(size);
        // Both sizes must page, independently of the catalog's rendered length.
        return { search, padding: "x".repeat(24_000) };
      };
      const minted = await rpc();
      const handle = minted.structuredContent.result;
      expect(handle.truncated).toBe(true);
      expect(handle.resultId).toBeTypeOf("string");
      work = (fns) => fns.result!(handle.resultId, { offset: 0, maxBytes: 10000 });
      tokenReads = 0;
      delayMs = 120;
      const started = Date.now();
      const page = await rpc();
      const elapsedMs = Date.now() - started;
      expect(page.isError, JSON.stringify(page.structuredContent)).not.toBe(true);
      expect(page.structuredContent.result).toMatchObject({ offset: 0, bytes: 10000, totalBytes: handle.totalBytes });
      expect(elapsedMs).toBeLessThan(15_000);
      // Admission and validation passes remain bounded as tool dependencies grow.
      expect(tokenReads).toBeGreaterThan(0);
      expect(tokenReads).toBeLessThanOrEqual(12);
      counts.push(tokenReads);
    } finally {
      await app.close();
    }
  }
  expect(counts[1]).toBe(counts[0]);
});

it("INV-4: revoking an agent token between page validation passes refuses the page", async () => {
  const inner = memoryStorage();
  let resultId = "";
  let revokeDuringPage = false;
  let revoked = false;
  const storage = {
    ...inner,
    async get(key: string) {
      if (revokeDuringPage && key.endsWith(resultKeys.chunk(resultId, 1))) {
        revoked = true;
        await manager.revoke("assistant");
      }
      return inner.get(key);
    },
  };
  const manager = new AccessTokenManager(storage, { agents: ["assistant"] });
  const token = (await manager.rotate("assistant")).token;
  let work = (fns: Record<string, (...args: unknown[]) => Promise<unknown>>) => fns.call!("notes.read");
  const app = createConnecta({
    readOnly: true,
    connectors: [
      {
        id: "notes",
        kind: "api",
        async listTools() {
          return [{ name: "read", annotations: { readOnlyHint: true } }];
        },
        async callTool() {
          return "private-page-sentinel".repeat(6000);
        },
      },
    ],
    storage,
    logger: "silent",
    agents: ["assistant"],
    accessTokens: accessTokens(storage),
    pools: { research: { tools: ["notes"], members: ["agent:assistant"] } },
    executor: customExecutor(
      scriptedExecutor((fns) => work(fns)),
      { lifecycle: "self-managed" },
    ),
  });
  const rpc = async () => {
    const response = await mcpRpc(
      app,
      "tools/call",
      { name: "execute_code", arguments: { code: "async () => null" } },
      { agentPool: "research", token },
    );
    expect(response.status).toBe(200);
    return (await readJsonRpc(response)).result;
  };
  try {
    const minted = await rpc();
    resultId = minted.structuredContent.result.resultId;
    expect(resultId).toBeTypeOf("string");
    work = (fns) => fns.result!(resultId, { offset: 48_000, maxBytes: 10_000 });
    expect((await rpc()).isError).not.toBe(true);
    revokeDuringPage = true;
    const denied = await rpc();
    expect(revoked).toBe(true);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error.code).toBe("not_found");
    expect(JSON.stringify(denied)).not.toContain("private-page-sentinel");
  } finally {
    await app.close();
  }
});
