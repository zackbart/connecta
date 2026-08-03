/**
 * The eval lane's shared observation layer.
 *
 * Both isolated servers — the fixture sandbox and the reference-connection
 * sandbox — must be watched the same way, or a number measured against one
 * cannot be read beside a number measured against the other. Extracting the
 * instrumentation is what makes "same scoring, different catalog" true rather
 * than merely intended: the harness reads `/__eval/trace` identically from
 * either server, and `agent-benchmark-scoring.mjs` cannot tell them apart.
 *
 * Nothing here decides what is measured. It records outer meta-tool calls,
 * meta-tool calls made from inside `execute_code`, and downstream executions,
 * and leaves every verdict to the scorer.
 */
import type {
  AdmittingExecutor,
  Connecta,
  ExecutorProvider,
  ToolCallActivityEvent,
} from "../../src/index.js";

export type EvalTraceSource = "outer" | "execute_code";

export interface EvalMetaToolTrace {
  schemaVersion: 1;
  sequence: number;
  kind: "meta_tool";
  source: EvalTraceSource;
  operation: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface EvalExecutionTrace {
  schemaVersion: 1;
  sequence: number;
  kind: "execution";
  address: string;
  source: ToolCallActivityEvent["source"];
  outcome: ToolCallActivityEvent["outcome"];
  durationMs: number;
  attempts: number;
  errorCode?: string;
}

export type EvalTrace = EvalMetaToolTrace | EvalExecutionTrace;

export type EvalTraceInput =
  | Omit<EvalMetaToolTrace, "schemaVersion" | "sequence">
  | Omit<EvalExecutionTrace, "schemaVersion" | "sequence">;

export interface EvalTracing {
  /** Every trace recorded so far, in emission order. */
  readonly traces: EvalTrace[];
  /** Record one trace. A no-op when tracing is disabled. */
  emitTrace(trace: EvalTraceInput): void;
  /** Wrap an executor so meta-tool calls inside programs are observed. */
  tracedExecutor(base: AdmittingExecutor): AdmittingExecutor;
  /** Wrap a deployment so outer `tools/call` requests are observed. */
  withOuterTracing(connecta: Connecta): Connecta;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map a guest-visible provider function onto the meta-tool name it stands for.
 *
 * A search run inside `execute_code` is still discovery work, and scoring it as
 * anything else would let code mode hide the learning cost it exists to reduce.
 */
function providerOperation(
  name: string,
  args: unknown[],
): { operation: string; arguments: unknown } {
  if (name === "search") {
    return { operation: "search_tools", arguments: args[0] ?? {} };
  }
  if (name === "describe") {
    return { operation: "describe_tools", arguments: args[0] ?? {} };
  }
  if (name === "call") {
    return {
      operation: "call_tool",
      arguments: { address: String(args[0]), args: args[1] ?? {} },
    };
  }
  if (name === "batch") {
    return { operation: "batch_call", arguments: { calls: args[0] ?? [] } };
  }
  if (name === "__callNamespace") {
    return {
      operation: "call_tool",
      arguments: {
        address: `${String(args[0])}.${String(args[1])}`,
        args: args[2] ?? {},
        via: "namespace",
      },
    };
  }
  return { operation: name, arguments: args };
}

async function outerMetaToolCall(
  request: Request,
): Promise<{ operation: string; arguments: unknown } | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const body = (await request.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown; arguments?: unknown };
    };
    if (body.method !== "tools/call" || typeof body.params?.name !== "string") {
      return undefined;
    }
    return {
      operation: body.params.name,
      arguments: body.params.arguments ?? {},
    };
  } catch {
    return undefined;
  }
}

/**
 * Build the tracing layer for one isolated eval server.
 *
 * `token` guards `/__eval/trace`: the harness reads it with the same bearer the
 * agent uses, and an unauthenticated reader gets nothing.
 */
export function createEvalTracing(options: {
  enabled: boolean;
  token: string;
}): EvalTracing {
  const traces: EvalTrace[] = [];
  let sequence = 0;

  function emitTrace(trace: EvalTraceInput): void {
    if (!options.enabled) return;
    const event = {
      schemaVersion: 1,
      sequence: ++sequence,
      ...trace,
    } as EvalTrace;
    traces.push(event);
    console.log(JSON.stringify({ event: "eval_trace", trace: event }));
  }

  function tracedProviders(
    providers: ExecutorProvider[],
  ): ExecutorProvider[] {
    return providers.map((provider) => ({
      ...provider,
      fns: Object.fromEntries(
        Object.entries(provider.fns).map(([name, fn]) => [
          name,
          async (...args: unknown[]) => {
            const operation = providerOperation(name, args);
            const started = performance.now();
            try {
              const result = await fn(...args);
              emitTrace({
                kind: "meta_tool",
                source: "execute_code",
                ...operation,
                result,
                durationMs: performance.now() - started,
              });
              return result;
            } catch (error) {
              emitTrace({
                kind: "meta_tool",
                source: "execute_code",
                ...operation,
                error: errorMessage(error),
                durationMs: performance.now() - started,
              });
              throw error;
            }
          },
        ]),
      ),
    }));
  }

  function tracedExecutor(base: AdmittingExecutor): AdmittingExecutor {
    return {
      async acquire(acquireOptions = {}) {
        const lease = await base.acquire(acquireOptions);
        return {
          ...(lease.waitMs !== undefined ? { waitMs: lease.waitMs } : {}),
          execute: (code, providers) =>
            lease.execute(code, tracedProviders(providers)),
          release: () => lease.release(),
        };
      },
      execute: (code, providers) =>
        base.execute(code, tracedProviders(providers)),
      ...(base.admissionSnapshot
        ? { admissionSnapshot: () => base.admissionSnapshot!() }
        : {}),
      close: () => base.close?.(),
    };
  }

  function withOuterTracing(connecta: Connecta): Connecta {
    return {
      ...connecta,
      async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/__eval/trace") {
          if (
            request.headers.get("authorization") !== `Bearer ${options.token}`
          ) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          return Response.json({ traces });
        }
        const operation = await outerMetaToolCall(request);
        const started = performance.now();
        try {
          const response = await connecta.fetch(request, env, ctx);
          if (!operation) return response;
          let payload: {
            result?: unknown;
            error?: { message?: unknown };
          } = {};
          try {
            payload = (await response.clone().json()) as typeof payload;
          } catch {
            // A malformed transport result is still traced below as an error.
          }
          emitTrace({
            kind: "meta_tool",
            source: "outer",
            ...operation,
            ...(payload.result !== undefined
              ? { result: payload.result }
              : {
                  error:
                    typeof payload.error?.message === "string"
                      ? payload.error.message
                      : `HTTP ${response.status}`,
                }),
            durationMs: performance.now() - started,
          });
          return response;
        } catch (error) {
          if (operation) {
            emitTrace({
              kind: "meta_tool",
              source: "outer",
              ...operation,
              error: errorMessage(error),
              durationMs: performance.now() - started,
            });
          }
          throw error;
        }
      },
    };
  }

  return { traces, emitTrace, tracedExecutor, withOuterTracing };
}
