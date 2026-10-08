import { staticOAuth } from "../auth/static-oauth.js";
import type { Connector } from "../types.js";
import { assertKnownOptions } from "../config-schema.js";
import { API_OPTIONS, apiConnector } from "./api-connector.js";
import type { ApiOptions } from "./api-connector.js";

export type {
  ApiHandlerContext,
  ApiOAuthAccess,
  ApiOAuthClientAuthentication,
  ApiOAuthConfig,
  ApiOptions,
  ApiTool,
} from "./api-connector.js";

/**
 * A hand-written connector: static tools, each with a handler. With `oauth`,
 * its handlers reach the API through the calling owner's downstream grant
 * (`ctx.oauth`), managed exactly like a `remoteMcp()` grant.
 */
export function api(id: string, opts: ApiOptions): Connector {
  // Read the options once, as plain data, before choosing a grant from them.
  opts = assertKnownOptions(opts, `api(${JSON.stringify(id)})`, API_OPTIONS);
  if (opts.oauth !== undefined && opts.credential !== undefined) {
    throw new Error(
      `api() connector "${id}" declares both oauth and credential. Declare ` +
        "one: auth_required must name a single recovery. A provider offering " +
        "both lets the deployment choose which one to pass.",
    );
  }
  return apiConnector(id, opts, opts.oauth !== undefined ? staticOAuth(id, opts.oauth) : undefined);
}
