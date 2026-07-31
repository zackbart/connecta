import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ActivityRequestContext } from "./activity.js";
import {
  boundedDiscoveryText,
  CatalogService,
  DiscoveryPolicyError,
  flatSearchResult,
} from "./catalog-service.js";
import { errorResult, jsonResult, type ToolResult } from "./meta-tools.js";
import {
  guardExecuteResultValue,
  MAX_EXECUTE_LOG_CHARS,
  truncateExecuteText,
} from "./executor-result.js";
import {
  ExecutorAdmissionError,
  isAdmittingExecutor,
} from "./executor-admission.js";
import { classifyCallError } from "./errors.js";
import {
  InvocationFailure,
  InvocationService,
} from "./invocation.js";
import type { RegistryView } from "./registry.js";
import type {
  ConnectaSurface,
  Executor,
  ExecutorProvider,
  Logger,
} from "./types.js";

/** Keep one model-written program from amplifying into an unbounded fan-out. */
const EXECUTE_MAX_HOST_CALLS = 20;
export const EXECUTE_MAX_BATCH_CALLS = 10;
const EXECUTE_HOST_CALL_TIMEOUT_MS = 15_000;
/**
 * Default budgets for `connecta.emit`. The byte budget is a transport bound,
 * not a context bound — emitted image/audio blocks reach the model as media,
 * not base64 text — so it sits far above the 24k return-value guard: room for
 * two or three real screenshots after base64's 4/3 inflation, well short of a
 * file-hosting ambition (design record M5).
 */
export const EXECUTE_MAX_EMITTED_BYTES = 4_000_000;
export const EXECUTE_MAX_EMITTED_BLOCKS = 32;
const diagnosticsEncoder = new TextEncoder();

type ExecuteDiagnosticOperation = "search" | "describe" | "call" | "batch";

interface ExecuteOperationDiagnostics {
  operation: ExecuteDiagnosticOperation;
  count: number;
  failures: number;
  durationMs: number;
  resultBytes: number;
  catalogMs: number;
  connectorMs: number;
  calls?: number;
}

type MutableOperationDiagnostics = ExecuteOperationDiagnostics;

class ExecuteDiagnostics {
  private readonly started = Date.now();
  private readonly operations = new Map<
    ExecuteDiagnosticOperation,
    MutableOperationDiagnostics
  >();
  admissionMs = 0;
  setupMs = 0;
  executorWallMs = 0;
  private emitted?: { count: number; bytes: number };

  /** Numbers only, per R8 — and only once something was emitted, so a
   * non-emitting run's diagnostics stay byte-for-byte what they were. */
  recordEmitted(count: number, bytes: number): void {
    if (count > 0) this.emitted = { count, bytes };
  }

  private stats(operation: ExecuteDiagnosticOperation) {
    let stats = this.operations.get(operation);
    if (!stats) {
      stats = {
        operation,
        count: 0,
        failures: 0,
        durationMs: 0,
        resultBytes: 0,
        catalogMs: 0,
        connectorMs: 0,
      };
      this.operations.set(operation, stats);
    }
    return stats;
  }

  recordCatalog(
    operation: "search" | "describe",
    durationMs: number,
    ok: boolean,
    result?: unknown,
  ): void {
    const stats = this.stats(operation);
    stats.count++;
    stats.failures += ok ? 0 : 1;
    stats.durationMs += durationMs;
    stats.catalogMs += durationMs;
    if (ok) stats.resultBytes += serializedDiagnosticBytes(result);
  }

  recordCall(
    operation: "call" | "batch",
    outcome: {
      ok: boolean;
      durationMs: number;
      timing: { catalogMs: number; connectorMs: number };
      value?: unknown;
    },
  ): void {
    const stats = this.stats(operation);
    if (operation === "call") {
      stats.count++;
      if (outcome.ok) {
        stats.resultBytes += serializedDiagnosticBytes(outcome.value);
      }
    } else {
      stats.calls = (stats.calls ?? 0) + 1;
    }
    stats.failures += outcome.ok ? 0 : 1;
    if (operation === "call") stats.durationMs += outcome.durationMs;
    stats.catalogMs += outcome.timing.catalogMs;
    stats.connectorMs += outcome.timing.connectorMs;
  }

  recordBatch(
    durationMs: number,
    ok: boolean,
    calls: number,
    result?: unknown,
  ): void {
    const stats = this.stats("batch");
    stats.count++;
    // Calls normally accrue while each child runs. Invalid batch input never
    // starts children, so retain the attempted cardinality here.
    if (!ok) stats.calls = Math.max(stats.calls ?? 0, calls);
    stats.durationMs += durationMs;
    if (!ok) stats.failures++;
    else stats.resultBytes += serializedDiagnosticBytes(result);
  }

