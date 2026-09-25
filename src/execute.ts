import type { McpServer } from "@modelcontextprotocol/server";
import { Cause, Deferred, Duration, Effect, Exit, type Scope } from "effect";
import { z } from "zod";
import type { ActivityRequestContext } from "./activity.js";
import { advertisedSchema } from "./advertised-schema.js";
import {
  boundedDiscoveryText,
  CatalogService,
  DiscoveryPolicyError,
  flatSearchResult,
  type ResolvedCatalogTool,
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
  timed,
  type WriteGateDecision,
} from "./invocation.js";
import { normalizeProgramSource } from "./program-source.js";
import type { RegistryView } from "./registry.js";
import {
  DEFAULT_MAX_WRITES,
  ExemptWrites,
  MIN_STORAGE_TIMEOUT_MS,
  RunState,
  writeStateOf,
  type ResumableSettings,
  type RunStop,
} from "./resumable.js";
import { journalKey, type JournalOp, type WriteState } from "./run-journal.js";
import { underAnySignal } from "./timeout.js";
import {
  isApprovalExempt,
  NO_EXEMPTIONS,
  type ApprovalPolicy,
} from "./tool-safety.js";
import { fromSignal, runEdge } from "./runtime/run.js";
import {
  connectorGuide,
  connectorGuideRequired,
  connectorSkillName,
  hasConnectorGuides,
} from "./skills.js";
import type {
  AdmittingExecutor,
  ExecuteResult,
  Executor,
  ExecutorLease,
  ExecutorProvider,
  Logger,
} from "./types.js";

/** Keep one model-written program from amplifying into an unbounded fan-out. */
const EXECUTE_MAX_HOST_CALLS = 20;
const EXECUTE_HOST_CALL_TIMEOUT_MS = 15_000;
/** Above every program in the recorded evals, below the QuickJS IPC ceiling. */
const EXECUTE_MAX_CODE_BYTES = 64 * 1024;
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
 * The clock and randomness a program sees, fixed for one run (P6).
 *
 * Resumable writes replay a paused program from the top against its recorded
 * host calls, and a program that branched on `Date.now()` or `Math.random()`
 * would take a different branch the second time — which replay can only
 * report as divergence. So every run, paused or not, sees one instant and one
 * seeded stream, and nothing about a run changes when it is replayed.
 */
export interface PinnedEnvironment {
  /** Epoch milliseconds every clock read in the run returns. */
  clockMs: number;
  /** Four 32-bit words seeding the run's sfc32 stream. */
  seed: readonly [number, number, number, number];
}

/** A clock read now and a seed drawn from the host's CSPRNG. */
function freshEnvironment(): PinnedEnvironment {
  const words = new Uint32Array(4);
  crypto.getRandomValues(words);
  return {
    clockMs: Date.now(),
    seed: [words[0] ?? 0, words[1] ?? 0, words[2] ?? 0, words[3] ?? 0],
  };
}

/**
 * Trusted guest code installing the pinned clock and stream, evaluated after
 * the error prelude and before the program. Every replacement is locked the
 * way `Error` is — non-writable and non-configurable — so a program can read
 * the pinned values and nothing else.
 *
 * `Date` becomes a wrapper whose argument-free forms (`new Date()`, `Date()`,
 * `Date.now()`) read the pinned instant; with arguments it is the native
 * constructor, and instances are ordinary dates. The native constructor's own
 * `now` and the prototype's `constructor` are pinned too, so the usual ways
 * back to it read the same instant. `Math.random` is sfc32 over the seed:
 * small, fast, and specified in a few lines anyone can check. Where the
 * runtime has them (a Dynamic Worker; QuickJS has neither), `crypto`'s
 * `getRandomValues` and `randomUUID` draw from the same stream and
 * `performance.now()` stays at 0, the run's start. None of that makes
 * `crypto` contract (`P2`): it only keeps a Workers-only program from being
 * the one that cannot replay.
 */
