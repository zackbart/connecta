import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { createMetaTools } from "../src/meta-tools.js";
import { ConnectorCallError } from "../src/errors.js";
import { connectorWith } from "./fixtures/connectors.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, makeRegistry, required, silentLogger } from "./helpers.js";
import { memoryStorage } from "../src/storage/memory.js";

const BASE = "https://connecta.test";
const CAP = 1_000;

function fixture(kind: "mcp" | "api", format: "text" | "json", truncated: boolean, write: boolean) {
  const data = format === "text" ? "balance paid\n" : { balance: 42, invoiceIds: ["one", "two"] };
  const value = truncated
    ? format === "text"
      ? "balance paid\n".repeat(200)
      : { data, pad: "x".repeat(2_000) }
    : data;
  const text = format === "text" && kind === "mcp" ? String(value) : JSON.stringify(value);
  const content = [{ type: "text" as const, text }];
  const call = vi.fn(async () =>
    kind === "mcp" ? { content, ...(format === "json" ? { structuredContent: value } : {}) } : value,
  );
  const tool = {
    name: "run",
    description: "Return the balance result",
    annotations: { readOnlyHint: !write },
    inputSchema: { type: "object" as const },
  };
  const connector =
    kind === "api"
      ? api("down", { tools: [{ ...tool, handler: call }] })
      : connectorWith({ id: "down", kind, tools: [tool], call });
  return { connector, call, value, text, content };
}

const cases = (["mcp", "api"] as const).flatMap((kind) =>
  (["text", "json"] as const).flatMap((format) =>
    [false, true].flatMap((truncated) => [false, true].map((write) => ({ kind, format, truncated, write }))),
  ),
);

describe("direct-call result projections", () => {
  it("INV-9: default direct-call results preserve data and previews without structured stubs or repeated writes", async () => {
    for (const { kind, format, truncated, write } of cases) {
      for (const resultMode of [undefined, "mcp"] as const) {
        const { connector, call, text, content } = fixture(kind, format, truncated, write);
        const app = createTestConnecta({
          connectors: [connector],
          storage: memoryStorage(),
          trust: "trusted",
          calls: { maxResultBytes: CAP },
          logger: silentLogger,
        });
        try {
          const response = await readJsonRpc(
            await mcpRpc(app, "tools/call", {
              name: write ? "call_destructive_tool" : "call_tool",
              arguments: { address: "down.run", ...(resultMode ? { resultMode } : {}) },
            }),
          );
          expect(response.error).toBeUndefined();
          const result = response.result;
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toBeUndefined();
          expect(result._meta).toEqual({ "dev.connecta/format": format });
          // A host preferring structuredContent must fall back to actual data.
          expect(result.structuredContent ?? result.content).toEqual(result.content);
          if (truncated) {
            const rendered = result.content[0].text as string;
            const newline = rendered.indexOf("\n");
            const notice = JSON.parse(rendered.slice(0, newline));
            expect(notice).toMatchObject({
              truncated: true,
              totalBytes: new TextEncoder().encode(text).length,
              nextOffset: CAP,
              resultId: expect.any(String),
            });
            expect(rendered.slice(newline + 1)).toBe(text.slice(0, CAP));
          } else {
            expect(result.content).toEqual(content);
          }
          expect(call).toHaveBeenCalledTimes(1);
        } finally {
          await app.close();
        }
      }
    }
  });

  it("INV-9: value-mode direct-call results mirror complete data or paging envelopes in both forms", async () => {
    for (const { kind, format, truncated, write } of cases) {
      const { connector, call, value } = fixture(kind, format, truncated, write);
      const mt = createMetaTools(makeRegistry([connector], { maxResultBytes: CAP }), BASE, { trust: "trusted" });
      const args = { address: "down.run", resultMode: "value" as const };
      const result = await (write ? mt.callDestructiveTool(args) : mt.callTool(args));
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(required(result.content[0]).text)).toEqual(result.structuredContent);
      expect(result.structuredContent).toMatchObject({ ok: true, format, durationMs: expect.any(Number), attempts: 1 });
      expect(result.structuredContent?.data).toEqual(
        truncated ? expect.objectContaining({ truncated: true, resultId: expect.any(String), nextOffset: 0 }) : value,
      );
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("direct-call failures mirror the full error envelope in every mode", async () => {
    for (const kind of ["mcp", "api"] as const) {
      for (const write of [false, true]) {
        for (const resultMode of [undefined, "mcp", "value"] as const) {
          const { connector, call } = fixture(kind, "json", false, write);
          call.mockRejectedValue(new ConnectorCallError("provider_permission_denied", "Access refused"));
          const mt = createMetaTools(makeRegistry([connector]), BASE);
          const args = { address: "down.run", ...(resultMode ? { resultMode } : {}) };
          const result = await (write ? mt.callDestructiveTool(args) : mt.callTool(args));
          expect(result.isError).toBe(true);
          expect(JSON.parse(required(result.content[0]).text)).toEqual(result.structuredContent);
          expect(result.structuredContent).toMatchObject({
            ok: false,
            error: { code: "provider_permission_denied", message: "Access refused" },
            attempts: 1,
          });
        }
      }
    }
  });

  it("INV-9: result pages retain the same bytes and metadata in both internal forms without recalling the tool", async () => {
    for (const { kind, format, write } of cases.filter((c) => c.truncated)) {
      const { connector, call, text } = fixture(kind, format, true, write);
      const mt = createMetaTools(makeRegistry([connector], { maxResultBytes: CAP }), BASE, { trust: "trusted" });
      const args = { address: "down.run" };
      const result = await (write ? mt.callDestructiveTool(args) : mt.callTool(args));
      const notice = JSON.parse(required(result.content[0]).text.split("\n")[0]!);
      let offset = 0;
      let joined = "";
      do {
        const page = await mt.readResult({ id: notice.resultId, offset });
        const rendered = required(page.content[0]).text;
        const newline = rendered.indexOf("\n");
        const header = JSON.parse(rendered.slice(0, newline));
        const slice = rendered.slice(newline + 1);
        expect(page.structuredContent).toEqual({ ...header, format: "text", text: slice });
        joined += slice;
        offset = header.hasMore ? header.nextOffset : text.length;
      } while (offset < text.length);
      expect(joined).toBe(text);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
});
