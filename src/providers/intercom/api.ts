import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, StatusFailure, type VendorErrors } from "../../http/errors.js";
import type { HatchPageAdapter } from "../../http/hatch-paging.js";
import type { HatchBinding } from "../../http/hatch.js";
import { Credentials } from "../../http/services.js";
import { restSafety } from "../../http/safety.js";
import { get } from "../../http/vendor.js";
import type { ConnectOptions, Connection } from "../../http/vendor.js";
import { checked, indexedVendor } from "../_shared/rest/kit.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { queryPairs } from "./lib/query.js";
import { INTERCOM_VALUE_SAFETY, NAMED_WRITES, READS } from "./safety.js";

export const index = new OperationIndex(openapi, { vendor: "intercom", title: "Intercom" });

export const verdicts = Object.fromEntries(
  index.ops.map((op) => {
    const key = `${op.method} ${op.path}`;
    return [key, READS.has(key) ? ("read" as const) : ("refuse" as const)];
  }),
);

export const named = {
  [NAMED_WRITES.reply]: "reply_to_conversation",
  [NAMED_WRITES.manage]: "close_conversation",
  [NAMED_WRITES.tag]: "tag_conversation",
  [NAMED_WRITES.untag]: "untag_conversation",
};

const identifyAdmin = get("identifyAdmin", "/me", { success: Schema.Unknown });
export const IntercomApi = indexedVendor("Intercom", index, [identifyAdmin]);

const reviewed = valueSafety(INTERCOM_VALUE_SAFETY, () => index);
export const safety = () => ({
  reviewed: restSafety(reviewed, index),
  sensitiveFields: { names: [], choice: "drop" as const },
});

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const printableToken = (value: string) => /^[!-~]+$/.test(value);

function cursorToken(cursor: unknown): string {
  if (
    typeof cursor !== "string" ||
    !cursor.trim() ||
    cursor.length > 2048 ||
    !printableToken(cursor) ||
    /^[a-z][a-z0-9+.-]*:/i.test(cursor)
  )
    throw new ConnectorCallError("invalid_args", "This cursor contains no valid Intercom starting_after token.");
  return cursor;
}

const startingAfter: HatchPageAdapter = {
  param: "starting_after",
  in: "query",
  cursorInputMessage:
    "Omit starting_after on the first call; pass page.nextCursor unchanged as top-level cursor thereafter.",
  decode: cursorToken,
  next(data) {
    const body = record(data);
    if (!Object.hasOwn(body, "pages")) return undefined;
    const next = record(body["pages"])["next"];
    if (next === undefined || next === null) return null;
    try {
      return cursorToken(record(next)["starting_after"]);
    } catch {
      throw new ConnectorCallError("connector_call_failed", "Intercom returned invalid paging metadata.", {
        retryable: false,
      });
    }
  },
};

const conversationPartsPage: HatchPageAdapter = {
  param: "page",
  in: "query",
  initialAnchor: true,
  decode(cursor) {
    const value = Number(cursor);
    if (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(value) || value < 1)
      throw new ConnectorCallError("invalid_args", "query.page must be a whole number from 1.");
    return value;
  },
  next(data, call) {
    const parts = record(record(data)["conversation_parts"]);
    if (!Object.hasOwn(parts, "pages")) return undefined;
    const pages = record(parts["pages"]);
    const current = Number(pages["page"] ?? call.query["page"]);
    if (!Number.isSafeInteger(current) || current < 1)
      throw new ConnectorCallError("connector_call_failed", "Intercom returned invalid paging metadata.", {
        retryable: false,
      });
    const next = pages["next"];
    if (typeof next === "string" && next) return current + 1;
    const total = Number(pages["total_pages"]);
    return Number.isSafeInteger(total) && current < total ? current + 1 : null;
  },
};

const CONVERSATION = "GET /conversations/{conversation_id}";
const PART_LIMIT = 500;

export const pages = {
  ...Object.fromEntries(
    index.ops
      .filter(
        (op) =>
          READS.has(`${op.method} ${op.path}`) &&
          op.method === "GET" &&
          index.contract(op).parameters.some((param) => param.in === "query" && param.name === "starting_after"),
      )
      .map((op) => [`${op.method} ${op.path}`, startingAfter]),
  ),
  [CONVERSATION]: conversationPartsPage,
};