function pinnedEnvironmentPrelude(environment: PinnedEnvironment): string {
  return `((clock, seed) => {
  const NativeDate = globalThis.Date;
  const construct = Reflect.construct;
  const defineProperty = Object.defineProperty;
  const lock = (target, key, value) => defineProperty(target, key, {
    value, writable: false, enumerable: false, configurable: false
  });
  let a = seed[0] | 0, b = seed[1] | 0, c = seed[2] | 0, d = seed[3] | 0;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  const now = function now() { return clock; };
  function Date(...args) {
    if (new.target === undefined) return new NativeDate(clock).toString();
    return construct(NativeDate, args.length === 0 ? [clock] : args, new.target);
  }
  Date.prototype = NativeDate.prototype;
  lock(Date, "now", now);
  lock(Date, "parse", NativeDate.parse);
  lock(Date, "UTC", NativeDate.UTC);
  lock(NativeDate, "now", now);
  lock(NativeDate.prototype, "constructor", Date);
  lock(globalThis, "Date", Date);
  lock(Math, "random", function random() { return next() / 4294967296; });
  // Lock the replacement on the object and on its prototype, where the
  // native method lives: \`Object.getPrototypeOf(crypto).getRandomValues\`
  // would otherwise still reach the real stream. A prototype the runtime
  // will not let us redefine keeps its native method (\`tryLock\`), and a
  // program that uses it diverges on replay rather than sending anything.
  const tryLock = (target, key, value) => {
    try { lock(target, key, value); } catch {}
  };
  if (typeof crypto === "object" && crypto !== null) {
    const getRandomValues = function getRandomValues(array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = next() >>> 24;
      return array;
    };
    const randomUUID = function randomUUID() {
      const bytes = getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      let hex = "";
      for (let i = 0; i < 16; i++) {
        hex += (bytes[i] + 0x100).toString(16).slice(1);
        if (i === 3 || i === 5 || i === 7 || i === 9) hex += "-";
      }
      return hex;
    };
    lock(crypto, "getRandomValues", getRandomValues);
    lock(crypto, "randomUUID", randomUUID);
    const cryptoProto = Object.getPrototypeOf(crypto);
    if (cryptoProto) {
      tryLock(cryptoProto, "getRandomValues", getRandomValues);
      tryLock(cryptoProto, "randomUUID", randomUUID);
    }
  }
  if (typeof performance === "object" && performance !== null) {
    const perfNow = function now() { return 0; };
    lock(performance, "now", perfNow);
    const performanceProto = Object.getPrototypeOf(performance);
    if (performanceProto) tryLock(performanceProto, "now", perfNow);
  }
  // An Intl formatter asked for "now" (no date) reads the native clock.
  if (typeof Intl === "object" && Intl !== null && typeof Intl.DateTimeFormat === "function") {
    const proto = Intl.DateTimeFormat.prototype;
    const formatGetter = Object.getOwnPropertyDescriptor(proto, "format");
    if (formatGetter && typeof formatGetter.get === "function") {
      const nativeFormat = formatGetter.get;
      try {
        defineProperty(proto, "format", {
          get() {
            const bound = nativeFormat.call(this);
            return function format(date) { return bound(date === undefined ? clock : date); };
          },
          enumerable: false,
          configurable: false,
        });
      } catch {}
    }
    const nativeFormatToParts = proto.formatToParts;
    if (typeof nativeFormatToParts === "function") {
      tryLock(proto, "formatToParts", function formatToParts(date) {
        return nativeFormatToParts.call(this, date === undefined ? clock : date);
      });
    }
  }
})(${JSON.stringify(environment.clockMs)}, ${JSON.stringify([...environment.seed])});`;
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
  limits: SandboxLimits = {},
): Promise<ExecutorProvider[]> {
  return [sandboxProvider(registry, baseUrl, activity, limits)];
}

interface SandboxLimits {
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
  /** The run's clock and seed (P6). A fresh pair when omitted. */
  environment?: PinnedEnvironment | undefined;
  /** One play of a resumable run; absent when resumable writes are off. */
  runState?: RunState | undefined;
  /** Config approval exemptions (#566). */
  approval?: ApprovalPolicy | undefined;
  /** Writes one program may send; the run state keeps its own count. */
  maxWrites?: number | undefined;
  /** Exempt writes when resumable writes are off, for close and drain. */
  exemptWrites?: ExemptWrites | undefined;
}

/**
 * The `connecta` provider for one execution.
 *
 * Building it is synchronous and loads nothing. Each function is a Promise
 * edge the executor awaits, and behind it one host call is one fiber: spend
 * the budget, do the operation, and turn a typed failure into the frame the
 * prelude rebuilds inside the guest. Nothing is shared between those fibers
 * but the budget counter and this request's catalog, so a call the program
 * never awaits cannot disturb the others.
 */
