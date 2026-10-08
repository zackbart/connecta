// ConnectaConfig as one schema.
//
// The schema below is the canonical record of the configuration surface. It
// produces the TypeScript type a deployment writes (`ConnectaConfig`), the
// unknown-key rejection createConnecta runs before reading anything, every
// default (src/config-defaults.ts), and one validation policy: a present value
// that is wrong throws with its path at construction (INV-11). Each field's
// default and operator-facing meaning belongs in its doc comment here, where a
// deployment author reads it from the editor.
//
// `resolveConfig` turns an accepted config into the `ResolvedConfig` core
// reads, with defaults applied once, so no later layer re-derives a value or
// re-plumbs a field.

import type { ConnectorGrant } from "./connector-access.js";
import type { CredentialVault } from "./credential-contract.js";
import { CONFIG_DEFAULTS as D } from "./config-defaults.js";
import {
  array,
  ConfigError,
  fn,
  object,
  opaque,
  record,
  required,
  seconds,
  readPlain,
  text,
  whole,
  type ConfigInput,
  type ConfigOutput,
} from "./config-schema.js";
import { assertExecutor } from "./executor-contract.js";
import type {
  AccessTokensModule,
  ActivityModule,
  OperatorSurface,
} from "./module-contracts.js";
import { memoryStorage } from "./storage/memory.js";
import type {
  AuthenticatedIdentity,
  Connector,
  Executor,
  IdentityReference,
  InboundAuth,
  KVStorage,
  Logger,
} from "./types.js";
import { CONNECTA_VERSION } from "./version.js";

/** Config-owned identity rules for one deployment and tenant. */
export type ConnectorPermission = "all" | "none" | readonly string[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const STORAGE_METHODS = ["get", "set", "delete", "list", "compareAndSet"] as const;

const hasMethods = (value: unknown, methods: readonly string[]): boolean =>
  isObject(value) && methods.every((method) => typeof value[method] === "function");

/** An absolute http(s) URL without credentials; a request's Host never substitutes for it. */
function httpUrl(value: unknown, path: string): void {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ConfigError(`${path} must be an absolute http(s) URL without credentials.`);
  }
}

function isExactOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

/** Explicit machine credentials take precedence over ambient browser identity. */
function normalizeAuth(auth: readonly InboundAuth[]): readonly InboundAuth[] {
  const rank = (provider: InboundAuth) => (provider.kind === "access_token" ? 0 : 1);
  return Object.freeze([...auth].sort((a, b) => rank(a) - rank(b)));
}

/**
 * Resolve `logger`. `"silent"` discards every line; an omitted logger writes
 * to the console with the `[connecta]` prefix.
 */
