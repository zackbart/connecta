import type { ConnectaBranding, Connector } from "./types.js";
import type {
  ActivityStore,
  ActivityReadGate,
  recordToolActivity,
  recordCatalogDriftActivity,
} from "./activity.js";
import type { RouteContext } from "./routes/shared.js";
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
}
