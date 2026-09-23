import type { McpServer } from "@modelcontextprotocol/server";
import { Duration, Effect } from "effect";
import { z } from "zod";
import type { ActivityRequestContext } from "./activity.js";
import {
  boundedDiscoveryText,
  CatalogService,
  DiscoveryPolicyError,
  flatSearchResult,
} from "./catalog-service.js";
import type { DeferredWork } from "./connector-scope.js";
import { errorResult, jsonResult, type ToolResult } from "./meta-tools.js";
import {
  guardExecuteResultValue,
  MAX_EXECUTE_LOG_CHARS,
  truncateExecuteText,
} from "./executor-result.js";
import {
  ExecutorAdmissionError,
  ExecutorExecutionError,
  isAdmittingExecutor,
} from "./executor-admission.js";
import { boundedEchoText, msg, type CallErrorDetails } from "./errors.js";
import {
  InvocationFailure,
  InvocationService,
} from "./invocation.js";
import type { RegistryView } from "./registry.js";
import { fromSignal, runEdge } from "./runtime/run.js";
import {
  connectorGuide,
  connectorGuideRequired,
  connectorSkillName,
  hasConnectorGuides,
} from "./skills.js";
import type {
  ExecuteResult,
  Executor,
  ExecutorProvider,
  Logger,
} from "./types.js";

/** Keep one model-written program from amplifying into an unbounded fan-out. */
const EXECUTE_MAX_HOST_CALLS = 20;
const EXECUTE_HOST_CALL_TIMEOUT_MS = 15_000;
/**
 * The outer ceiling on one execution. It sits above both executors' own
 * deadlines (QuickJS 30s, the Dynamic Worker 60s), so a healthy executor
 * always reports its own timeout first and this fires only for one that
 * never settles at all.
 */
const EXECUTE_WATCHDOG_MS = 120_000;
/** Complete entries plus an exact omission count, all inside this byte cap. */
export const CONNECTOR_INVENTORY_MAX_BYTES = 256;
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

type ExecuteDiagnosticOperation = "search" | "describe" | "call";

interface ExecuteOperationDiagnostics {
  operation: ExecuteDiagnosticOperation;
  count: number;
  failures: number;
  durationMs: number;
  resultBytes: number;
  catalogMs: number;
  connectorMs: number;
}

class ExecuteDiagnostics {
  private readonly started = Date.now();
  private readonly operations = new Map<
    ExecuteDiagnosticOperation,
    ExecuteOperationDiagnostics
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
    outcome: {
      ok: boolean;
      durationMs: number;
      timing: { catalogMs: number; connectorMs: number };
      value?: unknown;
    },
  ): void {
    const stats = this.stats("call");
    stats.count++;
    if (outcome.ok) stats.resultBytes += serializedDiagnosticBytes(outcome.value);
    stats.failures += outcome.ok ? 0 : 1;
    stats.durationMs += outcome.durationMs;
    stats.catalogMs += outcome.timing.catalogMs;
    stats.connectorMs += outcome.timing.connectorMs;
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
    throw guestFailure(
      "invalid_args",
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
    throw guestFailure(
      "invalid_args",
      `connecta.emit supports content types "text", "image", and "audio"; got ${JSON.stringify(block.type)}`,
    );
  }
  for (const field of fields) {
    if (typeof block[field] !== "string") {
      throw guestFailure(
        "invalid_args",
        `connecta.emit block field "${field}" must be a string: ${EMIT_SHAPE_HINT}`,
      );
    }
  }
  const extra = Object.keys(block).filter((key) => !fields.includes(key));
  if (extra.length > 0) {
    throw guestFailure(
      "invalid_args",
      `connecta.emit block carries unsupported field(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}; a "${String(block.type)}" block is exactly { ${fields.join(", ")} }`,
    );
  }
  return raw as EmittedBlock;
}

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
      // M5: distinguish exhausted block slots from the remaining byte budget.
      throw guestFailure(
        "budget_exceeded",
        `connecta.emit block-count budget exceeded: ${this.maxBlocks} block(s) maximum, 0 blocks remaining; ${this.maxBytes - this.bytes} of ${this.maxBytes} serialized bytes remaining`,
      );
    }
    const size = diagnosticsEncoder.encode(JSON.stringify(block)).byteLength;
    if (this.bytes + size > this.maxBytes) {
      throw guestFailure(
        "budget_exceeded",
        `connecta.emit byte budget exceeded: block is ${size} serialized bytes with ${this.maxBytes - this.bytes} of ${this.maxBytes} remaining`,
      );
    }
    this.blocks.push(block);
    this.bytes += size;
    this.diagnostics?.recordEmitted(this.blocks.length, this.bytes);
  }

}

