// Node-only: runs a real program in the Node QuickJS child-process executor.
// The portable suite drives programs as closures; this arm proves the same
// refusal holds for model-written source in the sandbox a Node deployment uses.
import { describe, expect, it } from "vitest";
import { createConnecta } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { trackedQuickJs } from "./fixtures/node.js";
import { STALE_SCHEMA_PATHS, currentDigest } from "./fixtures/stale-schema.js";

const PROGRAM = `async () => {
  const found = await connecta.search({ connector: "things", query: "", safety: "readOnly" });
  const listed = await connecta.call("things.list_things", {});
  const refused = [];
  for (const address of ["things.peek_things", "things.scan_things"]) {
    try {
      await connecta.call(address, {});
    } catch (error) {
      refused.push(error.code);
    }
  }
  return { readOnly: found.tools.map((tool) => tool.address), listed: listed !== undefined, refused };
}`;

describe.each(Object.keys(STALE_SCHEMA_PATHS) as Array<keyof typeof STALE_SCHEMA_PATHS>)(
  "a stale reviewed read in a QuickJS program (%s)",
  (path) => {
    it("INV-1: is hidden from read-only discovery and refused before it is sent", async () => {
      const calls: string[] = [];
      const connecta = createConnecta({
        connectors: [STALE_SCHEMA_PATHS[path](await currentDigest(), calls)],
        storage: memoryStorage(),
        logger: "silent",
        executor: trackedQuickJs(),
      });
      try {
        const body = await readJsonRpc(
          await mcpRpc(connecta, "tools/call", { name: "execute_code", arguments: { code: PROGRAM } }),
        );
        expect(body.result.structuredContent.result).toEqual({
          readOnly: ["things.list_things"],
          listed: true,
          refused: ["destructive_tool_requires_approval", "destructive_tool_requires_approval"],
        });
        expect(calls).toEqual(["list_things"]);
      } finally {
        await connecta.close();
      }
    }, 30_000);
  },
);
