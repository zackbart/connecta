// Vercel's configuration of the shared REST connector: the team default,
// reviewed read-only POSTs, the value-safety table (`value-safety.ts`: refusals,
// reviewed redaction, fixed messages for secret families), failure mapping,
// cursors, and the named tools a generic call cannot serve well (value-safe
// environment variables, bounded logs, raw-byte uploads, teams).
import type { ApiTool } from "../../connectors/api-connector.js";
import { guardedFetch, retryAfterMs, type GuardedTransport } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext, CredentialTestResult, JsonSchema } from "../../types.js";
import { OperationIndex, type Operation, type RestMethod } from "../_shared/rest/operation-index.js";
import {
  callRest,
  restCall,
  unknownOutcome,
  restTransport,
  type RestCall,
  type RestPage,
  type RestReadPost,
  type RestVendor,
} from "../_shared/rest/tools.js";
import { openapi } from "./openapi.generated.js";
import { redactResponse, secretFamily, verdictFor } from "./value-safety.js";

/** Vercel's public REST origin. Override only for a proxy or test double. */
export const VERCEL_API_BASE_URL = "https://api.vercel.com";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const READ_CAP_MS = 60_000;
/** Most log bytes one bounded log read keeps. */
const MAX_LOG_BYTES = 1024 * 1024;
/** Characters kept from one log line; the rest is marked truncated. */
const MAX_LOG_TEXT = 4_000;
/**
 * Uploads named by their content, so repeating one stores the same bytes:
 * Remote Cache artifacts by the hash in the path, deployment files by the
 * SHA-1 sent as `x-vercel-digest` (Vercel answers "already uploaded").
 */
const CONTENT_ADDRESSED: ReadonlySet<string> = new Set(["PUT /v8/artifacts/{hash}", "POST /v2/files"]);
/** Most raw upload bytes, after base64 decoding. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** POSTs that only read, admitted by `vercel_api_read`. */
const READ_POSTS: readonly RestReadPost[] = [
  ["POST", "/v2/observability/query", "Runs an Observability metrics query; Vercel persists nothing."],
  ["POST", "/v1/registrar/domains/availability", "Checks availability for a list of domains; buys nothing."],
  ["POST", "/v1/registrar/domains/price", "Quotes registrar prices for a list of domains; buys nothing."],
  ["POST", "/v1/registrar/domains/search", "Searches domain availability and pricing; buys nothing."],
  ["POST", "/v8/artifacts", "Reads Remote Cache metadata for a list of artifact hashes; uploads nothing."],
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && /^(?:1|true)$/i.test(value.trim()));
}

function resetAfterMs(headers: Headers): number | undefined {
  const retryAfter = retryAfterMs(headers);
  if (retryAfter !== undefined) return retryAfter;
  const raw = headers.get("x-ratelimit-reset");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, Math.trunc(seconds * 1_000 - Date.now()));
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
function reviewedCode(value: unknown): string | undefined {
  return typeof value === "string" && REVIEWED_CODES.has(value) ? value : undefined;
}

/**
 * Map a Vercel failure by the caller's next move (H11). A secret family's
 * failure (`family`) never carries Vercel's message, which can quote a stored
 * value: it says the status, a reviewed code, and what to do.
 */