  finish(): {
    timing: {
      totalMs: number;
      admissionMs: number;
      setupMs: number;
      executorWallMs: number;
      catalogMs: number;
      connectorMs: number;
    };
    operations: ExecuteOperationDiagnostics[];
    emitted?: { count: number; bytes: number };
  } {
    const operations = [...this.operations.values()];
    return {
      timing: {
        totalMs: Date.now() - this.started,
        admissionMs: this.admissionMs,
        setupMs: this.setupMs,
        executorWallMs: this.executorWallMs,
        catalogMs: operations.reduce((sum, item) => sum + item.catalogMs, 0),
        connectorMs: operations.reduce(
          (sum, item) => sum + item.connectorMs,
          0,
        ),
      },
      operations,
      ...(this.emitted ? { emitted: this.emitted } : {}),
    };
  }
}

/**
 * One MCP content block a program may emit. The complete set, by design:
 * `resource` and `resource_link` are refused in ethos.md — pointers get
 * followed, and connecta serves no resources for them to point at.
 */
export type EmittedBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

const EMIT_SHAPE_HINT =
  '{ type: "text", text } or { type: "image" | "audio", data (base64), mimeType }';

/**
 * Strict M1 validation: required fields present and string-valued, nothing
 * else — no `annotations`, no `_meta`, no sugar forms. Rejected rather than
 * stripped, because silently deleting fields would deliver something the
 * program did not ask to emit.
 */
function requireEmittedBlock(raw: unknown): EmittedBlock {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `connecta.emit accepts exactly one content block: ${EMIT_SHAPE_HINT}`,
    );
  }
  const block = raw as Record<string, unknown>;
  const fields =
    block.type === "text"
      ? ["type", "text"]
      : block.type === "image" || block.type === "audio"
        ? ["type", "data", "mimeType"]
        : undefined;
  if (!fields) {
    throw new Error(
      `connecta.emit supports content types "text", "image", and "audio"; got ${JSON.stringify(block.type)}`,
    );
  }
  for (const field of fields) {
    if (typeof block[field] !== "string") {
      throw new Error(
        `connecta.emit block field "${field}" must be a string: ${EMIT_SHAPE_HINT}`,
      );
    }
  }
  const extra = Object.keys(block).filter((key) => !fields.includes(key));
  if (extra.length > 0) {
    throw new Error(
      `connecta.emit block carries unsupported field(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}; a "${String(block.type)}" block is exactly { ${fields.join(", ")} }`,
    );
  }
  return raw as EmittedBlock;
}

/**
 * Request-local collection for `connecta.emit`. Budgets fail loudly at the
 * crossing call — the block is not partially accepted and prior blocks are
 * unaffected — so a program learns it is over budget while it can still
 * choose differently (M5). Accepted blocks never ride `ExecuteResult`; the
 * handler that owns this collector appends them to the final tool result.
 */
export class EmitCollector {
  readonly blocks: EmittedBlock[] = [];
  bytes = 0;
  constructor(
    private readonly maxBytes: number,
    private readonly maxBlocks: number,
    private readonly diagnostics?: ExecuteDiagnostics,
  ) {}

  accept(raw: unknown): void {
    const block = requireEmittedBlock(raw);
    if (this.blocks.length >= this.maxBlocks) {
      throw new Error(
        `connecta.emit block-count budget exceeded: ${this.maxBlocks} block(s) maximum, 0 remaining`,
      );
    }
    const size = diagnosticsEncoder.encode(JSON.stringify(block)).byteLength;
    if (this.bytes + size > this.maxBytes) {
      throw new Error(
        `connecta.emit byte budget exceeded: block is ${size} serialized bytes with ${this.maxBytes - this.bytes} of ${this.maxBytes} remaining`,
      );
    }
    this.blocks.push(block);
    this.bytes += size;
    this.diagnostics?.recordEmitted(this.blocks.length, this.bytes);
  }
}

/** A configured emit budget must be a finite number >= 1; anything else falls back. */
function resolveEmitBudget(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

function serializedDiagnosticBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined
      ? 0
      : diagnosticsEncoder.encode(text).byteLength;
  } catch {
    // The executor's normal result guard owns the error. Diagnostics must
    // never turn measurement into a second failure path.
    return 0;
  }
}

// deno-fmt-ignore
const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "await",
  "async",
]);