function sandboxProvider(
  registry: RegistryView,
  baseUrl: string,
  activity: ActivityRequestContext | undefined,
  limits: SandboxLimits,
): ExecutorProvider {
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
    approval: limits.approval,
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
  const { signal, diagnostics } = limits;
  let hostCalls = 0;
  // L4/M7: discovery and invocation spend the same budget, on entry; emit
  // does not.
  const spendHostCall = Effect.suspend(() =>
    ++hostCalls > maxHostCalls
      ? Effect.fail(
          guestFailure(
            "budget_exceeded",
            `execute_code host-call budget exceeded (${maxHostCalls} calls maximum)`,
          ),
        )
      : Effect.void,
  );
  const { runState, exemptWrites } = limits;
  const approval = limits.approval ?? NO_EXEMPTIONS;
  const maxWrites = resolveBudget(limits.maxWrites, DEFAULT_MAX_WRITES);
  let exemptWriteCount = 0;
  /**
   * Without resumable writes nothing can pause, but a config exemption
   * (#566) still lets its writes run: the gate covers exactly the exempt
   * calls, spends the write budget on each, and every other write keeps
   * E4's refusal, ahead of validation as it always was. A dispatched write
   * is tracked until it settles (`ExemptWrites`), so the play can wait for
   * it rather than abort it.
   */
  const exemptOnly = (sending: { settle?: (state: WriteState) => void }) => ({
    gates: (target: ResolvedCatalogTool) =>
      isApprovalExempt(approval, target.connector, target.toolName, target.definition),
    writeGate: (target: ResolvedCatalogTool): Effect.Effect<WriteGateDecision> =>
      Effect.sync((): WriteGateDecision => {
        if (exemptWrites?.isClosed) {
          return {
            kind: "refuse",
            error: {
              code: "cancelled",
              message: "The program had already returned, so this write was not sent.",
              retryable: false,
            },
            activity: "none",
          };
        }
        if (exemptWriteCount >= maxWrites) {
          return {
            kind: "refuse",
            error: {
              code: "budget_exceeded",
              message: `execute_code write budget exceeded (${maxWrites} writes maximum, execute.maxWrites); ${target.connector.id}.${target.toolName} was not sent`,
              retryable: false,
            },
          };
        }
        exemptWriteCount++;
        if (exemptWrites) sending.settle = exemptWrites.begin();
        return { kind: "dispatch" };
      }),
  });
  const invocationContext = (
    seq: number | undefined,
    key: string | undefined,
    sending: { settle?: (state: WriteState) => void },
  ) => ({
    source: runState?.source ?? ("execute_code" as const),
    timeoutMs: hostCallTimeoutMs,
    ...(signal !== undefined ? { requestSignal: signal } : {}),
    unwrapResult: true,
    // With resumable writes, a consequential call reaches the run's gate
    // instead of the flat E4 refusal, and a read's decision is marked the
    // moment it passes the same point.
    ...(runState && seq !== undefined && key !== undefined
      ? {
          beforeDispatch: () => runState.decide(seq),
          writeGate: (target: ResolvedCatalogTool, args: unknown) =>
            runState.gate(seq, key, target, args),
        }
      : runState
        ? {}
        : exemptOnly(sending)),
  });

  /**
   * The front of every numbered host call once resumable writes are on: a
   * stopped run makes no call at all (not journaled, no activity), a
   * recorded one is answered from the journal before the budget-free part
   * of the path, and one the journal cannot account for is divergence.
   * Replayed calls spend the host-call budget again, so a play's total is
   * the run's total and nothing is counted twice.
   */
  const fromJournal = (
    seq: number | undefined,
    op: JournalOp,
    address: string,
    args: unknown,
  ): Effect.Effect<
    { kind: "live"; key: string | undefined } | { kind: "replayed"; value: unknown },
    unknown
  > =>
    Effect.gen(function* () {
      const halted = runState?.halted();
      if (halted) return yield* Effect.fail(halted);
      yield* spendHostCall;
      if (!runState || seq === undefined) return { kind: "live", key: undefined };
      const key = journalKey(op, address, args);
      const found = runState.lookup(key);
      if (found.kind === "diverged") {
        return yield* Effect.fail(runState.diverge(found.reason));
      }
      if (found.kind === "live") return { kind: "live", key };
      runState.decide(seq);
      const { outcome } = found.entry;
      return outcome.ok
        ? { kind: "replayed", value: outcome.value }
        : yield* Effect.fail(new InvocationFailure(outcome.error));
    });

  // A call brings its own cancellation: the invocation pipeline reads the
  // run's signal, refuses a call that starts after it, and records the
  // cancelled attempt in activity like any other outcome.
  const call = (seq: number | undefined, address: unknown, args: unknown) =>
    Effect.gen(function* () {
      const addressText = String(address);
      const callArgs = args ?? {};
      const front = yield* fromJournal(seq, "call", addressText, callArgs);
      if (front.kind === "replayed") return front.value;
      // An exempt write dispatched without a run state settles here —
      // unknown if the call never returned an outcome.
      const sending: { settle?: (state: WriteState) => void } = {};
      const outcome = yield* invocation.pipeline(
        addressText,
        callArgs,
        invocationContext(seq, front.key, sending),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            sending.settle?.(Exit.isSuccess(exit) ? writeStateOf(exit.value) : "unknown"),
          ),
        ),
      );
      diagnostics?.recordCall(outcome);
      if (runState && seq !== undefined && front.key !== undefined) {
        if (runState.isLiveWrite(seq)) {
          const resolved = outcome.resolved;
          const replaced = yield* runState.settleWrite(seq, front.key, {
            address: resolved
              ? `${resolved.connector.id}.${resolved.toolName}`
              : addressText,
            args: callArgs,
          }, outcome);
          if (replaced) return yield* Effect.fail(replaced);
        } else {
          runState.record(
            seq,
            "call",
            front.key,
            outcome.ok
              ? { ok: true, value: outcome.value }
              : { ok: false, error: outcome.error },
          );
        }
      }
      return outcome.ok
        ? outcome.value
        : yield* Effect.fail(new InvocationFailure(outcome.error));
    });

  // Discovery gets the same treatment from here (L2): once the run has
  // ended no search or describe starts, and one still in flight fails
  // `cancelled` instead of holding the program until its probe deadline.
  // Policy failures use the same thrown vocabulary as calls and utilities;
  // the transport below reconstructs their code inside the guest.
  const discovery = <T>(
    operation: "search" | "describe",
    seq: number | undefined,
    raw: unknown,
    read: () => Promise<T>,
  ): Effect.Effect<unknown, unknown> =>
    Effect.suspend(() => {
      const started = Date.now();
      const cancelled = () =>
        guestFailure(
          "cancelled",
          `connecta.${operation} was cancelled because the run ended.`,
        );
      const reading = Effect.tryPromise({
        try: read,
        catch: (err) =>
          err instanceof DiscoveryPolicyError
            ? guestFailure(err.code, err.message)
            : err,
      });
      return fromJournal(seq, operation, "", raw ?? {}).pipe(
        Effect.flatMap((front) => {
          if (front.kind === "replayed") return Effect.succeed(front.value);
          const live = (
            !signal
              ? reading
              : signal.aborted
                ? Effect.fail(cancelled())
                : Effect.raceAllFirst([
                    reading,
                    fromSignal(signal).pipe(Effect.mapError(cancelled)),
                  ])
          ).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (!runState || seq === undefined || front.key === undefined) return;
                // Typed outcomes replay; an untyped throw is a bug, not an
                // answer, and is not journaled — so a replay that re-issues
                // the call before repeating the approved write finds no record
                // and fails `execution_diverged`.
                if (Exit.isSuccess(exit)) {
                  runState.record(seq, operation, front.key, {
                    ok: true,
                    value: exit.value,
                  });
                  return;
                }
                const error = Cause.squash(exit.cause);
                if (error instanceof InvocationFailure) {
                  runState.record(seq, operation, front.key, {
                    ok: false,
                    error: error.details,
                  });
                }
              }),
            ),
          );
          return live;
        }),
        Effect.onExit((exit) =>
          Effect.sync(() =>
            diagnostics?.recordCatalog(
              operation,
              Date.now() - started,
              Exit.isSuccess(exit),
              Exit.isSuccess(exit) ? exit.value : undefined,
            ),
          ),
        ),
      );
    });

  const operations: Record<
    string,
    (seq: number | undefined, ...args: unknown[]) => Effect.Effect<unknown, unknown>
  > = {
    call,
    // Emission is a provider function, never an ExecuteResult field —
    // that is what keeps the Executor contract untouched and parity
    // structural (M8). It spends no host-call budget (M7); its own
    // budgets live in the collector. It is never journaled: a replay emits
    // again, and only the play that completes delivers.
    emit: (_seq, block) =>
      Effect.try({
        try: () => {
          if (!limits.emitCollector) {
            throw guestFailure(
              "unavailable",
              "connecta.emit is unavailable: no emission collector was configured for this execution",
              true,
            );
          }
          limits.emitCollector.accept(block);
        },
        catch: (err) => err,
      }),
    search: (seq, raw) =>
      discovery("search", seq, raw, async () => {
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
    describe: (seq, raw) =>
      discovery("describe", seq, raw, async () => {
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
  };
  // Every failure leaves through the same frame, so the prelude can rebuild
  // a typed error however the host call failed — refused, over budget, or
  // cancelled. Anything that is not an InvocationFailure crosses unchanged.
  const framed = (err: unknown): Effect.Effect<never, unknown> =>
    Effect.suspend(() => {
      if (!(err instanceof InvocationFailure)) return Effect.fail(err);
      const failure = boundedGuestFailure(err);
      const frame = framedGuestFailure(failureSecret, failure);
      limits.onInvocationFailure?.(failure);
      return Effect.fail(frame);
    });
  return {
    name: "connecta",
    // Typed errors first, then the pinned clock and randomness: both are
    // trusted host code the program runs after and cannot undo.
    prelude: `${guestErrorPrelude(failureSecret)}\n${pinnedEnvironmentPrelude(
      runState?.environment ?? limits.environment ?? freshEnvironment(),
    )}`,
    fns: Object.fromEntries(
      Object.entries(operations).map(([name, operation]) => [
        name,
        (...args: unknown[]) => {
          // Numbered here, synchronously, as the program makes the call: the
          // numbering is the program's own issue order, which is what makes
          // a pause point and a replay reproducible.
          const seq = runState && name !== "emit" ? runState.begin() : undefined;
          const settled = runEdge(
            Effect.suspend(() => operation(seq, ...args)).pipe(
              Effect.catch(framed),
              Effect.ensuring(
                Effect.sync(() => {
                  if (seq !== undefined) runState?.decide(seq);
                }),
              ),
            ),
          );
          if (seq !== undefined) runState?.track(seq, settled);
          // The executor owns this promise, and a program may abandon a call
          // that the run's end then cancels before anyone has awaited it.
          // The rejection is still there for whoever does; it is just not an
          // unhandled rejection of the host's, which workerd reports as soon
          // as a microtask passes without a handler.
          settled.catch(() => {});
          return settled;
        },
      ]),
    ),
  };
}

/**
 * Await an executor's promise without trusting it to settle.
 *
 * An executor's deadline is its own business, and the Dynamic Worker's lives
 * inside the sandbox: a wedged isolate never fires it, so the call never
 * settles, the handler never returns, and the admission lease is held for
 * good. Two of those fill the default code pool and every later execute_code
 * queues behind them (executor hit this in production). An `acquire()` that
 * ignores its signal holds a cancelled request the same way.
 *
 * So the host races the promise against the request's signal and, for a run,
 * a ceiling of its own. Cancellation settles as the same `executor_cancelled`
 * the QuickJS pool reports, unless the executor reports its own first; the
 * ceiling as an untyped executor failure naming the key that sets it. Either
 * way the handler returns and releases the lease, and the abandoned call
 * keeps whatever it was doing: the QuickJS lease release recycles its child,
 * a Dynamic Worker isolate runs on to its own deadline, and a lease granted
 * after its request gave up goes to `late`. The result contract is untouched
 * — this only decides when to stop waiting for one.
 */
function awaitExecutor<A>(
  start: () => A | Promise<A>,
  signal: AbortSignal,
  options: {
    late?: (value: A) => void;
    watchdog?: { ms: number; logger: Logger };
  } = {},
): Effect.Effect<A, unknown> {
  const contenders: Array<Effect.Effect<A, unknown>> = [
    Effect.suspend(() => {
      let pending: Promise<A> | undefined;
      const settling = Effect.tryPromise({
        try: () => (pending = Promise.resolve(start())),
        catch: (err) => err,
      });
      const { late } = options;
      return late
        ? settling.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                pending?.then(late, () => {});
              }),
            ),
          )
        : settling;
    }),
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
  ];
  const { watchdog } = options;
  if (watchdog) {
    contenders.push(
      Effect.sleep(Duration.millis(watchdog.ms)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            watchdog.logger.warn(
              "[connecta] execute_code executor did not settle; run abandoned",
              { watchdogMs: watchdog.ms },
            );
            return Effect.fail(
              new Error(
                `sandbox unresponsive: no outcome within the ${watchdog.ms}ms ` +
                  "execute.watchdogMs ceiling, so the run was abandoned",
              ),
            );
          }),
        ),
      ),
    );
  }
  return Effect.raceAllFirst(contenders);
}

