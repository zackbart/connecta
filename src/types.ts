import type { CallErrorDetails } from "./errors.js";
// Core contracts for connecta. Web-API only — no node: imports here.

/** A JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

/**
 * Minimal key/value store — the only state connecta needs. Keys and list
 * prefixes must not contain U+0000 (NUL); adapters reject them with TypeError
 * before accessing storage. SQL TEXT results truncate at NUL on Node 22.
 */
export interface KVStorage {
  /** The live value at `key`; null when absent or expired. */
  get(key: string): Promise<string | null>;
  /**
   * Write `value`. With `opts.ttlSeconds` the entry reads as absent once that
   * many seconds pass; omitted or zero means no expiry. Shared stores must
   * create and check expiry with a storage-owned clock, not each caller's clock.
   */
  set(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  /** Live keys beginning with `prefix`, sorted by UTF-16 code unit. */
  list(prefix: string): Promise<string[]>;
  /**
   * Atomic compare-and-set: write `next` only if the key's current value is
   * exactly `expected`, and report whether the write happened. `expected:
   * null` means "absent", and an expired entry is absent. `next: null`
   * deletes; otherwise `next` is stored with `options.ttlSeconds`, or with no
   * expiry when that is omitted, exactly as `set` would. On `false` nothing
   * changed.
   *
   * Atomic means linearizable against every other operation on the same
   * store, `set` and `delete` included: of N concurrent `compareAndSet(key,
   * null, value)` claims on an absent key, exactly one returns true.
   *
   * Required. Every subsystem that must claim a key exactly once relies on
   * it, and none of them carries a read-then-write fallback. The shipped
   * adapters are `memoryStorage()`, `d1Storage()` from
   * `@zackbart/connecta/d1`, and `sqliteStorage()` from
   * `@zackbart/connecta/sqlite`; an eventually consistent store such as
   * Cloudflare Workers KV cannot implement it and is not supported.
   */
  compareAndSet(
    key: string,
    expected: string | null,
    next: string | null,
    options?: { ttlSeconds?: number },
  ): Promise<boolean>;
  /**
   * Which adapter this is, for `Connecta.describeConfig()`. The shipped
   * adapters answer `"memory"`, `"d1"`, or `"sqlite"`; any other answer, or
   * none, is described as `"custom"`. Never a path, binding, or value.
   */
  describe?(): { kind: string };
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ToolDef {
  /** Final verdict on a request-scoped published catalog entry. Never persisted. */
  classification?: "read" | "write";
  name: string; // unique within the connector
  description?: string;
  /** Downstream display metadata retained with the catalog. */
  title?: string;
  icons?: Array<{
    src: string;
    mimeType?: string;
    sizes?: string[];
    theme?: "light" | "dark";
  }>;
  /** Downstream execution requirements, enforced even on a cached catalog. */
  execution?: { taskSupport?: "required" | "optional" | "forbidden" };
  inputSchema?: JsonSchema;
  /** Optional JSON Schema describing the tool's structured result. */
  outputSchema?: JsonSchema;
  /**
   * Standard MCP tool behavior hints plus provider-specific extensions.
   * The registry classifies these after deployment overrides and provider
   * review. Only a stored read verdict may use call_tool; program writes
   * require a trusted pool. Approval belongs to the host.
   */
  annotations?: ToolAnnotations;
}

export interface ToolAnnotations extends Record<string, unknown> {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Inputs a connector may reduce to a non-secret admission partition key. */
export interface ConnectorCallAdmissionInput {
  toolName: string;
  args: unknown;
}

/** Exact sliding-window budget for one connector-call partition. */
export interface ConnectorRollingWindowBudget {
  kind: "rolling-window";
  /** Calls admitted during `windowMs` before another is proactively refused. */
  maxCalls: number;
  /** Width of the rolling window in milliseconds. */
  windowMs: number;
}

/**
 * One connector-level downstream call-admission rule.
 *
 * This release accepts the plural `rules` container below but enforces exactly
 * one rule. That keeps the public shape ready for providers whose concurrency
 * and budget limits eventually need different partition dimensions without
 * pretending multi-rule admission is already atomic.
 */
export interface ConnectorCallAdmissionRule {
  /** Maximum simultaneous tool calls and resource reads in one partition. */
  maxConcurrency?: number;
  /** Callers allowed to wait behind the concurrency bound. Default 32. */
  maxQueueSize?: number;
  /** Maximum concurrency-queue wait in milliseconds. Default 5,000. */
  queueTimeoutMs?: number;
  /** Retry hint for concurrency overloads. Default 1,000. */
  retryAfterMs?: number;
  /** Optional exact rolling-window call-start budget. */
  budget?: ConnectorRollingWindowBudget;
  /**
   * Derive a bounded, non-secret partition key from the tool call. Omit for
   * one connector-wide partition. Connecta retains the returned key only; it
   * never copies arguments into limiter state.
   */
  partitionKey?(
    input: Readonly<ConnectorCallAdmissionInput>,
  ): string;
}

/** Optional downstream call-admission policy declared by one connector. */
export interface ConnectorCallAdmissionPolicy {
  /**
   * Plural-ready policy container. Exactly one rule is supported in this
   * release; empty or multi-rule policies fail construction.
   */
  rules: readonly ConnectorCallAdmissionRule[];
  /** Maximum simultaneously retained partition states. Default 1,024. */
  maxPartitions?: number;
}

export type ConnectorCredentialValues = Record<string, string>;

/** Read-only access to the credentials assigned to one connector. */
export interface ConnectorCredentialAccess {
  /**
   * Returns one decrypted field. Omitting `field` preserves the original
   * single-credential behavior and reads the reserved `value` field.
   */
  get(field?: string): Promise<string | null>;
  /** Returns every decrypted field, or null when nothing is configured. */
  getAll(): Promise<ConnectorCredentialValues | null>;
}

/** Operator-facing description of one named credential field. */
export interface ConnectorCredentialFieldConfig {
  /** Stable field name used by connector code and the credential API. */
  name: string;
  /** Short field label, e.g. "Account email". */
  label: string;
  /** Plain-language guidance shown in the connection's credential form in the operator UI. Never include the credential itself. */
  description?: string;
  /** Input placeholder, e.g. "you@example.com". */
  placeholder?: string;
  /** Browser input type. Defaults to password. */
  inputType?: "email" | "password" | "text";
}

/** Operator-facing description of the credential set a connector needs. */
export interface ConnectorCredentialConfig {
  /** Short group or field label, e.g. "API token" or "Service credentials". */
  label: string;
  /** Plain-language guidance shown in the connection's credential form in the operator UI. Never include the credential itself. */
  description?: string;
  /** Password-field placeholder, e.g. "Paste API token". */
  placeholder?: string;
  /**
   * Named fields for multi-value authentication. Omit to retain the original
   * one-secret credential behavior.
   */
  fields?: ConnectorCredentialFieldConfig[];
}

export interface CredentialTestResult {
  ok: boolean;
  /**
   * Shown and logged nowhere: a downstream's reply quoted here can quote the
   * credential it rejected (INV-6). The operator page shows fixed copy for
   * `ok`, and the log records only that a test failed.
   */
  message?: string;
}

export interface ConnectorContext {
  /** Explicit downstream consent initiation, never set by status/catalog/calls. */
  allowAuthorization?: boolean;
  /** Storage namespaced to this connector. */
  storage: KVStorage;
  logger: Logger;
  /** Public base URL of this deployment (origin), used for OAuth callbacks. */
  baseUrl: string;
  /** Fixed deployment configuration, independent of the request Host. */
  publicUrl?: string;
  /** Deployment name used in downstream client metadata. */
  oauthClientName?: string;
  /**
   * Read-only access to this connector's human-managed credential. Present
   * only when the connector declares `credential` and the deployment configures
   * `vault`.
   */
  credential?: ConnectorCredentialAccess;
  /**
   * Identity shared by connector calls that belong to one inbound request.
   * Connectors may use it to reuse request-safe resources within that request,
   * but must never retain I/O resources beyond the scope's lifetime. For
   * probe-only scopes the core owns, `Connector.closeScope` signals that end.
   *
   * Optional for custom/test contexts; the context object itself is the scope
   * when omitted.
   */
  requestScope?: object;
  /** Best-effort cancellation signal for this connector operation. */
  signal?: AbortSignal;
  /** Runtime hook keeping a dispatched OAuth refresh alive through its commit. */
  defer?: (promise: Promise<unknown>) => void;
  /** Requested connector-operation deadline in milliseconds. */
  timeoutMs?: number;
}

type ConnectorStatusState = "ok" | "auth_required" | "credential_required" | "error";

/**
 * What a reviewed downstream tool does. `"read"` is observational. `"write"`
 * changes state without destroying any that already exists, such as a create.
 * `"destructive"` modifies or removes existing state, including an upsert that
 * can overwrite. Both writes leave the read-only path; `"destructive"` also
 * asserts `destructiveHint`, which shapes the approval copy a human reads.
 */
export type ToolVerdict = "read" | "write" | "destructive";

/** One reviewed tool, with the evidence that justifies its verdict. */
export interface ReviewedTool {
  readonly verdict: ToolVerdict;
  /** Why the verdict holds when the name or downstream annotations do not say. */
  readonly reason?: string;
  /**
   * `sha256:<hex>` digest of the input and output schemas the review read.
   * Omit until a review has actually read them; an invented digest reports
   * drift that never happened. When the live schema no longer matches it, or
   * it cannot be checked, the verdict lapses and the tool is served as a write.
   */
  readonly schemaDigest?: string;
}

/**
 * A reviewed classification of a downstream MCP catalog, keyed by exact tool
 * name. Plain data, validated at construction, so the same record classifies
 * live tools and feeds the drift check. A connector carries it as
 * `Connector.classification`, and the registry applies it on every read.
 *
 * It fails closed. A name it does not list keeps only an explicit downstream
 * read annotation; silence and contradiction classify as writes. A listed read
 * fills downstream silence but never overrules an explicit write annotation.
 * A listed write or destructive tool stays a write whatever the downstream
 * claims. A listed tool whose `schemaDigest` no longer matches is a write.
 */
export interface ToolClassification {
  /** Hide every name absent from tools, including tools claiming to be reads. */
  readonly unlisted?: "hide";
  readonly tools: Readonly<Record<string, ToolVerdict | ReviewedTool>>;
}

/**
 * How far a downstream catalog has moved away from the manifest a release
 * reviewed. Counts and nothing else: names, schemas, and prose stay out
 * of every surface this rides on, so a drift report can never become a payload
 * ([#343](https://github.com/zackbart/connecta/issues/343)).
 */
export interface CatalogDriftCounts {
  /** Downstream tools dropped because their names contain C0, DEL, or C1. */
  droppedTools?: number;
  /** Live tools no release classified. Each one fails closed at call time. */
  unclassifiedTools: number;
  /** Classified names this catalog no longer serves — plan gating included. */
  unservedTools: number;
  /** Explicit downstream annotations that contradict a vetted verdict. */
  annotationConflicts: number;
  /** Tools whose reviewed schema digest no longer matches what arrived. */
  schemaChanges: number;
}

/** One drift observation, taken while serving a catalog refresh. */
export interface CatalogDriftReport extends CatalogDriftCounts {
  /** When the observation was taken; never when a probe was scheduled. */
  observedAt: string;
}

/** The last agent-facing catalog read this runtime served for one connector. */
export interface CatalogAccessObservation {
  /** Fresh means the read used a live or unexpired catalog; stale means SWR. */
  state: "fresh" | "stale";
  observedAt: string;
}

export type ResourceTemplateRefusalCode = "resource_template_ambiguous" | "resource_match_budget_exceeded";

export interface ConnectorStatus {
  /** Distinct host-observed refusal codes, without URI or template text. */
  resourceTemplateRefusals?: ResourceTemplateRefusalCode[];
  state: ConnectorStatusState;
  /** When state === "auth_required", the URL the operator should open. */
  authorizationUrl?: string;
  /**
   * Set by a non-forced `startAuth` that handed back a still-recent pending
   * authorization URL instead of starting a new flow. Absent otherwise.
   */
  authorizationReused?: boolean;
  /** The client registration mechanism actually selected for this grant. */
  registrationPath?: "cimd" | "dcr" | "static";
  /**
   * From `startAuth()`, the message reaches the agent. From `status()`, it is
   * never logged, and `Registry.statusFor` keeps it only when connecta wrote
   * it: a custom connector's `status()` contributes its state alone, since
   * its text can quote a downstream (INV-6). Connecta's connectors describe a
   * failed status from its typed record.
   */
  message?: string;
  /**
   * Drift observed the last time this connector served a catalog refresh *in
   * this runtime*. Absent until one has happened — status reports what a
   * refresh saw, and never asks a downstream a question of its own. The
   * observation is not persisted the way the catalog is, so absence means this
   * isolate or process has seen nothing, not that nothing drifted.
   */
  catalogDrift?: CatalogDriftReport;
  /**
   * The last agent-facing catalog read in this runtime. This payload-free
   * observation is not persisted and operator reads do not replace it.
   */
  catalogAccess?: CatalogAccessObservation;
}

/** A downstream skill's verbatim frontmatter and complete file manifest. */
export interface ConnectorSkill {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: "dynamic" | Array<{ uri: string; digest: string; size: number }>;
}

/** Resource bytes before the agent boundary, with exactly one encoding. */
export type ConnectorSkillResourceContents = {
  uri: string;
  mimeType?: string;
} & ({ text: string; blob?: never } | { blob: string; text?: never });

/** The whole plugin contract — the one open seam. */
export interface Connector {
  id: string; // address prefix; [a-z0-9_-]+
  /**
   * Who owns this connector's downstream authentication. `shared` keeps one
   * deployment-wide grant. `personal` isolates storage and credentials by the
   * authenticated human principal. Defaults to `shared`.
   */
  authScope?: "shared" | "personal";
  /** Human-readable display name; the stable `id` remains the tool-address prefix. */
  title?: string;
  /** How call_tool wraps results. "mcp" passes the content array through; anything else is JSON-wrapped. */
  kind?: "mcp" | "api";
  description?: string;
  /**
   * Max inline result size (bytes) for this connector's tools before
   * call_tool truncates and stashes the full text for connecta.result
   * paging. Overrides `ConnectaConfig.calls.maxResultBytes`;
   * omit to inherit it (which itself defaults to 24_000). Must be a whole
   * number of bytes >= 1; anything else refuses to construct.
   */
  maxResultBytes?: number;
  /**
   * Optional per-runtime admission policy for downstream tool calls and resource reads. It covers
   * call_tool, call_destructive_tool, and every execute_code host call, but
   * not catalog/status/auth operations.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /**
   * Optional agent-facing usage guide for this connector. A string preserves
   * the original markdown-only contract. The structured form can add a short
   * discovery summary and require review when even a complete compact schema
   * cannot describe correct use (for example a generic API wrapper or a
   * cross-operation sequencing rule).
   *
   * Served as `skill://connecta/connectors/<id>/SKILL.md`, with generated
   * frontmatter followed by the unchanged guide body. `connector:<id>` is a
   * one-release lookup alias. The guide remains deployment-owned configuration;
   * no runtime registration or shared mutable copy exists.
   */
  usageGuide?: string | ConnectorUsageGuide;
  /**
   * Opted-in downstream Skills transport. The registry validates advertised
   * URIs and manifest bounds before exposing these bytes to an agent. The host
   * verifies preserved digests against the returned bytes. Neither
   * operation registers tools or retains a catalog across requests.
   */
  downstreamSkills?: {
    list(ctx: ConnectorContext): Promise<ConnectorSkill[]>;
    read(uri: string, ctx: ConnectorContext): Promise<ConnectorSkillResourceContents[]>;
  };
  /** Optional human-managed credential slot rendered in the connection in the operator UI. */
  credential?: ConnectorCredentialConfig;
  /** Optional server-side check used by the connection's Test action in the operator UI. */
  testCredential?(
    value: string,
    ctx: ConnectorContext,
  ): Promise<CredentialTestResult>;
  /** Optional multi-field credential check used by the connection's Test action in the operator UI. */
  testCredentials?(
    values: ConnectorCredentialValues,
    ctx: ConnectorContext,
  ): Promise<CredentialTestResult>;
  /**
   * Statically-known tool defs, exposed by in-code connectors (`api()`) for
   * startup convention checks. Remote connectors omit this — their tools are
   * fetched lazily over the network and are not known at construction time.
   */
  staticTools?: ToolDef[];
  /**
   * Optional reviewed classification of the tools `listTools` returns: data
   * the registry applies, never something the connector applies itself.
   * `remoteMcp({ classify })` and maintained providers set it to a
   * deep-frozen record; a custom connector may set one too. It is validated
   * when a registry first reads it (INV-11), and read once per connector
   * object. A connector that sets it lists raw downstream tools; the
   * registry caches and persists only that listing, and classifies it on
   * every read with this record, so no cache layer carries a verdict.
   * Connectors with `staticTools` cannot set it: annotate those directly.
   *
   * A wrapper that rebuilds a connector must forward this field to keep the
   * review. `{ ...connector }`, `Object.assign`, and `Object.create` keep it;
   * a forwarding class that omits it serves an unreviewed connector, whose
   * downstream annotations are its own claims and fail closed when absent.
   * Deployment-level classifier overrides, keyed by connector id
   * and tool ([#706](https://github.com/zackbart/connecta/issues/706)), apply
   * regardless of wrapping.
   */
  readonly classification?: ToolClassification | undefined;
  /**
   * Optional: the drift this connector saw the last time it listed tools,
   * or undefined when it has not listed any yet. A getter over an
   * observation, never a probe: calling it makes no request, touches no
   * credential, and returns counts only. Ignored for a connector with a
   * `classification`, whose drift the registry observes itself, against
   * that record, while serving a refresh the deployment already asked for.
   */
  catalogDrift?(): CatalogDriftReport | undefined;
  /**
   * Optional: what this connector is, for `Connecta.describeConfig()` and the
   * operator surfaces built on it — where it points, how it authenticates,
   * and its static tools. Never a probe and never a secret: header names but
   * no values, a credential slot's labels but never its contents, an
   * endpoint's origin and path but no query or userinfo. `remoteMcp()`,
   * `api()`, the maintained providers, and the artifacts connector implement
   * it; a custom connector without it is described as `{ source: { kind:
   * "custom" } }`. Core copies only the fields named in
   * `ConnectorDescription`, so anything else returned is dropped.
   */
  describe?(): ConnectorDescription;
  listTools(ctx: ConnectorContext): Promise<ToolDef[]>;
  callTool(
    name: string,
    args: unknown,
    ctx: ConnectorContext,
    /** A fresh deep copy of the catalog definition for this dispatch. */
    options?: { definition?: ToolDef },
  ): Promise<unknown>;
  /**
   * Optional read-only downstream resource operation. The URI is an opaque
   * argument to this configured connector, never a destination to fetch.
   * Return the MCP-shaped `{ contents }` result. Programs require a grant to
   * the whole connector; an exact-tool grant does not authorize resources.
   */
  readResource?(uri: string, ctx: ConnectorContext): Promise<unknown>;
  /**
   * Optional best-effort teardown for resources retained under
   * `ctx.requestScope`. The core calls this at most once when a probe or
   * execute_code scope ends, and never uses that scope again. Teardown gets a
   * small, fixed best-effort completion window; a missing, rejected, or
   * never-settling hook cannot change or hold open the operation's result
   * beyond that bound.
   *
   * Per-request `/mcp` scopes are not closed through this hook: their
   * request-local reuse remains in force until the request boundary.
   */
  closeScope?(ctx: ConnectorContext): Promise<void>;
  /** Optional connector-level health/auth status for the operator UI. */
  status?(ctx: ConnectorContext): Promise<ConnectorStatus>;
  /**
   * Optional: start (or with force, restart from scratch) a downstream OAuth
   * flow (called by authorize_connector). Present only on connectors that use
   * downstream OAuth. Returns the resulting status — "auth_required" with an
   * authorizationUrl when there is a URL to open, "ok" when already authorized.
   */
  startAuth?(
    ctx: ConnectorContext,
    opts?: { force?: boolean },
  ): Promise<ConnectorStatus>;
  /**
   * Optional: remove every stored downstream OAuth credential and pending flow
   * without immediately starting a replacement flow. Present only on
   * connectors whose authorization can be managed by the operator UI.
   */
  disconnectAuth?(ctx: ConnectorContext): Promise<void>;
  /**
   * Verify the OAuth `state` returned to /oauth/callback/<id> against the value
   * this connector generated when it started the flow. Required whenever
   * `finishAuth` is present: the callback rejects before `finishAuth` when this
   * hook is absent, throws, or returns false — otherwise anyone holding the
   * pending URL could complete consent with their own account.
   */
  verifyState?(state: string | null, ctx: ConnectorContext): Promise<boolean>;
  /** Validate a callback issuer against its verified consent, including error responses. */
  verifyCallbackIssuer?(issuer: string | null, ctx: ConnectorContext): Promise<boolean>;
  /**
   * Atomically terminate the consent verified in this context, discarding its
   * verifier. Required to accept error callbacks; must share finishAuth's
   * single-use claim so concurrent error and code callbacks have one winner.
   */
  consumeAuthError?(ctx: ConnectorContext): Promise<void>;
  /**
   * Optional: complete a downstream OAuth flow (called by
   * /oauth/callback/<id>). `callbackParams` preserves the authorization
   * server's RFC 9207 `iss` response parameter for validation. Built-in
   * OAuth adapters require a nonempty `state` in this parameter, including
   * programmatic calls and `api()` flows with PKCE disabled. Missing state
   * is refused before any downstream request.
   */
  finishAuth?(
    code: string,
    ctx: ConnectorContext,
    callbackParams: URLSearchParams,
  ): Promise<void>;
}

/** An endpoint as `describeConfig()` shows it: never a query, fragment, or userinfo. */
export interface DescribedEndpoint {
  origin: string;
  path: string;
}

/** A connector's downstream authentication, without a single secret. */
export interface ConnectorAuthDescription {
  /** `none` when the connector authenticates nothing itself. */
  mode: "none" | "headers" | "credential" | "oauth" | "request";
  /** Names of deployment-owned static headers; their values never appear. */
  headerNames?: string[];
  /** Header a stored credential rides. */
  header?: string;
  /** Framing placed before a stored credential; null sends it verbatim. */
  scheme?: string | null;
  /** Requested OAuth scopes. */
  scope?: string;
  /** Public CIMD client metadata document. */
  clientMetadataUrl?: string;
  /** A declared authorization endpoint (`api()` OAuth). */
  authorizationEndpoint?: DescribedEndpoint;
  /** A declared token endpoint (`api()` OAuth). */
  tokenEndpoint?: DescribedEndpoint;
  /** Origins `ctx.oauth.fetch` sends the access token to. */
  apiOrigins?: string[];
  /** Token-endpoint client authentication method. */
  tokenEndpointAuthMethod?: string;
  /** Whether the client authenticates with a secret; the secret never appears. */
  confidentialClient?: boolean;
  /** Whether PKCE is used. */
  pkce?: boolean;
  /** Names of extra authorization-request parameters; values never appear. */
  authorizationParamNames?: string[];
  /** Names of extra token-request headers; values never appear. */
  tokenRequestHeaderNames?: string[];
}

/** One statically known tool, with the classification core will apply. */
export interface ConnectorToolDescription {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /** Present on registry descriptions after overrides and provider review (INV-1). */
  classification?: "read" | "write";
}

/** What `Connector.describe()` reports. Every field is optional but `source`. */
export interface ConnectorDescription {
  /** Construction-time presence for described fields, keyed by relative dot path. Never option values. */
  optionSources?: Readonly<Record<string, "default" | "config">>;
  source: {
    kind: "remote-mcp" | "api" | "builtin" | "custom";
    /** The maintained provider or built-in module that built the connector. */
    provider?: string;
  };
  endpoint?: DescribedEndpoint;
  auth?: ConnectorAuthDescription;
  transport?: {
    versionNegotiation?: "auto" | "legacy";
    redirects?: "none" | "same-origin";
    requireHttps?: boolean;
  };
  /** Static tools; omitted for a catalog that loads from the network. */
  tools?: ConnectorToolDescription[];
}

export interface ConnectorUsageGuide {
  /** Markdown returned verbatim by `skills({ name: "connector:<id>" })`. */
  content: string;
  /**
   * Discovery hint describing the conventions the guide covers. Whitespace is
   * normalized, and a value over 120 characters throws at construction. When
   * omitted, Connecta derives a bounded summary from the first body paragraph.
   */
  summary?: string;
  /**
   * Require review before every operation on this connector. Reserve this for
   * cases whose correct arguments or sequence cannot be expressed by the
   * downstream tool schema; mutations and truncated schemas are required
   * automatically and do not need this flag.
   */
  required?: boolean;
}

/** Result of one sandboxed code execution. */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  /** Host-owned sandbox facts. Never derive these from guest result values or logs. */
  failure?: {
    name: string;
    /** An uncaught typed host rejection, retained by guest Error identity. */
    call?: CallErrorDetails;
    line?: number;
    timeout?: { elapsedMs: number; deadlineMs: number };
  };
  logs?: string[];
}

/** A named group of host functions exposed to sandboxed code as a global. */
export interface ExecutorProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  /**
   * Optional trusted sandbox-side setup run after provider globals exist.
   * Connecta uses this for the immutable namespace and emission acknowledgements. This is host-authored code, never
   * model input. See documentation/code-mode.md#what-an-executor-must-implement.
   */
  prelude?: string;
}

/**
 * Runs model-written JavaScript in a sandbox where the ONLY capabilities are
 * the provider functions — no network, filesystem, env, or timers. Structurally
 * compatible with the upstream `DynamicWorkerExecutor` result/provider seam;
 * Workers must use `workerExecutor()` from "@zackbart/connecta/worker" so each
 * run owns and releases its Worker Loader and RPC handles. Direct upstream
 * construction is rejected by `createConnecta()`.
 * `quickJsExecutor()` from "@zackbart/connecta/quickjs" is the Node implementation.
 * Custom implementations must explicitly opt in with
 * `customExecutor(executor, { lifecycle: "self-managed" })` from the root entry.
 * NEVER back this with an unsandboxed eval — the code is untrusted.
 */
export interface Executor {
  /**
   * What `/health` and `connecta doctor` call this sandbox. Optional, and
   * sanitized and bounded before it is reported. A class-shaped executor gets
   * its constructor name for free, but that is runtime metadata a bundler may
   * rewrite; set this to say the same thing minification-proof.
   */
  readonly name?: string;
  execute(code: string, providers: ExecutorProvider[]): Promise<ExecuteResult>;
  /** Release runtime resources. Node's built-in pool implements this. */
  close?(): void | Promise<void>;
}

/** Payload-free, monotonically increasing admission observations. */
export interface AdmissionSnapshot {
  concurrency: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  retryAfterMs: number;
  /** Hard admitted-request lifetime, present only on the /mcp pool. */
  maxDurationMs?: number;
  active: number;
  queued: number;
  closed: boolean;
  totals: {
    admitted: number;
    queued: number;
    rejected: number;
    cancelled: number;
    closed: number;
  };
  queueWaitMs: {
    count: number;
    total: number;
    max: number;
  };
}

/**
 * Optional admission capability used by bounded executors. The acquired lease
 * carries execution so an already-admitted caller cannot accidentally acquire
 * a second slot and deadlock a pool of one. `wait: false` must refuse with
 * executor_overloaded immediately when no slot is free; never queue it.
 */
export interface AdmittingExecutor extends Executor {
  acquire(options?: { signal?: AbortSignal; wait?: boolean }): Promise<ExecutorLease>;
  /** Payload-free health/metrics view when the executor exposes one. */
  admissionSnapshot?(): AdmissionSnapshot;
}

export interface ExecutorLease {
  /** Time spent waiting before this lease was granted, when observed. */
  readonly waitMs?: number;
  execute(code: string, providers: ExecutorProvider[]): Promise<ExecuteResult>;
  /** Idempotent. Call from finally even when provider construction fails. */
  release(): void;
}

/** Result of an inbound-auth check. */
export type AuthResult =
  | {
      ok: true;
      userId?: string;
      subjectId?: string;
      /** Browser session cookies refreshed by an interactive provider. */
      sessionCookies?: readonly string[];
      /** Human owner represented by a non-interactive access credential. */
      principal?: IdentityReference;
    }
  | {
      ok: false;
      response: Response;
    };

/** Stable identity inside one configured authentication directory. */
export interface IdentityReference {
  namespace: string;
  id: string;
}

/** Identity data passed to config-owned access resolvers. */
export interface AuthenticatedIdentity {
  actor: {
    kind: string;
    id?: string;
    namespace?: string;
  };
  /** Any stable admitted caller, including service identities and tokens. */
  subject?: IdentityReference;
  /** Human owner of personal connector authentication. */
  principal?: IdentityReference;
  interactive: boolean;
}

/** Public browser-auth configuration exposed to connecta's status UI. */
export type UiAuthConfig =
  | {
      kind: "cloudflare-access";
    }
  | {
      kind: "clerk";
      publishableKey: string;
      /**
       * Origin the operator shell fetches its browser sign-in loader from.
       * **Must be an absolute `https:` URL** — the value lands in a `<script
       * src>`, so the gate is stricter than the branding href gate: no `http:`,
       * no loopback exemption, and no root-relative form (a relative path is
       * rejected, not resolved). The shipped `clerkAuth` adapter derives this
       * from the publishable key and Clerk's Frontend API is always https, so
       * nothing legitimate needs a carve-out. A value that fails the gate
       * reaches neither the loader tag nor the page's inline auth config:
       * operator pages render without it and report that Clerk could not load,
       * and `createConnecta` names the drop in a startup warning.
       */
      frontendApiUrl: string;
      /**
       * Hosted Account Portal sign-in address, handed to `Clerk.load`. **Must
       * be an absolute `https:` URL** — the same gate `frontendApiUrl` passes,
       * because this value is where Clerk *navigates* the operator's browser.
       * An Account Portal address is always https, so the stricter gate costs
       * nothing real: a value that fails it (a `javascript:`/`data:` payload,
       * a cleartext `http:` address, a relative path) reaches no part of the
       * page, the shell signs in through Clerk's default instead, and
       * `createConnecta` names the drop in a startup warning.
       */
      signInUrl?: string;
      /** Hosted Account Portal sign-up address. Gated exactly like `signInUrl`. */
      signUpUrl?: string;
    };

/**
 * Runtime identity context an inbound-auth provider may consume. The shape is
 * deliberately structural: core stays Web-API-only while a Worker can pass
 * Cloudflare's authenticated `ctx.access` object through unchanged.
 */
export interface InboundAuthRuntimeContext {
  readonly access?: {
    readonly aud: string;
    getIdentity(): Promise<Record<string, unknown> | undefined>;
  };
}

/**
 * Optional labels and marks used by the browser UI and OAuth result pages.
 * Every deployment-identifying string and image is configurable here — nothing
 * about the operator is baked into the package.
 */
export interface ConnectaBranding {
  /** Product label. Defaults to "Connecta". */
  productName?: string;
  /** Optional link for the product label. */
  productUrl?: string;
  /** Organization or owner shown beside the product label. */
  ownerName?: string;
  /** Optional link for the organization or owner label. */
  ownerUrl?: string;
  /** Operator-page introduction and meta description. */
  description?: string;
  /**
   * Browser tab title and page meta name. Defaults to
   * `"<productName> — <ownerName>"`, or just `productName` when no owner is set.
   */
  pageTitle?: string;
  /**
   * Replace the default monochrome "C" mark. `svg` is served at
   * `/favicon.svg`, `ico` at `/favicon.ico`; omit either to keep the default
   * for that format. Use `href` instead to point the page at an icon you host
   * elsewhere (it replaces the `/favicon.svg` link in the page head; the
   * `/favicon.*` routes still serve whatever `svg`/`ico` provide). `href` must
   * be an absolute `http(s)` URL or a root-relative path; anything else falls
   * back to the default mark.
   */
  favicon?: {
    svg?: string;
    ico?: Uint8Array;
    href?: string;
  };
  /** `theme-color` meta value. Defaults to "#ffffff". */
  themeColor?: string;
  /**
   * Operator-page appearance. Every field is optional, and a rejected value
   * takes its default rather than failing the page, so `createConnecta` warns
   * at startup about anything it dropped.
   *
   * Five knobs, not a palette. Surfaces, borders, muted text, and the status
   * colors all derive from these, so a deployment sets an accent and gets a
   * readable page instead of thirty chances to break one.
   */
  theme?: ConnectaTheme;
}

/**
 * The operator UI's themeable tokens. These land in a `:root` block on the
 * page, so each is gated by a narrow syntactic check: an unvalidated value
 * here would let deployment config write arbitrary CSS.
 */
export interface ConnectaTheme {
  /**
   * The brand color: links, focus rings, primary actions, the active nav item.
   * Hex only (`#rgb`, `#rrggbb`, or `#rrggbbaa`). Defaults to `#2f5fe0`.
   */
  accent?: string;
  /**
   * Corner rounding for cards, inputs, and buttons. A CSS length (`10px`,
   * `0.5rem`) or a bare number read as pixels. `0` restores square corners.
   * Defaults to `10px`.
   */
  radius?: string | number;
  /** Body font stack. A plain CSS font-family list. Defaults to a system stack. */
  fontFamily?: string;
  /** Monospace font stack for addresses, ids, and the endpoint URL. */
  monoFamily?: string;
  /**
   * `"system"` (the default) follows the operator's OS setting; `"light"` and
   * `"dark"` pin the page to one palette.
   */
  colorScheme?: "system" | "light" | "dark";
}

/** An inbound authentication provider (machine token or interactive identity). */
export interface InboundAuth {
  kind: string;
  /** This provider may admit a human identity to operator mutation routes. */
  interactiveOperator?: true;
  /**
   * Recognize credential syntax or trusted runtime context, without verifying
   * it or doing I/O. The first recognizing provider owns the verdict, including
   * refusals. Human routes reject recognized machine credentials without
   * consulting storage or another identity. A throw fails closed.
   * Explicit Authorization headers are normalized and exclude cookies and
   * Access context. Without recognition, the first eligible provider owns
   * that header's verdict; a refusal never falls back to another provider.
   */
  recognizesCredential?(request: Request, runtimeContext?: InboundAuthRuntimeContext): boolean;
  /**
   * Stable, non-secret namespace of the identity directory behind
   * `activityActorLabel`. Stored with new activity actors so two providers with
   * the same `kind` never receive each other's ids. Legacy actors without a
   * namespace are resolved only when exactly one directory is unambiguous.
   * Must be 1–256 printable, non-space ASCII characters; invalid values are
   * treated as an unknown directory and are not persisted.
   */
  activityActorNamespace?: string;
  /**
   * Best-effort friendly label for a stable activity actor id. Called only
   * while serving an authorized activity read, never during tool admission or
   * event writes. The result is display-only and cannot grant access.
   */
  activityActorLabel?(
    subjectId: string,
  ): string | undefined | Promise<string | undefined>;
  /**
   * Optional browser sign-in configuration. When present, operator pages use
   * the provider's interactive sign-in flow.
   */
  uiAuth?: UiAuthConfig;
  /** Serve/short-circuit .well-known + OPTIONS. Return null when not handled. */
  handleMetadata?(
    request: Request,
    baseUrl: string,
  ): Response | null | Promise<Response | null>;
  /** 401 challenge, selected only when this provider serves the resource metadata. */
  challenge?(request: Request, baseUrl: string): string;
  /** Attempt to authorize a request. */
  authorize(
    request: Request,
    baseUrl: string,
    runtimeContext?: InboundAuthRuntimeContext,
  ): AuthResult | Promise<AuthResult>;
}
