import { Effect, Schema } from "effect";
import type { ApiHandlerContext } from "../../src/connectors/api-connector.js";
import { guardedClient } from "../../src/http/client.js";
import type { VendorErrors } from "../../src/http/errors.js";
import { bearer, Grant, grantFromOAuth, refreshOnce } from "../../src/http/oauth.js";
import { resultSafety } from "../../src/http/safety.js";
import { read, write } from "../../src/http/tools.js";
import { connect, get, vendor } from "../../src/http/vendor.js";
import { OAUTH_CHALLENGE_MAX_BYTES } from "../../src/auth/renewable-grant.js";
import type { WriteRequest } from "../../src/http/write-request.js";

export const oauthTransports = ["facade", "grant"] as const;
export type OAuthTransport = (typeof oauthTransports)[number];

const errors: VendorErrors = {
  provider: "tickets",
  facts: () => ({}),
  detail: ({ status }) => `Tickets answered HTTP ${status}.`,
  statuses: {
    401: () => ({ code: "downstream_oauth_required", retryable: false }),
    403: () => ({ code: "provider_permission_denied" }),
    404: () => ({ code: "not_found" }),
  },
  unreadable: "Tickets returned an unreadable response.",
};

/** Exercise the production kit builder and real Grant bridge, never a synthetic renewal. */
export async function staticOAuthRequest(
  transport: OAuthTransport,
  ctx: ApiHandlerContext,
  origin: string,
  request: WriteRequest & { readonly headers?: Readonly<Record<string, string>> },
  built: "read" | "write",
  effect?: "read",
): Promise<unknown> {
  if (transport === "facade") {
    const response = await ctx.oauth!.fetch(`${origin}${request.path}`, {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
    });
    return response.ok ? response.json() : { status: response.status };
  }
  const connection = connect(
    vendor("tickets", get("unused", "/unused")),
    refreshOnce(guardedClient({
      provider: "tickets",
      baseUrl: origin,
      maxResponseBytes: OAUTH_CHALLENGE_MAX_BYTES,
      authenticate: bearer,
      ...(request.headers ? { headers: request.headers } : {}),
    })),
    {
      errors,
      safety: resultSafety({
        review: "Fixture responses contain only an ok flag.",
        sensitiveFields: { names: [], choice: "drop" },
      }),
    },
  );
  const spec = {
    name: "run",
    description: "Read or write tickets.",
    input: Schema.Struct({}),
    output: Schema.Unknown,
    run: () => connection.sendPath(request, effect ? { effect } : {}).pipe(
      Effect.map(({ data }) => data),
      Effect.provideService(Grant, grantFromOAuth(ctx.oauth!)),
    ),
  };
  const tool = built === "read"
    ? read(connection, { ...spec, review: "Exercise core write classification even for a read-built POST." })
    : write(connection, { ...spec, destructive: true });
  return tool.handler({}, ctx);
}
