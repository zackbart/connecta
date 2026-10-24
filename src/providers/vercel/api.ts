// Vercel's pinned contract, authentication, failures and value-safety boundary.
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type VendorErrors } from "../../http/errors.js";
import { restSafety } from "../../http/safety.js";
import { Credentials } from "../../http/services.js";
import { get, post, patch, del, type Connection, type ConnectOptions } from "../../http/vendor.js";
import { checked, indexedVendor } from "../_shared/rest/kit.js";
import { OperationIndex, type Operation, type RestMethod } from "../_shared/rest/operation-index.js";
import type { RestCall, RestPage, RestReadPost } from "../_shared/rest/tools.js";
import {
  valueSafety,
  withholdEmbeddedUrlsIn,
  refuseWithheldLinks,
  refuseWithheldBase64,
} from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { VERCEL_VALUE_SAFETY } from "./safety.js";
import { skill } from "./skill.generated.js";
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
  facts: (body) => ({ code: reviewedCode(record(record(body)["error"])["code"]) }),
  detail: ({ body, status, withheld, facts }) => {
    const root = record(withholdEmbeddedUrlsIn(body));
    const error = record(root["error"]);
    const code = text(error["code"]);
    const message =
      text(error["message"])?.trim() ?? text(root["message"])?.trim() ?? `Vercel returned HTTP ${status}.`;
    const reviewed = withheld ? facts["code"] : reviewedCode(code);
    return withheld
      ? `Vercel answered HTTP ${status}${reviewed ? ` (${reviewed})` : ""}; its message is withheld because this operation handles secret values.`
      : (code ? `Vercel ${code}: ${message}` : message).slice(0, 1_000);
  },
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
    400: () => ({ code: "invalid_args" }),
    409: () => ({ code: "invalid_args" }),
    422: () => ({ code: "invalid_args" }),
    serverError: ({ numbers, retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs: retryAfterMs ?? numbers["resetAfterMs"],
      words: (detail) => `${detail} Vercel is failing upstream.`,
    }),
  },
  unreadable: "Vercel returned malformed JSON.",
};
export const vercelIndex = new OperationIndex(openapi, { vendor: "vercel", title: "Vercel" });
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
export const deleteEnv = del("deleteEnv", "/v9/projects/:idOrName/env/:id", {
  params: params("idOrName", "id"),
  query: Query,
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
export const named = [currentUser, teams, projectEnv, upsertEnv, updateEnv, deleteEnv, buildLogs, runtimeLogs];
const binaryType = (type: string) =>
  type !== "" &&
  !/\bjson\b|\+json\b|\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type) &&
  !/^text\/|\bxml\b|\bcsv\b/.test(type);
export const VercelApi = {
  ...indexedVendor("vercel", vercelIndex, named),
  textBodies: {
    review: "Legacy Vercel replies retain text, XML, CSV, NDJSON and bounded log prefixes. Errors are JSON-only.",
    forResponse: (status: number, operation: { flags?: Readonly<Record<string, true>> }, type = "") =>
      status >= 200 && status <= 299
        ? operation.flags?.["log"]
          ? ("text" as const)
          : operation.flags?.["upload"]
            ? ("json-or-text" as const)
            : !/\bjson\b|\+json\b/.test(type) || /\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type)
              ? ("text" as const)
              : undefined
        : undefined,
  },
  binaryBodies: {
    review: "Legacy Vercel hatches retain bounded binary replies with sent-secret checks before base64.",
    forResponse: (_status: number, operation: { flags?: Readonly<Record<string, true>> }, type: string) =>
      !operation.flags?.["upload"] && binaryType(type),
  },
};
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) =>
  Effect.sync(() => {
    if (answer.operation.method === "HEAD")
      return Object.fromEntries([...answer.headers].filter(([name]) => name !== "set-cookie"));
    if (answer.operation.flags?.["log"]) return typeof body === "string" ? completeRows(body) : [];
    if (answer.operation.flags?.["upload"] && answer.bodyFormat === "text")
      return body === ""
        ? null
        : {
            contentType: answer.headers.get("content-type") ?? "",
            bytes: new TextEncoder().encode(String(body)).length,
          };
    if (answer.bodyFormat !== "text" || typeof body !== "string") return body;
    const type = (answer.headers.get("content-type") ?? "").toLowerCase();
    if (/\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type))
      return body
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { line };
          }
        });
    return body === "" ? null : body;
  });
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

