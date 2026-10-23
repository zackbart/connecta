import { confinementBase, REDIRECT_STATUSES, BODILESS_STATUSES } from "../http-policy.js";
import { guardedTransport } from "../guarded-transport.js";
// Guarded HTTP transport (decision 0010, B.2). Unreachable from src/index.ts.
//
// The guarded transport as an Effect `HttpClient`, with the behaviour of
// src/connectors/guarded-fetch.ts: requests confined beneath one base URL,
// credentials applied last and registered as sent secrets, redirects refused,
// bodies read under a byte ceiling, and network failures normalized. It is
// built with `HttpClient.makeWith`, not `HttpClient.make`, so it carries no
// span, no `traceparent`/`b3` header, and no response registry: what leaves
// connecta is exactly what this file assembles. It is also the one place a
// request reaches `fetch`, so it keeps the call's dispatch ledger and refuses
// a second dispatch of any logical write, whatever above it asked for one.
// Each request enters the core's ledger (src/provider-call.ts) synchronously
// before `fetch`, with its method, any idempotency key it carries, and its
// status once answered: the facts `api()`'s boundary decides a write from.
//
// effect/http is annotated unstable in 4.0.5. Only client.ts, oauth.ts and
// vendor.ts import the HTTP area modules; providers never do.

import { Effect, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Url from "effect/http/Url";
import { ConnectorCallError } from "../errors.js";
import { readRequest, recordProviderResponse, type ProviderRequest } from "../provider-call.js";
import { fromSignal } from "../runtime/run.js";
import {
  RedirectRefused,
  Refusal,
  RequestRefused,
  ResendRefused,
  ResponseTooLarge,
  TransportFailure,
  type HttpFailure,
} from "./errors.js";
import {
  Classification,
  Dispatches,
  IdempotencyKey,
  Ledger,
  RequestFacts,
  Secrets,
  Signal,
  WriteCapacity,
  reserveWrite,
  writeRequestKey,
  type CallServices,
  type Dispatch,
} from "./services.js";

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
  readonly admit?: (
    url: URL,
    request: { readonly method: string; readonly body?: string },
  ) => Effect.Effect<void, HttpFailure, R | CallServices>;
  /** Headers proving identity, resolved per request and applied last. */
  readonly authenticate: Effect.Effect<Readonly<Record<string, string>>, HttpFailure, R | CallServices>;
}

