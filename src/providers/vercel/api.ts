// Vercel's pinned contract, authentication, failures and value-safety boundary.
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, StatusFailure, UnreadableBody, type VendorErrors } from "../../http/errors.js";
import { restSafety } from "../../http/safety.js";
import { Credentials, RequestSecrets } from "../../http/services.js";
import { get, post, patch, type Connection, type ConnectOptions, type SendOptions } from "../../http/vendor.js";
import { checked, indexedVendor } from "../_shared/rest/kit.js";
import { OperationIndex, type Operation, type RestMethod } from "../_shared/rest/operation-index.js";
import type { RestCall, RestReadPost } from "../_shared/rest/tools.js";
import {
  valueSafety,
  withholdEmbeddedUrlsIn,
  refuseWithheldLinks,
  refuseWithheldBase64,
} from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { discoveryIndex } from "./lib/index.js";
import { VERCEL_VALUE_SAFETY } from "./safety.js";
import type { HatchBinding, HatchDeclaration } from "../../http/hatch.js";
import { vercelPage as timestampPage, type HatchPageAdapter } from "../../http/hatch-paging.js";
import { completeRows } from "./lib/logs.js";
import type { VercelTokenOptions } from "./index.js";
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const READ_CAP_MS = 60_000;
/** POSTs that only read, admitted by `vercel_api_read`. */
export const READ_POSTS: readonly RestReadPost[] = [
  ["POST", "/v2/observability/query", "Runs an Observability metrics query; Vercel persists nothing."],
  ["POST", "/v1/registrar/domains/availability", "Checks availability for a list of domains; buys nothing."],
  ["POST", "/v1/registrar/domains/price", "Quotes registrar prices for a list of domains; buys nothing."],
  ["POST", "/v1/registrar/domains/search", "Searches domain availability and pricing; buys nothing."],
  ["POST", "/v8/artifacts", "Reads Remote Cache metadata for a list of artifact hashes; uploads nothing."],
];

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function truthy(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && /^(?:1|true)$/i.test(value.trim()));
}

/**
 * Error codes a secret-family failure may name: Vercel's documented generic
 * codes and its environment-variable conflicts. Anything else is withheld,
 * since a code is vendor text too.
 */
const REVIEWED_CODES: ReadonlySet<string> = new Set([
  "bad_request",
  "forbidden",
  "not_found",
  "rate_limited",
  "conflict",
  "unauthorized",
  "invalid_token",
  "internal_server_error",
  "ENV_ALREADY_EXISTS",
  "ENV_CONFLICT",
  "ENV_KEY_RESERVED",
  "ENV_NOT_FOUND",
  "ENV_SIZE_LIMIT_EXCEEDED",
]);

/** A reviewed code, or nothing. */
export function reviewedCode(value: unknown): string | undefined {
  return typeof value === "string" && REVIEWED_CODES.has(value) ? value : undefined;
}

