// Provider kit (decision 0010, B.4). Unreachable from src/index.ts.
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
import { confinementBase } from "../http-policy.js";
import { ContinuationStorage } from "../runtime/call.js";
import { continuationKeys } from "../storage/keys.js";
import type { KVStorage } from "../types.js";

/** The `page` object every list tool returns. */
export const PageInfo = Schema.Struct({
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
});

/**
 * The standard `page` (decision 0011 S2): `nextCursor` is present exactly
 * when `hasMore` is true. Step-1 lists keep `PageInfo` until their step 2.
 */
export const StandardPage = Schema.Struct({
  hasMore: Schema.Boolean,
  nextCursor: Schema.optionalKey(Schema.String),
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

/** Vendor-supplied continuation, read only after the connection made its data safe. */
export function token<Row, R>(options: {
  readonly fetch: () => Effect.Effect<
    { readonly rows: readonly Row[]; readonly hasMore: boolean; readonly nextCursor: string | null },
    HttpFailure,
    R
  >;
}): Effect.Effect<Page<Row>, HttpFailure, R> {
  return Effect.flatMap(Effect.suspend(options.fetch), ({ rows, hasMore, nextCursor }) => {
    if (hasMore && !nextCursor) return badPage("The vendor reported another page without a next cursor.");
    return Effect.succeed({ rows, page: { hasMore, nextCursor: hasMore ? nextCursor : null } });
  });
}

/** Offset paging advances by the rows actually returned, with a total when supplied. */
export function offset<Row, R>(options: {
  readonly offset: number;
  readonly limit: number;
  readonly fetch: (
    offset: number,
    limit: number,
  ) => Effect.Effect<{ readonly rows: readonly Row[]; readonly total?: number }, HttpFailure, R>;
}): Effect.Effect<Page<Row>, HttpFailure, R> {
  return Effect.gen(function* () {
    yield* position(options.offset, 0);
    yield* position(options.limit, 1);
    return yield* Effect.map(options.fetch(options.offset, options.limit), ({ rows, total }) => {
      const next = options.offset + rows.length;
      const hasMore = rows.length > 0 && (total === undefined ? rows.length >= options.limit : next < total);
      return { rows, page: { hasMore, nextCursor: hasMore ? String(next) : null } };
    });
  });
}

/** Page numbers from a vendor's safe body or headers, with full-page fallback. */
export function page<Row, R>(options: {
  readonly page: number;
  readonly limit: number;
  readonly fetch: (
    page: number,
    limit: number,
  ) => Effect.Effect<
    { readonly rows: readonly Row[]; readonly hasMore?: boolean; readonly totalPages?: number },
    HttpFailure,
    R
  >;
}): Effect.Effect<Page<Row>, HttpFailure, R> {
  return Effect.gen(function* () {
    yield* position(options.page, 1);
    yield* position(options.limit, 1);
    return yield* Effect.map(options.fetch(options.page, options.limit), ({ rows, hasMore, totalPages }) => {
      const more = hasMore ?? (totalPages === undefined ? rows.length >= options.limit : options.page < totalPages);
      return { rows, page: { hasMore: more, nextCursor: more ? String(options.page + 1) : null } };
    });
  });
}

/** Extract only a cursor from a next URL confined to this connection's origin and path. */
export function link<Row, R>(options: {
  readonly baseUrl: string;
  readonly param: string;
  readonly fetch: () => Effect.Effect<{ readonly rows: readonly Row[]; readonly next?: string | null }, HttpFailure, R>;
}): Effect.Effect<Page<Row>, HttpFailure, R> {
  const base = confinementBase("Paging", options.baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  if (!options.param) throw new Error("Link paging needs a cursor parameter.");
  return Effect.flatMap(Effect.suspend(options.fetch), ({ rows, next }): Effect.Effect<Page<Row>, HttpFailure> => {
    if (!next) return Effect.succeed({ rows, page: { hasMore: false, nextCursor: null } });
    let url: URL;
    try {
      url = new URL(next, base);
    } catch {
      return badPage("The vendor returned an invalid next-page URL.");
    }
    if (
      url.origin !== base.origin ||
      !`${url.pathname}/`.startsWith(`${prefix}/`) ||
      url.username ||
      url.password ||
      url.hash
    )
      return badPage("The vendor returned a next-page URL outside this connection.");
    const cursors = url.searchParams.getAll(options.param);
    if (cursors.length !== 1 || !cursors[0]) return badPage("The vendor returned no unique next-page cursor.");
    return Effect.succeed({ rows, page: { hasMore: true, nextCursor: cursors[0] } });
  });
}

function position(value: number, minimum: number): Effect.Effect<void, Refusal> {
  return Number.isSafeInteger(value) && value >= minimum
    ? Effect.void
    : Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "invalid_args",
            "Paging positions and limits must be whole numbers within their bounds.",
          ),
        }),
      );
}