/**
 * The run's own signal, aborted however the run ends. It follows the
 * caller's, and aborting it on the way out is what releases outstanding host
 * waits and tells cooperative connectors to stop.
 */
function runSignal(
  caller: AbortSignal | undefined,
): Effect.Effect<AbortSignal, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const forward = () => controller.abort(caller?.reason);
      if (caller?.aborted) forward();
      else caller?.addEventListener("abort", forward, { once: true });
      return { controller, forward };
    }),
    ({ controller, forward }) =>
      Effect.sync(() => {
        controller.abort();
        caller?.removeEventListener("abort", forward);
      }),
  ).pipe(Effect.map(({ controller }) => controller.signal));
}

/**
 * An admitting executor's lease, released when the run's scope closes.
 *
 * `acquire()` is the executor's Promise, awaited as one on purpose. A queued
 * request is handed its lease from inside whichever request released one, so
 * a fiber resumed straight from the executor's admission queue would build
 * this request's providers and run its program in the releasing request —
 * which workerd refuses for any I/O. Awaiting the promise resumes it here.
 */
function leased(
  executor: AdmittingExecutor,
  signal: AbortSignal,
): Effect.Effect<ExecutorLease, unknown, Scope.Scope> {
  return Effect.acquireRelease(
    awaitExecutor(() => executor.acquire({ signal }), signal, {
      late: (lease) => lease.release(),
    }),
    (lease) => Effect.sync(() => lease.release()),
  );
}

