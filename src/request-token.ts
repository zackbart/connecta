import type { ConnectorContext } from "./types.js";

/** A request-local Bearer resolver with optional cache invalidation on HTTP 401. */
export interface RequestToken {
  (ctx: ConnectorContext): Promise<string>;
  /** Drop only the rejected token. This hook never authorizes replay. */
  invalidate?: (rejected: string, ctx: ConnectorContext) => Promise<void>;
}