export const vercelErrors: VendorErrors = {
  meanings: { unknownId: "not_found", provesAbsence: true, conflicts: [] },
  factVocabulary: { code: [...REVIEWED_CODES], envRejected: [true, false] },
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
    resetAfterMs: {
      header: "x-ratelimit-reset",
      format: "epoch-seconds",
      review: "Vercel endpoint rate-limit reset time in epoch seconds.",
    },
  },
  provider: "Vercel",
  facts: (body) => ({
    // Shape-only fact: no variable names, values or vendor prose survive here.
    envRejected:
      Array.isArray(record(body)["failed"]) &&
      (record(body)["failed"] as unknown[]).length > 0 &&
      !(Array.isArray(record(body)["created"])
        ? (record(body)["created"] as unknown[]).length
        : record(body)["created"]),
    code:
      reviewedCode(record(record(body)["error"])["code"]) ??
      reviewedCode(
        record(
          record((Array.isArray(record(body)["failed"]) ? (record(body)["failed"] as unknown[]) : [])[0])["error"],
        )["code"],
      ),
  }),
  detail: ({ body, status, withheld, facts }) => {
    const root = record(withholdEmbeddedUrlsIn(body));
    const error = record(root["error"]);
    const code = text(error["code"]);
    const message =
      text(error["message"])?.trim() ?? text(root["message"])?.trim() ?? `Vercel returned HTTP ${status}.`;
    const reviewed = withheld ? facts["code"] : reviewedCode(code);
    const detail = (code ? `Vercel ${code}: ${message}` : message).slice(0, 1_000);
    if (status >= 200 && status <= 299 && facts["envRejected"] === true)
      return `Vercel rejected the environment-variable write${reviewed ? ` (${reviewed})` : ""}; its message is withheld because this operation handles secret values.`;
    return withheld
      ? `Vercel answered HTTP ${status}${reviewed ? ` (${reviewed})` : ""}; its message is withheld because this operation handles secret values.`
      : /[.!?]$/.test(detail)
        ? detail
        : `${detail}.`;
  },
  classify: [
    ({ status, facts, operation }) =>
      status >= 200 &&
      status <= 299 &&
      facts["envRejected"] === true &&
      operation.method === "POST" &&
      canonicalTemplate(operation.template) === "/v10/projects/{idOrName}/env"
        ? {
            code: "invalid_args",
            retryable: false,
            words: (detail) =>
              `${detail}${
                facts["code"] === "ENV_ALREADY_EXISTS" || facts["code"] === "ENV_CONFLICT"
                  ? " Pass upsert: true to replace it, or update it by id with update_project_env_var."
                  : ""
              } Check the target before repeating the write.`,
          }
        : undefined,
  ],
  statuses: {
    429: ({ numbers, retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: retryAfterMs ?? numbers["resetAfterMs"],
      words: (detail) => `${detail} Vercel meters endpoints separately.`,
      advice: "; wait for the reported reset before retrying this operation",
    }),
    401: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} The configured access token is invalid, expired, outside this team, or lacks the required scope. An operator must replace it or widen its Vercel scope.`,
    }),
    403: () => ({
      code: "provider_permission_denied",
      words: (detail) =>
        `${detail} Vercel refused access to this team or resource. Ask the team administrator to grant access and an operator to widen the configured token's Vercel scope.`,
    }),
    404: () => ({
      code: "not_found",
      words: (detail) =>
        `${detail} Confirm the team, project, deployment, domain, or environment-variable id with a list read.`,
    }),
  },
  unreadable: "Vercel returned malformed JSON.",
};
class VercelIndex extends OperationIndex {
  override search(query: string, options: Parameters<OperationIndex["search"]>[1]): Operation[] {
    // A custom environment is a container, not a variable. Only variable-specific
    // summaries participate in a variable-phrase search; other query words keep
    // the shared partial-match behavior.
    const operations = super.search(query, options);
    const variablePhrase = /\b(?:environment variables?|env vars?)\b/i;
    return variablePhrase.test(query) ? operations.filter((op) => variablePhrase.test(op.summary)) : operations;
  }
}
export const vercelIndex = new VercelIndex(discoveryIndex(openapi), { vendor: "vercel", title: "Vercel" });
export const vercelSafety = valueSafety(VERCEL_VALUE_SAFETY, () => vercelIndex);
const Query = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]));
const params = (...names: string[]) => Schema.Struct(Object.fromEntries(names.map((name) => [name, Schema.String])));
export const currentUser = get("currentUser", "/v2/user", { success: Schema.Unknown });
export const teams = get("teams", "/v2/teams", { query: Query, success: Schema.Unknown });
export const projectEnv = get("projectEnv", "/v10/projects/:idOrName/env", {
  params: params("idOrName"),
  query: Query,
  success: Schema.Unknown,
});
export const upsertEnv = post("upsertEnv", "/v10/projects/:idOrName/env", {
  params: params("idOrName"),
  query: Query,
  payload: Schema.Unknown,
  success: Schema.Unknown,
});
export const updateEnv = patch("updateEnv", "/v9/projects/:idOrName/env/:id", {
  params: params("idOrName", "id"),
  query: Query,
  payload: Schema.Unknown,
  success: Schema.Unknown,
});
export const buildLogs = get("buildLogs", "/v3/deployments/:idOrUrl/events", {
  params: params("idOrUrl"),
  query: Query,
  success: Schema.Unknown,
});
export const runtimeLogs = get("runtimeLogs", "/v1/projects/:projectId/deployments/:deploymentId/runtime-logs", {
  params: params("projectId", "deploymentId"),
  query: Query,
  success: Schema.Unknown,
});
export const named = [currentUser, teams, projectEnv, upsertEnv, updateEnv, buildLogs, runtimeLogs];
const canonicalTemplate = (path: string) => path.replace(/:([^/]+)/g, "{$1}");

