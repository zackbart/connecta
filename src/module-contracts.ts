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
/** Optional agent-token authentication and operator lifecycle. */
export interface AccessTokensModule {
  readonly auth: import("./types.js").InboundAuth;
  handle(context: RouteContext): Promise<Response | null>;
  /**
   * Every declared agent's token slot, in declaration order: the list GET
   * /ui/access-tokens serves, which the maintainer's operator contract
   * repeats field by field. Never secret material.
   */
  slots(): Promise<
    Array<
      | { name: string; state: "none"; revision: string }
      | { name: string; state: "issued"; issuedAt: string; revision: string }
      | { name: string; state: "revoked"; revokedAt: string; revision: string }
    >
  >;
  /** The same module bound to the deployment's declared `agents`; createConnecta calls it once. */
  forAgents(agents: readonly string[]): AccessTokensModule;
}
