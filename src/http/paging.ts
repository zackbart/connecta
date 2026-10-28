import { bytesToHex, decodeBase64url } from "../bytes.js";
// Provider kit. Unreachable from src/index.ts.
//
// List tools take one page at a time. Lookahead detects an extra row; bound
// cursors authenticate the tool, arguments, connection and credential owner.

import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../errors.js";
import { Refusal, type HttpFailure } from "./errors.js";
import { canonicalJson } from "../canonical-json.js";
import { ContinuationBinding, ContinuationStorage } from "../runtime/call.js";
import { continuationKeys } from "../storage/keys.js";
import type { KVStorage } from "../types.js";

/**
 * The standard `page` (decision 0011 S2): `nextCursor` is present exactly
 * when `hasMore` is true and continuation is safe. A hatch adapter can report
 * more data without a cursor when its continuation cannot be confined.
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
  /** Internal vendor page; the list builder omits nextCursor on terminal pages. */
  readonly page: { readonly hasMore: boolean; readonly nextCursor: string | null; readonly total?: number };
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

const STRAY_CURSOR =
  "This cursor belongs to a different call. Pass back the nextCursor from the previous page of this same call, with the same arguments.";

/** Resolved, nonextractable keys only: no request promise is retained between calls. */
const signingKeys = new WeakMap<KVStorage, CryptoKey>();

async function signingKey(storage: KVStorage): Promise<CryptoKey> {
  const cached = signingKeys.get(storage);
  if (cached) return cached;
  let raw = await storage.get(continuationKeys.signingKey);
  if (raw === null) {
    const candidate = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
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

const keyUnavailable = () =>
  new Refusal({
    error: new ConnectorCallError(
      "unavailable",
      "The cursor signing key is unavailable. Retry after storage recovers; a corrupt key requires operator recovery.",
      { retryable: true },
    ),
  });

const keyForCall = ContinuationStorage.use((storage) =>
  storage
    ? Effect.tryPromise({ try: () => signingKey(storage), catch: keyUnavailable })
    : Effect.fail(keyUnavailable()),
);

/**
 * Authenticated base64url JSON `{v, d, c, m}`: the MAC covers the version,
 * connection/owner/caller binding, tool/argument digest and continuation
 * payload in a canonical tuple and envelope. The deployment store owns
 * the key across isolates/restarts; limit and cursor are excluded from args.
 */
export const boundCursor = {
  encode(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    cursor: string,
    encode: (json: string) => string = base64url,
  ): Effect.Effect<string, Refusal> {
    return Effect.gen(function* () {
      const d = yield* digest(tool, args);
      const key = yield* keyForCall;
      const binding = yield* ContinuationBinding;
      const claims = new TextEncoder().encode(canonicalJson([2, binding.connection, binding.principal, d, cursor]));
      const mac = yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, claims));
      const m = base64urlBytes(new Uint8Array(mac));
      return encode(JSON.stringify({ v: 2, d, c: cursor, m }));
    });
  },
  decode(tool: string, args: Readonly<Record<string, unknown>>, token: string): Effect.Effect<string, Refusal> {
    return Effect.gen(function* () {
      const expected = yield* digest(tool, args);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(decodeBase64url(token)));
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
      if (token !== base64url(JSON.stringify({ v: record.v, d: record.d, c: record.c, m: record.m })))
        return yield* Effect.fail(new Refusal({ error: new ConnectorCallError("invalid_args", STRAY_CURSOR) }));
      const key = yield* keyForCall;
      const mac = decodeBase64url(record.m);
      const binding = yield* ContinuationBinding;
      const claims = new TextEncoder().encode(
        canonicalJson([record.v, binding.connection, binding.principal, record.d, record.c]),
      );
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
  const bytes = new TextEncoder().encode(canonicalJson([tool, shape]));
  return Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((hash) => bytesToHex(new Uint8Array(hash).slice(0, 16))),
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