/** Convert a connector/tool name into a valid JS identifier. */
export function sanitizeIdentifier(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(id)) id = `_${id}`;
  if (RESERVED.has(id)) id = `${id}_`;
  return id;
}

const SANDBOX_RESERVED_NAMES = new Set([
  "connecta",
  "console",
  "arguments",
  "result",
  "undefined",
  "setTimeout",
  "Promise",
  "Error",
  "WorkerEntrypoint",
  "CodeExecutor",
  "__invoke",
  "__namespace",
  "__call",
  "__log",
  "__dispatchers",
  "__connectors",
  "__logs",
  "__CODEMODE_BINARY_TAG",
  "__bytesToBase64",
  "__base64ToBytes",
  "__encodeCodemodeValue",
  "__decodeCodemodeValue",
  "__stringifyForCodemode",
  "__parseForCodemode",
]);

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lazyNamespacePrelude(
  connectors: Array<{ id: string; namespace: string }>,
): string {
  const declarations = connectors
    .map(
      ({ id, namespace }) =>
        `globalThis[${JSON.stringify(namespace)}] = __makeConnectaNamespace(${JSON.stringify(id)});`,
    )
    .join("\n");
  return `(() => {
  const __makeConnectaNamespace = (connectorId) => Object.freeze(new Proxy(Object.create(null), {
    get: (_target, toolName) => typeof toolName === "string"
      ? (args) => connecta.__callNamespace(connectorId, toolName, args)
      : undefined
  }));
${declarations}
})();`;
}

/**
 * Expose one fixed host provider plus trusted sandbox setup that creates a
 * lazy proxy global per connector. No connector catalog is touched until code
 * calls that namespace or explicitly asks search/describe.
 */
