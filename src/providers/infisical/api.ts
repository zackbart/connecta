// Universal Auth is a private token exchange; resource requests and 401 recovery use the kit.
import { Context, Effect, Option, Schema } from "effect";
import { guardedFetch } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import { deriveContext } from "../../derived-context.js";
import { sentSecretsFor } from "../../sent-secrets.js";
import { Operation } from "../../runtime/call.js";
import {
  Refusal,
  StatusFailure,
  toConnectorCallError,
  type HttpFailure,
  type VendorErrors,
} from "../../http/errors.js";
import { Grant, type Write401Renewal } from "../../http/oauth.js";
import type { SafetyOptions } from "../../http/safety.js";
import { Signal } from "../../http/services.js";
import { del, get, patch, post, vendor } from "../../http/vendor.js";
import type { ConnectorContext, ConnectorCredentialValues } from "../../types.js";
import { providerFailureMessage, unsentAfterUnauthorized } from "../../write-outcome.js";
import { requestTokenCache } from "../_shared/request-token.js";
import type { InfisicalOptions } from "./index.js";
import { INFISICAL_API_BASE_URL } from "./lib/constants.js";
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const RESPONSE_CEILING_MESSAGE =
  "Infisical's response exceeded 8 MiB. Narrow secretPath, drop recursive, or omit includeValues.";
const LOGIN = "/v1/auth/universal-auth/login";
type Json = Record<string, unknown>;
function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
export function baseUrl(options: Readonly<InfisicalOptions>): string {
  if (options.baseUrl !== undefined && (typeof options.baseUrl !== "string" || !options.baseUrl.trim()))
    throw new Error("baseUrl must be a non-empty absolute HTTPS URL including /api.");
  return options.baseUrl?.trim() ?? INFISICAL_API_BASE_URL;
}
export const InfisicalApi = {
  ...vendor(
    { name: "Infisical", manifestBase: "/api" },
    post("login", LOGIN, { success: Schema.Unknown }),
    get("listProjects", "/v1/projects", { success: Schema.Unknown }),
    get("listFolders", "/v2/folders", { success: Schema.Unknown }),
    post("createFolder", "/v2/folders", { success: Schema.Unknown }),
    get("listSecrets", "/v4/secrets", { success: Schema.Unknown }),
    get("getSecret", "/v4/secrets/:secretName", { params: { secretName: Schema.String }, success: Schema.Unknown }),
    post("createSecret", "/v4/secrets/:secretName", { params: { secretName: Schema.String }, success: Schema.Unknown }),
    patch("updateSecret", "/v4/secrets/:secretName", {
      params: { secretName: Schema.String },
      success: Schema.Unknown,
    }),
    del("deleteSecret", "/v4/secrets/:secretName", { params: { secretName: Schema.String }, success: Schema.Unknown }),
  ),
  textBodies: {
    review:
      "Legacy writes accept empty, malformed or non-JSON success bodies and project them as {ok:true,metadataOmitted:true}; reads require JSON.",
    forResponse: (status: number, operation: { method: string }) =>
      status >= 200 && status < 300 && operation.method !== "GET" ? ("json-or-text" as const) : undefined,
  },
};
export const result = (body: unknown, answer: { bodyFormat: string }) =>
  Effect.succeed(answer.bodyFormat === "text" ? undefined : body);
/** The private login transport uses the same status table, without a resource dispatch. */
function loginFailure(status: number, headers: Headers, login = false): ConnectorCallError {
  return toConnectorCallError(
    new StatusFailure({
      status,
      headers,
      body: undefined,
      operation: { method: login ? "POST" : "GET", template: login ? LOGIN : "/v1/projects" },
    }),
    errors,
    { classification: "read", dispatches: [], withholds: () => true },
  );
}

