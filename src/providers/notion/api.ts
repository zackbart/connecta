// Notion's pinned API and value-safety boundary on the provider kit. The compact index remains the hatch contract.
import { Effect, Schema, type Context } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import { restSafety, type SafetyOptions } from "../../http/safety.js";
import { Classification, Credentials, RequestSecrets, type CallServices } from "../../http/services.js";
import { get, type Connection, type ConnectOptions } from "../../http/vendor.js";
import type { ConnectorUsageGuide } from "../../types.js";
import { indexedVendor } from "../_shared/rest/kit.js";
import { OperationIndex, type RestMethod } from "../_shared/rest/operation-index.js";
import { type RestCall, type RestPage, type RestReadPost, type RestResult } from "../_shared/rest/tools.js";
import { carriesWithheldLink, valueSafety } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { NOTION_FILE_HOSTS, NOTION_VALUE_SAFETY, sanitizeLinks } from "./safety.js";
import { skill } from "./skill.generated.js";

export const NOTION_API_BASE_URL = "https://api.notion.com";
// Equal to the compact index: projections and authoring shapes assume this version.
export const NOTION_API_VERSION = "2026-03-11";
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const NOTION_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READ_POSTS: readonly RestReadPost[] = [
  ["POST", "/v1/search", "Searches titles shared with the integration; Notion persists nothing."],
  [
    "POST",
    "/v1/data_sources/{data_source_id}/query",
    "Lists a data source's rows by filter and sort; persists nothing.",
  ],
  ["POST", "/v1/blocks/meeting_notes/query", "Lists meeting notes by filter and sort; persists nothing."],
  ["POST", "/v1/agents/query", "Lists custom agents by name, filter, and sort; persists nothing."],
  ["POST", "/v1/sessions/query", "Lists agent sessions by title, filter, and sort; persists nothing."],
  ["POST", "/v1/sessions/{session_id}/events/query", "Lists one session's events; persists nothing."],
];

type JsonRecord = Record<string, any>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

/**
 * Notion repeats `Retry-After` in the body as `additional_data.retry_after`,
 * a string of whole seconds, so a proxy that drops the header still leaves a
 * window to wait out.
 */
function bodyRetryAfterMs(additional: unknown): number | undefined {
  const raw = isRecord(additional) ? additional["retry_after"] : undefined;
  const seconds = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1000) : undefined;
}

/** A Notion object id, dashed or not: the only committed-id shape shown when error text is withheld. */
const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * The ids a 503 reports as already committed, so a caller reads them instead
 * of repeating the write. For an operation whose error text is withheld, only
 * ids shaped as Notion ids are named, since anything else could echo what the
 * request sent; the write is still reported as committed.
 */
function committedIds(additional: unknown, withheld: boolean): string {
  if (!isRecord(additional)) return "";
  const resource = additional["committed_resource_id"];
  const children = Array.isArray(additional["committed_child_ids"])
    ? additional["committed_child_ids"].filter((child): child is string => typeof child === "string")
    : [];
  if (typeof resource !== "string" || resource === "") return "";
  if (withheld && ![resource, ...children].every((committed) => NOTION_ID.test(committed))) {
    return " Notion committed the write before failing; what it committed is withheld because this operation handles credentials. Read the object instead of repeating the write.";
  }
  return children.length
    ? ` Notion committed the write before failing: it appended ${children.length} block(s) (${children.join(", ")}) under ${resource}. Read that block instead of repeating the write.`
    : ` Notion committed the write before failing: the object it created or changed is ${resource}. Read it instead of repeating the write.`;
}

/**
 * Notion's own next step for a failed write, `additional_data.retry_guidance`.
 * An update to an existing object that was saved anyway names no committed
 * id, only this, so it is relayed as Notion wrote it.
 */
function retryGuidance(additional: unknown): string {
  const guidance = isRecord(additional) ? additional["retry_guidance"] : undefined;
  const lines = (Array.isArray(guidance) ? guidance : [guidance]).filter(
    (line): line is string => typeof line === "string" && line.trim() !== "",
  );
  return lines.map((line) => line.trim()).join(" ");
}

function page(data: unknown, call: RestCall): RestPage | undefined {
  if (!isRecord(data) || typeof data["has_more"] !== "boolean" || !Array.isArray(data["results"])) return undefined;
  if (!data["has_more"] && incomplete(data)) return { hasMore: true };
  const hasMore = data["has_more"];
  const next = typeof data["next_cursor"] === "string" && data["next_cursor"] !== "" ? data["next_cursor"] : undefined;
  if (!hasMore || !next) return { hasMore };
  if (data["object"] === "view_query" && typeof data["id"] === "string" && typeof data["view_id"] === "string") {
    return {
      hasMore,
      next,
      param: "start_cursor",
      in: "query",
      path: `/v1/views/${encodeURIComponent(data["view_id"])}/queries/${encodeURIComponent(data["id"])}`,
    };
  }
  return { hasMore, next, param: "start_cursor", ...(call.method === "GET" ? {} : { in: "body" as const }) };
}