/** A positive whole-number budget, or the default when the value is unusable. */
function resolveBudget(
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

function guestFailure(
  code: string,
  message: string,
  retryable = false,
): InvocationFailure {
  return new InvocationFailure({ code, message, retryable });
}

const GUEST_FAILURE_FRAME = "\u001econnecta-error:";
const guestFailureFrames = new WeakMap<InvocationFailure, string>();

/** Per-execution secret: guest prose cannot collide with this host frame. */
function guestFailureSecret(): string {
  const words = new Uint32Array(4);
  crypto.getRandomValues(words);
  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * E1/X11: bound the serialized frame, including JSON escapes, before transport.
 * Keep optional recovery whole: clipping an address or echoed args could turn
 * recovery into a different call. Oversized metadata is omitted instead.
 */
function boundedGuestFailure(failure: InvocationFailure): InvocationFailure {
  const boundText = (text: string, maxChars: number): string => {
    if (JSON.stringify(text).length <= maxChars) return text;
    let low = 0;
    let high = Math.min(text.length, maxChars);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (JSON.stringify(`${text.slice(0, mid)}…`).length <= maxChars) low = mid;
      else high = mid - 1;
    }
    // Do not manufacture a lone surrogate when clipping a Unicode message.
    if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
    return `${text.slice(0, low)}…`;
  };
  let details: CallErrorDetails = {
    ...failure.details,
    code: boundText(failure.details.code, 128),
    message: boundText(failure.details.message, 2_000),
  };
  // 3,700 plus the prefix and 32-character secret stays below QuickJS's
  // 4,000-character error bound, with room for bridge-added context.
  if (JSON.stringify(details).length > 3_700) {
    details = {
      code: details.code,
      message: details.message,
      retryable: details.retryable,
      ...(details.retryAfterMs !== undefined
        ? { retryAfterMs: details.retryAfterMs }
        : {}),
    };
  }
  return new InvocationFailure(details);
}

function framedGuestFailure(
  secret: string,
  failure: InvocationFailure,
): InvocationFailure {
  const framed = new InvocationFailure(failure.details);
  framed.message =
    `${GUEST_FAILURE_FRAME}${secret}:${JSON.stringify(failure.details)}`;
  guestFailureFrames.set(failure, framed.message);
  return framed;
}

/** Rebuild host failures as guest errors without exposing the private frame. */
function guestErrorPrelude(failureSecret: string): string {
  return `((failurePrefix) => {
  const NativeError = globalThis.Error;
  const startsWith = Function.prototype.call.bind(String.prototype.startsWith);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const parse = JSON.parse;
  const freeze = Object.freeze;
  const defineProperties = Object.defineProperties;
  const construct = Reflect.construct;
  function ConnectaError(message, options) {
    let details;
    if (typeof message === "string" && startsWith(message, failurePrefix)) {
      try { details = parse(slice(message, failurePrefix.length)); }
      catch { message = "Invalid host failure frame."; }
    }
    const error = construct(
      NativeError,
      options === undefined ? [details ? details.message : message] : [details ? details.message : message, options],
      new.target || NativeError
    );
    if (details) {
      freeze(details);
      defineProperties(error, {
        code: { value: details.code, enumerable: true },
        retryable: { value: details.retryable, enumerable: true },
        details: { value: details, enumerable: true }
      });
    }
    return error;
  }
  ConnectaError.prototype = NativeError.prototype;
  Object.setPrototypeOf(ConnectaError, NativeError);
  Object.defineProperty(globalThis, "Error", {
    value: ConnectaError,
    writable: false,
    configurable: false
  });
})(${JSON.stringify(`${GUEST_FAILURE_FRAME}${failureSecret}:`)});`;
}

/**
 * Expose one host provider and typed guest errors. Catalogs load only when
 * the program calls a tool or asks search/describe.
 */
export async function buildSandboxProviders(
  registry: RegistryView,
  baseUrl: string,
  _logger: Logger,
  activity?: ActivityRequestContext,
  limits: {
    signal?: AbortSignal | undefined;
    maxHostCalls?: number | undefined;
    hostCallTimeoutMs?: number | undefined;
    discoveryConcurrency?: number | undefined;
    /** Per-connector deadline for in-program catalog probes. Default 30_000. */
    probeTimeoutMs?: number | undefined;
    onInvocationFailure?: ((failure: InvocationFailure) => void) | undefined;
    diagnostics?: ExecuteDiagnostics | undefined;
    /**
     * Where `connecta.emit` collects. The handler that will deliver the
     * blocks owns it; without one, emit fails loudly rather than accept
     * blocks nobody will ever return.
     */
    emitCollector?: EmitCollector | undefined;
    /** Runtime-owned tail for stale catalog refreshes. */
    defer?: DeferredWork | undefined;
  } = {},
): Promise<ExecutorProvider[]> {
  // All host calls made by one execute_code invocation share a downstream
  // connection, while a later invocation receives a fresh request scope.
  const requestScope = {};
  const catalog = new CatalogService(registry, baseUrl, {
    requestScope,
    // A program that just missed an address cannot call search_tools.
    searchRoute: "connecta.search",
    concurrency: limits.discoveryConcurrency,
    probeTimeoutMs: limits.probeTimeoutMs,
    defer: limits.defer,
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
  const failureSecret = guestFailureSecret();
  let hostCalls = 0;
  // L4/M7: discovery and invocation spend the same budget; emit does not.
  const spendHostCall = () => {
    hostCalls++;
    if (hostCalls > maxHostCalls) {
      throw guestFailure(
        "budget_exceeded",
        `execute_code host-call budget exceeded (${maxHostCalls} calls maximum)`,
      );
    }
  };
  const invocationContext = () => ({
    source: "execute_code" as const,
    timeoutMs: hostCallTimeoutMs,
    ...(limits.signal !== undefined ? { requestSignal: limits.signal } : {}),
    unwrapResult: true,
  });
  /**
   * Discovery policy failures use the same thrown vocabulary as calls and
   * utilities. The transport below reconstructs their code inside the guest.
   */
  const typedDiscovery = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (err) {
      if (err instanceof DiscoveryPolicyError) {
        throw guestFailure(err.code, err.message);
      }
      throw err;
    }
  };
  const timedCatalog = async <T>(
    operation: "search" | "describe",
    fn: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    try {
      spendHostCall();
      const result = await fn();
      limits.diagnostics?.recordCatalog(
        operation,
        Date.now() - started,
        true,
        result,
      );
      return result;
    } catch (err) {
      limits.diagnostics?.recordCatalog(
        operation,
        Date.now() - started,
        false,
      );
      throw err;
    }
  };
  const callAddress = async (address: unknown, args: unknown) => {
    spendHostCall();
    const outcome = await invocation.invoke(String(address), args ?? {}, invocationContext());
    limits.diagnostics?.recordCall(outcome);
    if (!outcome.ok) throw new InvocationFailure(outcome.error);
    return outcome.value;
  };

  const fns: ExecutorProvider["fns"] = {
    call: (address: unknown, args: unknown) =>
      callAddress(address, args),
    // Emission is a provider function, never an ExecuteResult field —
    // that is what keeps the Executor contract untouched and parity
    // structural (M8). It spends no host-call budget (M7); its own
    // budgets live in the collector.
    emit: async (block: unknown) => {
      if (!limits.emitCollector) {
        throw guestFailure(
          "unavailable",
          "connecta.emit is unavailable: no emission collector was configured for this execution",
          true,
        );
      }
      limits.emitCollector.accept(block);
    },
    // Not `async`: a synchronous budget refusal must reject the same promise
    // the transport wrapper awaits, or workerd reports an unhandled rejection.
    search: (raw: unknown) =>
      timedCatalog("search", () =>
        typedDiscovery(async () => {
          const args = (raw ?? {}) as {
            query?: string;
            connector?: string;
            safety?: "readOnly" | "approvalRequired" | "all";
            limit?: number;
            offset?: number;
            fullDescriptions?: boolean;
            includeSchemas?: "compact" | "json" | "typescript";
            includeSchemaKeys?: boolean;
          };
          const result = flatSearchResult(
            await catalog.search({
              ...args,
              includeSchemaKeys: args.includeSchemaKeys !== false,
            }),
          );
          boundedDiscoveryText(
            result,
            "Request a smaller limit, omit fullDescriptions, use compact schemas, or pass includeSchemaKeys: false.",
          );
          return result;
        }),
      ),
    describe: (raw: unknown) =>
      timedCatalog("describe", () =>
        typedDiscovery(async () => {
          const args = (raw ?? {}) as {
            address?: unknown;
            addresses?: unknown;
            format?: "compact" | "json" | "typescript";
            fullDescriptions?: boolean;
          };
          const result = { tools: await catalog.describe(args) };
          boundedDiscoveryText(
            result,
            'Split the address list or use format: "compact".',
          );
          return result;
        }),
      ),
  };
  const transportedFns = Object.fromEntries(
    Object.entries(fns).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          if (err instanceof InvocationFailure) {
            const failure = boundedGuestFailure(err);
            const framed = framedGuestFailure(failureSecret, failure);
            limits.onInvocationFailure?.(failure);
            throw framed;
          }
          throw err;
        }
      },
    ]),
  );
  return [
    {
      name: "connecta",
      prelude: guestErrorPrelude(failureSecret),
      fns: transportedFns,
    },
  ];
}

