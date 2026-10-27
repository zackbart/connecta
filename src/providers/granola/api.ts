import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, StatusFailure, type VendorErrors } from "../../http/errors.js";
import type { HatchPageAdapter } from "../../http/hatch-paging.js";
import type { HatchBinding } from "../../http/hatch.js";
import { Credentials } from "../../http/services.js";
import { restSafety } from "../../http/safety.js";
import { get } from "../../http/vendor.js";
import type { ConnectOptions as ConnectionOptions } from "../../http/vendor.js";
import type { Connection } from "../../http/vendor.js";
import { indexedVendor } from "../_shared/rest/kit.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { GRANOLA_VALUE_SAFETY, READS } from "./safety.js";

export const index = new OperationIndex(openapi, { vendor: "granola", title: "Granola" });
export const verdicts = Object.fromEntries(
  index.ops.map((op) => [
    `${op.method} ${op.path}`,
    READS.has(`${op.method} ${op.path}`) ? ("read" as const) : ("refuse" as const),
  ]),
);
const listSpaces = get("listSpaces", "/v1/spaces", {
  query: { page_size: Schema.optionalKey(Schema.Number) },
  success: Schema.Unknown,
});
export const GranolaApi = indexedVendor("Granola", index, [listSpaces]);
const reviewed = valueSafety(GRANOLA_VALUE_SAFETY, () => index);
export const safety = () => ({
  reviewed: restSafety(reviewed, index),
  sensitiveFields: { names: [], choice: "drop" as const },
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const printableToken = (value: string) => /^[!-~]+$/.test(value);

const page: HatchPageAdapter = {
  param: "cursor",
  in: "query",
  decode(cursor) {
    if (
      typeof cursor !== "string" ||
      !cursor.trim() ||
      [...cursor].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      /^[a-z][a-z0-9+.-]*:/i.test(cursor)
    )
      throw new ConnectorCallError("invalid_args", "This cursor contains no valid Granola page token.");
    return cursor;
  },
  next(data) {
    const body = object(data);
    if (body.hasMore === false && (body.cursor === null || body.cursor === undefined)) return null;
    if (body.hasMore === true && typeof body.cursor === "string" && body.cursor.trim()) {
      try {
        return page.decode(body.cursor);
      } catch {
        /* Fail closed on malformed vendor metadata. */
      }
    }
    throw new ConnectorCallError("connector_call_failed", "Granola returned inconsistent paging metadata.", {
      retryable: false,
    });
  },
};
export const pages = Object.fromEntries(
  [...READS].filter((op) => op !== "GET /v1/notes/{note_id}").map((op) => [op, page]),
);

/** The compact index preserves bounds/formats but omits vendor regex patterns. */
export function binding({ connection }: { connection: Connection }): HatchBinding {
  return {
    review:
      "Exact pinned note/folder/space identifier patterns before dispatch; standard JSON GET framing through Connection.sendPath.",
    refuse(call) {
      if (call.op.path.includes("{note_id}") && !/^\/v1\/notes\/not_[a-z0-9]{14}(?:\/transcript)?$/i.test(call.path))
        return "Use a discovered Granola not_ API identifier with 14 alphanumeric characters, not a web-link UUID.";
      for (const [key, prefix] of [
        ["folder_id", "fol"],
        ["space_id", "spa"],
      ]) {
        const value = call.query[key!];
        if (
          value !== undefined &&
          (typeof value !== "string" || !new RegExp(`^${prefix}_[a-z0-9]{14}$`, "i").test(value))
        )
          return `Use a discovered Granola ${prefix}_ API identifier for ${key}.`;
      }
      return undefined;
    },
    send: (call, options) =>
      connection.sendPath(
        {
          method: call.method,
          path: call.path,
          template: call.op.path,
          query: Object.entries(call.query).map(([key, value]) => [key, String(value)] as const),
        },
        options,
      ),
  };
}

export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const key = values?.value?.trim();
  if (!key || !printableToken(key))
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "An operator must configure a valid Granola workspace API key in this connection's credential slot.",
        ),
      }),
    );
  return { Authorization: `Bearer ${key}` };
});

export const errors: VendorErrors = {
  provider: "Granola",
  facts: () => ({}),
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay on rate-limited responses.",
    },
  },
  meanings: { unknownId: "connector_call_failed", provesAbsence: false, conflicts: [] },
  detail: ({ status }) => `Granola returned HTTP ${status}.`,
  unreadable: "Granola returned an invalid JSON success body.",
  statuses: {
    401: () => ({
      code: "auth_required",
      words: (detail) => `${detail} The workspace API key is invalid or revoked; an operator must replace it.`,
    }),
    403: () => ({
      code: "provider_permission_denied",
      words: (detail) => `${detail} Check the workspace key's access and the space's Granola API integration.`,
    }),
    404: () => ({
      code: "connector_call_failed",
      words: (detail) =>
        `${detail} The note is inaccessible, missing, or has no generated summary/transcript; this does not prove absence.`,
    }),
    413: () => ({
      code: "connector_call_failed",
      words: (detail) =>
        `${detail} If include=transcript was requested, read /v1/notes/{note_id}/transcript in pages, then read note details without include. No automatic fallback or extra request was sent.`,
    }),
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: retryAfterMs ?? 5_000,
      words: (detail) =>
        `${detail} The workspace shares a burst of 25 requests per 5 seconds and a sustained 5 requests/second. Wait before retrying.`,
    }),
  },
};

/** Validate framing, independently of optional response fields and the caller's field selection. */
export const result: ConnectionOptions["result"] = (body, answer) => {
  const root = object(body);
  const path = answer.operation.template;
  const key =
    path === "/v1/notes"
      ? "notes"
      : path === "/v1/folders"
        ? "folders"
        : path === "/v1/spaces"
          ? "spaces"
          : path.endsWith("/transcript")
            ? "transcript"
            : undefined;
  const valid = key
    ? Array.isArray(root[key]) && typeof root.hasMore === "boolean"
    : typeof root.id === "string" && /^not_[a-zA-Z0-9]{14}$/.test(root.id);
  return valid
    ? Effect.succeed(body)
    : Effect.fail(
        new StatusFailure({ status: answer.status, headers: answer.headers, body: {}, operation: answer.operation }),
      );
};
export const probe = {
  operation: listSpaces,
  request: { query: { page_size: 1 } },
  check: (values: { readonly value?: string }) =>
    !values.value?.trim() || !printableToken(values.value.trim()) ? "Enter a Granola workspace API key." : undefined,
  describe: () =>
    "Authenticated to the accessible Granola spaces. This does not prove access to every workspace note or verify the key's ownership type.",
};
