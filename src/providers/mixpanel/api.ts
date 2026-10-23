// Mixpanel's pinned contracts, regional confinement, authentication and failure semantics.
import { Effect, Schema, Stream } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { guardedClient } from "../../http/client.js";
import { Refusal, StatusFailure, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import { Credentials, type CallServices } from "../../http/services.js";
import { restSafety, resultSafety } from "../../http/safety.js";
import { connect, get, type Connection, type ConnectOptions } from "../../http/vendor.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import { OperationIndex, type RestMethod } from "../_shared/rest/operation-index.js";
import { checked, indexedVendor } from "../_shared/rest/kit.js";
import { type RestCall, type RestReadPost } from "../_shared/rest/tools.js";
import { valueSafety, refuseWithheldLinks } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { MIXPANEL_VALUE_SAFETY } from "./safety.js";
import { skill } from "./skill.generated.js";
import type { MixpanelApiOptions, MixpanelRegion } from "./index.js";

/** Per runtime and connection, conservatively shared across its projects and API families. */
export const MIXPANEL_API_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 5,
      budget: { kind: "rolling-window", maxCalls: 60, windowMs: 3_600_000 },
      maxQueueSize: 16,
      queueTimeoutMs: 5_000,
    },
  ],
};

export const INDEX = new OperationIndex(openapi, { vendor: "mixpanel", title: "Mixpanel" });
export const SAFETY = valueSafety(MIXPANEL_VALUE_SAFETY, () => INDEX);
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const READ_CAP_MS = 60_000;
const encoder = new TextEncoder();
export const READ_POSTS: readonly RestReadPost[] = [
  ["POST", "/api/query/engage", "Queries existing profiles; no profile mutation or ingestion occurs."],
];

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}
function project(value: unknown, defaultProjectId?: number): number {
  const id = value ?? defaultProjectId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    invalid("Supply a positive project_id from list_projects or configure defaultProjectId; never guess one.");
  return id;
}
const rejected = () => ({
  code: "connector_call_failed" as const,
  retryable: false,
  words: (detail: string) => detail,
});
export const mixpanelErrors: VendorErrors = {
  provider: "Mixpanel",
  facts: () => ({}),
  detail: ({ status }) =>
    status >= 200 && status <= 299
      ? "Mixpanel reported a failure in a successful HTTP response. Check parameters and project access."
      : `Mixpanel returned HTTP ${status}. Check the documented parameters, project access and region. Import failures can partially ingest valid records; inspect the target before repeating.`,
  statuses: {
    401: () => ({
      code: "auth_required",
      words: () =>
        "Mixpanel rejected the service account. An operator must set username:secret in this connection's operator UI.",
    }),
    403: () => ({
      code: "provider_permission_denied",
      retryable: false,
      words: () =>
        "Mixpanel refused access. Check the service account's project membership, data sensitivity and role; import needs Owner or Admin.",
    }),
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: retryAfterMs ?? 60_000,
      words: () => "Mixpanel's project API budget is spent.",
      advice: "; respect the retry window",
    }),
    serverError: ({ status, retryAfterMs }) => ({
      code: "unavailable",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      words: () => `Mixpanel returned HTTP ${status}.`,
    }),
    400: rejected,
    404: rejected,
    409: rejected,
    422: rejected,
    otherwise: rejected,
  },
  unreadable: "Mixpanel returned malformed JSON.",
};

export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const pair = values?.value;
  if (!pair)
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "An operator must set the Mixpanel service account as username:secret in this connection's operator UI.",
        ),
      }),
    );
  const colon = pair.indexOf(":");
  if (colon < 1 || colon === pair.length - 1 || /[\r\n]/.test(pair))
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "The Mixpanel service account must be username:secret, with both fields non-empty.",
        ),
      }),
    );
  const bytes = encoder.encode(pair);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { Authorization: `Basic ${btoa(binary)}` };
});
function encode(call: RestCall) {
  if (call.op.path === "/api/query/engage") {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(call.body as Record<string, unknown>)) {
      if (value !== undefined)
        form.set(key, Array.isArray(value) || record(value) ? JSON.stringify(value) : String(value));
    }
    return {
      query: call.query as Record<string, string | number>,
      rawBody: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    };
  }
  const query: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(call.query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) query[key] = JSON.stringify(value);
    else if (["string", "number", "boolean"].includes(typeof value)) query[key] = value as string | number | boolean;
    else invalid(`Mixpanel query ${key} must be a scalar or JSON array.`);
  }
  return { query, ...(call.body !== undefined ? { body: call.body } : {}) };
}