function partsWarning(
  call: { readonly op: { readonly method: string; readonly path: string } },
  query: Readonly<Record<string, unknown>>,
  data: unknown,
) {
  if (`${call.op.method} ${call.op.path}` !== CONVERSATION || query["page"] !== undefined) return [];
  const parts = record(record(data)["conversation_parts"])["conversation_parts"];
  return Array.isArray(parts) && parts.length >= PART_LIMIT
    ? [
        "Intercom returned only the 500 most recent conversation parts. To read every part, repeat this read with query.page 1 (and query.per_page up to 500), then follow page.nextCursor; pages run oldest first.",
      ]
    : [];
}

function namesAdmin(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => namesAdmin(item, depth + 1));
  return Object.entries(value).some(([key, item]) => key === "admin_id" || namesAdmin(item, depth + 1));
}

const ADMIN_REFUSAL =
  "admin_id is set by this connection's deployment config, never by a call; remove it and the configured teammate acts.";

export function binding({ connection }: { connection: Connection }): HatchBinding {
  return {
    review:
      "Reads only; any admin_id in a query or body is refused because the acting teammate comes from deployment config. Query parameters follow the pinned style: explode:false arrays comma-joined, the exploded /events filter object spread into its field. JSON framing through Connection.sendPath.",
    refuse: (call) => (namesAdmin(call.query) || namesAdmin(call.body) ? ADMIN_REFUSAL : undefined),
    warnings: true,
    send: (call, options) =>
      Effect.gen(function* () {
        const query = yield* checked(() => queryPairs(`${call.method} ${call.op.path}`, call.query));
        const answer = yield* connection.sendPath(
          {
            method: call.method,
            path: call.path,
            template: call.op.path,
            query,
            ...(call.body === undefined ? {} : { json: JSON.stringify(call.body) }),
          },
          options,
        );
        const warnings = partsWarning(call, call.query, answer.data);
        return warnings.length ? { ...answer, warnings } : answer;
      }),
  };
}

export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const token = values?.value?.trim();
  if (!token || !printableToken(token))
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "An operator must configure a valid Intercom access token in this connection's credential slot.",
        ),
      }),
    );
  return { Authorization: `Bearer ${token}` };
});

type IntercomFacts = { readonly code?: string | undefined };

export const errors: VendorErrors<IntercomFacts> = {
  provider: "Intercom",
  facts: (body) => {
    const first = record(Array.isArray(record(body)["errors"]) ? (record(body)["errors"] as unknown[])[0] : undefined);
    return { code: text(first["code"]) };
  },
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "Intercom sends Retry-After seconds on some 429s, such as a conversation receiving parts too quickly.",
    },
  },
  meanings: {
    unknownId: "connector_call_failed",
    provesAbsence: false,
    conflicts: ["HTTP 409 when several existing contacts match the email address a request named"],
  },
  detail: ({ status, facts }) => `Intercom returned HTTP ${status}${facts.code ? ` (${facts.code})` : ""}.`,
  unreadable: "Intercom returned an invalid JSON success body.",
  statuses: {
    401: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} The access token is invalid or revoked, or the workspace is hosted in another region; an operator must fix the connection.`,
    }),
    403: () => ({
      code: "provider_permission_denied",
      words: (detail) =>
        `${detail} The app's scopes, the plan, or the installing teammate's conversation access does not allow this request.`,
    }),
    404: () => ({
      code: "connector_call_failed",
      words: (detail) =>
        `${detail} The record is missing or outside the token teammate's access; this does not prove it does not exist.`,
    }),
    409: () => ({ code: "conflict" }),
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: retryAfterMs ?? 10_000,
      words: (detail) => `${detail} Intercom meters requests in 10-second windows. Wait before retrying.`,
    }),
  },
};

export const result: ConnectOptions["result"] = (body, answer) =>
  body !== null && typeof body === "object"
    ? Effect.succeed(body)
    : Effect.fail(
        new StatusFailure({ status: answer.status, headers: answer.headers, body: {}, operation: answer.operation }),
      );

export const probe = {
  operation: identifyAdmin,
  request: {},
  check: (values: { readonly value?: string }) =>
    !values.value?.trim() || !printableToken(values.value.trim()) ? "Enter an Intercom access token." : undefined,
  describe: (body: unknown) => {
    const admin = record(body),
      app = record(admin["app"]);
    const workspace = text(app["name"]) ?? text(app["id_code"]) ?? "an Intercom workspace";
    const region = text(app["region"]);
    return `Authenticated to ${workspace}${region ? ` (${region})` : ""} with a token issued to admin ${text(admin["id"]) ?? "unknown"}.`;
  },
};