function resolveLogger(logger: Logger | "silent" | undefined): Logger {
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

const discovery = {
  /**
   * Maximum connector catalogs/status probes fetched at once by discovery
   * operations. Default 4.
   */
  concurrency: whole({ min: 1, default: D.discovery.concurrency }),
  /** Fallback tool-list TTL when the downstream omits ttlMs. Default 300 seconds. */
  catalogTtlSeconds: seconds({ default: D.discovery.catalogTtlSeconds }),
  /** Floor for positive downstream hints. Zero hints always disable reuse. Default 0. */
  catalogMinTtlSeconds: seconds({ default: D.discovery.catalogMinTtlSeconds }),
  /** Ceiling for downstream hints and the fallback, capped by the SDK at 24h. Default 86400. */
  catalogMaxTtlSeconds: seconds({ default: D.discovery.catalogMaxTtlSeconds }),
  /**
   * Deadline (ms) for each downstream probe/catalog call fanned out by
   * `search_tools` and by `connecta.search`/`connecta.describe` inside
   * `execute_code`. Defaults to 30_000. A timed-out connector degrades
   * independently; this does not apply to tool calls. Catalog walks receive the
   * same cancellation signal, which aborts an in-flight page where supported and
   * prevents another from starting.
   */
  probeTimeoutMs: whole({ min: 1, default: D.discovery.probeTimeoutMs }),
};

const calls = {
  /**
   * Deadline (ms) for `call_tool`/`call_destructive_tool` calls that pass no
   * `timeoutMs`. An explicit per-call value wins. Opt-in: unset by default, so
   * existing long-running calls gain no surprise deadline.
   *
   * Each call makes one attempt. `execute_code` host calls are
   * unaffected because they already carry their own bound.
   */
  defaultTimeoutMs: whole({ min: 1 }),
  /**
   * Max inline result size (bytes) before truncation and `connecta.result` paging.
   * A positive whole number; default 24_000. Connectors may override it
   * individually.
   */
  maxResultBytes: whole({ min: 1, default: D.calls.maxResultBytes }),
};

const results = {
  /** Stored bytes, including the paging envelope. Default 8 MiB. Zero disables stashing. */
  maxStashBytes: whole({ min: 0, default: D.results.maxStashBytes }),
  /** Stored or in-flight entries. Default 64. Zero disables stashing. */
  maxStashEntries: whole({ min: 0, default: D.results.maxStashEntries }),
};

const execute = {
  /**
   * Aggregate serialized bytes `connecta.emit` accepts per run. Default
   * 4_000_000 — a transport bound, not a context bound: emitted image/audio
   * blocks reach the model as media, not base64 text.
   */
  maxEmittedBytes: whole({ min: 1, default: D.execute.maxEmittedBytes }),
  /** Content blocks `connecta.emit` accepts per run. Default 32. */
  maxEmittedBlocks: whole({ min: 1, default: D.execute.maxEmittedBlocks }),
  /** Host calls one program may make. Default 20. */
  maxHostCalls: whole({ min: 1, default: D.execute.maxHostCalls }),
  /**
   * Deadline for each host call a program makes, in milliseconds. Default
   * 15_000. Raise it for providers whose legitimate calls run longer, such as
   * analytics queries; `call_tool`'s own `timeoutMs` is unaffected.
   */
  hostCallTimeoutMs: whole({ min: 1, default: D.execute.hostCallTimeoutMs }),
  /**
   * Hard ceiling on one execution, in milliseconds, enforced outside the
   * sandbox. Default 120_000, above both executors' own deadlines (QuickJS
   * 30_000, the Dynamic Worker 60_000), so it only ends a run whose executor
   * never settled; that run fails as unresponsive and its admission slot is
   * released. Keep it above any raised executor deadline.
   */
  watchdogMs: whole({ min: 1, default: D.execute.watchdogMs }),
  /**
   * Trusted-pool writes one program may send, on top of the host-call
   * budget every call already spends. Default 10.
   */
  maxWrites: whole({ min: 1, default: D.execute.maxWrites }),
};

function admissionPool(defaults: {
  concurrency: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  retryAfterMs: number;
}) {
  return {
    /** Simultaneous work admitted to this pool. */
    concurrency: whole({ min: 1, default: defaults.concurrency }),
    /** Callers allowed to wait behind active work. Set zero to fail fast. */
    maxQueueSize: whole({ min: 0, default: defaults.maxQueueSize }),
    /** Maximum queue wait in milliseconds. */
    queueTimeoutMs: whole({ min: 1, default: defaults.queueTimeoutMs }),
    /** Retry hint returned with overload failures, in milliseconds. */
    retryAfterMs: whole({ min: 0, default: defaults.retryAfterMs }),
  };
}

const codeAdmission = admissionPool(D.admission.code);

const requestAdmission = {
  ...admissionPool(D.admission.requests),
  /** Hard lifetime of an admitted /mcp request. Default 300,000 ms. */
  maxDurationMs: whole({
    min: 1,
    max: 2_147_483_647,
    unit: "milliseconds",
    default: D.admission.requests.maxDurationMs,
  }),
};

const admission = {
  /**
   * The `/mcp` request boundary. Defaults to 16 active, 32 queued, and a
   * 5-second maximum wait.
   */
  requests: object(requestAdmission),
  /**
   * Fallback pool for an `executor` that does not implement its own `acquire`.
   * Defaults to 2 active, 8 queued, and a 5-second maximum wait. Bounded
   * executors (including `quickJsExecutor`) keep their own tighter pool.
   */
  code: object(codeAdmission),
};

const identity = {
  /**
   * What this admitted identity may discover and call: `"all"`, or a list
   * whose entries are connector ids (the whole connector) and `connector.tool`
   * addresses (that tool only), or `{ tool: "connector.tool",
   * requireReadOnly: true }` for an exact tool only while its loaded catalog
   * explicitly classifies it read-only. Grants are additive: an unrestricted
   * connector or address grant wins over the guarded form. An address naming
   * a tool the catalog lacks is unreachable and warned once, never widened.
   */
  connectorAccess: fn<
    (
      identity: Readonly<AuthenticatedIdentity>,
    ) => "all" | readonly ConnectorGrant[] | Promise<"all" | readonly ConnectorGrant[]>
  >(),
  /** Global payload-free activity reads. Defaults to interactive humans. */
  activityAccess: fn<(principal: Readonly<IdentityReference>) => boolean | Promise<boolean>>(),
  /** Shared credential and OAuth administration. Defaults to none. */
  credentialAdministration: fn<
    (identity: Readonly<AuthenticatedIdentity>) => ConnectorPermission | Promise<ConnectorPermission>
  >(),
  /** Client-token lifecycle management by interactive humans. Defaults to false. */
  accessTokenManagement: fn<
    (identity: Readonly<AuthenticatedIdentity>) => boolean | Promise<boolean>
  >(),
  /** Connecting or changing the caller's personal account. Defaults to none. */
  personalConnection: fn<
    (identity: Readonly<AuthenticatedIdentity>) => ConnectorPermission | Promise<ConnectorPermission>
  >(),
};

const trust = () => opaque<"trusted" | "read-only", "trusted" | "read-only">({
  check: (value, path) => {
    if (value !== "trusted" && value !== "read-only") {
      throw new ConfigError(`${path} must be "trusted" or "read-only".`);
    }
  },
  resolve: value => value ?? "read-only",
});

const pool = {
  /** Programs may write only in trusted pools. Default read-only. */
  trust: trust(),
  /** Connector ids and exact `connector.tool` addresses in this pool. */
  tools: required(
    opaque<readonly string[]>({
      check: (value, path) => {
        if (!Array.isArray(value)) {
          throw new ConfigError(
            `${path} must be an array of connector ids or connector.tool addresses.`,
          );
        }
      },
    }),
  ),
  /**
   * Whether this admitted identity may open the pool. Denied by default:
   * a pool with no grant serves nobody. A false return, a throw, and an
   * undeclared pool name are the same 404.
   */
  grant: fn<(identity: Readonly<AuthenticatedIdentity>) => boolean | Promise<boolean>>(),
};

const icon = {
  src: required(text()),
  mimeType: text(),
  sizes: array(text()),
};

const serverInfo = {
  name: text(),
  version: text(),
  /** Human-readable name clients may show instead of `name`. */
  title: text(),
  /** Homepage clients may link from the server listing: an absolute http(s) URL. */
  websiteUrl: opaque<string>({ check: httpUrl }),
  /** MCP icons-spec entries; clients render these instead of a scraped favicon. */
  icons: array(object(icon)),
};

const connectaConfig = {
  connectors: required(
    array(
      opaque<Connector>({
        check: (value, path) => {
          if (isObject(value) && Object.hasOwn(value, "approval")) {
            throw new ConfigError(`${path}.approval was removed; configure pool trust instead.`);
          }
          if (!isObject(value) || typeof value.id !== "string" ||
            typeof value.listTools !== "function" || typeof value.callTool !== "function") {
            throw new ConfigError(
              `${path} must be a Connector: an object with an id, listTools, and callTool.`,
            );
          }
        },
      }),
    ),
  ),
  /** Inbound auth adapters, such as clerkAuth(...); omit for open (dev). */
  auth: opaque<InboundAuth | InboundAuth[], readonly InboundAuth[]>({
    check: (value, path) => {
      const list = Array.isArray(value) ? value : [value];
      list.forEach((provider, index) => {
        if (!isObject(provider) || typeof provider.kind !== "string" ||
          typeof provider.authorize !== "function" ||
          ["recognizesCredential", "handleMetadata", "challenge"].some(key => provider[key] !== undefined && typeof provider[key] !== "function")) {
          throw new ConfigError(
            `${Array.isArray(value) ? `${path}[${index}]` : path} must be an inbound auth adapter.`,
          );
        }
        if (provider.recognizesCredential !== undefined && Object.prototype.toString.call(provider.recognizesCredential) === "[object AsyncFunction]") {
          throw new ConfigError(`${Array.isArray(value) ? `${path}[${index}]` : path}.recognizesCredential must be synchronous.`);
        }
        if ("finalRefusals" in provider) {
          throw new ConfigError(`${Array.isArray(value) ? `${path}[${index}]` : path}.finalRefusals is retired; use synchronous recognizesCredential.`);
        }
      });
    },
    resolve: (value) =>
      normalizeAuth(value === undefined ? [] : Array.isArray(value) ? value : [value]),
  }),
  /** Code-derived connection visibility and independent management permissions. */
  identity: object(identity),
  /** Named tool pools, each served at `/mcp/<name>` to identities its grant admits. */
  pools: record(object(pool)),
  /** Trust of the default /mcp endpoint. Default read-only. */
  trust: trust(),
  /** Exact connector id -> tool name -> verdict. Unknown names fail at catalog publication. */
  classification: record(record(opaque<"read" | "write">({
    check: (value, path) => {
      if (value !== "read" && value !== "write") {
        throw new ConfigError(`${path} must be "read" or "write".`);
      }
    },
  }))),
  /**
   * The deployment's one store: `d1Storage(env.CONNECTA_DB)` from
   * `@zackbart/connecta/d1` on Workers, `sqliteStorage(path)` from
   * `@zackbart/connecta/sqlite` on Node. Defaults to memoryStorage(), which
   * forgets everything on restart.
   */
  storage: opaque<KVStorage, KVStorage>({
    // Every subsystem relies on the atomic claim and enumeration, so storage
    // without them is refused here rather than at the first OAuth callback.
    // The likeliest cause is a 0.28 deployment still passing its Workers KV
    // adapter, which could never offer either guarantee.
    check: (value, path) => {
      const missing = STORAGE_METHODS.filter((method) => !hasMethods(value, [method]));
      if (missing.length === 0) return;
      throw new ConfigError(
        `${path} must implement ${missing.join(" and ")}. ` +
          "Use d1Storage(env.CONNECTA_DB) from @zackbart/connecta/d1 on Workers, " +
          "sqliteStorage(path) from @zackbart/connecta/sqlite on Node, or " +
          "memoryStorage() in tests. Workers KV is not supported: it is eventually " +
          "consistent and cannot compare-and-set.",
      );
    },
    resolve: (value) => value ?? memoryStorage(),
  }),
  /**
   * Public base URL. Defaults to the request origin per-request. Configuring an
   * HTTPS URL also redirects matching inbound HTTP requests to HTTPS.
   */
  publicUrl: opaque<string>({ check: httpUrl }),
  /**
   * Exact browser MCP origins, or "*". Defaults to publicUrl's origin and
   * HTTP(S) loopback origins at any port. Originless clients are admitted.
   */
  allowedOrigins: opaque<readonly string[] | "*">({
    check: (value) => {
      if (value !== "*" && (!Array.isArray(value) || !value.every(isExactOrigin))) {
        throw new ConfigError(
          'ConnectaConfig.allowedOrigins must be an array of exact HTTP(S) origins or "*".',
        );
      }
    },
  }),
  /** Optional recorder and reader, created by activityHistory() from /activity. */
  activity: opaque<ActivityModule>({
    check: (value) => {
      if (!isObject(value) || typeof value.recordTool !== "function") {
        throw new ConfigError("ConnectaConfig.activity must be created with activityHistory(...)");
      }
    },
  }),
  /** Replaceable owner-partitioned credential storage. Omit for config-owned secrets. */
  vault: opaque<CredentialVault>({
    check: (value) => {
      if (
        !hasMethods(value, ["get", "getAll", "set", "setAll", "metadata", "delete"]) ||
        ["seal", "open", "signOAuthHandoff", "verifyOAuthHandoff"].some(
          (key) => !["undefined", "function"].includes(typeof (value as Record<string, unknown>)[key]),
        )
      ) {
        throw new ConfigError("ConnectaConfig.vault must implement CredentialVault");
      }
    },
  }),
  /** Optional connection UI, created by operatorUi() from /ui. */
  ui: opaque<OperatorSurface>({
    check: (value) => {
      if (!hasMethods(value, ["handle", "credentialHandoffUrl"]) ||
        !Array.isArray((value as Record<string, unknown>).reservedPaths)) {
        throw new ConfigError("ConnectaConfig.ui must be created with operatorUi(...)");
      }
    },
  }),
  /** Optional managed client tokens, created by accessTokens() from /auth/access-tokens. */
  accessTokens: opaque<AccessTokensModule>({
    check: (value) => {
      const auth = isObject(value) ? value.auth : undefined;
      if (
        !hasMethods(value, ["handle"]) ||
        !isObject(auth) ||
        typeof auth.authorize !== "function" ||
        auth.interactiveOperator
      ) {
        throw new ConfigError(
          "ConnectaConfig.accessTokens must be created with accessTokens(storage) from " +
            "@zackbart/connecta/auth/access-tokens; reuse your existing storage to preserve tokens",
        );
      }
    },
  }),
  /** Tool-catalog TTL bounds and probe deadlines. */
  discovery: object(discovery),
  /** Deployment-wide call deadlines and result paging threshold. */
  calls: object(calls),
  /** Runtime-wide transient result stash limits, shared across subjects. */
  results: object(results),
  /** Budgets for execute_code programs: host calls, writes, and `connecta.emit`. */
  execute: object(execute),
  /**
   * Runtime-portable server-memory boundaries. `/health` and operator routes
   * do not consume these permits, so they remain responsive during MCP
   * saturation.
   */
  admission: object(admission),
  /** Diagnostic output. Use "silent" to disable all diagnostic logging. */
  logger: opaque<Logger | "silent", Logger>({
    check: (value, path) => {
      if (value !== "silent" && !hasMethods(value, ["debug", "info", "warn", "error"])) {
        throw new ConfigError(`${path} must be a Logger or "silent".`);
      }
    },
    resolve: resolveLogger,
  }),
  serverInfo: object(serverInfo),
  /** Deployment metadata exposed by /health (for example a Worker version). */
  deploymentInfo: opaque<Record<string, unknown>>({
    check: (value, path) => {
      if (!isObject(value)) throw new ConfigError(`${path} must be an object.`);
    },
  }),
  /**
   * Required sandbox for `execute_code`. Workers use
   * `workerExecutor({ loader: env.LOADER })` from
   * `@zackbart/connecta/worker`; Node uses `quickJsExecutor()` from
   * `@zackbart/connecta/quickjs`. Direct upstream DynamicWorkerExecutor
   * construction throws because its request-owned handles cannot be released.
   * Custom sandboxes explicitly opt in with
   * `customExecutor(myExecutor, { lifecycle: "self-managed" })`.
   */
  executor: required(
    opaque<Executor>({
      check: (value) => assertExecutor(value as Executor),
    }),
    () =>
      "ConnectaConfig.executor is required. Configure quickJsExecutor() from " +
      '"@zackbart/connecta/quickjs" on Node, or ' +
      "workerExecutor({ loader: env.LOADER }) from " +
      '"@zackbart/connecta/worker" around DynamicWorkerExecutor on Workers.',
  ),
};

const CONFIG = object(connectaConfig);

/** A deployment's whole configuration, passed to `createConnecta`. */
export type ConnectaConfig = ConfigInput<typeof connectaConfig>;
/** Tool-catalog TTL bounds and probe deadlines. */
export type ConnectaDiscoveryConfig = ConfigInput<typeof discovery>;
/** Deployment-wide call deadlines and inline-result paging thresholds. */
export type ConnectaCallsConfig = ConfigInput<typeof calls>;
/** Runtime-wide bounds for transient direct-call result paging. */
export type ConnectaResultsConfig = ConfigInput<typeof results>;
/** Budgets for execute_code programs: host calls and rich output (`connecta.emit`). */
export type ConnectaExecuteConfig = ConfigInput<typeof execute>;
export type AdmissionPoolConfig = ConfigInput<typeof codeAdmission>;
export type RequestAdmissionConfig = ConfigInput<typeof requestAdmission>;
/** Runtime-portable server-memory boundaries for `/mcp` and fallback code-mode work. */
export type ConnectaAdmissionConfig = ConfigInput<typeof admission>;
export type ConnectaIdentityConfig = ConfigInput<typeof identity>;
/**
 * A named tool pool served at `/mcp/<name>`. The pool is the slice a client
 * pointed at that endpoint may see; the identity's own `connectorAccess`
 * remains its ceiling and the pool can only narrow it.
 */
export type ConnectaPoolConfig = ConfigInput<typeof pool>;

type Parsed = ConfigOutput<typeof connectaConfig>;

/**
 * The configuration a Connecta runs with: validated, every default applied,
 * auth ordered, and `serverInfo` named and
 * versioned. Built once by createConnecta; nothing downstream re-derives it.
 */
export interface ResolvedConfig extends Omit<Parsed, "serverInfo"> {
  /** `serverInfo` with its name and version defaults applied. */
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
    readonly title?: string;
    readonly websiteUrl?: string;
    readonly icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
  };
}

