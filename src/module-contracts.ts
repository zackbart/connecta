import type { ConnectaBranding } from "./types.js";
import type { ActivityStore, ActivityReadGate, recordToolActivity, recordCatalogChangeActivity } from "./activity.js";
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
  readonly recordChange: typeof recordCatalogChangeActivity;
}
/** Optional client-token authentication and operator lifecycle. */
export interface AccessTokensModule {
  readonly auth: import("./types.js").InboundAuth;
  handle(context: RouteContext): Promise<Response | null>;
  /** Token policy for `describeConfig()`; never token material. */
  describe?(): { maxActive: number; optionSources?: Readonly<Record<string, "default" | "config">> };
}