/** The execute_code configuration a runner enforces. */
interface RunnerConfig {
  /** Refresh only: a refused host call fails the whole run even if guest code catches it. */
  failOnInvocationFailure?: boolean | undefined;
  discoveryConcurrency?: number | undefined;
  probeTimeoutMs?: number | undefined;
  maxEmittedBytes?: number | undefined;
  maxEmittedBlocks?: number | undefined;
  maxHostCalls?: number | undefined;
  hostCallTimeoutMs?: number | undefined;
  watchdogMs?: number | undefined;
  /**
   * The deadline on each paused-run storage call. Defaults to the host-call
   * deadline, never under `MIN_STORAGE_TIMEOUT_MS`; tests shorten it.
   */
  storageTimeoutMs?: number | undefined;
  defer?: DeferredWork | undefined;
  /**
   * One clock and seed for every fresh run of this handler instead of a
   * fresh pair per run. Tests pin a known stream with it; a replay always
   * uses its journal's.
   */
  environment?: PinnedEnvironment | undefined;
  /**
   * Resumable writes. When set and the view's result storage has
   * `compareAndSet`, a consequential call pauses the run instead of being
   * refused; absent, E4's refusal stands.
   */
  resumable?: ResumableSettings | undefined;
  /** Config approval exemptions (#566): writes a program sends unasked. */
  approval?: ApprovalPolicy | undefined;
  /** Writes one program may send (`execute.maxWrites`). Default 10. */
  maxWrites?: number | undefined;
}

