/** See documentation/connectors.md#the-guarded-fetch-transport. Web APIs only. */
import { ConnectorCallError } from "../errors.js";
import type { ConnectorContext } from "../types.js";

// Three of the types below carry no `export`: they are reached through the
// exported `GuardedRequest` and `GuardedTransport` rather than named directly,
// and the unused-export gate is right to say so while this module is internal.
// They get their own `export` on the day the helper joins the published
// surface, and not before.

/** The methods a hand-written provider surface actually uses. */
type GuardedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface GuardedRequest {
  method: GuardedMethod;
  /**
   * Provider-relative path beginning with one `/`, resolved against the base
   * URL's own path. Never an absolute URL, and never carrying `?` or `#` —
   * query parameters go in `query`, where they are encoded rather than parsed.
   */
  path: string;
  /** Search parameters; `undefined` values are dropped, others stringified. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Per-request headers. `undefined` values are dropped, and a header that
   * collides with an authentication header is refused rather than allowed to
   * shadow it.
   */
  headers?: Record<string, string | undefined>;
  /** JSON request body. Serialized here, with the `Content-Type` to match. */
  body?: unknown;
  /**
   * A pre-framed body — `FormData`, text, bytes. Mutually exclusive with
   * `body`, and no `Content-Type` is supplied: multipart needs `fetch` to pick
   * the boundary, and anything else knows its own type.
   */
  rawBody?: BodyInit;
}

/**
 * One downstream response, read under the connector's byte ceiling.
 *
 * The accessors are the whole read surface — there is no escape to the
 * underlying `Response`, because an unbounded `.text()` on it is exactly the
 * mistake this type exists to remove. `status`, `ok`, and `headers` are the
 * raw facts a provider mapper needs to make its own classification.
 */
interface GuardedResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  /** The body as bytes. */
  bytes(): Promise<Uint8Array>;
  /** The body decoded as UTF-8. */
  text(): Promise<string>;
  /** The body parsed as JSON; `undefined` for an empty body, throws on junk. */
  json(): Promise<unknown>;
  /** Parse JSON while distinguishing malformed content from transport failure. */
  jsonResult(): Promise<{ value: unknown } | { parseError: unknown }>;
}

/** Parse a decimal `Retry-After` header in seconds into milliseconds. */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.trunc(seconds * 1000);
}

/**
 * Turn one response into the provider's own result, or throw the provider's
 * own typed failure. This is where status codes acquire meaning, and it is
 * always the provider's code.
 */
type GuardedResponseMapper<T> = (
  response: GuardedResponse,
  ctx: ConnectorContext,
) => T | Promise<T>;

export interface GuardedFetchOptions {
  /**
   * Provider name as it appears in normalized failure prose — "Cloudflare",
   * "Notion". Used for messages only; it is never parsed.
   */
  provider: string;
  /**
   * Absolute base URL. Its origin and path prefix are the confinement: every
   * request resolves beneath it or is refused.
   */
  baseUrl: string;
  /**
   * Headers proving the caller's identity, resolved once per request. Throwing
   * a typed `auth_required` from here is the documented way to report a
   * missing credential — the helper has no opinion about what a credential is.
   */
  authenticate: (
    ctx: ConnectorContext,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** Constant headers sent with every request — `Accept`, an API version. */
  headers?: Record<string, string>;
  /**
   * Ceiling on the response body, in bytes. Required, because a default here
   * would be the helper guessing on a provider's behalf: what counts as an
   * absurd response is a fact about the API, not about HTTP.
   */
  maxResponseBytes: number;
}

/** Send one guarded request and map its response with provider knowledge. */
export type GuardedTransport = <T>(
  request: GuardedRequest,
  ctx: ConnectorContext,
  map: GuardedResponseMapper<T>,
) => Promise<T>;

/** Statuses that instruct a client to re-send somewhere else. Never followed. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Statuses the HTTP spec defines as carrying no body at all. */
const BODILESS_STATUSES = new Set([204, 205, 304]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * A base URL is deployment configuration, so a bad one is a structural mistake
 * and throws where it is written rather than on the first call that uses it.
 */
function confinementBase(provider: string, baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`${provider} baseUrl must be an absolute URL: ${baseUrl}`);
  }
  const loopback =
    base.hostname === "localhost" ||
    base.hostname === "127.0.0.1" ||
    base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error(
      `${provider} baseUrl must be https (http is allowed only for a loopback proxy or test double): ${baseUrl}`,
    );
  }
  if (base.username || base.password) {
    throw new Error(
      `${provider} baseUrl must not embed URL credentials; authentication belongs in headers.`,
    );
  }
  if (base.search || base.hash) {
    throw new Error(
      `${provider} baseUrl must not carry a query or fragment: ${baseUrl}`,
    );
  }
  return base;
}

/**
 * Resolve a provider-relative path beneath the base and prove it stayed there.
 *
 * The proof is the point. `new URL` normalizes `..` and percent-escapes for
 * us, which is convenient and also exactly how a path escapes its prefix, so
 * the origin and prefix are re-checked *after* normalization rather than
 * before it.
 */