/** One answer, read under the ceiling. `text` is undefined when the body could not be read. */
interface Reply {
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

const decoder = new TextDecoder();
const responseEntries = new WeakMap<HttpClientResponse.HttpClientResponse, ProviderRequest>();

/** The core's physical request, also available to direct HttpClient middleware. */
export function responseRequest(response: HttpClientResponse.HttpClientResponse): ProviderRequest | undefined {
  return responseEntries.get(response);
}

export function guardedClient<R = never>(options: GuardedOptions<R>): GuardedClient<R | CallServices> {
  const { provider, maxResponseBytes: limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`${provider} maxResponseBytes must be a whole number of bytes >= 1; received ${String(limit)}.`);
  }
  const base = confinementBase(provider, options.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const constant = { ...options.headers };
  const refuse = (message: string) => Effect.fail(new RequestRefused({ message }));

  const preparedEntries = new WeakMap<HttpClientRequest.HttpClientRequest, ProviderRequest>();

  // Confine, then authenticate last, then register what will be sent.
  const preprocess = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const facts = yield* RequestFacts;
      const idempotency = facts.effect === "call" ? yield* IdempotencyKey : undefined;
      const entry = (yield* Ledger).open({
        auxiliary: facts.effect === "read",
        provider,
        method: request.method,
        ...(idempotency ? { key: idempotency.key } : {}),
      });
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
      if (options.admit)
        yield* options.admit(wireUrl(confined), {
          method: confined.method,
          ...(bodyText(confined) === undefined ? {} : { body: bodyText(confined)! }),
        });
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
      preparedEntries.set(confined, entry);
      return confined;
    });

  const postprocess = (prepared: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpFailure, R | CallServices>) =>
    Effect.gen(function* () {
      const callSignal = yield* Signal;
      const live = () =>
        callSignal?.aborted ? refuse("This call has ended; no transport work may continue.") : Effect.void;
      yield* live();
      const facts = yield* RequestFacts;
      const ledger = yield* Dispatches;
      // A new attempt: until it is handed to `fetch`, no failure is its answer.
      if (facts.sent) delete facts.sent.dispatch;
      const earlyWrite = (yield* Classification) === "write";
      const capacity = yield* WriteCapacity;
      // Claim the early Send reservation (or reserve a direct HttpClient call)
      // atomically, before evaluating `prepared`. A wrapper cannot reuse it.
      const claim = () => {
        const reserved = facts.sent?.reservation ?? reserveWrite(ledger, capacity, facts);
        if (reserved instanceof RequestRefused || reserved instanceof ResendRefused) return reserved;
        if (reserved.state !== "reserved") return new ResendRefused({ first: reserved });
        reserved.state = "preparing";
        return reserved;
      };
      const initial = yield* Effect.sync(() => (earlyWrite ? claim() : undefined));
      if (initial instanceof RequestRefused || initial instanceof ResendRefused) return yield* Effect.fail(initial);
      let slot: Dispatch | undefined = initial;
      return yield* Effect.gen(function* () {
        const preparation = callSignal
          ? Effect.raceFirst(
              prepared,
              fromSignal(callSignal).pipe(
                Effect.mapError(
                  () => new RequestRefused({ message: "This call has ended; no transport work may continue." }),
                ),
              ),
            )
          : prepared;
        const request = yield* preparation;
        const url = wireUrl(request);
        yield* live();
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => name !== "content-length"),
        );
        // A genuine key the vendor honors rides only on the tool's own request,
        // added after sent-secret registration like guarded-fetch's visible
        // headers. Only a key sent here is recorded, so only it can make the
        // write repeatable or earn key-reuse advice (`keyProtectsCall`).
        const idempotency = facts.effect === "call" ? yield* IdempotencyKey : undefined;
        if (idempotency) {
          const name = idempotency.header.toLowerCase();
          if (Object.keys(headers).some((header) => header.toLowerCase() === name)) {
            return yield* refuse(`A ${provider} request sets the ${name} header twice.`);
          }
          headers[idempotency.header] = idempotency.key;
        }
        const core = yield* Ledger;
        const entry =
          preparedEntries.get(request) ??
          core.open({
            auxiliary: facts.effect === "read",
            provider,
            method: request.method,
            ...(idempotency ? { key: idempotency.key } : {}),
          });
        const write = !readRequest({ classification: entry.classification, method: request.method }, headers);
        // Preparation can reveal a write in a served read or auxiliary request.
        // The core's actual facts and final headers decide before any dispatch.
        if (write && !slot) {
          const reserved = yield* Effect.sync(claim);
          if (reserved instanceof RequestRefused || reserved instanceof ResendRefused)
            return yield* Effect.fail(reserved);
          slot = reserved;
        }
        const expected = slot ? capacity.get(slot.step!)?.get(slot.item) : undefined;
        if (expected) {
          const text = bodyText(request);
          const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
          if (
            request.body._tag !== "Empty" &&
            (text === undefined ||
              !["application/x-www-form-urlencoded", "application/json"].includes(contentType ?? ""))
          ) {
            return yield* refuse("A bulk item request must use its declared form or JSON body.");
          }
          const actual = yield* Effect.try({
            try: () =>
              writeRequestKey({
                method: request.method as typeof expected.method,
                path: url.pathname.slice(basePath.length),
                template: expected.template,
                query: [...url.searchParams],
                ...(text === undefined
                  ? {}
                  : contentType === "application/json"
                    ? { json: text }
                    : { form: [...new URLSearchParams(text)] }),
                ...(expected.multiValue ? { multiValue: expected.multiValue } : {}),
              }),
            catch: () =>
              new RequestRefused({ message: "Duplicate or invalid identifying content in this write item's request." }),
          });
          if (actual !== writeRequestKey(expected))
            return yield* refuse("This write item's request differs from its declared identifying content.");
        }
        // Resolve the runtime-owned sender before recording a physical dispatch.
        const transport = yield* Effect.try({
          try: () => guardedTransport(write),
          catch: (error) => new Refusal({ error: error as ConnectorCallError }),
        });
        const body = bodyInit(request);
        // A reservation is never released, including preparation failures and
        // failures to connect. Only a new deliberate call gets capacity.
        const dispatch: Dispatch = slot ?? {
          write: false,
          ...(facts.operation ? { operation: facts.operation } : {}),
          state: "pending",
        };
        if (!slot) ledger.push(dispatch);
        dispatch.request = entry;
        if (facts.sent) facts.sent.dispatch = dispatch;
        const refused = (failure: HttpFailure) => {
          dispatch.failure = failure;
          return Effect.fail(failure);
        };
        const response = yield* Effect.tryPromise({
          try: (interrupted) => {
            // Synchronous with the send: from here the core counts it as left,
            // and it refuses a request whose call has already ended.
            core.dispatch(entry, headers, request.method);
            dispatch.state = "pending";
            return transport.send(url, {
              method: request.method,
              headers,
              ...body,
              // A redirect re-sends the credential wherever `Location` points.
              redirect: "manual",
              signal: callSignal ? AbortSignal.any([interrupted, callSignal]) : interrupted,
            });
          },
          catch: (failure): HttpFailure => {
            if (!entry.dispatched) {
              return failure instanceof ConnectorCallError
                ? new Refusal({ error: failure })
                : new RequestRefused({ message: "This call has ended; no transport work may continue." });
            }
            // No rejection proves a write unsent: one fetch can hide several
            // attempts (a 421 or HTTP/2 refused-stream resend, a retrying
            // dispatcher), whatever the last one reports (#902 round 8).
            dispatch.state = "lost";
            return (dispatch.failure = new TransportFailure({ failure, host: url.href }));
          },
        });
        dispatch.state = "answered";
        dispatch.status = response.status;
        recordProviderResponse(entry, response.status);
        dispatch.headers = response.headers;
        if (REDIRECT_STATUSES.has(response.status)) {
          yield* cancel(response);
          return yield* refused(new RedirectRefused({ status: response.status }));
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > limit && request.method !== "HEAD") {
          yield* cancel(response);
          return yield* refused(tooLarge(provider, limit, `a declared ${declared} bytes`));
        }
        const answer = HttpClientResponse.fromWeb(request, response);
        responseEntries.set(answer, entry);
        return answer;
      }).pipe(
        Effect.tapError((failure) =>
          Effect.sync(() => {
            if (slot && slot.failure === undefined && failure._tag !== "ResendRefused") slot.failure = failure;
          }),
        ),
      );
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
