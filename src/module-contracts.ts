import type { ConnectaBranding } from "./types.js";
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