/** Pause-only options #672 removed with `resume_execution`. */
const RETIRED_PAUSE_OPTIONS = [
  "ConnectaConfig.execute.resumableWrites",
  "ConnectaConfig.execute.pausedRunTtlSeconds",
];

function rejectUnknownOptions(paths: string[]): void {
  if (paths.length === 0) return;
  throw new ConfigError(
    `Unknown Connecta configuration option${paths.length === 1 ? "" : "s"}:\n` +
      paths.map((path) => `- ${path}`).join("\n") +
      (paths.includes("ConnectaConfig.credentials") ? "\nUse vault: encryptedCredentialVault(storage, key) from @zackbart/connecta/credentials." : "") +
      (paths.includes("ConnectaConfig.branding") ? "\nMove branding into ui: operatorUi({ branding }) from @zackbart/connecta/ui." : "") +
      (paths.includes("ConnectaConfig.execute.approval") ? "\nexecute.approval was removed. Set trust: \"trusted\" on a pool to allow program writes; the default is read-only." : "") +
      (paths.some((path) => RETIRED_PAUSE_OPTIONS.includes(path))
        ? "\nPrograms no longer pause at writes, so there is nothing to configure: read-only pools route writes through call_destructive_tool; trusted pools allow program writes (issue #672). Delete the option."
        : ""),
  );
}