function vercelFailure(status: number, headers: Headers, payload: unknown, family = false): ConnectorCallError {
  const root = record(payload);
  const error = record(root["error"]);
  const code = text(error["code"]);
  const message = text(error["message"])?.trim() ?? text(root["message"])?.trim() ?? `Vercel returned HTTP ${status}.`;
  const reviewed = reviewedCode(code);
  const detail = family
    ? `Vercel answered HTTP ${status}${reviewed ? ` (${reviewed})` : ""}; its message is withheld because this operation handles secret values.`
    : (code ? `Vercel ${code}: ${message}` : message).slice(0, 1_000);
  if (status === 429) {
    const wait = resetAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `${detail} Vercel meters endpoints separately; wait for the reported reset before retrying this operation.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} The configured access token is invalid, expired, outside this team, or lacks the required scope. An operator must replace it or widen its Vercel scope.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} Vercel refused access to this team or resource. Ask the team administrator to grant access and an operator to widen the configured token's Vercel scope.`,
    );
  }
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
      `${detail} Confirm the team, project, deployment, domain, or environment-variable id with a list read.`,
    );
  }
  if (status === 400 || status === 409 || status === 422) return new ConnectorCallError("invalid_args", detail);
  if (status >= 500) {
    const wait = resetAfterMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `${detail} Vercel is failing upstream.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError("connector_call_failed", detail, { retryable: false });
}

/** The pinned index, shared by every Vercel REST connector in the deployment. */
let index: OperationIndex | undefined;

function vercelIndex(): OperationIndex {
  index ??= new OperationIndex(openapi, { vendor: "vercel", title: "Vercel" });
  return index;
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
function vercelPage(operations: OperationIndex, data: unknown, call: RestCall): RestPage | undefined {
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

/**
 * Items of a possibly cut-off JSON array, or complete NDJSON lines: a bounded
 * log read stops mid-body, and the rows it finished are still the answer.
 */
export function completeRows(body: string): unknown[] {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("[")) {
    const rows: unknown[] = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // A line the read cut off, or one Vercel did not finish.
      }
    }
    return rows;
  }
  try {
    const whole = JSON.parse(trimmed) as unknown;
    if (Array.isArray(whole)) return whole;
  } catch {
    // Cut off: scan for the complete top-level items below.
  }
  const rows: unknown[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let at = 1; at < trimmed.length; at += 1) {
    const character = trimmed[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      if (depth === 0 && start < 0) start = at;
    } else if (character === "{" || character === "[") {
      if (depth === 0) start = at;
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && start >= 0) {
        try {
          rows.push(JSON.parse(trimmed.slice(start, at + 1)));
        } catch {
          // Not a complete item.
        }
        start = -1;
      }
    }
  }
  return rows;
}

function clamp(value: unknown): { text?: string; textTruncated?: true } {
  if (typeof value !== "string") return {};
  return value.length > MAX_LOG_TEXT ? { text: value.slice(0, MAX_LOG_TEXT), textTruncated: true } : { text: value };
}

/** When a bounded log read stops early, and which rows count toward its row limit. */
interface LogLimits {
  waitMs: number;
  /** Stop once this many complete NDJSON rows that `accept` keeps have arrived. */
  maxRows?: number;
  accept?: (row: unknown) => boolean;
}

/**
 * A body that ends cleanly, instead of erroring, `waitMs` after the response
 * arrives or once `maxRows` accepted rows have arrived, whichever is first.
 * Rows are counted as each chunk lands, so a stream that stays open stops as
 * soon as it has answered.
 */
function boundedBody(
  body: ReadableStream<Uint8Array>,
  limits: LogLimits,
  stop: (reason: "time" | "rows") => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let rows = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), limits.waitMs);
  });
  const finish = async (controller: ReadableStreamDefaultController<Uint8Array>, reason?: "time" | "rows") => {
    clearTimeout(timer);
    if (reason) stop(reason);
    controller.close();
    if (reason) await reader.cancel().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "deadline") return await finish(controller, "time");
      if (next.done) return await finish(controller);
      controller.enqueue(next.value);
      if (limits.maxRows === undefined) return;
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (limits.accept && !limits.accept(row)) continue;
        rows += 1;
        if (rows >= limits.maxRows) return await finish(controller, "rows");
      }
    },
    async cancel(reason) {
      clearTimeout(timer);
      await reader.cancel(reason).catch(() => {});
    },
  });
}

async function failureBody(response: { jsonResult(): Promise<{ value: unknown } | { parseError: unknown }> }) {
  try {
    const parsed = await response.jsonResult();
    return "value" in parsed ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

const TEAM_ID: JsonSchema = {
  type: ["string", "null"],
  minLength: 1,
  description: "Vercel team id. Omit for the connection's default; null for the token owner's personal account.",
};

const PROJECT_ID: JsonSchema = { type: "string", minLength: 1, description: "Project id or name." };

const ENV_VAR_ID: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Environment-variable id from list_project_env_vars.",
};

const TARGETS: JsonSchema = {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: {
    type: "string",
    enum: ["production", "preview", "development"],
    description: "A default Vercel environment.",
  },
  description: "Default Vercel environments that receive this value.",
};

const CUSTOM_ENVIRONMENT_IDS: JsonSchema = {
  type: "array",
  uniqueItems: true,
  items: { type: "string", minLength: 1, description: "A custom environment id." },
  description: "Custom environment ids that receive this value.",
};

const ENV_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    type: { type: "string" },
    target: { type: ["array", "string"], items: { type: "string" } },
    gitBranch: { type: ["string", "null"] },
    customEnvironmentIds: { type: "array", items: { type: "string" } },
    comment: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["id", "key", "type"],
};

/** Deliberately omits `value`, even though redaction already removed it. */
function envMetadata(value: unknown): JsonRecord {
  const variable = record(value);
  return compact({
    id: variable["id"],
    key: variable["key"],
    type: variable["type"],
    target: variable["target"],
    gitBranch: variable["gitBranch"],
    customEnvironmentIds: variable["customEnvironmentIds"],
    comment: variable["comment"],
    createdAt: variable["createdAt"],
    updatedAt: variable["updatedAt"],
  });
}

function closed(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function segment(value: unknown): string {
  return encodeURIComponent(String(value));
}

function decodeUpload(args: JsonRecord): Uint8Array {
  const hasText = typeof args["textBody"] === "string";
  const hasBase64 = typeof args["base64Body"] === "string";
  if (hasText === hasBase64) invalid("Provide exactly one of textBody or base64Body for a Vercel upload.");
  let bytes: Uint8Array;
  if (hasText) bytes = new TextEncoder().encode(args["textBody"] as string);
  else {
    try {
      bytes = Uint8Array.from(atob(args["base64Body"] as string), (character) => character.charCodeAt(0));
    } catch {
      return invalid("base64Body is not valid base64.");
    }
  }
  if (bytes.length > MAX_UPLOAD_BYTES)
    invalid(`A Vercel upload through Connecta is at most ${MAX_UPLOAD_BYTES} bytes.`);
  return bytes;
}

async function sha1(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface VercelRest {
  vendor: RestVendor;
  tools: ApiTool[];
  testCredential(value: string, ctx: ConnectorContext): Promise<CredentialTestResult>;
}

/** Vercel's REST vendor, its named tools, and its credential test, for one connection. */
export function vercelRest(options: { baseUrl: string; teamId: string | undefined }): VercelRest {
  const operations = vercelIndex();
  const { teamId } = options;
  const authenticate = async (ctx: ConnectorContext) => {
    const token = (await ctx.credential?.get())?.trim();
    if (!token) {
      throw new ConnectorCallError(
        "auth_required",
        "No Vercel access token is configured for this connector. An operator must add one in this connection in the operator UI.",
      );
    }
    return { Authorization: `Bearer ${token}` };
  };
  const transport = restTransport({
    provider: "Vercel",
    baseUrl: options.baseUrl,
    headers: { Accept: "application/json" },
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: READ_CAP_MS,
    authenticate,
  });
  const refuse = (call: RestCall): string | undefined => {
    const verdict = verdictFor(call.method, call.op.path);
    if (verdict?.verdict === "refuse") return `Connecta refuses ${call.method} ${call.op.path}: it ${verdict.reason}`;
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
  const vendor: RestVendor = {
    vendor: "vercel",
    title: "Vercel",
    index: operations,
    transport(server) {
      return server === undefined
        ? transport
        : `This operation is served from ${server}, which this connector does not reach.`;
    },
    failure: (status, headers, body, call) =>
      vercelFailure(status, headers, body, call ? secretFamily(call.method, call.op.path) : false),
    readPosts: READ_POSTS,
    refuse,
    scope(call) {
      const query: JsonRecord = { ...call.query };
      // null selects the token owner's personal account: no team parameter at all.
      if (query["teamId"] === null) {
        delete query["teamId"];
        return { ...call, query };
      }
      if (teamId && query["teamId"] === undefined && query["slug"] === undefined) {
        if (queryNamesOf(operations, call.op).has("teamId")) query["teamId"] = teamId;
      }
      return { ...call, query };
    },
    page: (data, call) => vercelPage(operations, data, call),
    redact: (data, call) => redactResponse(data, call.method, call.op.path),
    upload: "Send raw bytes with vercel_api_upload.",
  };

  const family = (call: RestCall) => secretFamily(call.method, call.op.path);
  const send = (method: RestMethod, path: string, ctx: ConnectorContext, input: Parameters<typeof restCall>[3] = {}) =>
    callRest(vendor, restCall(vendor, method, path, input), ctx);

  /**
   * Read one bounded log body: at most `MAX_LOG_BYTES`, never past `waitMs`
   * after Vercel starts answering, and no further than `maxRows` accepted
   * rows, whichever comes first. A follow stream
   * ends at the deadline instead of failing, so the rows read so far are the
   * answer.
   */
  const boundedRows = async (
    call: RestCall,
    ctx: ConnectorContext,
    limits: LogLimits,
  ): Promise<{ rows: unknown[]; stopped: "end" | "time" | "bytes" | "rows" }> => {
    let stopped: "time" | "rows" | undefined;
    const logs: GuardedTransport = guardedFetch({
      provider: "Vercel",
      baseUrl: options.baseUrl,
      headers: { Accept: "application/json" },
      maxResponseBytes: MAX_RESPONSE_BYTES,
      authenticate,
      fetch: async (url, init) => {
        const cap = AbortSignal.timeout(READ_CAP_MS);
        const response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, cap]) : cap });
        if (!response.ok || !response.body) return response;
        return new Response(
          boundedBody(response.body, limits, (reason) => (stopped = reason)),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      },
    });
    const query: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(call.query)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") query[name] = value;
    }
    return await logs({ method: "GET", path: call.path, query, prefixOnly: true }, ctx, async (response) => {
      if (!response.ok) {
        throw vercelFailure(response.status, response.headers, await failureBody(response), family(call));
      }
      const { bytes, truncated } = await response.prefix(MAX_LOG_BYTES);
      const rows = completeRows(new TextDecoder().decode(bytes)).map((row) =>
        redactResponse(row, call.method, call.op.path),
      );
      return { rows, stopped: truncated ? "bytes" : (stopped ?? "end") };
    });
  };

  const tools: ApiTool[] = [
    {
      name: "list_teams",
      description:
        "List the Vercel teams this token can reach, with ids and slugs to pass as teamId. Also names the connection's default team.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Most teams per page; default 20." },
          until: { type: "number", description: "page.next from the previous page: a millisecond timestamp." },
        },
        [],
      ),
      outputSchema: {
        type: "object",
        properties: {
          teams: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                slug: { type: "string" },
                name: { type: ["string", "null"] },
                role: { type: "string" },
              },
              required: ["id", "slug"],
            },
          },
          defaultTeamId: { type: ["string", "null"], description: "The team operations use when teamId is omitted." },
          page: {
            type: "object",
            properties: { hasMore: { type: "boolean" }, next: { type: "string" }, param: { type: "string" } },
            required: ["hasMore"],
          },
        },
        required: ["teams", "defaultTeamId"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const result = await send("GET", "/v2/teams", ctx, {
          query: compact({ limit: args["limit"] ?? 20, until: args["until"] }),
        });
        const teams = Array.isArray(record(result.data)["teams"]) ? (record(result.data)["teams"] as unknown[]) : [];
        return {
          teams: teams.map((team) => {
            const entry = record(team);
            return compact({
              id: entry["id"],
              slug: entry["slug"],
              name: entry["name"] ?? null,
              role: record(entry["membership"])["role"],
            });
          }),
          defaultTeamId: teamId ?? null,
          ...(result.page ? { page: result.page } : {}),
        };
      },
    },
    {
      name: "list_project_env_vars",
      description:
        "List a project's environment-variable metadata without decrypting or returning values: keys, types, targets, branches, and custom environments.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          teamId: TEAM_ID,
          gitBranch: { type: "string", description: "Preview branch filter." },
          customEnvironmentId: { type: "string", description: "Custom environment filter." },
        },
        ["projectId"],
      ),
      outputSchema: {
        type: "object",
        properties: { variables: { type: "array", items: ENV_SCHEMA } },
        required: ["variables"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const { data } = await send("GET", `/v10/projects/${segment(args["projectId"])}/env`, ctx, {
          query: compact({
            teamId: args["teamId"],
            gitBranch: args["gitBranch"],
            customEnvironmentId: args["customEnvironmentId"],
            decrypt: "false",
          }),
        });
        const envs = record(data)["envs"];
        return { variables: (Array.isArray(envs) ? envs : []).map(envMetadata) };
      },
    },
    {
      name: "upsert_project_env_var",
      description:
        "Create or replace one Vercel project environment variable. Changes affect only future deployments; returns metadata without the value.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          teamId: TEAM_ID,
          key: { type: "string", minLength: 1, maxLength: 256, description: "Environment variable name." },
          value: {
            type: "string",
            maxLength: 65536,
            description: "New value; write input only. Vercel caps a project's environment at 64 KB.",
          },
          type: {
            type: "string",
            enum: ["plain", "encrypted", "sensitive"],
            description: "Storage type. Sensitive values cannot be read back.",
          },
          targets: TARGETS,
          gitBranch: { type: "string", description: "Optional preview-only Git branch." },
          customEnvironmentIds: CUSTOM_ENVIRONMENT_IDS,
          comment: { type: "string", maxLength: 500, description: "Operator-facing note explaining the variable." },
          upsert: {
            type: "boolean",
            description: "Defaults to true. False refuses to overwrite an existing variable.",
          },
        },
        ["projectId", "key", "value", "type", "targets"],
      ),
      outputSchema: ENV_SCHEMA,
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const { data } = await send("POST", `/v10/projects/${segment(args["projectId"])}/env`, ctx, {
          query: compact({ teamId: args["teamId"], upsert: args["upsert"] === false ? "false" : "true" }),
          body: compact({
            key: args["key"],
            value: args["value"],
            type: args["type"],
            target: args["targets"],
            gitBranch: args["gitBranch"],
            customEnvironmentIds: args["customEnvironmentIds"],
            comment: args["comment"],
          }),
        });
        const payload = record(data);
        const failed = Array.isArray(payload["failed"]) ? payload["failed"] : [];
        if (failed.length > 0) {
          // Vercel's message can quote the existing value: only a reviewed code is named.
          const code = reviewedCode(record(record(failed[0])["error"])["code"]);
          throw new ConnectorCallError(
            "invalid_args",
            code === "ENV_ALREADY_EXISTS" || code === "ENV_CONFLICT"
              ? `Vercel ${code}: a variable with this key already targets one of these environments. Pass upsert: true to replace it, or update it by id with update_project_env_var.`
              : `Vercel rejected the environment-variable write${code ? ` (${code})` : ""}; its message is withheld because it can quote stored values.`,
          );
        }
        const created = Array.isArray(payload["created"]) ? payload["created"][0] : payload["created"];
        const result = envMetadata(created ?? payload);
        if (!result["id"] || !result["key"] || !result["type"]) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "Vercel accepted the environment-variable write without returning the created variable.",
            { retryable: false },
          );
        }
        return result;
      },
    },
    {
      name: "update_project_env_var",
      description:
        "Update one Vercel project environment variable by id, sending only the fields that change. Deployments keep their previous values.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          teamId: TEAM_ID,
          envVarId: ENV_VAR_ID,
          key: { type: "string", minLength: 1, maxLength: 256, description: "Replacement variable name." },
          value: { type: "string", maxLength: 65536, description: "Replacement value; write input only." },
          type: { type: "string", enum: ["plain", "encrypted", "sensitive"], description: "Replacement storage type." },
          targets: { ...TARGETS, description: "Replacement default environments." },
          gitBranch: { type: ["string", "null"], description: "Replacement preview branch, or null to clear it." },
          customEnvironmentIds: { ...CUSTOM_ENVIRONMENT_IDS, description: "Replacement custom environment ids." },
          comment: { type: "string", maxLength: 500, description: "Replacement operator-facing note." },
        },
        ["projectId", "envVarId"],
      ),
      outputSchema: ENV_SCHEMA,
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const body = compact({
          key: args["key"],
          value: args["value"],
          type: args["type"],
          target: args["targets"],
          gitBranch: args["gitBranch"],
          customEnvironmentIds: args["customEnvironmentIds"],
          comment: args["comment"],
        });
        if (Object.keys(body).length === 0) {
          invalid("Nothing to update: provide key, value, type, targets, gitBranch, customEnvironmentIds, or comment.");
        }
        const { data } = await send(
          "PATCH",
          `/v9/projects/${segment(args["projectId"])}/env/${segment(args["envVarId"])}`,
          ctx,
          { query: compact({ teamId: args["teamId"] }), body },
        );
        return envMetadata(data);
      },
    },
    {
      name: "delete_project_env_var",
      description:
        "Delete one environment variable from a Vercel project by id. Existing deployments keep their embedded value; future deployments do not.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed({ projectId: PROJECT_ID, teamId: TEAM_ID, envVarId: ENV_VAR_ID }, ["projectId", "envVarId"]),
      outputSchema: {
        type: "object",
        properties: { deleted: { type: "boolean" }, envVarId: { type: "string" } },
        required: ["deleted", "envVarId"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        await send("DELETE", `/v9/projects/${segment(args["projectId"])}/env/${segment(args["envVarId"])}`, ctx, {
          query: compact({ teamId: args["teamId"] }),
        });
        return { deleted: true, envVarId: args["envVarId"] };
      },
    },
    {
      name: "get_deployment_build_logs",
      description:
        "Read a deployment's build events and log lines, without following live output. Bounded by limit and 1 MB; filter by build, time, or direction.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          deploymentId: { type: "string", minLength: 1, description: "Deployment id (dpl_…) or hostname." },
          teamId: TEAM_ID,
          buildId: { type: "string", minLength: 1, description: "Only this build's events (bld_…)." },
          direction: {
            type: "string",
            enum: ["forward", "backward"],
            description: "forward (default) reads oldest first; backward reads the newest first.",
          },
          limit: { type: "integer", minimum: 1, maximum: 2000, description: "Most events; default 200." },
          since: { type: "number", description: "Only events at or after this millisecond timestamp." },
          until: { type: "number", description: "Only events at or before this millisecond timestamp." },
        },
        ["deploymentId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                created: { type: "number" },
                type: { type: "string", description: "stdout, stderr, command, exit, deployment-state, and so on." },
                text: { type: "string" },
                textTruncated: { type: "boolean" },
                info: { type: "object", description: "Build step, entrypoint, and path when Vercel sends them." },
              },
            },
          },
          truncated: { type: "boolean", description: "True when the 1 MB or time cap stopped the read early." },
        },
        required: ["events", "truncated"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const call = restCall(vendor, "GET", `/v3/deployments/${segment(args["deploymentId"])}/events`, {
          query: compact({
            teamId: args["teamId"],
            name: args["buildId"],
            direction: args["direction"],
            limit: args["limit"] ?? 200,
            since: args["since"],
            until: args["until"],
            follow: 0,
          }),
        });
        const { rows, stopped } = await boundedRows(call, ctx, { waitMs: 20_000 });
        return {
          events: rows.map((row) => {
            const event = record(row);
            const payload = record(event["payload"]);
            const raw = isRecord(payload["info"])
              ? payload["info"]
              : isRecord(event["info"])
                ? event["info"]
                : undefined;
            const info = raw
              ? compact({
                  type: text(raw["type"]),
                  name: text(raw["name"]),
                  step: text(raw["step"]),
                  entrypoint: text(raw["entrypoint"]),
                  path: text(raw["path"]),
                  readyState: text(raw["readyState"]),
                })
              : undefined;
            return compact({
              created: event["created"] ?? payload["created"] ?? payload["date"],
              type: event["type"],
              ...clamp(payload["text"] ?? event["text"]),
              info,
            });
          }),
          truncated: stopped !== "end",
        };
      },
    },
    {
      name: "get_runtime_logs",
      description:
        "Collect a deployment's runtime log stream for at most waitMs or maxRows, then stop. Returns level, message, request path, and status per row.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          deploymentId: { type: "string", minLength: 1, description: "Deployment id (dpl_…)." },
          teamId: TEAM_ID,
          waitMs: {
            type: "integer",
            minimum: 1000,
            maximum: 20000,
            description: "How long to collect the stream; default 5000.",
          },
          maxRows: { type: "integer", minimum: 1, maximum: 1000, description: "Most rows returned; default 200." },
          levels: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "string",
              enum: ["debug", "info", "warning", "error", "fatal", "trace"],
              description: "A log level to keep.",
            },
            description: "Keep only these levels.",
          },
        },
        ["projectId", "deploymentId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          logs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                timestampInMs: { type: "number" },
                level: { type: "string" },
                source: { type: "string" },
                text: { type: "string" },
                textTruncated: { type: "boolean" },
                requestMethod: { type: "string" },
                requestPath: { type: "string" },
                responseStatusCode: { type: "number" },
                domain: { type: "string" },
              },
            },
          },
          stopped: {
            type: "string",
            enum: ["end", "time", "bytes", "rows"],
            description: "Why collection stopped.",
          },
        },
        required: ["logs", "stopped"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const call = restCall(
          vendor,
          "GET",
          `/v1/projects/${segment(args["projectId"])}/deployments/${segment(args["deploymentId"])}/runtime-logs`,
          { query: compact({ teamId: args["teamId"] }) },
        );
        const waitMs = typeof args["waitMs"] === "number" ? args["waitMs"] : 5_000;
        const maxRows = typeof args["maxRows"] === "number" ? args["maxRows"] : 200;
        const levels = Array.isArray(args["levels"]) ? new Set(args["levels"]) : undefined;
        const keep = (row: unknown) => !levels || levels.has(record(row)["level"]);
        const { rows, stopped } = await boundedRows(call, ctx, { waitMs, maxRows, accept: keep });
        const logs = rows
          .map(record)
          .filter(keep)
          .map((row) =>
            compact({
              timestampInMs: row["timestampInMs"],
              level: row["level"],
              source: row["source"],
              ...clamp(row["message"]),
              requestMethod: row["requestMethod"],
              requestPath: row["requestPath"],
              responseStatusCode: row["responseStatusCode"],
              domain: row["domain"],
            }),
          );
        return { logs: logs.slice(0, maxRows), stopped: logs.length > maxRows ? "rows" : stopped };
      },
    },
    {
      name: "vercel_api_upload",
      description:
        "Upload explicit text or base64 bytes to a Vercel octet-stream operation, such as POST /v2/files for deployment files. Reads no local files.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          method: { type: "string", enum: ["POST", "PUT"], description: "The operation's HTTP method." },
          path: {
            type: "string",
            minLength: 2,
            maxLength: 2048,
            description: "Concrete path of an octet-stream operation from vercel_api_search, e.g. /v2/files.",
          },
          query: { type: "object", description: "Query parameters as JSON, named as vercel_api_details lists them." },
          contentType: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Content-Type of the bytes; default application/octet-stream.",
          },
          textBody: { type: "string", description: "Raw UTF-8 body. Exclusive with base64Body." },
          base64Body: { type: "string", description: "Base64-encoded bytes. Exclusive with textBody." },
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "integer", description: "HTTP status." },
          data: { description: "Vercel's response body." },
          digest: { type: "string", description: "SHA-1 of the bytes, sent as x-vercel-digest for /v2/files." },
        },
        required: ["status", "data"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const call = restCall(vendor, args["method"] as RestMethod, String(args["path"]), {
          query: isRecord(args["query"]) ? args["query"] : {},
        });
        const framing = operations.bodyType(call.op) ?? "";
        if (!/octet-stream|^multipart\//.test(framing)) {
          invalid(`${call.method} ${call.op.path} is not an upload; call it with vercel_api_write.`);
        }
        const refusal = refuse(call);
        if (refusal) invalid(refusal);
        // Decode first, then validate what was supplied: a required binary body
        // is present whenever bytes are (the index types it as a string).
        const bytes = decodeUpload(args);
        operations.check(call.op, call.query, String(args["base64Body"] ?? args["textBody"]));
        const digest = call.op.path === "/v2/files" ? await sha1(bytes) : undefined;
        const query: Record<string, string | number | boolean> = {};
        for (const [name, value] of Object.entries(call.query)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") query[name] = value;
        }
        // A keyless write whose request may have reached Vercel has an unknown
        // outcome (INV-9): never advertised as retryable, except a
        // content-addressed upload, where repeating it stores the same bytes.
        const repeatable = CONTENT_ADDRESSED.has(`${call.method} ${call.op.path}`);
        let responded = false;
        try {
          return await transport(
            {
              method: call.method,
              path: call.path,
              query,
              headers: {
                "Content-Type":
                  typeof args["contentType"] === "string" ? args["contentType"] : "application/octet-stream",
                ...(digest ? { "x-vercel-digest": digest } : {}),
              },
              rawBody: bytes,
            },
            ctx,
            async (response) => {
              responded = true;
              if (!response.ok) {
                throw vercelFailure(response.status, response.headers, await failureBody(response), family(call));
              }
              let body: string;
              try {
                body = await response.text();
              } catch (error) {
                if (error instanceof ConnectorCallError) throw error;
                // Sent, answered, unread: whether the upload took effect is unknown (INV-9).
                throw new ConnectorCallError(
                  "connector_call_failed",
                  "Vercel answered the upload, but its response could not be read, so whether it took effect is unknown. Check the target before repeating it.",
                  { retryable: false },
                );
              }
              // Only JSON comes back, made value-safe; other bodies are described, never echoed.
              let data: unknown = null;
              if (body !== "") {
                try {
                  data = redactResponse(JSON.parse(body), call.method, call.op.path);
                } catch {
                  data = {
                    contentType: response.headers.get("content-type") ?? "",
                    bytes: new TextEncoder().encode(body).length,
                  };
                }
              }
              return { status: response.status, data, ...(digest ? { digest } : {}) };
            },
          );
        } catch (error) {
          throw repeatable ? error : unknownOutcome(vendor, error, responded);
        }
      },
    },
  ];

  return {
    vendor,
    tools,
    async testCredential(value, ctx) {
      const token = value.trim();
      try {
        const { data } = await callRest(vendor, restCall(vendor, "GET", "/v2/user"), {
          ...ctx,
          credential: { get: async () => token, getAll: async () => ({ value: token }) },
        });
        const payload = record(data);
        const user = record(payload["user"] ?? payload);
        const identity = text(user["username"]) ?? text(user["email"]) ?? text(user["name"]) ?? text(user["id"]);
        return { ok: true, message: `Authenticated as ${identity ?? "a Vercel user"}.` };
      } catch (error) {
        // Fixed text: Vercel's message can quote the candidate token.
        const code = error instanceof ConnectorCallError ? error.code : undefined;
        return {
          ok: false,
          message:
            code === "auth_required"
              ? "Vercel rejected the token: it is invalid, expired, or revoked."
              : code === "provider_permission_denied"
                ? "Vercel accepted the token but refused to read the current user; check the token's scope."
                : code === "rate_limited" || code === "unavailable"
                  ? "Vercel could not check the token right now; try again shortly."
                  : "Vercel did not accept the token.",
        };
      }
    },
  };
}
