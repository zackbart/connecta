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
  /** Plain-language guidance shown in /ui. Never include the credential itself. */
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
  /** Plain-language guidance shown in /ui. Never include the credential itself. */
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
   * `credentialEncryptionKey`.
   */
  credential?: ConnectorCredentialAccess;
  /**
   * Identity shared by connector calls that belong to one inbound request.
   * Connectors may use it to reuse request-safe resources within that request,
   * but must never retain I/O resources beyond the scope's lifetime.
   *
   * Optional for custom/test contexts; the context object itself is the scope
   * when omitted.
   */
  requestScope?: object;
  /** Best-effort cancellation signal for this individual tool call. */
  signal?: AbortSignal;
  /** Requested tool-call deadline in milliseconds. */
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
   * paging. Overrides the deployment-wide `ConnectaConfig.maxResultBytes`;
   * omit to inherit it (which itself defaults to 50_000).
   */
  maxResultBytes?: number;
   * Optional agent-facing usage guide (markdown) for this connector — preferred
   * tools, address quirks, pagination conventions, rate-limit etiquette, good
   * query patterns. Listed by the `skills` meta-tool as `connector:<id>` and
   * returned verbatim by `skills({ name: "connector:<id>" })`. Keep it concise
   * and imperative; it is read by agents, not operators.
   */
  usageGuide?: string;
  /** Optional operator-managed credential slot rendered inside this connector's /ui card. */
  credential?: ConnectorCredentialConfig;
  /** Optional server-side check used by /ui's Test action. */
  testCredential?(
    value: string,
    ctx: ConnectorContext,
  ): Promise<CredentialTestResult>;
  /** Optional multi-field credential check used by /ui's Test action. */
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
  listTools(ctx: ConnectorContext): Promise<ToolDef[]>;
  callTool(
    name: string,
    args: unknown,
    ctx: ConnectorContext,
  ): Promise<unknown>;
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
   * Optional: verify the OAuth `state` returned to /oauth/callback/<id> against
   * the value this connector generated when it started the flow. Present only
   * on downstream-OAuth connectors. The callback MUST reject before finishAuth
   * when this returns false — otherwise anyone holding the pending URL could
   * complete consent with their own account.
   */
  verifyState?(state: string | null, ctx: ConnectorContext): Promise<boolean>;
  /** Optional: complete a downstream OAuth flow (called by /oauth/callback/<id>). */
  finishAuth?(code: string, ctx: ConnectorContext): Promise<void>;
  /**
   * Optional: serve a connector-owned HTTP route — for example a signed
   * download link minted by one of the connector's tools. Called only after
   * every built-in route misses, so a connector can never shadow `/mcp`,
   * `/ui`, `/health`, or the credential API. The first connector to return a
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
}

/** Result of an inbound-auth check. */
export type AuthResult =
  | { ok: true; userId?: string; subjectId?: string }
  | { ok: false; response: Response };

/** Public browser-auth configuration exposed to connecta's status UI. */
export type UiAuthConfig = {
  kind: "clerk";
  publishableKey: string;
  frontendApiUrl: string;
  signInUrl?: string;
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
  /** Status-dashboard introduction. */
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
   * Optional browser sign-in configuration. When present, `/ui` uses this
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
