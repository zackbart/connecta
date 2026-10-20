// Internal prototype for decision 0010 (B.2). Unreachable from src/index.ts.
//
// The guarded transport as an Effect `HttpClient`, with the behaviour of
// src/connectors/guarded-fetch.ts: requests confined beneath one base URL,
// credentials applied last and registered as sent secrets, redirects refused,
// bodies read under a byte ceiling, and network failures normalized. It is
// built with `HttpClient.makeWith`, not `HttpClient.make`, so it carries no
// span, no `traceparent`/`b3` header, and no response registry: what leaves
// connecta is exactly what this file assembles.
//
// effect/http is annotated unstable in 4.0.5. This file and src/http/vendor.ts
// are the only kit modules that import it; providers never do.

import { Effect, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Url from "effect/http/Url";
import { RedirectRefused, RequestRefused, ResponseTooLarge, TransportFailure, type HttpFailure } from "./errors.js";
import { Dispatches, Secrets, Signal, type CallServices } from "./services.js";

export interface GuardedOptions<R = never> {
  /** Name in failure prose. Never parsed. */
  readonly provider: string;
  /** Absolute base URL; its origin and path prefix are the confinement. */
  readonly baseUrl: string;
  /** Ceiling on any response body, in bytes. Required: it is a fact about the API. */
  readonly maxResponseBytes: number;
  /** Constant headers, such as `Accept`. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Inspect the confined URL, query encoded, and refuse it. Runs before
   * `authenticate`, as guarded-fetch's `admit` does, so a refused request
   * never resolves a credential.
   */
  readonly admit?: (url: URL) => Effect.Effect<void, HttpFailure, R | CallServices>;
  /** Headers proving identity, resolved per request and applied last. */
  readonly authenticate: Effect.Effect<Readonly<Record<string, string>>, HttpFailure, R | CallServices>;
}

/** One answer, read under the ceiling. `text` is undefined when the body could not be read. */
export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string | undefined;
}

export interface GuardedClient<R = CallServices> {
  /** Name in failure prose, for wrappers such as `refreshOnce`. */
  readonly provider: string;
  readonly client: HttpClient.HttpClient.With<HttpFailure, R>;
  /** Read a response this client returned, never past the ceiling. */
  readonly read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<Reply, HttpFailure>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const decoder = new TextDecoder();
const BODILESS_STATUSES = new Set([204, 205, 304]);

/** A bad base URL is deployment configuration, so it throws at construction (INV-11). */
function confinementBase(provider: string, baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`${provider} baseUrl must be an absolute URL.`);
  }
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error(`${provider} baseUrl must be https (http is allowed only for a loopback proxy or test double).`);
  }
  if (base.username || base.password) {
    throw new Error(`${provider} baseUrl must not embed URL credentials; authentication belongs in headers.`);
  }
  if (base.search || base.hash) throw new Error(`${provider} baseUrl must not carry a query or fragment.`);
  return base;
}

export function guardedClient<R = never>(options: GuardedOptions<R>): GuardedClient<R | CallServices> {
  const { provider, maxResponseBytes: limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`${provider} maxResponseBytes must be a whole number of bytes >= 1; received ${String(limit)}.`);
  }
  const base = confinementBase(provider, options.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const constant = options.headers ?? {};
  const refuse = (message: string) => Effect.fail(new RequestRefused({ message }));

  // Confine, then authenticate last, then register what will be sent.
  const preprocess = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const path = request.url;
      if (!path.startsWith("/")) {
        return yield* refuse(`A ${provider} request path is provider-relative and must begin with "/".`);
      }
      if (path.includes("?") || path.includes("#") || request.hash._tag === "Some") {
        return yield* refuse(
          `A ${provider} request path carries no query or fragment; put query parameters in the query argument.`,
        );
      }
      let url: URL;
      try {
        url = new URL(`${base.origin}${basePath}${path}`);
      } catch {
        return yield* refuse(`A ${provider} request path did not resolve to a valid URL.`);
      }
      if (url.origin !== base.origin || !`${url.pathname}/`.startsWith(`${basePath}/`)) {
        return yield* refuse(`A ${provider} request path escaped the connector's base URL.`);
      }
      let confined = HttpClientRequest.setUrl(request, url.href);
      if (options.admit) yield* options.admit(wireUrl(confined));
      for (const [name, value] of Object.entries(constant)) {
        if (confined.headers[name.toLowerCase()] === undefined)
          confined = HttpClientRequest.setHeader(confined, name, value);
      }
      const secrets = yield* Secrets;
      for (const [name, value] of Object.entries(yield* options.authenticate)) {
        if (confined.headers[name.toLowerCase()] !== undefined) {
          return yield* refuse(
            `A ${provider} request may not set the ${name.toLowerCase()} header; authentication is connector-owned.`,
          );
        }
        confined = HttpClientRequest.setHeader(confined, name, value);
        secrets.header(value);
      }
      // Registered as guarded-fetch registers: the final URL, headers, and a
      // text body (a form body's secrets are read from it).
      const text = bodyText(confined);
      secrets.request(wireUrl(confined), {
        headers: Object.fromEntries(Object.entries(confined.headers)),
        ...(text === undefined ? {} : { body: text }),
      });
      return confined;
    });

  const postprocess = (prepared: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpFailure, R | CallServices>) =>
    Effect.gen(function* () {
      const request = yield* prepared;
      const url = wireUrl(request);
      const callSignal = yield* Signal;
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "content-length"));
      (yield* Dispatches).count++;
      const response = yield* Effect.tryPromise({
        try: (interrupted) =>
          globalThis.fetch(url, {
            method: request.method,
            headers,
            ...bodyInit(request),
            // A redirect re-sends the credential wherever `Location` points.
            redirect: "manual",
            signal: callSignal ? AbortSignal.any([interrupted, callSignal]) : interrupted,
          }),
        catch: (failure) => new TransportFailure({ failure, host: url.href }),
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        yield* cancel(response);
        return yield* Effect.fail(new RedirectRefused({ status: response.status }));
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit && request.method !== "HEAD") {
        yield* cancel(response);
        return yield* Effect.fail(tooLarge(provider, limit, `a declared ${declared} bytes`));
      }
      return HttpClientResponse.fromWeb(request, response);
    });

  return {
    provider,
    client: HttpClient.makeWith(postprocess, preprocess),
    read: (response) => readReply(provider, limit, response),
  };
}