/**
 * Await an executor without trusting it to settle.
 *
 * An executor's deadline is its own business, and the Dynamic Worker's lives
 * inside the sandbox: a wedged isolate never fires it, so the call never
 * settles, the handler's `finally` never runs, and the admission lease is
 * held for good. Two of those fill the default code pool and every later
 * execute_code queues behind them (executor hit this in production).
 *
 * So the host races the call against the request's signal and a ceiling of
 * its own. Cancellation settles as the same `executor_cancelled` the QuickJS
 * pool reports, unless the executor reports its own first; the ceiling as an
 * untyped executor failure naming the key that sets it. Either way the
 * handler returns and releases the lease, and the abandoned call keeps
 * whatever it was doing: the QuickJS lease release recycles its child, and a
 * Dynamic Worker isolate runs on to its own deadline. The result contract is
 * untouched — this only decides when to stop waiting for one.
 */
function watchExecution(
  run: () => Promise<ExecuteResult>,
  signal: AbortSignal,
  watchdogMs: number,
  logger: Logger,
): Promise<ExecuteResult> {
  return runEdge(
    Effect.raceAllFirst([
      Effect.tryPromise({ try: () => run(), catch: (err) => err }),
      // An executor that honors the signal rejects in the abort event itself,
      // with the logs it captured attached, and that report beats ours by one
      // timer turn. (A 1ms sleep, not 0: Effect.sleep(0) waits a microtask,
      // which the executor's promise chain can still lose to.)
      fromSignal(signal).pipe(
        Effect.catch(() => Effect.sleep(Duration.millis(1))),
        Effect.andThen(
          Effect.fail(
            new ExecutorAdmissionError(
              "executor_cancelled",
              "Execution was cancelled.",
            ),
          ),
        ),
      ),
      Effect.sleep(Duration.millis(watchdogMs)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            logger.warn(
              "[connecta] execute_code executor did not settle; run abandoned",
              { watchdogMs },
            );
            return Effect.fail(
              new Error(
                `sandbox unresponsive: no outcome within the ${watchdogMs}ms ` +
                  "execute.watchdogMs ceiling, so the run was abandoned",
              ),
            );
          }),
        ),
      ),
    ]),
  );
}