/** Plays programs: `execute_code` fresh, `resume_execution` from a journal. */
export interface ProgramRunner {
  execute(
    args: { code: string; diagnostics?: boolean },
    options?: { signal?: AbortSignal },
  ): Promise<ToolResult>;
  /** One play of a claimed run, for `resume_execution`. */
  replay(runState: RunState, signal?: AbortSignal): Effect.Effect<ToolResult>;
  /** How long a claimed play may take before another may take it over. */
  readonly claimMs: number;
  /** The deadline on each paused-run storage call. */
  readonly storageTimeoutMs: number;
}

/**
 * Room a claim leaves beyond the watchdog and one host-call deadline, for the
 * executor queue a resumed play waits in first. Only liveness rides on it: a
 * claim that lapses early lets a takeover start, and the write-ahead mark
 * still keeps any write from being sent twice.
 */
const CLAIM_SLACK_MS = 10_000;

type PlayEnd = { settled: ExecuteResult } | { stop: RunStop };

/** The runner behind both program tools. */
export function createProgramRunner(
  registry: RegistryView,
  baseUrl: string,
  executor: Executor,
  logger: Logger,
  activity?: ActivityRequestContext,
  config: RunnerConfig = {},
): ProgramRunner {
  const watchdog = {
    ms: resolveBudget(config.watchdogMs, EXECUTE_WATCHDOG_MS),
    logger,
  };
  const hostCallTimeoutMs = resolveBudget(
    config.hostCallTimeoutMs,
    EXECUTE_HOST_CALL_TIMEOUT_MS,
  );
  const storageTimeoutMs = resolveBudget(
    config.storageTimeoutMs,
    Math.max(hostCallTimeoutMs, MIN_STORAGE_TIMEOUT_MS),
  );

  /**
   * One play of a program. Without a run state it is the execute_code run it
   * always was. With one, the play also ends when the run stops — a pause or
   * a typed failure — and then waits for what is still on the wire, persists
   * what it must, and discards the program's own result.
   */
  const play = (
    program: string,
    runState: RunState | undefined,
    diagnosticsRequested: boolean | undefined,
    callerSignal: AbortSignal | undefined,
  ): Effect.Effect<ToolResult> =>
    Effect.suspend(() => {
      const diagnostics = diagnosticsRequested
        ? new ExecuteDiagnostics()
        : undefined;
      const emitted = new EmitCollector(
        resolveBudget(config.maxEmittedBytes, EXECUTE_MAX_EMITTED_BYTES),
        resolveBudget(config.maxEmittedBlocks, EXECUTE_MAX_EMITTED_BLOCKS),
        diagnostics,
      );
      const invocationFailures: InvocationFailure[] = [];
      const exemptWrites = runState ? undefined : new ExemptWrites();
      // The run's scope holds its signal and its lease. However the run
      // ends — a result, a thrown executor, the watchdog, cancellation —
      // closing it releases the lease and then aborts the signal, so
      // nothing the run started outlives the request.
      const run = Effect.gen(function* () {
        const signal = yield* runSignal(callerSignal);
        // Admission comes before provider construction: queued calls retain
        // no catalogs, request scopes, or provider closures.
        let lease: ExecutorLease | undefined;
        if (isAdmittingExecutor(executor)) {
          lease = yield* timed((elapsed) => {
            if (diagnostics) diagnostics.admissionMs = elapsed;
          }, leased(executor, signal));
          if ((lease.waitMs ?? 0) > 0) {
            logger.debug("[connecta] execute_code admitted after queue wait", {
              waitMs: lease.waitMs,
            });
          }
        }
        const provider = yield* timed((elapsed) => {
          if (diagnostics) diagnostics.setupMs = elapsed;
        }, Effect.sync(() =>
          sandboxProvider(registry, baseUrl, activity, {
            signal,
            onInvocationFailure: (failure) => {
              invocationFailures.push(failure);
              if (invocationFailures.length > 64) invocationFailures.shift();
            },
            emitCollector: emitted,
            ...(diagnostics ? { diagnostics } : {}),
            discoveryConcurrency: config.discoveryConcurrency,
            probeTimeoutMs: config.probeTimeoutMs,
            maxHostCalls: config.maxHostCalls,
            hostCallTimeoutMs,
            defer: config.defer,
            environment: config.environment,
            runState,
            approval: config.approval,
            maxWrites: config.maxWrites,
            exemptWrites,
          }),
        ));
        if (signal.aborted) {
          return yield* Effect.fail(
            new ExecutorAdmissionError(
              "executor_cancelled",
              "Execution was cancelled during sandbox setup.",
            ),
          );
        }
        const admitted = lease;
        const executing = awaitExecutor(
          () =>
            admitted
              ? admitted.execute(program, [provider])
              : executor.execute(program, [provider]),
          signal,
          { watchdog },
        ).pipe(Effect.map((settled): PlayEnd => ({ settled })));
        if (!runState) {
          // Nothing pauses, but an exempt write may be on the wire: close,
          // then let it finish before the scope aborts it.
          return yield* timed((elapsed) => {
            if (diagnostics) diagnostics.executorWallMs = elapsed;
          }, executing.pipe(Effect.ensuring(Effect.suspend(() => {
            exemptWrites?.close();
            return exemptWrites?.drain() ?? Effect.void;
          }))));
        }
        // The run stopping wins the race as soon as its gate decides, before
        // the program even sees the rejection. Either way the play closes —
        // a write gated after this is not sent — and what is still on the
        // wire finishes before the scope aborts it: every call after a stop,
        // since each is journaled, and every write otherwise, since an
        // abandoned write would be an unknown one.
        const ended = yield* timed((elapsed) => {
          if (diagnostics) diagnostics.executorWallMs = elapsed;
        }, Effect.raceFirst(
          executing,
          Deferred.await(runState.stopped).pipe(
            Effect.map((stop): PlayEnd => ({ stop })),
          ),
        ).pipe(Effect.ensuring(Effect.suspend(() => {
          runState.close();
          return runState.drain("writes");
        }))));
        if ("stop" in ended) yield* runState.drain("all");
        return ended;
      });
      const reported = { emitted, diagnostics, invocationFailures };
      return Effect.flatMap(Effect.exit(Effect.scoped(run)), (exit) => {
        if (Exit.isFailure(exit)) {
          const failed = failedRun(Cause.squash(exit.cause), logger, reported);
          return runState
            ? runState.finishExecutorFailure(failed)
            : Effect.succeed(exemptWrites?.finish(failed) ?? failed);
        }
        const ended = exit.value;
        if ("stop" in ended) {
          return runState
            ? runState.finishStopped()
            : Effect.die(new Error("a run without state cannot stop"));
        }
        const finished = finishedRun(ended.settled, reported);
        if (config.failOnInvocationFailure && invocationFailures.length > 0) {
          const refusal = invocationFailures[0]!;
          return Effect.succeed(failureResponse(refusal.details.message, {
            code: refusal.details,
          }));
        }
        return runState
          ? runState.finishSettled(finished)
          : Effect.succeed(exemptWrites?.finish(finished) ?? finished);
      });
    });

  return {
    claimMs: watchdog.ms + hostCallTimeoutMs + CLAIM_SLACK_MS,
    storageTimeoutMs,
    execute: ({ code, diagnostics }, options = {}) => {
      // A code-unit count above the cap is already too large in UTF-8. Check
      // that first so a huge direct-call string is never encoded in full.
      if (code.length > EXECUTE_MAX_CODE_BYTES ||
        new TextEncoder().encode(code).byteLength > EXECUTE_MAX_CODE_BYTES) {
        const message = `execute_code code exceeds the ${EXECUTE_MAX_CODE_BYTES}-byte UTF-8 limit.`;
        return Promise.resolve(failureResponse(message, {
          code: { code: "invalid_args", message, retryable: false },
        }));
      }
      return runEdge(Effect.suspend(() => {
        const program = normalizeProgramSource(code);
        const storage = config.resumable ? registry.resultsStorage() : undefined;
        const runState = config.resumable && storage?.compareAndSet
          ? RunState.fresh(
              storage,
              program,
              config.environment ?? freshEnvironment(),
              config.resumable,
              storageTimeoutMs,
            )
          : undefined;
        return play(program, runState, diagnostics, options.signal);
      }));
    },
    replay: (runState, signal) =>
      play(runState.program, runState, false, signal),
  };
}

