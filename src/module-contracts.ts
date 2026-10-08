import type { ConnectaBranding, Connector } from "./types.js";
import type {
  ActivityStore,
  ActivityReadGate,
  recordToolActivity,
  recordCatalogDriftActivity,
  recordCatalogChangeActivity,
} from "./activity.js";
import type { RouteContext } from "./routes/shared.js";
import type { ArtifactRefreshRuntime } from "./artifacts/refresh.js";
/** Construction-time UI contract. Core never imports the implementation. */
export interface OperatorSurface {
  readonly branding?: ConnectaBranding;
  readonly reservedPaths: readonly string[];
  credentialHandoffUrl(baseUrl: string): string;
  handle(context: RouteContext): Promise<Response | null>;
}
/** Optional recording and reading callbacks supplied by /activity. */
export interface ActivityModule {
  readonly store: ActivityStore;
  readonly deploymentId?: string;
  readonly readGate?: ActivityReadGate;
  handle(context: RouteContext): Promise<Response | null>;
  readonly recordTool: typeof recordToolActivity;
  readonly recordDrift: typeof recordCatalogDriftActivity;
  readonly recordChange: typeof recordCatalogChangeActivity;
}
/**
 * The artifacts module, created by `artifacts()` from /artifacts. Core appends
 * its one prebuilt connector to the configured set — the same catalog,
 * invocation, admission, and activity paths as any other — and imports none
 * of its implementation.
 */
export interface ArtifactsModule {
  /** The built-in `artifacts` connector. */
  readonly connector: Connector;
  /**
   * Serve the pages' JSON API (`/artifacts/_api/*`) and the sandboxed frame
   * (`/artifacts/_frame`); null for any other path. The operator UI delegates
   * here and serves the page shells itself, so without `ui` there are no
   * artifact routes at all.
   */
  handle(context: RouteContext): Promise<Response | null>;
  /** Bind the optional refresh runner after core has built its registry and executor. */
  bindRefresh?(runtime: ArtifactRefreshRuntime): void;
  /**
   * Start due refresh jobs. The deployment owns the timer that calls this
   * (a Worker's `scheduled` handler, a Node interval); core starts none.
   */
  runDue?(): Promise<unknown>;
  /** Resolved page policy for `describeConfig()`; never page data. */
  describe?(): ArtifactsModuleDescription;
}

/** The artifacts module's resolved policy, as `describeConfig()` reports it. */
export interface ArtifactsModuleDescription {
  /** Construction-time presence for described fields, keyed by relative dot path. */
  optionSources?: Readonly<Record<string, "default" | "config">>;
  /** Exact origins pages may load scripts, stylesheets, and fonts from. */
  allowlist: { scripts: string[]; styles: string[]; fonts: string[] };
  /** Every resolved page limit, by name. */
  limits: Record<string, number>;
  /** Whether a render check beyond static validation runs. */
  renderCheck: boolean;
}

/** Optional client-token authentication and operator lifecycle. */
export interface AccessTokensModule {
  readonly auth: import("./types.js").InboundAuth;
  handle(context: RouteContext): Promise<Response | null>;
  /** Token policy for `describeConfig()`; never token material. */
  describe?(): { maxActive: number; optionSources?: Readonly<Record<string, "default" | "config">> };
}