/** Whether a query stopped at Notion's per-query result cap rather than at its last row. */
export function incomplete(data: JsonRecord): boolean {
  const status = data["request_status"];
  return isRecord(status) && status["type"] === "incomplete";
}

/**
 * A read copied into a write: a file link whose signature this connector
 * withheld would be stored as the placeholder, or fail an exact `old_str`
 * match. Refused before dispatch, named tools and generic writes alike.
 */
function refuseWithheldLinks(call: RestCall): void {
  if (call.method === "GET" || call.method === "HEAD") return;
  if (READ_POSTS.some(([method, path]) => method === call.method && path === call.op.path)) return;
  if (!carriesWithheldLink(call.body, NOTION_FILE_HOSTS)) return;
  invalid(
    "This write carries a Notion file link whose signature Connecta withheld ([redacted]), so Notion would store the placeholder. A redacted file URL cannot be copied into a write: re-upload the file (POST /v1/file_uploads), reference the existing block instead, and match Markdown edits on the text around the media rather than its URL.",
  );
}

// Construction reads the pin, never a caller's context. Request schemas stay lazily expanded by OperationIndex.
export const notionIndex = new OperationIndex(openapi, { vendor: "notion", title: "Notion" });
const SAFETY = valueSafety(NOTION_VALUE_SAFETY, () => notionIndex);
const getMe = get("getMe", "/v1/users/me", { success: Schema.Unknown });
export const NotionApi = {
  ...indexedVendor("Notion", notionIndex, [getMe]),
  textBodies: {
    review: "The legacy REST hatch decodes JSON, text and newline-delimited JSON responses by Content-Type.",
    forResponse: (_status, _operation, contentType = "") =>
      /\b(?:x-ndjson|jsonl|stream\+json)\b/.test(contentType)
        ? ("text" as const)
        : /\bjson\b|\+json\b/.test(contentType)
          ? ("json-or-text" as const)
          : ("text" as const),
  },
};
export const safety: SafetyOptions = {
  reviewed: restSafety(SAFETY, notionIndex),
  sensitiveFields: { names: [], choice: "drop" },
};
export const authenticate = Effect.gen(function* () {
  const token = (yield* (yield* Credentials).values.pipe(
    Effect.mapError((error) => new Refusal({ error })),
  ))?.value?.trim();
  if (!token)
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "No Notion integration token is configured for this connector. Call authorize_connector for recovery options. When available, an operator can add the token in this connection in the operator UI.",
        ),
      }),
    );
  return { Authorization: `Bearer ${token}` };
});
export const NOTION_REST = {
  vendor: "notion",
  title: "Notion",
  index: notionIndex,
  valueSafety: SAFETY,
  readPosts: READ_POSTS,
  admit: refuseWithheldLinks,
  page,
  upload:
    'Create the upload with POST /v1/file_uploads and mode "external_url" instead; this connector sends no multipart bodies.',
  bodyHint: "Notion's JSON request body as notion_api_details lists it",
};
const failed = (error: ConnectorCallError) => Effect.fail(new Refusal({ error }));
export function callNotion(
  connection: Connection,
  call: RestCall,
  step?: string,
): Effect.Effect<RestResult, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    const refusal =
      call.op.server === undefined
        ? undefined
        : `This operation is served from ${call.op.server}, which this connector does not reach.`;
    if (refusal) return yield* failed(new ConnectorCallError("invalid_args", refusal));
    yield* Effect.try({
      try: () => refuseWithheldLinks(call),
      catch: (error) => new Refusal({ error: error as ConnectorCallError }),
    });
    const query: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(call.query)) {
      if (value === undefined) continue;
      const scalar = (item: unknown): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean";
      if (scalar(value) || (Array.isArray(value) && value.every(scalar))) {
        for (const item of Array.isArray(value) ? value : [value]) query.push([name, String(item)]);
      } else
        return yield* failed(
          new ConnectorCallError(
            "invalid_args",
            `Notion query parameter ${name} takes a string, number, boolean, or a list of them.`,
          ),
        );
    }
    const write = (yield* Classification) === "write";
    const reply = yield* connection.sendPath(
      {
        method: call.method,
        path: call.path,
        template: call.op.path,
        query,
        ...(call.body === undefined ? {} : { json: JSON.stringify(call.body) }),
      },
      { ...(step ? { step } : {}), ...(write ? { flags: { write: true } } : {}) },
    );
    const data = reply.data;
    const next = page(data, call);
    return { status: reply.status, data, ...(next ? { page: next } : {}) };
  });
}
function notionCall(
  method: RestMethod,
  path: string,
  input: { query?: Record<string, unknown>; body?: unknown },
): RestCall {
  const { op, params } = notionIndex.resolve(method, path);
  return { method: op.method, path, op, params, query: input.query ?? {}, body: input.body };
}
export function notion(
  connection: Connection,
  method: RestMethod,
  path: string,
  input: { query?: Record<string, unknown>; body?: unknown } = {},
  step?: string,
): Effect.Effect<JsonRecord, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    const call = yield* Effect.try({
      try: () => notionCall(method, path, input),
      catch: (error) => new Refusal({ error: error as ConnectorCallError }),
    });
    const { data } = yield* callNotion(connection, call, step);
    if (!isRecord(data))
      return yield* failed(
        new ConnectorCallError(
          "connector_call_failed",
          "Notion returned an unreadable or non-object response for a successful status. The request was sent, but its result could not be read; do not repeat a write to recover its result.",
          { retryable: false },
        ),
      );
    return data;
  });
}
function protectRichText(secrets: Context.Service.Shape<typeof RequestSecrets>, body: unknown): unknown {
  const pending: [unknown, boolean][] = [[body, false]];
  while (pending.length) {
    const [value, bounded] = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (
      Array.isArray(value) &&
      value.length &&
      value.every((run) => isRecord(run) && typeof run.plain_text === "string")
    )
      protectRuns(secrets, value as Record<string, any>[], bounded);
    else {
      const cut = isRecord(value) && value.has_more === true;
      for (const child of Object.values(value)) pending.push([child, cut]);
    }
  }
  return body;
}

