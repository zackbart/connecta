// The core's services, as Effect code sees them.
//
// createConnecta resolves storage, the vault, activity history, logging, and
// the rest of its configuration once, at construction. This module gives each
// of those a service key and assembles them into the layer behind that
// Connecta's runtime (an EdgeRuntime, src/runtime/run.ts), so an Effect
// program reads them from its context rather than from arguments threaded
// through every call. The shells — Registry, CatalogService, and the rest —
// stay constructible from plain arguments, as the tests construct them;
// nothing here replaces those arguments yet.
//
// Every import from an optional module is type-only. An omitted activity
// module is a no-op recorder that builds no event and calls nothing, and the
// UI, vault, and activity implementations stay out of the root import graph
// (test/purity.test.ts).

import { Context, Effect, Layer } from "effect";
import type { ActivityActor, ActivityEventInput } from "../activity.js";
import type { ResolvedPool } from "../connector-access.js";
import type { DeferredWork as DeferredWorkHook } from "../connector-scope.js";
import type { CredentialVault } from "../credential-contract.js";
import type { ConnectaConfig } from "../index.js";
import type { ActivityModule } from "../module-contracts.js";
import type { Registry } from "../registry.js";
import type {
  CatalogDriftCounts,
  InboundAuth,
  KVStorage,
  Logger as LoggerShape,
} from "../types.js";
import { type EdgeRuntime, makeEdgeRuntime } from "./run.js";

/**
 * The deployment's KVStorage: `config.storage`, or the memoryStorage() that
 * stands in for it. `compareAndSet` is present exactly when the adapter
 * implements it, so a caller that needs atomicity checks for it here.
 */
export class Storage extends Context.Service<Storage, KVStorage>()(
  "connecta/Storage",
) {}

/**
 * The credential vault, or undefined when the deployment configures none —
 * a required service whose value may be absent, not a default, so a program
 * run without it provided fails to typecheck instead of finding no vault.
 */
export class Vault extends Context.Service<
  Vault,
  CredentialVault | undefined
>()("connecta/Vault") {}

/**
 * Connecta's diagnostic logger, already resolved: the configured Logger, a
 * no-op for `"silent"`, or console output prefixed `[connecta]`. Effect's
 * own logger is never used (test/purity.test.ts), because it honors neither
 * `"silent"` nor the line format a deployment greps for.
 */
export class Logger extends Context.Service<Logger, LoggerShape>()(
  "connecta/Logger",
) {}

/** The part of a tool-call activity event that belongs to its request. */
interface ActivityRequest {
  readonly actor: ActivityActor;
  readonly requestId: string;
}

export interface ActivityRecorderShape {
  /**
   * False when the deployment omits the activity module. Every record is then
   * a no-op, and a caller may skip assembling the event at all.
   */
  readonly enabled: boolean;
  /**
   * Record one tool call. Best-effort: it never fails, a store failure is
   * logged, and a store write still pending is handed to the request's
   * DeferredWork when there is one.
   */
  recordTool(request: ActivityRequest, input: ActivityEventInput): Effect.Effect<void>;
  /** Record one catalog-drift observation, as best-effort as recordTool. */
  recordDrift(
    input: { connectorId: string } & CatalogDriftCounts,
  ): Effect.Effect<void>;
}

/** Payload-free activity history, or a recorder that records nothing. */
export class ActivityRecorder extends Context.Service<
  ActivityRecorder,
  ActivityRecorderShape
>()("connecta/ActivityRecorder") {}

type ResolvedServerInfo = NonNullable<ConnectaConfig["serverInfo"]> & {
  name: string;
  version: string;
};

export interface ResolvedConfigShape {
  /**
   * The configuration createConnecta accepted: unknown options and
   * structural mistakes have already thrown. Fields below are the values
   * construction derived from it; read those rather than deriving again.
   */
  readonly config: ConnectaConfig;
  /** `serverInfo` with its name and version defaults applied. */
  readonly serverInfo: ResolvedServerInfo;
  /** Inbound auth providers, bearer providers first. */
  readonly auth: readonly InboundAuth[];
  /** Declared pools, validated against the connector set. */
  readonly pools: ReadonlyMap<string, ResolvedPool>;
  /** The configured executor's name, read before any admission wrapper. */
  readonly executorName: string | undefined;
}

/** What createConnecta resolved at construction. */
export class ResolvedConfig extends Context.Service<
  ResolvedConfig,
  ResolvedConfigShape