export async function buildSandboxProviders(
  registry: RegistryView,
  baseUrl: string,
  logger: Logger,
  activity?: ActivityRequestContext,
  limits: {
    signal?: AbortSignal;
    maxHostCalls?: number;
    hostCallTimeoutMs?: number;
    discoveryConcurrency?: number;
    /** Per-connector deadline for in-program catalog probes. Default 30_000. */
    probeTimeoutMs?: number;
    onInvocationFailure?: (failure: InvocationFailure) => void;
    diagnostics?: ExecuteDiagnostics;
    /**
     * Where `connecta.emit` collects. The handler that will deliver the
     * blocks owns it; without one, emit fails loudly rather than accept
     * blocks nobody will ever return.
     */
    emitCollector?: EmitCollector;
  } = {},
): Promise<ExecutorProvider[]> {
  // All host calls made by one execute_code invocation share a downstream
  // connection, while a later invocation receives a fresh request scope.
  const requestScope = {};
  const catalog = new CatalogService(registry, baseUrl, {
    requestScope,
    // Every describe reaching this catalog came from inside a program, on a
    // code-first and a classic-with-executor deployment alike, so the retry
    // advice names connecta.describe regardless of what this server advertises.
    describeRoute: "connecta.describe",
    // Same reasoning for the discovery route a routing failure hands back: the
    // program that just missed an address cannot call search_tools.
    searchRoute: "connecta.search",
    ...(limits.discoveryConcurrency !== undefined
      ? { concurrency: limits.discoveryConcurrency }
      : {}),
    ...(limits.probeTimeoutMs !== undefined
      ? { probeTimeoutMs: limits.probeTimeoutMs }
      : {}),
  });
  const invocation = new InvocationService(registry, catalog, activity);
  const maxHostCalls = Math.max(
    1,
    Math.trunc(limits.maxHostCalls ?? EXECUTE_MAX_HOST_CALLS),
  );
  const hostCallTimeoutMs = Math.max(
    1,
    Math.trunc(limits.hostCallTimeoutMs ?? EXECUTE_HOST_CALL_TIMEOUT_MS),
  );
  let hostCalls = 0;
  const connectors = registry.listConnectors();
  const namespaces: Array<{ id: string; namespace: string }> = [];
  const namespaceOwners = new Map<string, string>();
  for (const connector of connectors) {
    const namespace = sanitizeIdentifier(connector.id);
    const owner = namespaceOwners.get(namespace);
    const problem = SANDBOX_RESERVED_NAMES.has(namespace)
      ? `Connector "${connector.id}" sanitizes to reserved execute_code namespace "${namespace}". Rename or exclude the connector before using execute_code.`
      : owner
        ? `Connector ids "${owner}" and "${connector.id}" both sanitize to execute_code namespace "${namespace}". Rename or exclude one connector before using execute_code.`
        : undefined;
    if (problem) {
      logger.warn(`[connecta] execute_code: ${problem}`);
      throw new Error(problem);
    }
    namespaceOwners.set(namespace, connector.id);
    namespaces.push({ id: connector.id, namespace });
  }

  const invocationContext = () => ({
    source: "execute_code" as const,
    timeoutMs: hostCallTimeoutMs,
    ...(limits.signal !== undefined ? { requestSignal: limits.signal } : {}),
    unwrapResult: true,
    beforeDispatch: () => {
      hostCalls++;
      if (hostCalls > maxHostCalls) {
        throw new Error(
          `execute_code host-call budget exceeded (${maxHostCalls} calls maximum)`,
        );
      }
    },
  });
  /**
   * A discovery bound is as typed a failure as a tool call is, and a program
   * that lets one escape deserves the same envelope: register it on the same
   * request-local channel so an unhandled `invalid_args`/`result_too_large`
   * reaches the model with its code instead of as prose. The guest still sees
   * only the message — that is the bridge's limit, not a policy.
   */
  const typedDiscovery = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (err) {
      if (err instanceof DiscoveryPolicyError) {
        limits.onInvocationFailure?.(
          new InvocationFailure({
            code: err.code,
            message: err.message,
            retryable: false,
          }),
        );
      }
      throw err;
    }
  };
  const callAddress = async (
    address: unknown,
    args: unknown,
    diagnosticOperation: "call" | "batch" = "call",
  ) => {
    const outcome = await invocation.invoke(
      String(address),
      args ?? {},
      invocationContext(),
    );
    limits.diagnostics?.recordCall(diagnosticOperation, outcome);
    if (!outcome.ok) {
      const failure = new InvocationFailure(outcome.error);
      limits.onInvocationFailure?.(failure);
      throw failure;
    }
    return outcome.value;
  };
  const callNamespace = async (
    connectorId: unknown,
    toolAlias: unknown,
    args: unknown,
  ) => {
    const outcome = await invocation.invokeToolAlias(
      String(connectorId),
      String(toolAlias),
      sanitizeIdentifier,
      args ?? {},
      invocationContext(),
    );
    limits.diagnostics?.recordCall("call", outcome);
    if (!outcome.ok) {
      const failure = new InvocationFailure(outcome.error);
      limits.onInvocationFailure?.(failure);
      throw failure;
    }
    return outcome.value;
  };

  return [
    {
      name: "connecta",
      prelude: lazyNamespacePrelude(namespaces),
      fns: {
        __callNamespace: callNamespace,
        call: (address: unknown, args: unknown) =>
          callAddress(address, args),
        // Emission is a provider function, never an ExecuteResult field —
        // that is what keeps the Executor contract untouched and parity
        // structural (M8). It spends no host-call budget (M7); its own
        // budgets live in the collector.
        emit: async (block: unknown) => {
          if (!limits.emitCollector) {
            throw new Error(
              "connecta.emit is unavailable: no emission collector was configured for this execution",
            );
          }
          limits.emitCollector.accept(block);
        },
        batch: async (calls: unknown) => {
          const started = Date.now();
          const callCount = Array.isArray(calls) ? calls.length : 0;
          try {
            if (!Array.isArray(calls)) throw new Error("calls must be an array");
            if (calls.length > EXECUTE_MAX_BATCH_CALLS) {
              throw new Error(
                `connecta.batch accepts at most ${EXECUTE_MAX_BATCH_CALLS} calls`,
              );
            }
            const result = await Promise.all(
              calls.map(async (call) => {
                const item = call as { address?: unknown; args?: unknown };
                try {
                  return {
                    address: String(item.address),
                    ok: true,
                    data: await callAddress(
                      item.address,
                      item.args,
                      "batch",
                    ),
                  };
                } catch (err) {
                  // Same failure shape batch_call reports: the message a program
                  // can log, plus the typed details it must classify by. A
                  // thrown host error crosses the sandbox bridge as a bare
                  // message string in every executor, so this is the one place a
                  // program can tell a policy refusal from a transient failure.
                  const details =
                    err instanceof InvocationFailure
                      ? err.details
                      : classifyCallError(err, "batch_call_failed");
                  return {
                    address: String(item.address),
                    ok: false,
                    error: details.message,
                    errorDetails: details,
                  };
                }
              }),
            );
            limits.diagnostics?.recordBatch(
              Date.now() - started,
              true,
              callCount,
              result,
            );
            return result;
          } catch (err) {
            limits.diagnostics?.recordBatch(
              Date.now() - started,
              false,
              callCount,
            );
            throw err;
          }
        },
        search: async (raw: unknown) => {
          const started = Date.now();
          try {
            const result = await typedDiscovery(async () => {
              const args = (raw ?? {}) as {
                query?: string;
                connector?: string;
                safety?: "readOnly" | "approvalRequired" | "all";
                limit?: number;
                offset?: number;
                fullDescriptions?: boolean;
                includeSchemas?: "compact" | "json";
                includeSchemaKeys?: boolean;
              };
              const result = flatSearchResult(
                await catalog.search({
                  ...args,
                  // Key metadata rides along with schemas by default, since that
                  // is the whole point of it in code mode. It stays opt-out
                  // because it counts against the same discovery-byte ceiling.
                  includeSchemaKeys: args.includeSchemaKeys !== false,
                }),
              );
              boundedDiscoveryText(
                result,
                "Request a smaller limit, omit fullDescriptions, use compact schemas, or pass includeSchemaKeys: false.",
              );
              return result;
            });
            limits.diagnostics?.recordCatalog(
              "search",
              Date.now() - started,
              true,
              result,
            );
            return result;
          } catch (err) {
            limits.diagnostics?.recordCatalog(
              "search",
              Date.now() - started,
              false,
            );
            throw err;
          }
        },
        describe: async (raw: unknown) => {
          const started = Date.now();
          try {
            const result = await typedDiscovery(async () => {
              const args = (raw ?? {}) as {
                address?: unknown;
                addresses?: unknown;
                format?: "compact" | "json";
                fullDescriptions?: boolean;
              };
              const result = { tools: await catalog.describe(args) };
              boundedDiscoveryText(
                result,
                'Split the address list or use format: "compact".',
              );
              return result;
            });
            limits.diagnostics?.recordCatalog(
              "describe",
              Date.now() - started,
              true,
              result,
            );
            return result;
          } catch (err) {
            limits.diagnostics?.recordCatalog(
              "describe",
              Date.now() - started,
              false,
            );
            throw err;
          }
        },
      },
    },
  ];
}