/** The execute_code handler. Exported for direct testing. */
export function createExecuteTool(
  registry: RegistryView,
  baseUrl: string,
  executor: Executor,
  logger: Logger,
  activity?: ActivityRequestContext,
  config: {
    discoveryConcurrency?: number | undefined;
    probeTimeoutMs?: number | undefined;
    maxEmittedBytes?: number | undefined;
    maxEmittedBlocks?: number | undefined;
    maxHostCalls?: number | undefined;
    hostCallTimeoutMs?: number | undefined;
    watchdogMs?: number | undefined;
    defer?: DeferredWork | undefined;
  } = {},
) {
  const watchdogMs = resolveBudget(config.watchdogMs, EXECUTE_WATCHDOG_MS);
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
      resolveBudget(config.maxEmittedBytes, EXECUTE_MAX_EMITTED_BYTES),
      resolveBudget(config.maxEmittedBlocks, EXECUTE_MAX_EMITTED_BLOCKS),
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
              if (invocationFailures.length > 64) invocationFailures.shift();
            },
            emitCollector: emitted,
            ...(diagnostics ? { diagnostics } : {}),
            discoveryConcurrency: config.discoveryConcurrency,
            probeTimeoutMs: config.probeTimeoutMs,
            maxHostCalls: config.maxHostCalls,
            hostCallTimeoutMs: config.hostCallTimeoutMs,
            defer: config.defer,
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
        const admitted = lease;
        outcome = await watchExecution(
          () =>
            admitted
              ? admitted.execute(code, providers)
              : executor.execute(code, providers),
          controller.signal,
          watchdogMs,
          logger,
        );
      } finally {
        if (diagnostics) {
          diagnostics.executorWallMs = Date.now() - executorStarted;
        }
      }
    } catch (err) {
      const logs = err !== null && typeof err === "object" && "logs" in err
        ? executeLogs(err.logs)
        : undefined;
      if (err instanceof ExecutorAdmissionError) {
        if (err.code === "executor_overloaded") {
          logger.warn("[connecta] execute_code admission rejected", {
            code: err.code,
            retryAfterMs: err.retryAfterMs,
          });
        }
        return failureResponse(err.message, {
          logs,
          emitted:
            err instanceof ExecutorExecutionError ? emitted : undefined,
          diagnostics,
          code: {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
            ...(err.retryAfterMs !== undefined
              ? { retryAfterMs: err.retryAfterMs }
              : {}),
          },
        });
      }
      return failureResponse(`Executor failed: ${msg(err)}`, {
        logs,
        emitted,
        diagnostics,
        code: "executor_failed",
      });
    } finally {
      // A sandbox timeout or early return must also release any outstanding
      // host waits and signal cooperative connectors to stop their work.
      controller.abort();
      lease?.release();
      options.signal?.removeEventListener("abort", forwardAbort);
    }
    const logs = executeLogs(outcome.logs);
    if (outcome.error !== undefined) {
      // Executor bridges necessarily reduce thrown host errors to strings.
      // Match that terminal string back to the request-local typed failure so
      // an unhandled tool failure keeps the same structured contract as
      // call_tool. Failures caught by model code never reach
      // outcome.error and therefore remain under that code's control.
      //
      // An error the program let through unchanged matches exactly, and an
      // exact match always wins: a program that wrapped one failure's message
      // around another's must not have the wrong type attached. Containment is
      // the fallback, so a wrapped message still reports its underlying type
      // rather than losing it to prose.
      let invocationFailure: InvocationFailure | undefined;
      for (const match of [
        (candidate: InvocationFailure) =>
          outcome.error !== "" &&
          [candidate.message, guestFailureFrames.get(candidate)].includes(
            outcome.error,
          ),
        (candidate: InvocationFailure) =>
          [candidate.message, guestFailureFrames.get(candidate)].some(
            (message) =>
              // E6: empty or tiny prose cannot identify a wrapped failure.
              message !== undefined &&
              message.length >= 8 &&
              outcome.error?.includes(message) === true,
          ),
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
        // E1/X11: return the same bounded details the guest received.
        return failureResponse(invocationFailure.details.message, {
          logs,
          emitted,
          diagnostics,
          code: invocationFailure.details,
        });
      }
      const message = `Error: ${outcome.error || "Execution failed without an error message."}`;
      return failureResponse(message, {
        logs,
        emitted,
        diagnostics,
        code: "executor_failed",
      });
    }
    // A result crossing back as a host BigInt (or otherwise unserializable
    // value) makes JSON.stringify throw — keep that inside the structured
    // error path so captured logs survive instead of a raw SDK 500.
    let result: unknown;
    try {
      result = guardExecuteResultValue(outcome.result);
    } catch (err) {
      const message = `Error: result is not JSON-serializable: ${msg(err)}`;
      return failureResponse(message, {
        logs,
        emitted,
        diagnostics,
        code: "executor_failed",
      });
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

function executeLogs(value: unknown): string | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
    ? truncateExecuteText(value.join("\n"), MAX_EXECUTE_LOG_CHARS)
    : undefined;
}

function failureResponse(
  message: string,
  options: {
    logs?: string | undefined;
    emitted?: EmitCollector | undefined;
    diagnostics?: ExecuteDiagnostics | undefined;
    code: string | CallErrorDetails;
  },
): ToolResult {
  const { logs, emitted, diagnostics, code } = options;
  if (diagnostics || typeof code !== "string") {
    const result = jsonResult({
      error:
        typeof code === "string"
          ? { code, message, retryable: false }
          : code,
      ...(logs ? { logs } : {}),
      ...(emitted ? discardedEmits(emitted) : {}),
      ...(diagnostics ? { diagnostics: diagnostics.finish() } : {}),
    });
    result.isError = true;
    return result;
  }
  return errorResult(
    `${message}${logs ? `\n\nLogs:\n${logs}` : ""}${emitted ? discardedEmitsText(emitted) : ""}`,
  );
}

/**
 * A failed program delivers no blocks and reports how many were discarded.
 */
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

function connectorInventory(
  connectors: ReturnType<RegistryView["listConnectors"]>,
): string {
  const prefix = "Connectors: ";
  if (connectors.length === 0) return `${prefix}none.`;
  const entries = connectors.map((connector) => {
    const address = connector.id;
    const title = connector.title?.replace(/\s+/g, " ").trim();
    const label = title && title !== connector.id
      ? `${address}: ${boundedEchoText(title, 45)}`
      : address;
    if (!connectorGuide(connector)) return label;
    const requirement = connectorGuideRequired(connector)
      ? "required guide"
      : "guide";
    return `${label} (${requirement} ${connectorSkillName(connector.id)})`;
  });
  const shown: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) break;
    const candidate = [...shown, entry].join(", ");
    const omitted = entries.length - index - 1;
    const suffix = omitted > 0 ? `; +${omitted} more.` : ".";
    const serialized = prefix + candidate + suffix;
    if (
      boundedEchoText(serialized, CONNECTOR_INVENTORY_MAX_BYTES) !== serialized
    ) {
      break;
    }
    shown.push(entry);
  }
  const omitted = entries.length - shown.length;
  if (omitted === 0) return `${prefix}${shown.join(", ")}.`;
  return `${prefix}${shown.join(", ")}${shown.length > 0 ? "; " : ""}+${omitted} more.`;
}