function protectRuns(
  secrets: Context.Service.Shape<typeof RequestSecrets>,
  runs: Record<string, any>[],
  bounded: boolean,
): void {
  for (const authored of [false, true]) {
    const parts = runs.map((run) =>
      authored && typeof run.text?.content === "string" ? (run.text.content as string) : (run.plain_text as string),
    );
    const safe = secrets.parts(parts, bounded);
    runs.forEach((run, index) => {
      if (safe[index] === parts[index]) return;
      if (!authored) run.plain_text = safe[index];
      else if (isRecord(run.text) && typeof run.text.content === "string") run.text.content = safe[index];
    });
  }
}

export const result: NonNullable<ConnectOptions["result"]> = (body, answer) =>
  Effect.gen(function* () {
    const type = (answer.headers.get("content-type") ?? "").toLowerCase();
    if (
      /\bjson\b|\+json\b/.test(type) &&
      answer.bodyFormat === "text" &&
      typeof body === "string" &&
      body.trim() !== ""
    )
      return yield* failed(
        new ConnectorCallError("connector_call_failed", "Notion returned malformed JSON.", { retryable: false }),
      );
    if (/\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type) && typeof body === "string")
      body = body
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { line };
          }
        });
    return sanitizeLinks((yield* RequestSecrets).redact(protectRichText(yield* RequestSecrets, body ?? null)));
  });
export const probe = {
  operation: getMe,
  request: {},
  describe: (reply: unknown): string => {
    if (!isRecord(reply))
      throw new ConnectorCallError(
        "connector_call_failed",
        "Notion returned an unreadable or non-object response for a successful status. The request was sent, but its result could not be read; do not repeat a write to recover its result.",
        { retryable: false },
      );
    return `Authenticated as ${reply["bot"]?.workspace_name ?? reply["name"] ?? "Notion"}.`;
  },
};
export function usageGuide(options: { purpose: string; instructions?: string }): ConnectorUsageGuide {
  const instructions = options.instructions?.trim();
  return {
    content: `# Notion usage

Workspace purpose: ${options.purpose}${skill.fragments.key}${skill.fragments.shared}${instructions ? `\n## ${skill.instructionsHeading}\n\n${instructions}\n` : ""}`,
    summary:
      "Internal integration over REST. Flattened reads, authoring helpers, and the pinned API index for the rest.",
    required: true,
  };
}