const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Cursors: lists answer `pagination.next` (a millisecond timestamp or an
 * opaque string) or a top-level `nextCursor`/`cursor`. The parameter to pass
 * it back as is the one the operation declares in the index: `until` (or
 * `from`) for timestamps, `cursor` or `next` for opaque strings. A cursor that
 * is a URL is never echoed: it can carry credentials.
 */
export function vercelPage(operations: OperationIndex, data: unknown, call: RestCall): RestPage | undefined {
  const body = record(data);
  const accepts = queryNamesOf(operations, call.op);
  const paramFor = (next: string | number): string | undefined =>
    typeof next === "number"
      ? ["until", "next", "from", "since"].find((name) => accepts.has(name))
      : ["cursor", "next", ...(/^\d+$/.test(next) ? ["until", "from"] : [])].find((name) => accepts.has(name));
  const found = (next: unknown): RestPage | undefined => {
    if (typeof next === "number" && Number.isFinite(next)) {
      const param = paramFor(next);
      return { hasMore: true, next: String(next), ...(param ? { param } : {}) };
    }
    if (typeof next === "string" && next !== "") {
      if (URL_SHAPE.test(next)) return { hasMore: true };
      const param = paramFor(next);
      return { hasMore: true, next, ...(param ? { param } : {}) };
    }
    return undefined;
  };
  if (isRecord(body["pagination"])) {
    const pagination = body["pagination"];
    return found(pagination["next"] ?? pagination["nextCursor"]) ?? { hasMore: false };
  }
  for (const name of ["nextCursor", "cursor", "next"]) {
    if (name in body) return found(body[name]) ?? { hasMore: false };
  }
  return undefined;
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
    return "Runtime logs are a live stream that never ends on its own. Read them with get_runtime_logs, which stops after waitMs or maxRows.";
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
export function sendVercel(connection: Connection, call: RestCall) {
  return checked(() => {
    const server = checkServer(call.op.server);
    if (server) invalid(server);
    return queryOf(call);
  }).pipe(
    Effect.flatMap((query) =>
      admit(call).pipe(
        Effect.flatMap(() =>
          connection.sendPath({
            method: call.method,
            path: call.path,
            template: call.op.path,
            query: Object.entries(query).flatMap(([key, value]) =>
              (Array.isArray(value) ? value : [value]).map((value) => [key, value] as const),
            ),
            ...(call.body === undefined ? {} : { json: JSON.stringify(call.body) }),
          }),
        ),
      ),
    ),
    Effect.map((answer) => {
      const page = vercelPage(vercelIndex, answer.data, call);
      return { status: answer.status, data: answer.data ?? null, ...(page ? { page } : {}) };
    }),
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
function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
}

function tokenUsageGuide(purpose: string, teamId: string | undefined, instructions: string | undefined): string {
  const { key, shared } = skill.fragments;
  const scope = teamId
    ? `This connection defaults to team \`${teamId}\`: operations that accept a team get it unless a call passes \`teamId\` (or \`slug\`), and \`teamId: null\` targets the token owner's personal account.`
    : "This connection defaults to the token owner's personal account. Call `list_teams`, then pass `teamId` for team-owned resources.";
  return `# Vercel usage

Connecta's REST connector to the Vercel API with one access token. Account purpose: ${purpose}

${scope}${key}${shared}${instructionsSection(instructions)}`;
}

export function usageGuide(options: Readonly<VercelTokenOptions>) {
  return {
    content: tokenUsageGuide(options.purpose, defaultTeam(options), options.instructions),
    summary: "One access token over REST: search operations, read details, then read or write. Value-safe env vars.",
    required: true,
  };
}