/** Exact operation/media pairs from the pin; named logs also accept bounded equivalents. */
const LOG_PATHS = [
  "/v3/deployments/{idOrUrl}/events",
  "/v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs",
];
const FRAMED_MEDIA: Readonly<Record<string, readonly string[]>> = {
  "GET /v1/billing/charges": ["application/jsonl"],
  "GET /v1/billing/contract-commitments": ["application/jsonl"],
  "GET /v2/sandboxes/sessions/{sessionId}/cmd/{cmdId}/logs": ["application/x-ndjson"],
  "POST /v2/sandboxes/sessions/{sessionId}/cmd": ["application/x-ndjson"],
  "GET /v3/deployments/{idOrUrl}/events": ["application/stream+json"],
  "GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs": ["application/stream+json"],
};
export const VercelApi = {
  ...indexedVendor("vercel", vercelIndex, named),
  textBodies: {
    review:
      "Exact pinned jsonl/ndjson billing and sandbox command operations, plus build/runtime stream+json logs. Bounded named log readers also accept JSON arrays/NDJSON equivalents. JSON-only writes never accept HTML/text (#1000).",
    forResponse: (
      status: number,
      operation: { method: string; template: string; flags?: Readonly<Record<string, true>> },
      type = "",
    ) => {
      const path = canonicalTemplate(operation.template);
      const media = type.split(";", 1)[0]!.trim().toLowerCase();
      return status >= 200 &&
        status <= 299 &&
        (FRAMED_MEDIA[`${operation.method} ${path}`]?.includes(media) ||
          (operation.method === "GET" &&
            operation.flags?.["log"] &&
            LOG_PATHS.includes(path) &&
            /^(?:application\/(?:json|[^/]+\+json|x-ndjson|jsonl))$/.test(media)))
        ? ("text" as const)
        : undefined;
    },
  },
  binaryBodies: {
    review:
      "Pinned sandbox fs/read alone declares application/octet-stream success. No other operation may acknowledge a JSON write as binary.",
    forResponse: (status: number, operation: { template: string }, type: string) =>
      status >= 200 &&
      status <= 299 &&
      canonicalTemplate(operation.template) === "/v2/sandboxes/sessions/{sessionId}/fs/read" &&
      type.split(";", 1)[0]!.trim().toLowerCase() === "application/octet-stream",
  },
};
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) => {
  if (answer.operation.method === "HEAD")
    return Effect.succeed(Object.fromEntries([...answer.headers].filter(([name]) => name !== "set-cookie")));
  if (
    canonicalTemplate(answer.operation.template) === "/v10/projects/{idOrName}/env" &&
    answer.operation.method === "POST"
  ) {
    const payload = record(body);
    if (
      Array.isArray(payload["failed"]) &&
      payload["failed"].length &&
      !(Array.isArray(payload["created"]) ? payload["created"].length : payload["created"])
    )
      return Effect.fail(
        new StatusFailure({ status: answer.status, headers: answer.headers, body, operation: answer.operation }),
      );
    const created = Array.isArray(payload["created"]) ? payload["created"][0] : payload["created"];
    const variable = record(created ?? payload);
    if (!variable["id"] || !variable["key"] || !variable["type"]) return Effect.fail(new UnreadableBody());
  }
  if (answer.operation.flags?.["log"]) return Effect.succeed(typeof body === "string" ? completeRows(body) : []);
  if (answer.bodyFormat === "text" && typeof body === "string") return Effect.succeed(completeRows(body));
  return Effect.succeed(body);
};
export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const token = typeof values?.value === "string" ? values.value.trim() : undefined;
  if (!token)
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "No Vercel access token is configured for this connector. An operator must add one in this connection in the operator UI.",
        ),
      }),
    );
  return { Authorization: `Bearer ${token}` };
});
export function safety() {
  return { reviewed: restSafety(vercelSafety, vercelIndex), sensitiveFields: { names: [], choice: "drop" as const } };
}
export function defaultTeam(options: Readonly<VercelTokenOptions>): string | undefined {
  return typeof options.teamId === "string" ? options.teamId.trim() || undefined : undefined;
}
/** Query parameter names each operation declares, by index row. */
const queryNames = new Map<number, ReadonlySet<string>>();