/** The execute_code handler. Exported for direct testing. */
export function createExecuteTool(
  registry: RegistryView,
  baseUrl: string,
  executor: Executor,
  logger: Logger,
  activity?: ActivityRequestContext,
  config: RunnerConfig = {},
): ProgramRunner["execute"] {
  return createProgramRunner(
    registry,
    baseUrl,
    executor,
    logger,
    activity,
    config,
  ).execute;
}

interface RunReport {
  emitted: EmitCollector;
  diagnostics: ExecuteDiagnostics | undefined;
  invocationFailures: readonly InvocationFailure[];
}

/** An execution that never produced an ExecuteResult, as the model sees it. */
function failedRun(
  err: unknown,
  logger: Logger,
  { emitted, diagnostics }: RunReport,
): ToolResult {
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
      emitted: err instanceof ExecutorExecutionError ? emitted : undefined,
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
}

/** The response for an ExecuteResult: the program's error or its value. */
function finishedRun(
  outcome: ExecuteResult,
  { emitted, diagnostics, invocationFailures }: RunReport,
): ToolResult {
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
  resumable: ResumableSettings | undefined,
) => `Use the configured services below to answer the task. A known address uses call_tool. Unknown-address and wider ${
  resumable ? "work, writes included," : "read-only work"
} uses one execute_code program for discovery, calls, and reduction. Do not return catalog matches alone. ${
  resumable
    ? `Writes pause for resume_execution. Limits: ${hostLimits.maxHostCalls} host calls, ${resumable.maxWrites} writes`
    : `Only readOnlyHint: true tools are available. Limits: ${hostLimits.maxHostCalls} host calls`
}, ${hostLimits.hostCallTimeoutMs / 1_000}s/host call.

${connectorInventory(connectors)}

Read guides with top-level skills. Write JavaScript as async () => { ... }; connecta is global, not a parameter:
- connecta.search({ connector, query, ${resumable ? "" : 'safety: "readOnly", '}includeSchemas: "json" }) returns { tools }. Search each operation separately; choose by connectorTitle and schemas. Use schema.required and .properties to build args, never guessed fields. Compact schemas are text.
- connecta.describe({ address }) returns { tools } for unclear schemas.
- connecta.call(address, args) returns the provider value directly.
- Use Promise.all for independent calls, or Promise.allSettled to retain failures. Check status before reading value; rejected calls and missing fields are unknown, never false or zero.
- connecta.emit(block): { type: "text", text } or { type: "image" | "audio", data (base64), mimeType }; success-only, ${emitBudgets.maxBlocks} blocks/${emitBudgets.maxBytes} bytes.
- console.log(...) is captured. Return data for the client to render.

No portable ambient capabilities. Return reduced JSON. If a provider result has an unfamiliar shape, return a small sample and continue in another call; never guess fields or use the whole text as an id. Top-level skills({ name: "usage" }): repair${connectorGuides ? ", guide handling" : ""}; skills({ name: "investigate" }): task planning.`;

