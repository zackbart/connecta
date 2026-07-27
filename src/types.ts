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
   * destructiveHint) may use call_tool, batch_call, or execute_code. Every
   * other tool must cross the call_destructive_tool approval boundary.
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

export type ConnectorStatusState = "ok" | "auth_required" | "error";

export interface ConnectorStatus {
  state: ConnectorStatusState;
  /** When state === "auth_required", the URL the operator should open. */
  authorizationUrl?: string;
  message?: string;
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
   * call_tool/batch_call truncate and stash the full text for get_result
   * paging. Overrides `ConnectaConfig.calls.maxResultBytes`;
   * omit to inherit it (which itself defaults to 50_000). Must be a whole
   * number of bytes >= 1; anything else warns at startup and is ignored, so
   * the connector inherits the deployment-wide cap.
   */
  maxResultBytes?: number;
  /**
   * Optional agent-facing usage guide (markdown) for this connector — preferred
   * tools, address quirks, pagination conventions, rate-limit etiquette, good
   * query patterns. Listed by the `skills` meta-tool as `connector:<id>` and
   * returned verbatim by `skills({ name: "connector:<id>" })`. Keep it concise
   * and imperative; it is read by agents, not operators.
   */
  usageGuide?: string;
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
   * Optional: whether this connector currently holds a stored downstream
   * credential — an OAuth grant it persisted, typically. Read only by the
   * credential liveness checks: a connector with nothing stored has no
   * credential whose liveness could be in question, and probing it anyway would
   * start an authorization flow nobody asked for.
   *
   * Implement it on connectors that manage their own credential storage (the
   * shipped `remoteMcp` does, for `auth: { type: "oauth" }`). Connectors whose
   * credential lives in connecta's vault (`credential` above) need not: the
   * vault answers for them. Must not perform downstream I/O.
   */
  hasStoredCredential?(ctx: ConnectorContext): Promise<boolean>;
  /**
   * Statically-known tool defs, exposed by in-code connectors (`api()`) for
   * startup convention checks. Remote connectors omit this — their tools are
   * fetched lazily over the network and are not known at construction time.
   */
  staticTools?: ToolDef[];
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
  /** Optional connector-level health/auth status for list_connectors. */
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
  /** Optional: complete a downstream OAuth flow (called by /oauth/callback/<id>). */
  finishAuth?(code: string, ctx: ConnectorContext): Promise<void>;
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

/**
 * Which toolkits one inbound identity may open — the membership half of the
 * deployment=org / toolkit=team framing (docs/toolkits.md). A mapping, never a
 * policy engine: one identity → the toolkit names it may select, plus whether
 * it may connect with no `?toolkit=` at all.
 *
 * An identity with NO binding is unbound and keeps the pre-binding behavior:
 * any declared toolkit, or the full registry. A binding is enforced at connect
 * time, before any scoped registry is constructed.
 */
export interface ToolkitBinding {
  /** Toolkit names this identity may select with `?toolkit=<name>`. */
  readonly toolkits: readonly string[];
  /**
   * Whether this identity may also connect with no `?toolkit=` and see the full
   * registry (and read the deployment-wide operator surfaces). Defaults to
   * false: binding a credential to a toolkit means binding it.
   */
  readonly unscoped?: boolean;
}

/** Result of an inbound-auth check. */
export type AuthResult =
  | {
      ok: true;
      userId?: string;
      subjectId?: string;
      /**
       * Toolkit binding resolved for THIS identity — the seam for an adapter
       * that maps its own users (or an IdP claim) to views. Omit to inherit the
       * provider's `toolkitBinding`.
       *
       * When the provider also declares one, the declaration is a **CEILING**,
       * not a default: connecta intersects the two, and grants `unscoped` only
       * if both do. A per-identity binding can therefore narrow the credential's
       * view but never widen it — otherwise an adapter reading a user-writable
       * claim would let the user name their own toolkits. When the provider
       * declares nothing, this binding is used as given.
       *
       * Validated on arrival (a malformed one refuses the request with 403
       * rather than being ignored), but never checked against the configured
       * toolkits, which is only possible for the static declaration at startup.
       */
      toolkitBinding?: ToolkitBinding;
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
  /**
   * Optional toolkit binding for every identity this provider admits
   * (docs/toolkits.md). Declared statically so `createConnecta` can validate the
   * names against `ConnectaConfig.toolkits` and throw on a typo — a binding
   * nobody wrote is not one an operator can reason about. An `authorize` result
   * may narrow it per identity with its own `toolkitBinding`.
   */
  toolkitBinding?: ToolkitBinding;
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
