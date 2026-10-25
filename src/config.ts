import { registerAgentDescriptions } from "./agent-description.js";
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

import type { CredentialVault } from "./credential-contract.js";
import { CONFIG_DEFAULTS as D } from "./config-defaults.js";
import {
  array,
  ConfigError,
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
import { agentConfig } from "./agent-config.js";
import { vercelAgentAuth } from "./auth/vercel-agent.js";
import type { MemberRef } from "./membership.js";
import { assertExecutor } from "./executor-contract.js";
import type { AccessTokensModule, ActivityModule, OperatorSurface } from "./module-contracts.js";
import { memoryStorage } from "./storage/memory.js";
import type { Connector, Executor, InboundAuth, KVStorage, Logger } from "./types.js";
import { CONNECTA_VERSION } from "./version.js";
import { isWorkspaceAddress } from "./workspace-address.js";

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
  return (
    logger ?? {
      debug: (...a) => console.debug("[connecta]", ...a),
      info: (...a) => console.info("[connecta]", ...a),
      warn: (...a) => console.warn("[connecta]", ...a),
      error: (...a) => console.error("[connecta]", ...a),
    }
  );
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
   * Writes one program may send on a writable endpoint, on top of the host-call
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

/** The choice every deployment makes explicitly while `trust` migrates (#820). */
const READ_ONLY_REQUIRED = (path: string) =>
  `${path} is required. Choose readOnly: true to refuse every write on /mcp, or readOnly: false to let ` +
  "call_destructive_tool and programs write with MCP client approval. Pools inherit it unless they set their own.";

function assertFlag(value: unknown, path: string): void {
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be true or false.`);
}

/** Longest pool `description`, in characters, after trimming. */
const MAX_POOL_DESCRIPTION_LENGTH = 500;

/**
 * A pool description is one line of prose for the model. C0 and C1 controls
 * (including NEL), plus Unicode line and paragraph separators, are refused.
 * A scan, as in remote-mcp.ts,
 * because a character class over the control range trips `no-control-regex`.
 */
function hasLineBreakOrControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function assertPoolDescription(value: unknown, path: string): void {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  if (
    trimmed === undefined ||
    trimmed.length === 0 ||
    [...trimmed].length > MAX_POOL_DESCRIPTION_LENGTH ||
    hasLineBreakOrControlCharacter(trimmed)
  ) {
    throw new ConfigError(
      `${path} must be text of 1 to ${MAX_POOL_DESCRIPTION_LENGTH} characters after trimming, with no line breaks or control characters.`,
    );
  }
}

/** Shape only; each reference resolves against auth and agents in createConnecta. */
function assertMemberList(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path} must be an array of principal ids, { namespace, id }, or "agent:<name>".`);
  }
}