function queryNamesOf(operations: OperationIndex, op: Operation): ReadonlySet<string> {
  let names = queryNames.get(op.row);
  if (!names) {
    names = new Set(
      operations
        .contract(op)
        .parameters.filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name),
    );
    queryNames.set(op.row, names);
  }
  return names;
}

export const refuse = (call: RestCall): string | undefined => {
  if (
    call.method === "PATCH" &&
    call.op.path === "/v3/domains/{domain}" &&
    String(record(call.body)["op"]).trim().toLowerCase() === "move-out"
  ) {
    return "Connecta refuses a domain move-out: Vercel answers it with a transfer token that lets the destination account claim the domain. Move domains in the Vercel dashboard.";
  }
  if (truthy(call.query["decrypt"])) {
    return "Connecta never asks Vercel to decrypt environment values. Use list_project_env_vars for metadata.";
  }
  if (call.op.path === "/v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs") {
    return "Runtime logs are a live stream that never ends on its own. Read them with get_runtime_logs, which stops after waitMs or limit.";
  }
  if (truthy(call.query["follow"])) {
    return "follow streams live events until the connection drops. Omit it (or pass 0); read build events with get_deployment_build_logs.";
  }
  return undefined;
};

export function scope(call: RestCall, teamId: string | undefined): RestCall {
  const query: JsonRecord = { ...call.query };
  if (query["teamId"] === null) {
    delete query["teamId"];
    return { ...call, query };
  }
  if (
    teamId &&
    query["teamId"] === undefined &&
    query["slug"] === undefined &&
    queryNamesOf(vercelIndex, call.op).has("teamId")
  )
    query["teamId"] = teamId;
  return { ...call, query };
}
export function restCall(
  method: RestMethod,
  path: string,
  input: { query?: Readonly<JsonRecord>; body?: unknown } = {},
  teamId?: string,
): RestCall {
  const { op, params } = vercelIndex.resolve(method, path);
  return scope({ method, path, op, params, query: { ...input.query }, body: input.body }, teamId);
}
export function checkServer(server: string | undefined): string | undefined {
  return server === undefined
    ? undefined
    : `This operation is served from ${server}, which this connector does not reach.`;
}
export function admit(call: RestCall) {
  return Effect.tryPromise({
    try: async () => {
      if (
        call.method === "GET" ||
        call.method === "HEAD" ||
        READ_POSTS.some(([method, path]) => method === call.method && path === call.op.path)
      )
        return;
      refuseWithheldLinks([call.body, call.query, call.path], "Vercel");
      if (call.method === "POST" && call.op.path === "/v13/deployments") {
        const files = record(call.body)["files"];
        if (Array.isArray(files))
          for (const file of files)
            if (record(file)["encoding"] === "base64") await refuseWithheldBase64(record(file)["data"], "Vercel");
      }
    },
    catch: (error) => error,
  }).pipe(
    Effect.tap(() =>
      Effect.gen(function* () {
        if (call.method === "POST" && call.op.path === "/v11/projects") {
          (yield* RequestSecrets).arguments(record(call.body)["environmentVariables"], {
            items: { properties: { value: { writeOnly: true } } },
          });
        }
        if (
          call.method !== "GET" &&
          call.method !== "HEAD" &&
          (call.op.path === "/v1/env" || /^\/v(?:9|10)\/projects\/\{idOrName\}\/env(?:\/\{id\})?$/.test(call.op.path))
        ) {
          const value = { properties: { value: { writeOnly: true } } };
          const body =
            call.op.path === "/v1/env"
              ? call.method === "POST"
                ? record(call.body)["evs"]
                : call.method === "PATCH"
                  ? Object.values(record(record(call.body)["updates"]))
                  : []
              : call.body;
          (yield* RequestSecrets).arguments(body, { ...value, items: value });
        }
      }),
    ),
    Effect.catch((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
}
export function queryOf(call: RestCall): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const scalar = (v: unknown): v is string | number | boolean =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  for (const [key, value] of Object.entries(call.query)) {
    if (value === undefined) continue;
    if (scalar(value)) out[key] = String(value);
    else if (Array.isArray(value) && value.every(scalar)) out[key] = value.map(String);
    else invalid(`Vercel query parameter ${key} takes a string, number, boolean, or a list of them.`);
  }
  return out;
}
export function queryPairs(call: RestCall): [string, string][] {
  return Object.entries(queryOf(call)).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).map((value) => [key, value] as [string, string]),
  );
}
export function sendVercel(
  connection: Connection,
  call: RestCall,
  sendOptions?: SendOptions,
): ReturnType<Connection["sendPath"]> {
  return checked(() => {
    const server = checkServer(call.op.server);
    if (server) invalid(server);
    return queryOf(call);
  }).pipe(
    Effect.flatMap((query) =>
      admit(call).pipe(
        Effect.flatMap(() =>
          connection.sendPath(
            {
              method: call.method,
              path: call.path,
              template: call.op.path,
              query: Object.entries(query).flatMap(([key, value]) =>
                (Array.isArray(value) ? value : [value]).map((value) => [key, value] as const),
              ),
              ...(call.body === undefined ? {} : { json: JSON.stringify(call.body) }),
            },
            sendOptions,
          ),
        ),
      ),
    ),
  );
}
export const probe = {
  operation: currentUser,
  request: {},
  describe: (data: unknown) => {
    const payload = record(data);
    const user = record(payload["user"] ?? payload);
    const identity = text(user["username"]) ?? text(user["email"]) ?? text(user["name"]) ?? text(user["id"]);
    return `Authenticated as ${identity ?? "a Vercel user"}.`;
  },
  failure: (error: ConnectorCallError) => ({
    ok: false,
    message:
      error.code === "auth_required"
        ? "Vercel rejected the token: it is invalid, expired, or revoked."
        : error.code === "provider_permission_denied"
          ? "Vercel accepted the token but refused to read the current user; check the token's scope."
          : error.code === "rate_limited" || error.code === "unavailable"
            ? "Vercel could not check the token right now; try again shortly."
            : "Vercel did not accept the token.",
  }),
};
export function usageGuide(options: Readonly<VercelTokenOptions>) {
  const team = defaultTeam(options);
  return {
    context: [
      `Vercel REST access token is already configured. Account purpose: ${options.purpose}`,
      team
        ? `Routing defaults to team ${team}. This is not a restriction or tenant pin: an explicit teamId or slug overrides it, and teamId: null selects personal scope. The token's Vercel permissions enforce access.`
        : "Routing defaults to the token owner's personal account. Explicit teamId or slug selects a team within the token's permissions.",
      ...(options.readOnly ? ["This connection is read-only."] : []),
    ],
    required: true,
  };
}

