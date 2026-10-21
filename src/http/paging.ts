// Internal prototype for decision 0010 (B.4). Unreachable from src/index.ts.
//
// Paging is a strategy plus one cursor codec. A strategy turns "the next page
// after this cursor" into a vendor request and reads back rows and the next
// vendor cursor; tools take one page, and `allRows` walks every page as a
// Stream for programs and the hatch. The codec is the only place a cursor is
// minted: `plain` hands the vendor's cursor through (what shipped providers
// promise today, so goldens hold), `bound` ties it to the tool and its
// arguments so a cursor from another call is refused instead of silently
// reading the wrong list.

import { Effect, Option, Schema, Stream } from "effect";
import { ConnectorCallError } from "../errors.js";
import { Refusal, type HttpFailure } from "./errors.js";

/** The `page` object every list tool returns. */
export const PageInfo = Schema.Struct({
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
});

/** The input field that carries a cursor back. */
export const Cursor = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "Opaque nextCursor from the previous page. Pass it back unchanged.",
});

export interface Page<Row> {
  readonly rows: ReadonlyArray<Row>;
  readonly page: typeof PageInfo.Type;
}

/**
 * Lookahead paging, for a vendor that returns no `has_more`: ask for one row
 * more than wanted, keep `limit`, and address the next page by the last kept
 * row's id. A full page proves nothing; the extra row does.
 */
export function lookahead<Row, R>(options: {
  readonly provider: string;
  readonly idKey: string;
  readonly limit: number;
  readonly fetch: (ask: number) => Effect.Effect<ReadonlyArray<Row>, HttpFailure, R>;
}): Effect.Effect<Page<Row>, HttpFailure, R> {
  return Effect.gen(function* () {
    const all = yield* options.fetch(options.limit + 1);
    const rows = all.slice(0, options.limit);
    const hasMore = all.length > options.limit;
    if (!hasMore) return { rows, page: { hasMore, nextCursor: null } };
    const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
    const id = last?.[options.idKey];
    if (typeof id !== "string" || id === "") {
      return yield* Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "connector_call_failed",
            `${options.provider} returned a page whose last row has no ${options.idKey}, so the next page cannot be addressed.`,
            { retryable: false },
          ),
        }),
      );
    }
    return { rows, page: { hasMore, nextCursor: id } };
  });
}

/** Every row of every page, fetched as the stream is pulled. */
export function allRows<Row, E, R>(
  fetchPage: (cursor: string | undefined) => Effect.Effect<Page<Row>, E, R>,
): Stream.Stream<Row, E, R> {
  return Stream.paginate(undefined as string | undefined, (cursor) =>
    Effect.map(fetchPage(cursor), ({ rows, page }) => [rows, Option.fromNullishOr(page.nextCursor)] as const),
  );
}

const STRAY_CURSOR =
  "This cursor belongs to a different call. Pass back the nextCursor from the previous page of this same call, with the same arguments.";

/**
 * The bound codec: base64url JSON `{v, d, c}` where `d` is 128 bits of
 * SHA-256 over the tool name and its arguments (cursor and limit excluded).
 */
export const boundCursor = {
  encode(tool: string, args: Readonly<Record<string, unknown>>, cursor: string): Effect.Effect<string> {
    return Effect.map(digest(tool, args), (d) => base64url(JSON.stringify({ v: 1, d, c: cursor })));
  },
  decode(tool: string, args: Readonly<Record<string, unknown>>, token: string): Effect.Effect<string, Refusal> {
    return Effect.flatMap(digest(tool, args), (expected) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(fromBase64url(token)));
      } catch {
        parsed = undefined;
      }
      const record = parsed as { v?: unknown; d?: unknown; c?: unknown } | undefined;
      if (record?.v !== 1 || record.d !== expected || typeof record.c !== "string") {
        return Effect.fail(new Refusal({ error: new ConnectorCallError("invalid_args", STRAY_CURSOR) }));
      }
      return Effect.succeed(record.c);
    });
  },
};

function digest(tool: string, args: Readonly<Record<string, unknown>>): Effect.Effect<string> {
  const shape = Object.keys(args)
    .filter((key) => key !== "cursor" && key !== "limit" && args[key] !== undefined)
    .sort()
    .map((key) => [key, args[key]]);
  const bytes = new TextEncoder().encode(JSON.stringify([tool, shape]));
  return Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((hash) =>
      Array.from(new Uint8Array(hash).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(token: string): Uint8Array {
  const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
