import { requestToken } from "./request-bound-async-resource.js";
import { createConnecta, type Connector } from "../../src/index.js";
import { workerExecutor } from "../../src/worker.js";
import type { AdmittingExecutor } from "../../src/types.js";

interface Env {
  LOADER: WorkerLoader;
  ORIGIN: string;
}

// Isolate-level apps and executors, as the Worker example builds them. Every
// request is a separate workerd request sharing only these singletons. `/mcp`
// uses the Worker executor's default admission; `/tight/mcp` a one-slot pool
// with a short queue, for refusals.
let apps: { standard: ReturnType<typeof createConnecta>; tight: ReturnType<typeof createConnecta> } | undefined;
let executors: { standard: AdmittingExecutor; tight: AdmittingExecutor } | undefined;
// A host call that ran outside the request owning its program, or failed.
const failures: string[] = [];
// One signal per program, created by its request. workerd refuses to read a
// request's signal from any other request, so reading it proves where a host
// call runs.
const owned = new Map<string, AbortSignal>();

function slowConnector(env: Env): Connector {
  return {
    id: "slow",
    kind: "api",
    async listTools() {
      return [{ name: "read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }];
    },
    // Real TCP I/O, from whichever request is running the program.
    async callTool(_name, args, context) {
      const { id, ms } = args as { id: string; ms: number };
      const program = id.slice(0, id.lastIndexOf("-"));
      try {
        void owned.get(program)?.aborted;
      } catch (error) {
        failures.push(`${id} ran outside its program's request: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const response = await fetch(
          `${env.ORIGIN}/executor/slow?id=${encodeURIComponent(id)}&ms=${ms}`,
          context.signal ? { signal: context.signal } : {},
        );
        return await response.json();
      } catch (error) {
        failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
  };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    executors ??= {
      standard: workerExecutor({ loader: env.LOADER }),
      tight: workerExecutor({
        loader: env.LOADER,
        admission: { concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1_000, retryAfterMs: 750 },
      }),
    };
    const app = (executor: AdmittingExecutor) =>
      createConnecta({
        readOnly: true,
        publicUrl: "http://localhost",
        logger: "silent",
        executor,
        connectors: [slowConnector(env)],
      });
    apps ??= { standard: app(executors.standard), tight: app(executors.tight) };
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json({
        standard: executors.standard.admissionSnapshot?.(),
        tight: executors.tight.admissionSnapshot?.(),
        failures,
      });
    }
    const program = request.headers.get("X-Program");
    if (program) owned.set(program, new AbortController().signal);
    const tight = url.pathname.startsWith("/tight/");
    const target = tight ? new Request(new URL(url.pathname.slice("/tight".length), url), request) : request;
    return requestToken.run({}, () =>
      (tight ? apps!.tight : apps!.standard).fetch(target, env, ctx),
    );
  },
};