/** Checks that span fields; each value is already individually valid. */
function assertCoherent(config: Parsed): void {
  if (config.discovery.catalogMinTtlSeconds > config.discovery.catalogMaxTtlSeconds || config.discovery.catalogMaxTtlSeconds > 86_400) {
    throw new ConfigError("ConnectaConfig.discovery requires catalogMinTtlSeconds <= catalogMaxTtlSeconds <= 86400.");
  }

}

/**
 * Validate a configuration and apply every default. Unknown keys are refused
 * first, before any value is read, so a typo beside a getter or a secret
 * neither runs it nor echoes it; then each present value is checked in
 * schema order and the first mistake throws with its path.
 */
export function resolveConfig(config: ConnectaConfig): ResolvedConfig {
  return readConfig(config).resolved;
}

/**
 * {@link resolveConfig}, also returning the plain copy it resolved: the
 * configuration as read through property descriptors, which is what any later
 * question about what the deployment set explicitly must read, never the
 * caller's object, whose getters or Proxy traps must not run.
 */
export function readConfig(config: ConnectaConfig): { input: ConnectaConfig; resolved: ResolvedConfig } {
  const read = readPlain(config, "ConnectaConfig", CONFIG);
  rejectUnknownOptions(read.unknown);
  const input = read.value as ConnectaConfig;
  const parsed = CONFIG.parse(input, "ConnectaConfig");
  assertCoherent(parsed);
  const info = {
    ...parsed.serverInfo,
    name: parsed.serverInfo.name ?? "connecta",
    version: parsed.serverInfo.version ?? CONNECTA_VERSION,
  } as ResolvedConfig["serverInfo"];
  const resolved: ResolvedConfig = Object.freeze({
    ...parsed,
    // A managed-token module contributes one more provider, ordered with the rest.
    auth: parsed.accessTokens ? normalizeAuth([parsed.accessTokens.auth, ...parsed.auth]) : parsed.auth,
    serverInfo: Object.freeze(info),
  });
  return { input, resolved };
}

