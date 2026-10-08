// One "things" connector behind a full deployment, driven through the public
// MCP surface: top-level discovery and calls, and programs that discover and
// call from inside `execute_code`. Programs are JavaScript closures run by a
// scripted executor, not source strings: workerd forbids eval, and the suites
// using this run in both projects.
import { createConnecta, customExecutor, type ConnectaConfig } from "../../src/index.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type {
  Connector,
  Executor,
  ExecutorProvider,
  KVStorage,
} from "../../src/types.js";
import { required } from "../helpers.js";
import { mcpRpc, readJsonRpc } from "./http.js";

type Guest = Record<string, (...args: unknown[]) => Promise<any>>;
export type Program = (connecta: Guest) => Promise<unknown>;

/** Runs registered closures by program text, through the real provider. */
function closureExecutor(programs: Map<string, Program>): Executor {
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

export function thingsDeployment(
  connector: Connector,
  storage: KVStorage = memoryStorage(),
  execute?: ConnectaConfig["execute"],
) {
  const programs = new Map<string, Program>();
  const connecta = createConnecta({
    connectors: [connector],
    storage,
    logger: "silent",
    ...(execute ? { execute } : {}),
    executor: customExecutor(closureExecutor(programs), { lifecycle: "self-managed" }),
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