function confinedUrl(
  provider: string,
  base: URL,
  basePath: string,
  request: GuardedRequest,
): URL {
  const path = request.path;
  if (!path.startsWith("/")) {
    throw new ConnectorCallError(
      "invalid_args",
      `A ${provider} request path is provider-relative and must begin with "/".`,
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new ConnectorCallError(
      "invalid_args",
      `A ${provider} request path carries no query or fragment; put query parameters in the query argument.`,
    );
  }
  let url: URL;
  try {
    url = new URL(`${base.origin}${basePath}${path}`);
  } catch {
    throw new ConnectorCallError(
      "invalid_args",
      `A ${provider} request path did not resolve to a valid URL.`,
    );
  }
  if (
    url.origin !== base.origin ||
    !`${url.pathname}/`.startsWith(`${basePath}/`)
  ) {
    throw new ConnectorCallError(
      "invalid_args",
      `A ${provider} request path escaped the connector's base URL.`,
    );
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function oversized(
  provider: string,
  limit: number,
  detail: string,
): ConnectorCallError {
  return new ConnectorCallError(
    "connector_call_failed",
    `${provider} returned ${detail}, past this connector's ${limit}-byte response ceiling.`,
    { retryable: false },
  );
}

/** The response body as a `ReadableStream`, or null when there is none to read. */
function readableBody(response: Response): ReadableStream<Uint8Array> | null {
  const body: unknown = response.body;
  return body && typeof (body as ReadableStream).getReader === "function"
    ? (body as ReadableStream<Uint8Array>)
    : null;
}

/** Read a stream to the ceiling and stop there — never past it. */
async function drain(
  provider: string,
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw oversized(provider, limit, "more bytes than it may");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** See documentation/connectors.md#the-guarded-fetch-transport. */
function boundedResponse(
  provider: string,
  response: Response,
  limit: number,
): GuardedResponse {
  if (BODILESS_STATUSES.has(response.status)) {
    const emptyJson = async (): Promise<unknown> => undefined;
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      bytes: async () => new Uint8Array(),
      text: async () => "",
      json: emptyJson,
      jsonResult: () => jsonResult(emptyJson),
    };
  }
  const stream = readableBody(response);
  let read: Promise<Uint8Array> | undefined;
  const bytes = (): Promise<Uint8Array> => {
    read ??= stream
      ? drain(provider, stream, limit)
      : response.arrayBuffer().then((buffer) => {
          if (buffer.byteLength > limit) {
            throw oversized(provider, limit, `${buffer.byteLength} bytes`);
          }
          return new Uint8Array(buffer);
        });
    return read;
  };
  const json = async (): Promise<unknown> => {
    // No stream means no bytes to count: a stand-in that answers `json()`
    // directly is taken at its word, which is the one accessor on the one
    // path where the ceiling cannot be applied.
    if (!stream) return await response.json();
    const body = decoder.decode(await bytes());
    return body.trim() === "" ? undefined : JSON.parse(body);
  };
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    bytes,
    async text() {
      if (stream) return decoder.decode(await bytes());
      const body = await response.text();
      const size = encoder.encode(body).length;
      if (size > limit) throw oversized(provider, limit, `${size} bytes`);
      return body;
    },
    json,
    jsonResult: () => jsonResult(json),
  };
}

async function jsonResult(
  read: () => Promise<unknown>,
): Promise<{ value: unknown } | { parseError: unknown }> {
  try {
    return { value: await read() };
  } catch (cause) {
    if (cause instanceof ConnectorCallError) throw cause;
    return { parseError: cause };
  }
}

/** Build the guarded transport described in documentation/connectors.md. */
export function guardedFetch(options: GuardedFetchOptions): GuardedTransport {
  const { provider, maxResponseBytes: limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `${provider} maxResponseBytes must be a whole number of bytes >= 1; received ${String(limit)}.`,
    );
  }
  const base = confinementBase(provider, options.baseUrl);
  // "" for a root base, so joining never doubles the separator.
  const basePath = base.pathname.replace(/\/+$/, "");
  const constantHeaders = { ...options.headers };

  return async function send(request, ctx, map) {
    if (request.body !== undefined && request.rawBody !== undefined) {
      throw new Error(
        `A ${provider} request cannot carry both a JSON body and a raw body.`,
      );
    }
    const url = confinedUrl(provider, base, basePath, request);

    const headers: Record<string, string> = { ...constantHeaders };
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (value !== undefined) headers[name] = value;
    }
    if (request.body !== undefined && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    // Authentication is applied last and may not be shadowed. A caller-shaped
    // header that reaches this point wearing the credential's name is a bug
    // worth failing on, not a precedence question worth resolving quietly.
    for (const [name, value] of Object.entries(await options.authenticate(ctx))) {
      const shadow = hasHeader(headers, name);
      if (shadow) {
        throw new ConnectorCallError(
          "invalid_args",
          `A ${provider} request may not set the ${shadow} header; authentication is connector-owned.`,
        );
      }
      headers[name] = value;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: request.method,
        headers,
        ...(request.body !== undefined
          ? { body: JSON.stringify(request.body) }
          : request.rawBody !== undefined
            ? { body: request.rawBody }
            : {}),
        // Rationale: documentation/connectors.md#the-guarded-fetch-transport.
        redirect: "manual",
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (cause) {
      throw new ConnectorCallError(
        "unavailable",
        `Could not reach the ${provider} API: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorCallError(
        "connector_call_failed",
        `${provider} answered HTTP ${response.status} with a redirect; this connector talks to exactly one origin and never forwards its credential to another.`,
        { retryable: false },
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      throw oversized(provider, limit, `a declared ${declared} bytes`);
    }
    return await map(boundedResponse(provider, response, limit), ctx);
  };
}

/** The stored spelling of a header already present, case-insensitively. */
function hasHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === wanted);
}