/**
 * Declare a deployment's configuration as a function of its environment:
 * `process.env` on Node, the Worker's `env` bindings on Workers. Optional
 * modules are ordinary type-checked expressions —
 * `vault: env.KEY ? encryptedCredentialVault(storage, env.KEY) : undefined` —
 * rather than commented blocks, and the entry file stays a few lines: it
 * imports the default export of its `connecta.config.ts` and calls
 * `createConnecta(config(process.env))`.
 *
 * The factory runs when the entry calls it, never at import, so a Worker can
 * import it at global scope. Validation still happens in createConnecta.
 */
export function defineConfig<Env>(
  factory: (env: Env) => ConnectaConfig,
): (env: Env) => ConnectaConfig {
  return factory;
}

/** The execute_code budgets a runner enforces, read from one resolved config. */
export function executeLimits(config: ResolvedConfig) {
  return {
    discoveryConcurrency: config.discovery.concurrency,
    probeTimeoutMs: config.discovery.probeTimeoutMs,
    maxEmittedBytes: config.execute.maxEmittedBytes,
    maxEmittedBlocks: config.execute.maxEmittedBlocks,
    maxHostCalls: config.execute.maxHostCalls,
    hostCallTimeoutMs: config.execute.hostCallTimeoutMs,
    watchdogMs: config.execute.watchdogMs,
    maxWrites: config.execute.maxWrites,
  };
}
