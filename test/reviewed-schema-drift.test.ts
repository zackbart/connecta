// A reviewed read vouches for the schema its review read. When the live
// schema no longer matches the recorded digest, or the digest cannot be
// checked, the tool is a write on every public path (INV-1): discovery at the
// top level and inside a program, `call_tool`, and a program's call. Both
// classification wrappers share this rule, so each case runs through
// `remoteMcp({ classify })` and the legacy `withVettedCatalog()`.
//
// Programs here are JavaScript closures run by a scripted executor, not source
// strings: workerd forbids eval, and this suite runs in both projects.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnecta, customExecutor } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, Executor, ExecutorProvider } from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { STALE_SCHEMA_PATHS as PATHS, currentDigest } from "./fixtures/stale-schema.js";
import { required } from "./helpers.js";

type Guest = Record<string, (...args: unknown[]) => Promise<any>>;
type Program = (connecta: Guest) => Promise<unknown>;

/** Runs registered closures by program text, through the real provider. */
function scriptedExecutor(programs: Map<string, Program>): Executor {
  return {
    async execute(code: string, providers: ExecutorProvider[]) {
      const program = programs.get(code.trim());
      if (!program) return { result: undefined, error: `no program for ${code}` };
      const provider = required(providers[0]);
      const connecta = new Proxy({} as Guest, {
        get: (_target, name: string) => (...args: unknown[]) =>
          required(provider.fns[name])(...args),
      });
      try {
        return { result: await program(connecta) };
      } catch (error) {
        return { result: undefined, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function deployment(connector: Connector) {
  const programs = new Map<string, Program>();
  const connecta = createConnecta({
    connectors: [connector],
    storage: memoryStorage(),
    logger: "silent",
    executor: customExecutor(scriptedExecutor(programs), { lifecycle: "self-managed" }),
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await readJsonRpc(await mcpRpc(connecta, "tools/call", { name, arguments: args }))).result as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
      content?: Array<{ text?: string }>;
    };
  let next = 0;
  return {
    connecta,
    call,
    async searched(safety: "readOnly" | "approvalRequired"): Promise<string[]> {
      const result = await call("search_tools", { connector: "things", query: "", safety });
      return (result.structuredContent?.connectors ?? []).flatMap(
        (entry: { tools: Array<{ address: string }> }) => entry.tools.map((tool) => tool.address),
      ).sort();
    },
    run(program: Program) {
      const code = `async () => program${next++}`;
      programs.set(code, program);
      return call("execute_code", { code });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(Object.keys(PATHS) as Array<keyof typeof PATHS>)(
  "a reviewed read whose schema digest no longer matches (%s)",
  (path) => {
    it("INV-1: is discovered as a write at the top level and inside a program", async () => {
      const app = deployment(PATHS[path](await currentDigest(), []));
      try {
        expect(await app.searched("readOnly")).toEqual(["things.list_things"]);
        expect(await app.searched("approvalRequired")).toEqual([
          "things.peek_things",
          "things.scan_things",
        ]);
        const found = await app.run(async (connecta) => {
          const page = await connecta.search!({ connector: "things", query: "", safety: "readOnly" });
          return page.tools.map((tool: { address: string }) => tool.address).sort();
        });
        expect(found.structuredContent?.result).toEqual(["things.list_things"]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1: is refused by call_tool and dispatched only by call_destructive_tool", async () => {
      const calls: string[] = [];
      const app = deployment(PATHS[path](await currentDigest(), calls));
      try {
        expect((await app.call("call_tool", { address: "things.list_things", args: {} })).isError)
          .toBeFalsy();
        for (const address of ["things.peek_things", "things.scan_things"]) {
          const refused = await app.call("call_tool", { address, args: {} });
          expect(refused.isError).toBe(true);
          expect(JSON.stringify(refused.structuredContent)).toContain(
            "destructive_tool_requires_approval",
          );
        }
        expect(calls).toEqual(["list_things"]);
        const approved = await app.call("call_destructive_tool", {
          address: "things.peek_things",
          args: {},
        });
        expect(approved.isError).toBeFalsy();
        expect(calls).toEqual(["list_things", "peek_things"]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1: is refused inside execute_code before it is sent", async () => {
      const calls: string[] = [];
      const app = deployment(PATHS[path](await currentDigest(), calls));
      try {
        const result = await app.run(async (connecta) => {
          await connecta.call!("things.list_things", {});
          const refused: string[] = [];
          for (const address of ["things.peek_things", "things.scan_things"]) {
            try {
              await connecta.call!(address, {});
            } catch (error) {
              refused.push(String((error as Error).message));
            }
          }
          return refused;
        });
        const refused = result.structuredContent?.result as string[];
        expect(refused).toHaveLength(2);
        for (const message of refused) {
          expect(message).toContain("destructive_tool_requires_approval");
        }
        expect(calls).toEqual(["list_things"]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1: becomes a write with every other digested review when the digest cannot be checked", async () => {
      const digest = await currentDigest();
      const calls: string[] = [];
      const app = deployment(PATHS[path](digest, calls));
      // Only the schema digest fails; the catalog cache hashes with the same
      // primitive and must keep working.
      const digestBytes = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
        if (new TextDecoder().decode(data as Uint8Array).startsWith('{"inputSchema"')) {
          throw new Error("digest unavailable");
        }
        return digestBytes(algorithm, data);
      });
      try {
        expect(await app.searched("readOnly")).toEqual([]);
        const refused = await app.call("call_tool", { address: "things.list_things", args: {} });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.structuredContent)).toContain(
          "destructive_tool_requires_approval",
        );
        expect(calls).toEqual([]);
      } finally {
        await app.connecta.close();
      }
    });
  },
);