function operationRefusal(op: Operation): string | undefined {
  return (
    (op.method === "GET" && op.path === "/v8/artifacts/{hash}"
      ? "Artifact downloads serve binary bytes despite this pin's JSON contract; this connector does not support artifact downloads."
      : undefined) ??
    vercelSafety.refusal(op.method, op.path) ??
    checkServer(op.server) ??
    (/octet-stream|^multipart\//.test(vercelIndex.bodyType(op) ?? "")
      ? "This operation takes explicit bytes; use vercel_api_upload."
      : undefined)
  );
}
export const VERCEL_VERDICTS: HatchDeclaration["verdicts"] = Object.fromEntries(
  vercelIndex.ops.map((op) => [
    `${op.method} ${op.path}`,
    operationRefusal(op)
      ? "refuse"
      : op.method === "GET" ||
          op.method === "HEAD" ||
          READ_POSTS.some(([method, path]) => method === op.method && path === op.path)
        ? "read"
        : "destructive",
  ]),
);
const cursorInputMessage =
  "Pass the signed page.nextCursor unchanged; omit it for the first page (numeric until may anchor its time window).";
const continuation = (next: unknown, call: Parameters<HatchPageAdapter["next"]>[1]) =>
  typeof next === "string" && /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)/i.test(next.trim())
    ? { hasMore: true as const }
    : timestampPage.next({ pagination: { next } }, call);