function badPage(message: string): Effect.Effect<never, Refusal> {
  return Effect.fail(
    new Refusal({ error: new ConnectorCallError("connector_call_failed", message, { retryable: false }) }),
  );
}

/** Every row of every page, fetched as the stream is pulled. */
export function allRows<Row, E, R>(
  fetchPage: (cursor: string | undefined) => Effect.Effect<Page<Row>, E, R>,
): Stream.Stream<Row, E, R> {
  return Stream.paginate(undefined as string | undefined, (cursor) =>
    Effect.map(
      fetchPage(cursor),
      ({ rows, page }) => [rows, Option.fromNullishOr(page.hasMore ? page.nextCursor : null)] as const,
    ),
  );
}

const STRAY_CURSOR =
  "This cursor belongs to a different call. Pass back the nextCursor from the previous page of this same call, with the same arguments.";

/** Resolved, nonextractable keys only: no request promise is retained between calls. */
const signingKeys = new WeakMap<KVStorage, CryptoKey>();

async function signingKey(storage: KVStorage): Promise<CryptoKey> {
  const cached = signingKeys.get(storage);
  if (cached) return cached;
  let raw = await storage.get(continuationKeys.signingKey);
  if (raw === null) {
    const candidate = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    raw = (await storage.compareAndSet(continuationKeys.signingKey, null, candidate))
      ? candidate
      : await storage.get(continuationKeys.signingKey);
  }
  if (raw === null || !/^[a-f0-9]{64}$/.test(raw)) throw new Error("The continuation signing key is unavailable.");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(raw.match(/../g)!, (byte) => Number.parseInt(byte, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  signingKeys.set(storage, key);
  return key;
}

const keyForCall = ContinuationStorage.use((storage) =>
  storage
    ? Effect.promise(() => signingKey(storage))
    : Effect.die(new Error("Bound continuation cursors require storage.")),
);

/**
 * Authenticated base64url JSON `{v, d, c, m}`: the MAC covers the version,
 * tool/argument digest and continuation payload. The deployment store owns
 * the key across isolates/restarts; limit and cursor are excluded from args.
 */
export const boundCursor = {
  encode(tool: string, args: Readonly<Record<string, unknown>>, cursor: string): Effect.Effect<string> {
    return Effect.gen(function* () {
      const d = yield* digest(tool, args);
      const key = yield* keyForCall;
      const claims = new TextEncoder().encode(JSON.stringify([2, d, cursor]));
      const mac = yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, claims));
      const m = base64urlBytes(new Uint8Array(mac));
      return base64url(JSON.stringify({ v: 2, d, c: cursor, m }));
    });
  },
  decode(tool: string, args: Readonly<Record<string, unknown>>, token: string): Effect.Effect<string, Refusal> {
    return Effect.gen(function* () {
      const expected = yield* digest(tool, args);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(fromBase64url(token)));
      } catch {
        parsed = undefined;
      }
      const record = parsed as { v?: unknown; d?: unknown; c?: unknown; m?: unknown } | undefined;
      if (
        record?.v !== 2 ||
        record.d !== expected ||
        typeof record.c !== "string" ||
        typeof record.m !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.m)
      ) {
        return yield* Effect.fail(new Refusal({ error: new ConnectorCallError("invalid_args", STRAY_CURSOR) }));
      }
      const key = yield* keyForCall;
      const mac = fromBase64url(record.m);
      const claims = new TextEncoder().encode(JSON.stringify([record.v, record.d, record.c]));
      const valid = yield* Effect.promise(() => crypto.subtle.verify("HMAC", key, mac, claims));
      if (!valid || base64urlBytes(mac) !== record.m) {
        return yield* Effect.fail(new Refusal({ error: new ConnectorCallError("invalid_args", STRAY_CURSOR) }));
      }
      return record.c;
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
  return base64urlBytes(new TextEncoder().encode(text));
}

function base64urlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(token: string): Uint8Array {
  const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