>()("connecta/ResolvedConfig") {}

/**
 * The request's hook for work that may outlive its response (a Worker's
 * `ctx.waitUntil`). Per request, not per Connecta, so it is never part of the
 * runtime: a request provides it with `Effect.provideService`, and a program
 * outside any request sees undefined and keeps its work in the foreground.
 */
export const DeferredWork = Context.Reference<DeferredWorkHook | undefined>(
  "connecta/DeferredWork",
  { defaultValue: () => undefined },
);

/** Every service the per-Connecta runtime provides. */
export type CoreServices =
  | Storage
  | Vault
  | Logger
  | ActivityRecorder
  | ResolvedConfig;

export interface CoreServiceOptions {
  storage: KVStorage;
  logger: LoggerShape;
  vault: CredentialVault | undefined;
  activity: ActivityModule | undefined;
  config: ResolvedConfigShape;
}

/**
 * Resolve `ConnectaConfig.logger`. `"silent"` discards every line; an omitted
 * logger writes to the console with the `[connecta]` prefix.
 */
export function resolveLogger(
  logger: LoggerShape | "silent" | undefined,
): LoggerShape {
  if (logger === "silent") {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }
  return logger ?? {
    debug: (...a) => console.debug("[connecta]", ...a),
    info: (...a) => console.info("[connecta]", ...a),
    warn: (...a) => console.warn("[connecta]", ...a),
    error: (...a) => console.error("[connecta]", ...a),
  };
}

const NO_ACTIVITY: ActivityRecorderShape = {
  enabled: false,
  recordTool: () => Effect.void,
  recordDrift: () => Effect.void,
};

function activityRecorder(
  module: ActivityModule,
  serverInfo: ResolvedServerInfo,
  logger: LoggerShape,
): ActivityRecorderShape {
  const deployment = module.deploymentId !== undefined
    ? { deploymentId: module.deploymentId }
    : {};
  // A custom module's recorder that throws is logged like a store that
  // throws: activity never changes the outcome of the work it describes.
  const bestEffort = (record: () => void) =>
    Effect.sync(() => {
      try {
        record();
      } catch (error) {
        logger.warn("[connecta] activity record failed", error);
      }
    });
  return {
    enabled: true,
    recordTool: (request, input) =>
      DeferredWork.use((defer) =>
        bestEffort(() =>
          module.recordTool(
            {
              sink: module.store,
              recordTool: module.recordTool,
              actor: request.actor,
              requestId: request.requestId,
              serverInfo,
              ...deployment,
              ...(defer ? { defer } : {}),
              logger,
            },
            input,
          ),
        ),
      ),
    recordDrift: (input) =>
      bestEffort(() =>
        module.recordDrift(
          { sink: module.store, serverInfo, ...deployment, logger },
          input,
        ),
      ),
  };
}

/**
 * The layer behind a Connecta's runtime. Every service is a value resolved
 * before this is called, so building the layer only assembles a context: it
 * starts no fiber and touches no storage.
 */
function coreServices(options: CoreServiceOptions): Layer.Layer<CoreServices> {
  const activity = options.activity
    ? activityRecorder(
        options.activity,
        options.config.serverInfo,
        options.logger,
      )
    : NO_ACTIVITY;
  return Layer.succeedContext(
    Context.make(Storage, options.storage).pipe(
      Context.add(Vault, options.vault),
      Context.add(Logger, options.logger),
      Context.add(ActivityRecorder, activity),
      Context.add(ResolvedConfig, options.config),
    ),
  );
}

// Keyed by the root Registry: it is the per-Connecta object every internal
// caller already holds, and a Registry built directly (as the tests build
// them) simply has no runtime.
const runtimes = new WeakMap<Registry, EdgeRuntime<CoreServices>>();

/**
 * Create the runtime for the Connecta that owns `registry`. Runs nothing:
 * the layer is built by the first run that needs it (see EdgeRuntime).
 */
export function createCoreRuntime(
  registry: Registry,
  options: CoreServiceOptions,
): EdgeRuntime<CoreServices> {
  const runtime = makeEdgeRuntime(coreServices(options));
  runtimes.set(registry, runtime);
  return runtime;
}

/** The runtime createConnecta made for this root registry, if it made one. */
export function coreRuntime(
  registry: Registry,
): EdgeRuntime<CoreServices> | undefined {
  return runtimes.get(registry);
}