// Module scope, like the other six meta-tool inputs: its JSON Schema is
// derived once per process. Budgets and connectors vary by deployment and
// view, so they live in the description, never here.
const EXECUTE_INPUT = advertisedSchema(
  z.object({
    code: z
      .string()
      .describe(
        "One complete zero-argument JavaScript async arrow: async () => { ... }. Use the provided connecta global to discover, call, and return the reduced answer. At most 65,536 UTF-8 bytes.",
      ),
    diagnostics: z
      .boolean()
      .optional()
      .describe(
        "Add request-local, payload-free timing and result-size summaries.",
      ),
  }),
);

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
    /** Resumable writes, when this deployment turned them on. */
    resumable?: ResumableSettings | undefined;
    /** Config approval exemptions (#566). */
    approval?: ApprovalPolicy | undefined;
    /** Writes one program may send. Default 10. */
    maxWrites?: number | undefined;
  },
): ProgramRunner {
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
  const runner = createProgramRunner(
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
      resumable: ctx.resumable,
      approval: ctx.approval,
      maxWrites: ctx.maxWrites,
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
        ctx.resumable,
      ),
      inputSchema: EXECUTE_INPUT,
      // This hint describes connector calls: only explicitly read-only ones
      // run here, and any other call pauses the run unsent (W1) — the write
      // itself runs inside resume_execution, which is annotated destructive.
      // The supported executor constructions deny outbound access,
      // filesystem, and deployment config; X5 documents Dynamic runtime
      // modules separately.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      underAnySignal([extra.mcpReq.signal, ctx.requestSignal], (signal) =>
        runner.execute(args as { code: string; diagnostics?: boolean }, {
          signal,
        })),
  );
  return runner;
}