/** The exact URL `fetch` receives: confined path plus encoded query. */
function wireUrl(request: HttpClientRequest.HttpClientRequest): URL {
  const built = Url.make(request.url, request.urlParams, undefined);
  if (built._tag === "Failure") throw new Error("A confined request URL failed to build.");
  return built.success;
}

/** A JSON, form, or text body as the string guarded-fetch would have sent. */
function bodyText(request: HttpClientRequest.HttpClientRequest): string | undefined {
  const body = request.body;
  if (body._tag === "Uint8Array") return body.text;
  return body._tag === "Raw" && typeof body.body === "string" ? body.body : undefined;
}

function bodyInit(request: HttpClientRequest.HttpClientRequest): { body?: BodyInit } {
  const body = request.body;
  switch (body._tag) {
    case "Empty":
      return {};
    case "Raw":
      return { body: body.body as BodyInit };
    case "Uint8Array":
      // The retained text when there is one, so the wire carries exactly the
      // string guarded-fetch sent and goldens record the same body.
      return { body: (body.text ?? body.body) as BodyInit };
    case "FormData":
      return { body: body.formData };
    case "Stream":
      // A stream cannot be read twice or measured; no kit operation sends one.
      throw new Error("The guarded client does not send stream bodies.");
  }
}

function tooLarge(provider: string, limit: number, detail: string): ResponseTooLarge {
  return new ResponseTooLarge({
    detail: `${provider} returned ${detail}, past this connector's ${limit}-byte response ceiling.`,
  });
}

function cancel(response: Response): Effect.Effect<void> {
  return Effect.promise(() => response.body?.cancel().catch(() => {}) ?? Promise.resolve());
}

/**
 * The body as UTF-8 decoded from bounded bytes (never `text()`, whose runtime
 * log can quote a non-text Content-Type, INV-6). The stream is abandoned at
 * the chunk that crosses the ceiling, and its reader is cancelled when the
 * read ends either way. A runtime with no body stream has buffered already,
 * so the buffer is measured instead. Any other read failure leaves `text`
 * undefined, as guarded-fetch's `jsonResult` reported a parse failure.
 */
function readReply(
  provider: string,
  limit: number,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Reply, ResponseTooLarge> {
  const reply = (text: string | undefined): Reply => ({
    status: response.status,
    headers: new Headers(Object.entries(response.headers)),
    text,
  });
  if (BODILESS_STATUSES.has(response.status) || response.request.method === "HEAD") return Effect.succeed(reply(""));
  const buffered = response.arrayBuffer.pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(reply(undefined)),
      onSuccess: (buffer) =>
        buffer.byteLength > limit
          ? Effect.fail(tooLarge(provider, limit, `${buffer.byteLength} bytes`))
          : Effect.succeed(reply(decoder.decode(buffer))),
    }),
  );
  return response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ parts: [] as Uint8Array[], total: 0 }),
      (read, chunk) => {
        read.total += chunk.byteLength;
        if (read.total > limit) return Effect.fail(tooLarge(provider, limit, "more bytes than it may"));
        read.parts.push(chunk);
        return Effect.succeed(read);
      },
    ),
    Effect.map(({ parts, total }) => {
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return reply(decoder.decode(bytes));
    }),
    Effect.catch((error: ResponseTooLarge | HttpClientError.HttpClientError) =>
      error._tag === "ResponseTooLarge"
        ? Effect.fail(error)
        : error.reason._tag === "EmptyBodyError"
          ? buffered
          : Effect.succeed(reply(undefined)),
    ),
  );
}