function loginExchange(options: Readonly<InfisicalOptions>) {
  const send = guardedFetch({
    provider: "Infisical",
    baseUrl: baseUrl(options),
    headers: { Accept: "application/json" },
    maxResponseBytes: MAX_RESPONSE_BYTES,
    authenticate: () => ({}),
  });
  async function exchange(clientId: string, clientSecret: string, ctx: ConnectorContext) {
    sentSecretsFor(ctx).add(clientId);
    sentSecretsFor(ctx).secret(clientSecret);
    const issuedAt = Date.now();
    return await send(
      { method: "POST", path: "/v1/auth/universal-auth/login", auxiliary: true, body: { clientId, clientSecret } },
      ctx,
      async (response) => {
        if (!response.ok) {
          await response.bytes();
          throw loginFailure(response.status, response.headers, true);
        }
        const parsed = await response.jsonResult();
        const body = asRecord("value" in parsed ? parsed.value : undefined);
        const accessToken = body["accessToken"],
          expiresIn = body["expiresIn"];
        if (
          typeof accessToken !== "string" ||
          !/^[\x21-\x7e]+$/.test(accessToken) ||
          typeof expiresIn !== "number" ||
          !Number.isFinite(expiresIn) ||
          expiresIn < 0 ||
          !Number.isSafeInteger(Math.ceil(expiresIn * 1000))
        )
          throw new ConnectorCallError("connector_call_failed", "Infisical returned a malformed login response.", {
            retryable: false,
          });
        const ttl = expiresIn === 0 ? 3_600_000 : expiresIn * 1000;
        return { accessToken, expiresAt: issuedAt + (expiresIn === 0 ? ttl : ttl - Math.min(60_000, ttl / 10)) };
      },
    );
  }

  return exchange;
}

/**
 * The factory runs at construction, outside a caller's Effect context (INV-7).
 * Only token strings/expiry cross requests. Flights are credential-bound and
 * request-local; requestTokenCache submits them synchronously after call-owned
 * credential resolution, with a 15-second deadline and last-waiter cancellation.
 * The Grant reads the active operation on every use, never when it is cached.
 */
export function grant(options: Readonly<InfisicalOptions>) {
  const exchange = loginExchange(options);
  const tokens = requestTokenCache(async (ctx) => {
    const values = await ctx.credential?.getAll();
    const clientId = values?.["clientId"]?.trim(),
      clientSecret = values?.["clientSecret"]?.trim();
    if (!clientId || !clientSecret)
      throw new ConnectorCallError(
        "auth_required",
        "No Infisical machine identity is configured. Call authorize_connector for recovery options; an operator adds the Universal Auth client ID and secret in this connection.",
      );
    // Stored values may be padded; register the exact login fields even
    // when this request reuses a token and sends no login body.
    sentSecretsFor(ctx).add(clientId);
    sentSecretsFor(ctx).secret(clientSecret);
    return {
      key: JSON.stringify([clientId, clientSecret]),
      mint: (loginCtx: ConnectorContext) => exchange(clientId, clientSecret, loginCtx),
    };
  });

  return Effect.gen(function* () {
    const operation = yield* Effect.serviceOption(Operation);
    if (Option.isNone(operation) || !operation.value)
      return yield* Effect.fail(
        new Refusal({
          error: new ConnectorCallError("connector_call_failed", "This call has no machine login context."),
        }),
      );
    const ctx = operation.value;
    const callSignal = yield* Signal;
    const use = <A>(work: (view: ConnectorContext) => Promise<A>): Effect.Effect<A, HttpFailure> =>
      Effect.tryPromise({
        try: (interrupted) =>
          work(deriveContext(ctx, { signal: callSignal ? AbortSignal.any([callSignal, interrupted]) : interrupted })),
        catch: (error) =>
          new Refusal({
            error:
              error instanceof ConnectorCallError
                ? error.message.includes("response ceiling")
                  ? providerFailureMessage(error, RESPONSE_CEILING_MESSAGE)
                  : error
                : new ConnectorCallError("connector_call_failed", "Infisical login failed.", { retryable: false }),
          }),
      });
    return {
      token: use((view) => tokens.token(view)),
      refresh: (stale) => use((view) => tokens.token(view, stale)),
      rejected: Effect.fail(new Refusal({ error: loginFailure(401, new Headers()) })),
    } satisfies Context.Service.Shape<typeof Grant>;
  });
}

export function writeUnauthorized(renewal: Write401Renewal): ConnectorCallError {
  return renewal._tag === "Unchanged"
    ? loginFailure(401, new Headers())
    : unsentAfterUnauthorized("Infisical", renewal._tag === "Failed" ? renewal.failure : undefined);
}