/** The execute_code handler. Exported for direct testing. */
export function createExecuteTool(
  registry: RegistryView,
  baseUrl: string,
  executor: Executor,
  logger: Logger,
  activity?: ActivityRequestContext,
  config: {
    discoveryConcurrency?: number;
    probeTimeoutMs?: number;
    maxEmittedBytes?: number;
    maxEmittedBlocks?: number;
  } = {},
) {
  return async (
    { code, diagnostics: diagnosticsRequested }: {
      code: string;
      diagnostics?: boolean;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult> => {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else {
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
    }
    let lease;
    let outcome;
    const diagnostics = diagnosticsRequested ? new ExecuteDiagnostics() : undefined;
    const emitted = new EmitCollector(
      resolveEmitBudget(config.maxEmittedBytes, EXECUTE_MAX_EMITTED_BYTES),
      resolveEmitBudget(config.maxEmittedBlocks, EXECUTE_MAX_EMITTED_BLOCKS),
      diagnostics,
    );
    const invocationFailures: InvocationFailure[] = [];
    try {
      // Admission comes before provider construction: queued calls retain no
      // catalogs, request scopes, or one-closure-per-tool provider arrays.
      if (isAdmittingExecutor(executor)) {
        const admissionStarted = Date.now();
        try {
          lease = await executor.acquire({ signal: controller.signal });
        } finally {
          if (diagnostics) {
            diagnostics.admissionMs = Date.now() - admissionStarted;
          }
        }
        if ((lease.waitMs ?? 0) > 0) {
          logger.debug("[connecta] execute_code admitted after queue wait", {
            waitMs: lease.waitMs,
          });
        }
      }
      const setupStarted = Date.now();
      let providers: ExecutorProvider[];
      try {
        providers = await buildSandboxProviders(
          registry,
          baseUrl,
          logger,
          activity,
          {
            signal: controller.signal,
            onInvocationFailure: (failure) => {
              invocationFailures.push(failure);
            },
            emitCollector: emitted,
            ...(diagnostics ? { diagnostics } : {}),
            ...(config.discoveryConcurrency !== undefined
              ? { discoveryConcurrency: config.discoveryConcurrency }
              : {}),
            ...(config.probeTimeoutMs !== undefined
              ? { probeTimeoutMs: config.probeTimeoutMs }
              : {}),
          },
        );
      } finally {
        if (diagnostics) diagnostics.setupMs = Date.now() - setupStarted;
      }
      if (controller.signal.aborted) {
        throw new ExecutorAdmissionError(
          "executor_cancelled",
          "Execution was cancelled during sandbox setup.",
        );
      }
      const executorStarted = Date.now();
      try {
        outcome = lease
          ? await lease.execute(code, providers)
          : await executor.execute(code, providers);
      } finally {
        if (diagnostics) {
          diagnostics.executorWallMs = Date.now() - executorStarted;
        }
      }
    } catch (err) {
      if (err instanceof ExecutorAdmissionError) {
        if (err.code === "executor_overloaded") {
          logger.warn("[connecta] execute_code admission rejected", {
            code: err.code,
            retryAfterMs: err.retryAfterMs,
          });
        }
        const result = jsonResult({
          error: {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
            ...(err.retryAfterMs !== undefined
              ? { retryAfterMs: err.retryAfterMs }
              : {}),
          },
          ...(diagnostics ? { diagnostics: diagnostics.finish() } : {}),
        });
        result.isError = true;
        return result;
      }
      if (diagnostics) {
        const result = jsonResult({
          error: {
            code: "executor_failed",
            message: `Executor failed: ${msg(err)}`,
            retryable: false,
          },
          ...discardedEmits(emitted),
          diagnostics: diagnostics.finish(),
        });
        result.isError = true;
        return result;
      }
      return errorResult(
        `Executor failed: ${msg(err)}${discardedEmitsText(emitted)}`,
      );
    } finally {
      // A sandbox timeout or early return must also release any outstanding
      // host waits and signal cooperative connectors to stop their work.
      controller.abort();
      lease?.release();
      options.signal?.removeEventListener("abort", forwardAbort);
    }
    const logs =
      outcome.logs && outcome.logs.length > 0
        ? truncateExecuteText(
            outcome.logs.join("\n"),
            MAX_EXECUTE_LOG_CHARS,
          )
        : undefined;
    if (outcome.error) {
      // Executor bridges necessarily reduce thrown host errors to strings.
      // Match that terminal string back to the request-local typed failure so
      // an unhandled tool failure keeps the same structured contract as
      // call_tool and batch_call. Failures caught by model code never reach
      // outcome.error and therefore remain under that code's control.
      //
      // An error the program let through unchanged matches exactly, and an
      // exact match always wins: a program that wrapped one failure's message
      // around another's must not have the wrong type attached. Containment is
      // the fallback, so a wrapped message still reports its underlying type
      // rather than losing it to prose.
      let invocationFailure: InvocationFailure | undefined;
      for (const match of [
        (candidate: InvocationFailure) => outcome.error === candidate.message,
        (candidate: InvocationFailure) =>
          outcome.error?.includes(candidate.message) === true,
      ]) {
        for (let i = invocationFailures.length - 1; i >= 0; i--) {
          const candidate = invocationFailures[i];
          if (candidate && match(candidate)) {
            invocationFailure = candidate;
            break;
          }
        }
        if (invocationFailure) break;
      }
      if (invocationFailure) {
        const result = jsonResult({
          error: invocationFailure.details,
          ...(logs ? { logs } : {}),
          ...discardedEmits(emitted),
          ...(diagnostics ? { diagnostics: diagnostics.finish() } : {}),
        });
        result.isError = true;
        return result;
      }
      const message = `Error: ${outcome.error}`;
      if (diagnostics) {
        const result = jsonResult({
          error: {
            code: "executor_failed",
            message,
            retryable: false,
          },
          ...(logs ? { logs } : {}),
          ...discardedEmits(emitted),
          diagnostics: diagnostics.finish(),
        });
        result.isError = true;
        return result;
      }
      return errorResult(
        `${message}${logs ? `\n\nLogs:\n${logs}` : ""}${discardedEmitsText(emitted)}`,
      );
    }
    // A result crossing back as a host BigInt (or otherwise unserializable
    // value) makes JSON.stringify throw — keep that inside the structured
    // error path so captured logs survive instead of a raw SDK 500.
    let result: unknown;
    try {
      result = guardExecuteResultValue(outcome.result);
    } catch (err) {
      const message = `Error: result is not JSON-serializable: ${msg(err)}`;
      if (diagnostics) {
        const response = jsonResult({
          error: {
            code: "executor_failed",
            message,
            retryable: false,
          },
          ...(logs ? { logs } : {}),
          ...discardedEmits(emitted),
          diagnostics: diagnostics.finish(),
        });
        response.isError = true;
        return response;
      }
      return errorResult(
        `${message}${logs ? `\n\nLogs:\n${logs}` : ""}${discardedEmitsText(emitted)}`,
      );
    }
    const response = jsonResult({
      result,
      ...(emitted.blocks.length > 0 ? { emitted: emitted.blocks.length } : {}),
      ...(logs ? { logs } : {}),
      ...(diagnostics ? { diagnostics: diagnostics.finish() } : {}),
    });
    if (emitted.blocks.length > 0) {
      // Emitted image/audio blocks are valid MCP content that ToolResult's
      // text-only typing does not model — the same acknowledged gap
      // guardContent lives with for downstream block passthrough.
      response.content.push(
        ...(emitted.blocks as unknown as typeof response.content),
      );
    }
    return response;
  };
}

/** M4: a failed program delivers no blocks, but the discard is visible. */
function discardedEmits(emitted: EmitCollector): {
  emittedDiscarded?: number;
} {
  return emitted.blocks.length > 0
    ? { emittedDiscarded: emitted.blocks.length }
    : {};
}

/** The same visibility for the plain-text error paths. */
function discardedEmitsText(emitted: EmitCollector): string {
  return emitted.blocks.length > 0
    ? `\n\nemittedDiscarded: ${emitted.blocks.length}`
    : "";
}

/**
 * How the tool opens, and where a program's argument schemas come from. Both
 * differ by surface: on the classic surface `execute_code` is the tool of last
 * resort and its neighbours (`batch_call`, `describe_tools`) own the simpler
 * jobs, while on the code-first surface those tools are gone and the program is
 * where all of that work happens. Everything after these two phrases is
 * identical, so the shared body below has one source of truth.
 */
const EXECUTE_ROUTING = {
  classic:
    "Use for dependent multi-step calls, loops, joins, branching, or reducing large results in a sandbox. Never use execute_code for search-only discovery or one downstream call: use search_tools, then call_tool when needed. For 2–10 independent calls use batch_call.",
  "code-first":
    "The primary surface. Use for discovery beyond one lookup, two or more calls, dependent steps, loops, joins, branching, or reducing large results before they reach the model — connecta.search and connecta.describe browse and expand catalogs in the run, and connecta.batch replaces a separate batch tool. The exception is a single call at an address already in hand: search_tools then one call_tool is cheaper than a program.",
} as const;

const EXECUTE_SCHEMA_SOURCE = {
  classic: "describe_tools",
  "code-first": "connecta.describe",
} as const;

const executeDescription = (
  surface: ConnectaSurface,
  emitBudgets: { maxBytes: number; maxBlocks: number },
) => `${EXECUTE_ROUTING[surface]} Only tools explicitly annotated readOnlyHint: true are available. Each run is limited to ${EXECUTE_MAX_HOST_CALLS} host calls; connecta.batch accepts at most ${EXECUTE_MAX_BATCH_CALLS}; each host call has a ${EXECUTE_HOST_CALL_TIMEOUT_MS / 1_000}-second deadline.

Write an async arrow function. It runs with NO network, filesystem, timers, or imports — the only capabilities are:
- One global per connector: every address <connectorId>.<toolName> from search_tools is callable as <connectorId>.<toolName>(args) with a single args object matching the schema from ${EXECUTE_SCHEMA_SOURCE[surface]}. Names are sanitized to JS identifiers: characters outside [A-Za-z0-9_$] become "_" (e.g. my-service.get.thing → my_service.get_thing), leading digits get "_" prefixed, reserved words get "_" appended.
- connecta.call(address, args) and connecta.batch(calls) — call raw addresses.
- connecta.search(args), connecta.describe({ address: "<connectorId>.<toolName>" }), and connecta.describe({ addresses: [...] }) — load and inspect request-local catalogs on demand. Use safety: "readOnly" to avoid advertising calls this sandbox cannot execute; the filter changes results, not authority. Matches carrying schemas also list inputKeys, requiredInputKeys, and outputKeys — the same names the schema shows, ready to check against before building args. They are absent when a schema is not a plain object shape, so read the schema itself rather than assuming a missing list means no fields.
- connecta.emit(block) — deliver rich MCP content alongside the JSON return: exactly { type: "text", text } or { type: "image" | "audio", data (base64), mimeType }, no other fields. Blocks are appended to the result on success only, spend no host calls, and are budgeted per run (${emitBudgets.maxBlocks} blocks, ${emitBudgets.maxBytes} serialized bytes); an over-budget or invalid emit throws catchably and accepts nothing.
- console.log(...) — captured and returned alongside the result.

Tool calls return plain values (MCP text content is JSON-parsed when possible) and throw on downstream errors — use try/catch to handle them. A thrown error carries only a message; connecta.batch reports each call as { address, ok: true, data } or { address, ok: false, error, errorDetails: { code, retryable } }, so use it when the program must tell a policy refusal from a transient failure. Never retry a failure whose retryable is false, and never retry a rate_limited one immediately — the sandbox has no timers. Return a JSON-serializable value; large results are truncated, so reduce data in code instead of returning raw payloads.

Plain JavaScript only — no TypeScript syntax. For unknown-address dependent work, use one execute_code call: search inside it, read the compact schemas, and continue to the dependent calls; do not return search results for a second execute_code call. Compact schemas are TypeScript-like strings, not JSON Schema objects: write the property names they display, never a positional guess or an invented alias.
Dependent example (only when the second call requires a value returned by the first): async () => { const { tools } = await connecta.search({ query: "pipeline run job logs", safety: "readOnly", includeSchemas: "compact" }); const pick = (suffix) => { const match = tools.find((tool) => tool.address.endsWith(suffix)); if (!match) throw new Error("no tool matching " + suffix); return match.address; }; const run = await connecta.call(pick(".get_run"), { runId: 42 }); const logs = await connecta.call(pick(".get_job_logs"), { jobId: run.failedJobId }); return [run, logs]; }`;

/** Register the execute_code meta-tool. Only called when an executor is configured. */
export function registerExecuteTool(
  server: McpServer,
  registry: RegistryView,
  ctx: {
    baseUrl: string;
    executor: Executor;
    logger: Logger;
    activity?: ActivityRequestContext;
    requestSignal?: AbortSignal;
    discoveryConcurrency?: number;
    /**
     * The deployment's configured per-connector probe deadline. Programs probe
     * the same downstream catalogs the top-level tools do, so an operator who
     * tightened `discovery.probeTimeoutMs` gets it honored inside the sandbox
     * too rather than silently falling back to the 30s default.
     */
    probeTimeoutMs?: number;
    /** Aggregate serialized-byte budget for connecta.emit. Default 4_000_000. */
    maxEmittedBytes?: number;
    /** Block-count budget for connecta.emit. Default 32. */
    maxEmittedBlocks?: number;
    /** The advertised surface, which decides this tool's routing copy. */
    surface?: ConnectaSurface;
  },
): void {
  // Resolved once so the description and the collector cannot disagree about
  // the budgets this deployment actually enforces.
  const emitBudgets = {
    maxBytes: resolveEmitBudget(ctx.maxEmittedBytes, EXECUTE_MAX_EMITTED_BYTES),
    maxBlocks: resolveEmitBudget(
      ctx.maxEmittedBlocks,
      EXECUTE_MAX_EMITTED_BLOCKS,
    ),
  };
  const handler = createExecuteTool(
    registry,
    ctx.baseUrl,
    ctx.executor,
    ctx.logger,
    ctx.activity,
    {
      ...(ctx.discoveryConcurrency !== undefined
        ? { discoveryConcurrency: ctx.discoveryConcurrency }
        : {}),
      ...(ctx.probeTimeoutMs !== undefined
        ? { probeTimeoutMs: ctx.probeTimeoutMs }
        : {}),
      maxEmittedBytes: emitBudgets.maxBytes,
      maxEmittedBlocks: emitBudgets.maxBlocks,
    },
  );
  server.registerTool(
    "execute_code",
    {
      description: executeDescription(ctx.surface ?? "classic", emitBudgets),
      inputSchema: z.object({
        code: z
          .string()
          .describe("A JavaScript async arrow function to execute."),
        diagnostics: z
          .boolean()
          .optional()
          .describe(
            "Add request-local, payload-free timing and result-size summaries.",
          ),
      }),
      // The sandbox exposes only tools that are explicitly read-only, and the
      // executor grants no network, filesystem, env, or timer capabilities.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const controller = new AbortController();
      const signals = [extra.mcpReq.signal, ctx.requestSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      const forwarders = signals.map((signal) => {
        const forward = () => controller.abort(signal.reason);
        if (signal.aborted) forward();
        else signal.addEventListener("abort", forward, { once: true });
        return { signal, forward };
      });
      try {
        return await handler(args as { code: string; diagnostics?: boolean }, {
          signal: controller.signal,
        });
      } finally {
        for (const { signal, forward } of forwarders) {
          signal.removeEventListener("abort", forward);
        }
      }
    },
  );
}
