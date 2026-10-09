import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { privateArgumentCases, PRIVATE_MARKER } from "./fixtures/private-arguments.js";
import { activityHistory } from "../src/activity.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("remote catalog argument echoes", () => {
  for (const { name, schema, args, echo } of privateArgumentCases)
    it(`INV-5 INV-6 INV-9: protects ${name} in MCP approval and uncertainty envelopes`, async () => {
      const writes: unknown[] = [];
      const records: unknown[] = [];
      const logs: unknown[] = [];
      const downstream = httpDownstream((server) => {
        server.registerTool(
          "write",
          { inputSchema: z.object({}).loose(), annotations: { readOnlyHint: false } },
          async () => ({ content: [] }),
        );
      });
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const message =
          request.method === "POST"
            ? ((await request.clone().json()) as { method?: string; params?: { arguments?: unknown } })
            : undefined;
        if (message?.method === "tools/call") {
          writes.push(message.params?.arguments);
          return await new Promise<Response>((_resolve, reject) => {
            if (request.signal.aborted) reject(request.signal.reason);
            else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
        const response = await downstream.fetch(input as string, init);
        if (message?.method !== "tools/list") return response;
        const body = (await response.json()) as { result: { tools: { inputSchema: unknown }[] } };
        body.result.tools[0]!.inputSchema = schema;
        return Response.json(body, { status: response.status, headers: response.headers });
      };
      vi.stubGlobal("fetch", fetch);
      const logger = { ...silentLogger };
      for (const method of ["debug", "info", "warn", "error"] as const)
        logger[method] = (...values) => {
          logs.push(values);
        };
      const app = createTestConnecta({
        connectors: [remoteMcp("private", { url: downstream.url })],
        logger,
        activity: activityHistory({
          store: {
            record: (event) => {
              records.push(event);
            },
          },
        }),
      });
      try {
        for (const name of ["call_tool", "call_destructive_tool"]) {
          const rpc = await readJsonRpc(
            await mcpRpc(app, "tools/call", {
              name,
              arguments: { address: "private.write", args, timeoutMs: 200 },
            }),
          );
          const result = rpc.result;
          expect(result.isError).toBe(true);
          expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
          const error = result.structuredContent.error;
          expect(error.code).toBe(
            name === "call_tool" ? "destructive_tool_requires_approval" : "write_outcome_unknown",
          );
          const context = error.uncertainCall ?? error.nextAction.arguments;
          expect(context).toEqual({
            address: "private.write",
            ...echo,
            ...(name !== "call_tool" && !("args" in echo) ? { argsOmitted: true } : {}),
          });
          expect(error.retry ?? error.nextAction.purpose).toMatch(/original arguments/);
          expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
        }
        expect(writes).toEqual([args]);
        expect(JSON.stringify(records)).not.toContain(PRIVATE_MARKER);
        expect(JSON.stringify(logs)).not.toContain(PRIVATE_MARKER);
      } finally {
        await app.close();
      }
    });
});
