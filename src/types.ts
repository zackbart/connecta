// Core contracts for connecta. Web-API only — no node: imports here.

/** A JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

/** Minimal key/value store — the only state connecta needs. */
export interface KVStorage {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Sorted keys beginning with `prefix`. Optional for existing adapters;
   * subsystems that need independent, enumerable records require it explicitly.
   */
  list?(prefix: string): Promise<string[]>;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ToolDef {
  name: string; // unique within the connector
  description?: string;
  inputSchema?: JsonSchema;
  /** Optional JSON Schema describing the tool's structured result. */
  outputSchema?: JsonSchema;
  /**
   * Standard MCP tool behavior hints plus provider-specific extensions.
   * Connecta fails closed: only readOnlyHint === true (without a contradictory
   * destructiveHint) may use call_tool or execute_code. Every other tool must
   * cross the call_destructive_tool approval boundary.
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
  /** Maximum simultaneous Connector.callTool attempts in one partition. */
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
  /** Plain-language guidance shown in /credentials. Never include the credential itself. */
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
  /** Plain-language guidance shown in /credentials. Never include the credential itself. */
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
  message?: string;
}

export interface ConnectorContext {
  /** Storage namespaced to this connector. */
  storage: KVStorage;
  logger: Logger;
  /** Public base URL of this deployment (origin), used for OAuth callbacks. */
  baseUrl: string;
  /**
   * Read-only access to this connector's operator-managed credential. Present
   * only when the connector declares `credential` and the deployment configures
   * `credentials.encryptionKey`.
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
  /** Requested connector-operation deadline in milliseconds. */
  timeoutMs?: number;
}

type ConnectorStatusState = "ok" | "auth_required" | "error";

/**
 * How far a downstream catalog has moved away from the manifest a release
 * reviewed. Four numbers and nothing else: names, schemas, and prose stay out
 * of every surface this rides on, so a drift report can never become a payload
 * ([#343](https://github.com/zackbart/connecta/issues/343)).
 */
export interface CatalogDriftCounts {
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

export interface ConnectorStatus {
  state: ConnectorStatusState;
  /** When state === "auth_required", the URL the operator should open. */
  authorizationUrl?: string;
  message?: string;
  /**
   * Drift observed the last time this connector served a catalog refresh *in
   * this runtime*. Absent until one has happened — status reports what a
   * refresh saw, and never asks a downstream a question of its own. The
   * observation is not persisted the way the catalog is, so absence means this
   * isolate or process has seen nothing, not that nothing drifted.
   */
  catalogDrift?: CatalogDriftReport;
}

/** The whole plugin contract — the one open seam. */
export interface Connector {
  id: string; // address prefix; [a-z0-9_-]+
  /** Human-readable display name; the stable `id` remains the tool-address prefix. */
  title?: string;
  /** How call_tool wraps results. "mcp" passes the content array through; anything else is JSON-wrapped. */
  kind?: "mcp" | "api";
  description?: string;
  /**
   * Max inline result size (bytes) for this connector's tools before
   * call_tool truncates and stashes the full text for get_result
   * paging. Overrides `ConnectaConfig.calls.maxResultBytes`;
   * omit to inherit it (which itself defaults to 50_000). Must be a whole
   * number of bytes >= 1; anything else warns at startup and is ignored, so
   * the connector inherits the deployment-wide cap.
   */
  maxResultBytes?: number;
  /**
   * Optional per-runtime admission policy for downstream tool calls. It covers
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
   * Listed by `skills` as `connector:<id>` and returned verbatim by
   * `skills({ name: "connector:<id>" })`. The guide remains deployment-owned
   * configuration; no runtime registration or shared mutable copy exists.
   */
  usageGuide?: string | ConnectorUsageGuide;
  /** Optional operator-managed credential slot rendered on /credentials. */
  credential?: ConnectorCredentialConfig;
  /** Optional server-side check used by /credentials' Test action. */
  testCredential?(
    value: string,
    ctx: ConnectorContext,
  ): Promise<CredentialTestResult>;
  /** Optional multi-field credential check used by /credentials' Test action. */
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
   * Optional: the drift this connector saw the last time it listed tools,
   * or undefined when it has not listed any yet. Implemented by maintained
   * hosted-MCP proxies, which compare the live catalog with the manifest a
   * release reviewed *while* serving a refresh the deployment already asked
   * for. It is a getter over an observation, never a probe: calling it makes
   * no request, touches no credential, and returns counts only.
   */
  catalogDrift?(): CatalogDriftReport | undefined;
  listTools(ctx: ConnectorContext): Promise<ToolDef[]>;
  callTool(
    name: string,
    args: unknown,
    ctx: ConnectorContext,
  ): Promise<unknown>;
  /**
   * Optional best-effort teardown for resources retained under
   * `ctx.requestScope`. The core calls this at most once when a scope it created
   * solely for probing ends, and never uses that scope again. Teardown gets a
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
  /**
   * Optional: complete a downstream OAuth flow (called by
   * /oauth/callback/<id>). `callbackParams` preserves the authorization
   * server's RFC 9207 `iss` response parameter for SDK validation.
   */
  finishAuth?(
    code: string,
    ctx: ConnectorContext,
    callbackParams?: URLSearchParams,
  ): Promise<void>;
  /**
   * Optional: serve a connector-owned HTTP route — for example a signed
   * download link minted by one of the connector's tools. Called only after
   * every built-in route misses, so a connector can never shadow `/mcp`,
   * `/`, `/credentials`, `/activity`, `/health`, or the credential API. The
   * first connector to return a
   * Response wins, in registration order; return null to decline.
   *
   * These routes are PUBLIC: connecta applies no auth gate to them. A
   * connector that serves data here MUST authenticate the request itself — for
   * example with a signed capability token in the URL.
   */
  handleRequest?(
    request: Request,
    ctx: ConnectorContext,
  ): Promise<Response | null>;
}

export interface ConnectorUsageGuide {
  /** Markdown returned verbatim by `skills({ name: "connector:<id>" })`. */
  content: string;
  /**
   * Bounded discovery hint describing the conventions the guide covers. When
   * omitted, Connecta derives a summary from the guide's first meaningful line.
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
  logs?: string[];
}

/** A named group of host functions exposed to sandboxed code as a global. */
export interface ExecutorProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  /**
   * Optional trusted sandbox-side setup run after provider globals exist.
   * Connecta uses this to install lazy connector namespace proxies without
   * materializing one host closure per tool. This is host-authored code, never
   * model input.
   */
  prelude?: string;
}

/**
 * Runs model-written JavaScript in a sandbox where the ONLY capabilities are
 * the provider functions — no network, filesystem, env, or timers. Structurally
 * compatible with `DynamicWorkerExecutor` from `@cloudflare/codemode` (Workers);
 * `quickJsExecutor()` from "@zackbart/connecta/quickjs" is the Node implementation.
 * NEVER back this with an unsandboxed eval — the code is untrusted.
 */
export interface Executor {
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
 * a second slot and deadlock a pool of one.
 */
export interface AdmittingExecutor extends Executor {
  acquire(options?: { signal?: AbortSignal }): Promise<ExecutorLease>;
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
    }
  | { ok: false; response: Response };

/** Public browser-auth configuration exposed to connecta's status UI. */
export type UiAuthConfig = {
  kind: "clerk";
  publishableKey: string;
  /**
   * Origin the operator shell fetches its browser sign-in loader from. **Must be an absolute
   * `https:` URL** — the value lands in a `<script src>`, so the gate is
   * stricter than the branding href gate: no `http:`, no loopback exemption, and
   * no root-relative form (a relative path is rejected, not resolved). The
   * shipped `clerkAuth` adapter derives this from the publishable key and
   * Clerk's Frontend API is always https, so nothing legitimate needs a
   * carve-out. A value that fails the gate reaches neither the loader tag nor
   * the page's inline auth config: operator pages render without it and report
   * that Clerk could not load, and `createConnecta` names the drop in a startup
   * warning.
   */
  frontendApiUrl: string;
  /**
   * Hosted Account Portal sign-in address, handed to `Clerk.load`. **Must be an
   * absolute `https:` URL** — the same gate `frontendApiUrl` passes, because
   * this value is where Clerk *navigates* the operator's browser. An Account
   * Portal address is always https, so the stricter gate costs nothing real: a
   * value that fails it (a `javascript:`/`data:` payload, a cleartext `http:`
   * address, a relative path) reaches no part of the page, the shell signs in
   * through Clerk's default instead, and `createConnecta` names the drop in a
   * startup warning.
   */
  signInUrl?: string;
  /** Hosted Account Portal sign-up address. Gated exactly like `signInUrl`. */
  signUpUrl?: string;
};

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
}

/** An inbound authentication provider (bearer token, Clerk, ...). */
export interface InboundAuth {
  kind: string;
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
   * Optional browser sign-in configuration. When present, operator pages use it
   * provider instead of asking the operator to paste a static bearer secret.
   */
  uiAuth?: UiAuthConfig;
  /** Serve/short-circuit .well-known + OPTIONS. Return null when not handled. */
  handleMetadata?(
    request: Request,
    baseUrl: string,
  ): Response | null | Promise<Response | null>;
  /** Attempt to authorize a request. */
  authorize(
    request: Request,
    baseUrl: string,
  ): AuthResult | Promise<AuthResult>;
}