/** Only indexed parameters and documented response continuation names opt in. */
const paginationPage = (param: string, timestamp = false): HatchPageAdapter => ({
  ...timestampPage,
  param,
  cursorInputMessage,
  ...(timestamp ? { initialAnchor: true } : {}),
  next(data, call) {
    const pagination = record(record(data)["pagination"]);
    if (!Object.keys(pagination).length) return undefined;
    if (pagination["hasNext"] === false || pagination["hasMore"] === false) return null;
    const next = pagination["next"] ?? pagination["nextCursor"];
    if (next === undefined) {
      if (pagination["hasNext"] === true || pagination["hasMore"] === true)
        throw new ConnectorCallError("connector_call_failed", "Vercel returned invalid paging metadata.", {
          retryable: false,
        });
      return null;
    }
    return continuation(next, call);
  },
});
export const VERCEL_PAGES: NonNullable<HatchDeclaration["pages"]> = Object.fromEntries(
  vercelIndex.ops.flatMap((op) => {
    if (VERCEL_VERDICTS[`${op.method} ${op.path}`] !== "read") return [];
    const names = queryNamesOf(vercelIndex, op),
      fields = vercelIndex
        .fields(op)
        .filter((f) => f.in === "response")
        .map((f) => f.path);
    if (fields.includes("pagination")) {
      if (names.has("until")) return [[`${op.method} ${op.path}`, paginationPage("until", true)]];
      if (names.has("next")) return [[`${op.method} ${op.path}`, paginationPage("next")]];
      if (names.has("cursor")) return [[`${op.method} ${op.path}`, paginationPage("cursor")]];
    }
    for (const key of ["nextCursor", "cursor", "next"])
      if (fields.includes(key) && (names.has(key) || (key === "nextCursor" && names.has("cursor"))))
        return [
          [
            `${op.method} ${op.path}`,
            {
              ...timestampPage,
              param: names.has(key) ? key : "cursor",
              cursorInputMessage,
              next: (data: unknown) => {
                const value = record(data)[key];
                return value === null || value === undefined
                  ? null
                  : continuation(value, { path: "", query: {}, headers: {} });
              },
            } satisfies HatchPageAdapter,
          ],
        ];
    return [];
  }),
);
export function vercelBinding({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<VercelTokenOptions>;
}): HatchBinding {
  return {
    review:
      "The same teamId/slug/null routing used by named tools and uploads, resolved before request validation and signed cursor binding. Token permissions remain the boundary. JSON framing through the existing connection.",
    query: (call) => scope(call, defaultTeam(options)).query,
    refusal: operationRefusal,
    refuse: (call) => operationRefusal(call.op) ?? refuse(call),
    send: (call, sendOptions) => sendVercel(connection, call, sendOptions),
  };
}