const executeDescription = (
  emitBudgets: { maxBytes: number; maxBlocks: number },
  hostLimits: { maxHostCalls: number; hostCallTimeoutMs: number },
  connectorGuides: boolean,
  connectors: ReturnType<RegistryView["listConnectors"]>,
) => `Use the configured services below to answer the task. A known address uses call_tool. Unknown-address and wider read-only work uses one execute_code program for discovery, calls, and reduction. Do not return catalog matches alone. Only readOnlyHint: true tools are available. Limits: ${hostLimits.maxHostCalls} host calls, ${hostLimits.hostCallTimeoutMs / 1_000}s/host call.

${connectorInventory(connectors)}

Read relevant guides using top-level skills, not sandbox code. Write a plain-JavaScript async arrow:
- connecta.search({ connector, query, safety: "readOnly", includeSchemas: "json" }) returns { tools }. Search each operation separately; choose by connectorTitle and schemas. Use schema.required and .properties to build args, never guessed fields. Compact schemas are text.
- connecta.describe({ address }) returns { tools } for unclear schemas.
- connecta.call(address, args) returns the provider value directly.
- Use Promise.all for independent calls, or Promise.allSettled to retain failures. Check status before reading value; rejected calls and missing fields are unknown, never false or zero.
- connecta.emit(block): { type: "text", text } or { type: "image" | "audio", data (base64), mimeType }; success-only, ${emitBudgets.maxBlocks} blocks/${emitBudgets.maxBytes} bytes.
- console.log(...) is captured. Return data for the client to render.

No portable ambient capabilities. Return reduced JSON. If a provider result has an unfamiliar shape, return a small sample and continue in another call; never guess fields or use the whole text as an id. Top-level skills({ name: "usage" }): repair${connectorGuides ? ", guide handling" : ""}; skills({ name: "investigate" }): task planning.`;