export const credential = {
  label: "Machine identity",
  description: "Universal Auth credentials. Project membership and roles bound this connection's access.",
  fields: [
    { name: "clientId", label: "Client ID", inputType: "text" as const, placeholder: "Universal Auth client ID" },
    {
      name: "clientSecret",
      label: "Client secret",
      inputType: "password" as const,
      placeholder: "Paste client secret",
    },
  ],
};
export const probe = {
  check: (values: ConnectorCredentialValues) =>
    !values["clientId"]?.trim() || !values["clientSecret"]?.trim()
      ? "Client ID and client secret are both required."
      : undefined,
  run: (options: Readonly<InfisicalOptions>) => {
    const exchange = loginExchange(options);
    return Effect.gen(function* () {
      const op = yield* Effect.serviceOption(Operation);
      if (Option.isNone(op) || !op.value) return yield* Effect.die(new Error("Missing credential probe context."));
      const ctx = op.value;
      return yield* Effect.tryPromise({
        try: async (interrupted) => {
          const all = await ctx.credential!.getAll();
          return exchange(
            all!["clientId"]!.trim(),
            all!["clientSecret"]!.trim(),
            deriveContext(ctx, { signal: interrupted }),
          );
        },
        catch: (error) =>
          new Refusal({
            error:
              error instanceof ConnectorCallError
                ? error
                : new ConnectorCallError("connector_call_failed", "Infisical login failed."),
          }),
      });
    });
  },
  describe: () => ({ ok: true as const }),
};

const auth401 = (detail: string) =>
  `${detail} An operator must replace invalid or revoked machine identity credentials in this connection.`;
export const errors: VendorErrors = {
  provider: "Infisical",
  facts: () => ({}),
  detail: ({ status }) => `Infisical returned HTTP ${status}.`,
  classify: [
    ({ status, operation }) =>
      operation.template === LOGIN && status >= 400 && status < 500 && status !== 429
        ? {
            code: "auth_required",
            words: (detail) =>
              `${detail} Infisical refused the machine identity login. An operator must check the client ID, secret, and trusted IPs in this connection.`,
          }
        : undefined,
  ],
  statuses: {
    401: () => ({ code: "auth_required", words: auth401 }),
    403: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} An operator must add the machine identity to the project or widen its role for this environment and path.`,
    }),
    404: () => ({
      code: "not_found",
      words: (detail) =>
        `${detail} Confirm the project ID with list_projects, the environment slug, and the path with list_folders.`,
    }),
    ...Object.fromEntries(
      [400, 409, 422].map((status) => [
        status,
        () => ({
          code: "invalid_args" as const,
          words: (detail: string) => `${detail} Check the named tool's arguments.`,
        }),
      ]),
    ),
    429: ({ retryAfterMs }) => ({ code: "rate_limited", retryAfterMs, advice: " Wait before retrying." }),
    serverError: ({ retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs,
      words: (detail) => `${detail} Infisical is failing upstream.`,
    }),
  },
  unreadable: "Infisical returned malformed JSON.",
};
/**
 * No arbitrary API hatch exists. Named value reads deliberately return values
 * and comments. Every other result uses the checked identifier projection in
 * tools.ts, including nested imports, approvals and unknown success bodies.
 * Errors never render vendor text; the private login reply never becomes data.
 * No URL field is returned by a metadata projection. Explicit secret values are
 * operator-stored material, so their contents are deliberately not rewritten.
 */
export const safety: SafetyOptions = {
  reviewed: {
    resolve: (method, path) => {
      const template = /^\/v4\/secrets\/[^/]+$/.test(path) ? "/v4/secrets/:secretName" : path;
      const admitted =
        template === "/v4/secrets/:secretName"
          ? ["GET", "POST", "PATCH", "DELETE"].includes(method)
          : template === "/v2/folders"
            ? ["GET", "POST"].includes(method)
            : method === "GET" && ["/v1/projects", "/v4/secrets"].includes(template);
      if (!admitted)
        throw new ConnectorCallError("invalid_args", "This Infisical operation is not exposed by the connection.");
      return { method, template };
    },
    redact: (data) => data,
    withholdsErrors: () => true,
  },
  sensitiveFields: { names: [], choice: "drop" },
};