export function settings(options: Readonly<MixpanelApiOptions>) {
  const region = options.region ?? "us";
  if (!["us", "eu", "in"].includes(region)) throw new Error('region must be "us", "eu", or "in".');
  if (options.via !== "api")
    throw new Error(
      "remoteMcp() with ConnectaConfig.classification for hosted MCP connections; use a distinct id beside the API connector.",
    );
  if (options.auth?.type !== "credential") throw new Error('via: "api" requires auth: { type: "credential" }.');
  if (
    options.defaultProjectId !== undefined &&
    (!Number.isSafeInteger(options.defaultProjectId) || options.defaultProjectId < 1)
  )
    throw new Error("defaultProjectId must be a positive safe integer.");
  const app = region === "us" ? "mixpanel.com" : `${region}.mixpanel.com`;
  const suffix = region === "us" ? "" : `-${region}`;
  return {
    query: `https://${app}`,
    app: `https://${app}`,
    export: `https://data${suffix}.mixpanel.com`,
    ingestion: `https://api${suffix}.mixpanel.com`,
  };
}
export const safety = () => ({
  reviewed: restSafety(SAFETY, INDEX),
  sensitiveFields: { names: [], choice: "drop" as const },
});
export const getAccount = get("getAccount", "/api/app/me", { success: Schema.Unknown });
export const MixpanelApi = {
  ...indexedVendor("mixpanel", INDEX, [getAccount]),
  textBodies: {
    review:
      "Legacy Mixpanel replies use JSON, text/XML/CSV or newline-delimited JSON according to Content-Type. Bounded export always reads JSONL as text. Errors expose no body text.",
    forResponse: (status: number, operation: { template: string }, type = "") =>
      status >= 200 &&
      status <= 299 &&
      (operation.template === "/api/2.0/export" ||
        !/\bjson\b|\+json\b/.test(type) ||
        /\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type))
        ? ("text" as const)
        : undefined,
  },
  binaryBodies: {
    review:
      "Legacy non-text Mixpanel replies retain bounded bytes, checked for sent secrets before base64 encoding. Bounded export always reads JSONL as text.",
    forResponse: (_status: number, operation: { template: string }, type: string) =>
      operation.template !== "/api/2.0/export" &&
      type !== "" &&
      !/\bjson\b|\+json\b|\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type) &&
      !/^text\/|\bxml\b|\bcsv\b/.test(type),
  },
};
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) =>
  Effect.gen(function* () {
    if (answer.operation.template === "/api/2.0/export") return body;
    if (answer.bodyFormat === "text" && typeof body === "string") {
      const type = (answer.headers.get("content-type") ?? "").toLowerCase();
      body = /\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type)
        ? body
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
              try {
                return JSON.parse(line) as unknown;
              } catch {
                return { line };
              }
            })
        : body === ""
          ? null
          : body;
    }
    if (record(body) && (body.status === "error" || body.status === 0 || body.error))
      return yield* Effect.fail(
        new StatusFailure({
          status: answer.status,
          headers: answer.headers,
          body: undefined,
          operation: answer.operation,
        }),
      );
    return body;
  });

/** Fixed secondary origins are built once, outside every caller's Effect context. */
export function regionalConnection(options: Readonly<MixpanelApiOptions>, origin: "export" | "ingestion"): Connection {
  const guarded = guardedClient({
    provider: "Mixpanel",
    baseUrl: settings(options)[origin],
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: READ_CAP_MS,
    authenticate,
  });
  return connect(
    MixpanelApi,
    origin === "export"
      ? {
          ...guarded,
          // Legacy export failures use status alone and cancel even a body that never emits.
          // Acquiring the stream pull opens its scoped reader; closing scope cancels without reading.
          read: (response, maxBytes, format, prefix) =>
            response.status < 200 || response.status > 299
              ? Effect.scoped(Stream.toPull(response.stream)).pipe(
                  Effect.as({ status: response.status, headers: new Headers(response.headers), text: undefined }),
                )
              : guarded.read(response, maxBytes, format, prefix),
        }
      : guarded,
    { errors: mixpanelErrors, safety: resultSafety(safety()), result },
  );
}
export function scopedCall(
  options: Readonly<MixpanelApiOptions>,
  method: RestMethod,
  path: string,
  input: { query?: Readonly<Record<string, unknown>>; body?: unknown } = {},
) {
  const { op, params } = INDEX.resolve(method, path);
  const query = input.query ?? {};
  return {
    method: op.method,
    path,
    op,
    params,
    query:
      path === "/api/app/me" ? query : { ...query, project_id: project(query.project_id, options.defaultProjectId) },
    body: input.body,
  };
}
export function sendMixpanel(
  connection: Connection,
  exports: Connection,
  ingestion: Connection,
  call: RestCall,
  prefix?: { maxBytes: number },
): Effect.Effect<
  {
    status: number;
    data: unknown;
    prefix?: { truncated: boolean; bytes: number; stopped: "end" | "bytes" | "time" | "stop" };
  },
  HttpFailure,
  CallServices
> {
  return checked(() => {
    const framing = encode(call);
    if (!["query", "app", "export", "ingestion"].includes(call.op.server ?? "query"))
      invalid("Mixpanel admits only its reviewed residency hosts.");
    if (
      call.method !== "GET" &&
      call.method !== "HEAD" &&
      !READ_POSTS.some(([method, path]) => method === call.method && path === call.op.path)
    )
      refuseWithheldLinks([call.body, call.query, call.path], "Mixpanel");
    return {
      method: call.method,
      path: call.path,
      template: call.op.path,
      query: Object.entries(framing.query)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)] as const),
      ...("rawBody" in framing
        ? { rawBody: framing.rawBody, ...(framing.headers ? { headers: framing.headers } : {}) }
        : call.body !== undefined
          ? { json: JSON.stringify(call.body) }
          : {}),
    };
  }).pipe(
    Effect.flatMap((request) =>
      (call.op.server === "export" ? exports : call.op.server === "ingestion" ? ingestion : connection).sendPath(
        request,
        prefix ? { prefix } : undefined,
      ),
    ),
  );
}
const REGION_COPY: Readonly<Record<MixpanelRegion, string>> = { us: "US", eu: "EU", in: "India" };
export function usageGuide(options: Readonly<MixpanelApiOptions>) {
  const region = options.region ?? "us";
  const instructions = options.instructions?.trim();
  return {
    content: `# Mixpanel API usage\n\nService-account REST, ${region} residency. Account purpose: ${options.purpose}\n\nDefault project: ${options.defaultProjectId ?? "none; supply project_id"}.${skill.fragments.api}${instructions ? `\n## ${skill.instructionsHeading}\n\n${instructions}\n` : ""}`,
    summary: `${REGION_COPY[region]} residency, service-account REST. Raw export, user activity, profiles, reports and event import.`,
    required: true,
  };
}