/** Register the execute_code meta-tool. Only called when an executor is configured. */
export function registerExecuteTool(
  server: McpServer,
  registry: RegistryView,
  ctx: {
    baseUrl: string;
    executor: Executor;
    logger: Logger;
    activity?: ActivityRequestContext | undefined;
    requestSignal?: AbortSignal | undefined;
    discoveryConcurrency?: number | undefined;
    /**
     * The deployment's configured per-connector probe deadline. Programs probe
     * the same downstream catalogs the top-level tools do, so an operator who
     * tightened `discovery.probeTimeoutMs` gets it honored inside the sandbox
     * too rather than silently falling back to the 30s default.
     */
    probeTimeoutMs?: number | undefined;
    /** Aggregate serialized-byte budget for connecta.emit. Default 4_000_000. */
    maxEmittedBytes?: number | undefined;
    /** Block-count budget for connecta.emit. Default 32. */
    maxEmittedBlocks?: number | undefined;
    /** Host calls one program may make. Default 20. */
    maxHostCalls?: number | undefined;
    /** Deadline per host call in milliseconds. Default 15_000. */
    hostCallTimeoutMs?: number | undefined;
    /** Hard ceiling on one execution, outside the sandbox. Default 120_000. */
    watchdogMs?: number | undefined;
    defer?: DeferredWork | undefined;
  },
): void {
  // Resolved once so the description and the collector cannot disagree about
  // the budgets this deployment actually enforces.
  const emitBudgets = {
    maxBytes: resolveBudget(ctx.maxEmittedBytes, EXECUTE_MAX_EMITTED_BYTES),
    maxBlocks: resolveBudget(
      ctx.maxEmittedBlocks,
      EXECUTE_MAX_EMITTED_BLOCKS,
    ),
  };
  // Same rule for host-call limits: the description advertises exactly what
  // the sandbox enforces, so a raised deadline is visible to the model.
  const hostLimits = {
    maxHostCalls: resolveBudget(ctx.maxHostCalls, EXECUTE_MAX_HOST_CALLS),
    hostCallTimeoutMs: resolveBudget(
      ctx.hostCallTimeoutMs,
      EXECUTE_HOST_CALL_TIMEOUT_MS,
    ),
  };
  const connectors = registry.listConnectors();
  const handler = createExecuteTool(
    registry,
    ctx.baseUrl,
    ctx.executor,
    ctx.logger,
    ctx.activity,
    {
      discoveryConcurrency: ctx.discoveryConcurrency,
      probeTimeoutMs: ctx.probeTimeoutMs,
      maxEmittedBytes: emitBudgets.maxBytes,
      maxEmittedBlocks: emitBudgets.maxBlocks,
      maxHostCalls: hostLimits.maxHostCalls,
      hostCallTimeoutMs: hostLimits.hostCallTimeoutMs,
      watchdogMs: ctx.watchdogMs,
      defer: ctx.defer,
    },
  );
  server.registerTool(
    "execute_code",
    {
      description: executeDescription(
        emitBudgets,
        hostLimits,
        hasConnectorGuides(connectors),
        connectors,
      ),
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            "One complete JavaScript async arrow function that discovers, calls, and returns the reduced answer.",
          ),
        diagnostics: z
          .boolean()
          .optional()
          .describe(
            "Add request-local, payload-free timing and result-size summaries.",
          ),
      }),
      // This hint describes connector calls, all explicitly read-only. The
      // supported executor constructions deny outbound access, filesystem,
      // and deployment config; X5 documents Dynamic runtime modules separately.
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