/** Notion's machine-readable error metadata, separate from its prose and from the core's write outcome. */
export const errors: VendorErrors = {
  provider: "Notion",
  presence: {
    commit: { path: ["additional_data", "committed_resource_id"], content: "string" },
    guidance: { path: ["additional_data", "retry_guidance"], content: "text" },
  },
  facts: (payload) => {
    const body = isRecord(payload) ? payload : {};
    const extra = isRecord(body.additional_data) ? body.additional_data : {};
    return {
      code: typeof body.code === "string" ? body.code : undefined,
      reason: typeof extra.rate_limit_reason === "string" ? extra.rate_limit_reason : undefined,
      retryAfter: bodyRetryAfterMs(extra),
      committed: typeof extra.committed_resource_id === "string" ? extra.committed_resource_id : undefined,
      children: Array.isArray(extra.committed_child_ids) ? extra.committed_child_ids : undefined,
    };
  },
  detail: ({ body: payload, status, withheld, facts, presence }) => {
    const body = isRecord(payload) ? (sanitizeLinks(payload) as JsonRecord) : {};
    const extra = withheld
      ? { committed_resource_id: facts.committed, committed_child_ids: facts.children }
      : body.additional_data;
    const detail = withheld
      ? `Notion answered HTTP ${status}; its message is withheld because this operation handles credentials.`
      : typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : `Notion returned HTTP ${status}.`;
    const label = facts.code ? `Notion ${facts.code}: ${detail}` : detail;
    if (status < 500 || status === 529) return label;
    const committed = committedIds(extra, withheld);
    if (committed) return `${label}${committed}`;
    if (presence.commit?.present && withheld)
      return `${label} Notion committed the write before failing; what it committed is withheld because this operation handles credentials. Read the object instead of repeating the write.`;
    if (presence.guidance?.nonBlank)
      return withheld
        ? `${label} Notion sent retry guidance, withheld because this operation handles credentials. Read the object before repeating the write.`
        : `${label} Notion's guidance: ${retryGuidance(extra)}`;
    return `${label} Notion is failing upstream.`;
  },
  unreadable: "Notion returned malformed JSON.",
  statuses: {
    400: () => ({ code: "invalid_args" }),
    401: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} The Notion integration token is missing or invalid. Call authorize_connector for recovery options. When available, an operator can set a valid token in this connection in the operator UI.`,
    }),
    403: () => ({
      code: "provider_permission_denied",
      retryable: false,
      words: (detail) =>
        `${detail} The token is valid but Notion refused this operation, and Notion's message says why. Usually an operator must enable the matching capability on the Notion integration (comment capabilities are off by default) or share the object with it; a workspace past its plan's block limit also answers 403. Re-authorizing will not help.`,
    }),
    404: () => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) =>
        `${detail} Notion returns this both for an object that does not exist and for one that exists but has not been shared with this integration — do not treat it as proof of deletion. Confirm the id, then confirm the page or database is shared with the integration in Notion.`,
    }),
    409: ({ operation, retryAfterMs, facts }) =>
      operation.flags?.write
        ? {
            code: "conflict",
            retryable: false,
            words: (detail) =>
              `${detail} Notion reported a conflicting transaction. Re-read the target and decide whether the write is still needed; do not repeat it automatically.`,
          }
        : {
            code: "unavailable",
            retryAfterMs: retryAfterMs ?? Number(facts.retryAfter ?? 1000),
            words: (detail) => `${detail} Notion reported a write conflict; this is safe to retry.`,
          },
    422: () => ({ code: "connector_call_failed", retryable: false }),
    429: ({ facts, retryAfterMs }) => {
      const reason = facts.reason;
      if (reason === "public_api_request_blocked")
        return {
          code: "connector_call_failed",
          retryable: false,
          words: (detail) =>
            `${detail} (limit: ${reason}) Notion has restricted this integration's API access. Retrying will not help; an operator must contact Notion support.`,
        };
      const scope =
        reason === "public_api_space_request_rate_limit"
          ? " The workspace's shared budget across all its connections is spent, and its window can exceed a minute."
          : " Notion allows each integration 180 requests a minute (600 on Business and Enterprise), and a separate budget shared by the whole workspace.";
      return {
        code: "rate_limited",
        retryAfterMs: retryAfterMs ?? Number(facts.retryAfter ?? 1000),
        words: (detail) => `${detail}${typeof reason === "string" ? ` (limit: ${reason})` : ""}${scope}`,
        advice: " Wait out the retry window.",
      };
    },
    529: ({ retryAfterMs, facts }) => ({
      code: "unavailable",
      retryAfterMs: retryAfterMs ?? Number(facts.retryAfter ?? 5000),
      words: (detail) => `${detail} Notion is overloaded.`,
      advice: "; retry after the reported window",
    }),
    serverError: ({ facts, retryAfterMs, presence }) =>
      presence.commit?.present || presence.guidance?.nonBlank
        ? { code: "connector_call_failed", retryable: false }
        : {
            code: "unavailable",
            retryAfterMs: retryAfterMs ?? (typeof facts.retryAfter === "number" ? facts.retryAfter : undefined),
          },
    otherwise: () => ({ code: "connector_call_failed", retryable: false }),
  },
};