const pool = {
  /**
   * Whether this pool's endpoint refuses every write: write tools are absent
   * from search_tools, tool listings, and describe, and every write call is
   * refused. Inherits the deployment's `readOnly` unless set here, in either
   * direction.
   */
  readOnly: opaque<boolean>({ check: assertFlag }),
  /** Connector ids and exact `connector.tool` addresses in this pool. */
  tools: required(
    opaque<readonly string[]>({
      check: (value, path) => {
        if (!Array.isArray(value)) {
          throw new ConfigError(`${path} must be an array of connector ids or connector.tool addresses.`);
        }
      },
    }),
  ),
  /**
   * Who may open `/mcp/<name>`: principal ids in the namespace of the one
   * interactive auth provider, `{ namespace, id }`, or `"agent:<name>"` for a
   * declared agent. Required and non-empty; the pool serves exactly its
   * `tools` to these members and the same 404 to everyone else.
   */
  members: required(
    opaque<readonly MemberRef[]>({ check: assertMemberList }),
    (path) =>
      `${path} is required: list who may open this pool, as principal ids, { namespace, id }, or "agent:<name>".`,
  ),
  /**
   * The Google Workspace address agents in this pool act as, on a Workspace
   * connector whose `subject` is a mapping function. Humans always act as
   * themselves through that mapping, and a fixed `subject` address applies to
   * everyone. Without an owner, a mapping-subject Workspace connector is
   * absent for this pool's agents, as a personal connector is; people in the
   * pool still see it.
   */
  owner: opaque<string>({
    check: (value, path) => {
      if (typeof value !== "string" || !isWorkspaceAddress(value.trim())) {
        throw new ConfigError(`${path} must be a Google Workspace email address.`);
      }
    },
  }),
  /**
   * What this pool is for, in plain words for the model: appended to the MCP
   * `initialize` instructions at `/mcp/<name>` and `/agent/<name>`, so a
   * caller learns its scope ("Team tier: shared tools only."). Trimmed, 1 to
   * 500 characters, no line breaks or control characters. It grants and hides nothing; plain
   * `/mcp` never shows it.
   */
  description: opaque<string>({ check: assertPoolDescription }),
  /**
   * The tools this pool's endpoints list. `"meta"`, the default, is the six
   * meta-tools. `"native"` lists each downstream tool directly, named
   * `<connector>__<tool>` and annotated from its classification, for clients
   * that run their own tool search; calls take the same invocation path.
   */
  surface: opaque<"meta" | "native">({
    check: (value, path) => {
      if (value !== "meta" && value !== "native") throw new ConfigError(`${path} must be "meta" or "native".`);
    },
  }),
  /**
   * `false` drops `execute_code` from a native pool and lists `read_result`
   * for paging instead. Only valid with `surface: "native"`: the meta surface
   * always includes it.
   */
  executeCode: opaque<boolean>({ check: assertFlag }),
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
            throw new ConfigError(
              `${path}.approval was removed; the MCP client owns approval. Set readOnly: true to refuse writes.`,
            );
          }
          if (
            !isObject(value) ||
            typeof value.id !== "string" ||
            typeof value.listTools !== "function" ||
            typeof value.callTool !== "function"
          ) {
            throw new ConfigError(`${path} must be a Connector: an object with an id, listTools, and callTool.`);
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
        if (
          !isObject(provider) ||
          typeof provider.kind !== "string" ||
          typeof provider.authorize !== "function" ||
          ["recognizesCredential", "handleMetadata", "challenge"].some(
            (key) => provider[key] !== undefined && typeof provider[key] !== "function",
          )
        ) {
          throw new ConfigError(
            `${Array.isArray(value) ? `${path}[${index}]` : path} must be an inbound auth adapter.`,
          );
        }
        if (
          provider.recognizesCredential !== undefined &&
          Object.prototype.toString.call(provider.recognizesCredential) === "[object AsyncFunction]"
        ) {
          throw new ConfigError(
            `${Array.isArray(value) ? `${path}[${index}]` : path}.recognizesCredential must be synchronous.`,
          );
        }
        if ("finalRefusals" in provider) {
          throw new ConfigError(
            `${Array.isArray(value) ? `${path}[${index}]` : path}.finalRefusals is retired; use synchronous recognizesCredential.`,
          );
        }
      });
    },
    resolve: (value) => normalizeAuth(value === undefined ? [] : Array.isArray(value) ? value : [value]),
  }),
  /**
   * Agents, declared by name: lowercase letters, digits, `_` and `-`, each
   * unique. With `accessTokens`, each has one `cta_` slot operators issue, rotate, and
   * revoke; nothing outside code adds, renames, or rebinds an agent. Removing
   * a name stops its credentials on the next request. A string name requires
   * `accessTokens`; `{ name, vercel: { team, project, environments? } }` also
   * accepts Vercel OIDC. Requires an immutable team_ ID; prefer a prj_ ID for the project. Environments
   * default to production. Both credential types may coexist.
   * An admitted agent carries `identity.agent` and has no principal, so
   * personal connectors are absent for it. Defaults to none.
   */
  agents: agentConfig,
  /**
   * The people who may use plain `/mcp`, which serves the whole catalog with
   * the deployment's `readOnly`, and who administer the deployment. Same
   * reference forms as pool `members`, people only. Required with inbound
   * auth; a maintainer opens no pool unless listed among its members.
   */
  maintainers: opaque<readonly MemberRef[]>({ check: assertMemberList }),
  /** Named tool pools, each served at `/mcp/<name>` to its members only. */
  pools: record(object(pool)),
  /** Exact connector id -> tool name -> verdict. Hidden tools cannot be discovered or called.
   * Unknown static names fail construction; absent runtime names stay dormant and are reported. */
  classification: record(
    record(
      opaque<"read" | "write" | "hidden">({
        check: (value, path) => {
          if (value !== "read" && value !== "write" && value !== "hidden") {
            throw new ConfigError(`${path} must be "read", "write", or "hidden".`);
          }
        },
      }),
    ),
  ),
  /**
   * The deployment's one store: `d1Storage(env.CONNECTA_DB)` from
   * `@zackbart/connecta/d1` on Workers, `sqliteStorage(path)` from
   * `@zackbart/connecta/sqlite` on Node. Defaults to memoryStorage(), which
   * forgets everything on restart.
   * Custom adapters must declare `capabilities.absoluteExpiry: true` and honor
   * `expiresAtMs` on set and compareAndSet; older adapters fail construction.
   */
  storage: opaque<KVStorage, KVStorage>({
    // Every subsystem relies on the atomic claim and enumeration, so storage
    // without them is refused here rather than at the first OAuth callback.
    // The likeliest cause is a 0.28 deployment still passing its Workers KV
    // adapter, which could never offer either guarantee.
    check: (value, path) => {
      const missing = STORAGE_METHODS.filter((method) => !hasMethods(value, [method]));
      if (missing.length > 0)
        throw new ConfigError(
          `${path} must implement ${missing.join(" and ")}. ` +
            "Use d1Storage(env.CONNECTA_DB) from @zackbart/connecta/d1 on Workers, " +
            "sqliteStorage(path) from @zackbart/connecta/sqlite on Node, or " +
            "memoryStorage() in tests. Workers KV is not supported: it is eventually " +
            "consistent and cannot compare-and-set.",
        );
      if (!isObject(value) || !isObject(value.capabilities) || value.capabilities.absoluteExpiry !== true) {
        throw new ConfigError(
          `${path} must declare capabilities.absoluteExpiry: true and honor expiresAtMs on set and compareAndSet. ` +
            "Upgrade the storage adapter before declaring this capability.",
        );
      }
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
        throw new ConfigError('ConnectaConfig.allowedOrigins must be an array of exact HTTP(S) origins or "*".');
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
      if (
        !hasMethods(value, ["handle", "credentialHandoffUrl"]) ||
        !Array.isArray((value as Record<string, unknown>).reservedPaths)
      ) {
        throw new ConfigError("ConnectaConfig.ui must be created with operatorUi(...)");
      }
    },
  }),
  /** Optional agent tokens for the declared `agents`, created by accessTokens() from /auth/access-tokens. */
  accessTokens: opaque<AccessTokensModule>({
    check: (value) => {
      const auth = isObject(value) ? value.auth : undefined;
      if (
        !hasMethods(value, ["handle", "slots", "forAgents"]) ||
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
  /**
   * Required. Whether the default /mcp endpoint refuses every write. `true`:
   * write tools are absent from search_tools, tool listings, and describe,
   * and call_tool, call_destructive_tool, and program writes are refused.
   * `false`: call_destructive_tool and programs may write, and the MCP
   * client owns approval. Pools inherit it unless they set their own. It has
   * no default while deployments migrate from `trust` (#820).
   */
  readOnly: required(opaque<boolean, boolean>({ check: assertFlag }), (path) => READ_ONLY_REQUIRED(path)),
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
/**
 * A named tool pool served at `/mcp/<name>`: exactly its `tools`, to its
 * `members` only.
 */
export type ConnectaPoolConfig = ConfigInput<typeof pool>;

type Parsed = ConfigOutput<typeof connectaConfig>;

/**
 * The configuration a Connecta runs with: validated, every default applied,
 * auth ordered, and `serverInfo` named and versioned. Built once by createConnecta; nothing downstream re-derives it.
 */
export interface ResolvedConfig extends Omit<Parsed, "serverInfo" | "agents"> {
  readonly agents: readonly string[];
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
const RETIRED_PAUSE_OPTIONS = ["ConnectaConfig.execute.resumableWrites", "ConnectaConfig.execute.pausedRunTtlSeconds"];

/** Access options pools replaced (#837, decisions/0006). */
const isRetiredPoolGrant = (path: string): boolean => /^ConnectaConfig\.pools\.[^.]+\.grant$/.test(path);

/** Management resolvers maintainers and pool membership replaced (#837, decisions/0006). */
const RETIRED_IDENTITY: ReadonlyArray<readonly [string, string]> = [
  ["credentialAdministration", "maintainers administer shared credentials and OAuth grants. List them in maintainers."],
  [
    "personalConnection",
    "pool members connect and disconnect their own personal connectors in their pools, and maintainers their own. Add people to a pool's members.",
  ],
  [
    "accessTokenManagement",
    "maintainers issue, rotate, and revoke agent tokens from an interactive session. List them in maintainers.",
  ],
  ["activityAccess", "maintainers read activity; activity.readGate can still narrow it. List them in maintainers."],
];

/** `trust`, on the deployment or a pool, was replaced by `readOnly` (#820). */
const isRetiredTrust = (path: string): boolean =>
  path === "ConnectaConfig.trust" || (path.startsWith("ConnectaConfig.pools.") && path.endsWith(".trust"));

/**
 * `identity` was removed whole (#837), so the walk reports only the section.
 * Name each key it still holds, read by descriptor without running a getter
 * or echoing a value, so a retired resolver's message names its replacement.
 */
function expandRetiredIdentity(config: unknown, paths: string[]): string[] {
  if (!paths.includes("ConnectaConfig.identity")) return paths;
  let keys: string[] = [];
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(config as object, "identity");
    const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
    }
  } catch {
    keys = [];
  }
  if (keys.length === 0) return paths;
  return paths.flatMap((path) =>
    path === "ConnectaConfig.identity" ? keys.map((key) => `ConnectaConfig.identity.${key}`) : [path],
  );
}

function rejectUnknownOptions(paths: string[]): void {
  if (paths.length === 0) return;
  throw new ConfigError(
    `Unknown Connecta configuration option${paths.length === 1 ? "" : "s"}:\n` +
      paths.map((path) => `- ${path}`).join("\n") +
      (paths.includes("ConnectaConfig.credentials")
        ? "\nUse vault: encryptedCredentialVault(storage, key) from @zackbart/connecta/credentials."
        : "") +
      (paths.includes("ConnectaConfig.branding")
        ? "\nMove branding into ui: operatorUi({ branding }) from @zackbart/connecta/ui."
        : "") +
      (paths.includes("ConnectaConfig.execute.approval")
        ? "\nexecute.approval was removed. The MCP client owns approval; set readOnly: true on the deployment or a pool to refuse writes."
        : "") +
      (paths.some((path) => RETIRED_PAUSE_OPTIONS.includes(path))
        ? "\nPrograms no longer pause at writes, so there is nothing to configure: writable endpoints let programs and call_destructive_tool write; readOnly endpoints refuse every write (issue #672). Delete the option."
        : "") +
      (paths.includes("ConnectaConfig.identity.connectorAccess")
        ? "\nidentity.connectorAccess was removed (#837): pools are the access model. List who may use plain /mcp in maintainers, and give each pool its tools and members. A guarded { tool, requireReadOnly: true } grant becomes a pool with readOnly: true."
        : "") +
      RETIRED_IDENTITY.filter(([key]) => paths.includes(`ConnectaConfig.identity.${key}`))
        .map(([key, replacement]) => `\nidentity.${key} was removed (#837): ${replacement}`)
        .join("") +
      (paths.some((path) => path === "ConnectaConfig.identity" || path.startsWith("ConnectaConfig.identity."))
        ? "\nThe identity section was removed (#837): maintainers and pool members decide access and management. Delete it."
        : "") +
      (paths.includes("ConnectaConfig.grant")
        ? "\nThe top-level grant was removed (#837); list the people who may use plain /mcp in maintainers."
        : "") +
      (paths.some(isRetiredPoolGrant)
        ? "\nPool grant was removed (#837); list who may open the pool in its members."
        : "") +
      (paths.some(isRetiredTrust)
        ? '\ntrust was removed (#820); set readOnly, which every deployment now chooses explicitly. trust: "read-only" becomes readOnly: true, which now also refuses call_destructive_tool. trust: "trusted" becomes readOnly: false. A pool inherits the deployment readOnly unless it sets its own.'
        : ""),
  );
}

/** Checks that span fields; each value is already individually valid. */
function assertCoherent(config: Parsed): void {
  if (
    config.discovery.catalogMinTtlSeconds > config.discovery.catalogMaxTtlSeconds ||
    config.discovery.catalogMaxTtlSeconds > 86_400
  ) {
    throw new ConfigError("ConnectaConfig.discovery requires catalogMinTtlSeconds <= catalogMaxTtlSeconds <= 86400.");
  }
  if (config.agents.some((agent) => !agent.vercel) && !config.accessTokens) {
    throw new ConfigError(
      "ConnectaConfig.agents needs accessTokens: accessTokens(storage) from @zackbart/connecta/auth/access-tokens " +
        "holds each agent's token slot.",
    );
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
  rejectUnknownOptions(expandRetiredIdentity(config, read.unknown));
  const input = read.value as ConnectaConfig;
  const parsed = CONFIG.parse(input, "ConnectaConfig");
  assertCoherent(parsed);
  const info = {
    ...parsed.serverInfo,
    name: parsed.serverInfo.name ?? "connecta",
    version: parsed.serverInfo.version ?? CONNECTA_VERSION,
  } as ResolvedConfig["serverInfo"];
  // The token module admits exactly the agents this configuration declares.
  const agents = Object.freeze(parsed.agents.map((agent) => agent.name));
  const accessTokens = parsed.accessTokens?.forAgents(agents);
  const vercel = vercelAgentAuth(parsed.agents, parsed.logger);
  const resolved: ResolvedConfig = Object.freeze({
    ...parsed,
    agents,
    accessTokens,
    // A managed-token module contributes one more provider, ordered with the rest.
    auth: normalizeAuth([...(accessTokens ? [accessTokens.auth] : []), ...(vercel ? [vercel] : []), ...parsed.auth]),
    serverInfo: Object.freeze(info),
  });
  registerAgentDescriptions(resolved, parsed.agents, accessTokens !== undefined);
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
export function defineConfig<Env>(factory: (env: Env) => ConnectaConfig): (env: Env) => ConnectaConfig {
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
