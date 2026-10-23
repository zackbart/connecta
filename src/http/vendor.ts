// Provider kit (decision 0010, B.4). Unreachable from src/index.ts.
//
// A vendor is an `HttpApi`: endpoints with Schemas for path params, query,
// and payload, from which requests are encoded and the endpoint manifest is
// derived. This is the only kit module that imports effect/http-api, which
// 4.0.5 annotates unstable; providers declare operations through the names
// re-exported here, so an upstream change is absorbed in this file.
// Re-exporting confines those modules; it does not make them stable.
//
// The typed client runs in `response-only` mode, and `Send` hands providers an
// `Answer`, never a response. HttpApiClient's own decoding would read the
// whole body without a ceiling, quote the body in a SchemaError, and fail an
// empty 200. Every answer, from a declared operation or a hatch's path, takes
// one route: bounded read, JSON, the request's sent secrets redacted from the
// whole body before anything can cut or extract from it (#911), status (with
// its operation, so value safety decides what a failure may quote), the
// vendor's `result` hook, then the connection's ResultSafety. A provider
// cannot reach a body earlier.

import { Context, Effect, type Schema } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import { parameterPairs } from "./write-request.js";
import type { GuardedClient, SuccessPrefix, PrefixResult } from "./client.js";
import {
  validateVendorErrors,
  isHttpFailure,
  RequestRefused,
  ResendRefused,
  StatusFailure,
  UnreadableBody,
  type HttpFailure,
  type OperationRef,
  type VendorErrors,
} from "./errors.js";
import type { ResultSafety } from "./safety.js";
import {
  Classification,
  Dispatches,
  RequestFacts,
  RequestSecrets,
  ReadTool,
  WriteCapacity,
  reserveWrite,
  type WriteRequest,
  type CallServices,
  type Dispatch,
} from "./services.js";

/** Declare a GET operation: `get("getCharge", "/charges/:chargeId", { params, query, success })`. */
export const get = HttpApiEndpoint.get;
export const head = HttpApiEndpoint.head;
export const post = HttpApiEndpoint.post;
export const put = HttpApiEndpoint.put;
export const patch = HttpApiEndpoint.patch;
export const del = HttpApiEndpoint.delete;

export type Operation = HttpApiEndpoint.ConstraintRequest;

type Part<Key extends string, S> = [S] extends [never]
  ? {}
  : { readonly [K in Key]: S extends Schema.Top ? S["Type"] : never };

/** What one call to an operation supplies, typed from its Schemas. */
type RequestOf<Op extends Operation> = Part<"params", Op["~Params"]> &
  Part<"query", Op["~Query"]> &
  Part<"payload", Op["~Payload"]> &
  Part<"headers", Op["~Headers"]>;

export interface Vendor {
  // The group type is erased here: kit callers name operations, never groups.
  readonly api: HttpApi.HttpApi<string, any>;
  /** A pinned-index adapter keeps bulk manifest declarations outside the typed client. */
  readonly indexed?: { readonly operations: readonly string[]; readonly api: () => HttpApi.HttpApi<string, any> };
  /** Published specification path prefix; transport operations remain relative to the confined base. */
  readonly manifestBase?: string;
  /** Explicit response-byte review; the kit checks bytes before any base64 representation. */
  readonly binaryBodies?: {
    readonly review: string;
    readonly forResponse: (status: number, operation: OperationRef, contentType: string) => boolean;
  };
  /** Reviewed text contracts, selected by status and canonical operation; absent means JSON only. */
  readonly textBodies?: {
    readonly review: string;
    readonly forResponse: (
      status: number,
      operation: OperationRef,
      contentType?: string,
    ) => "text" | "json-or-text" | undefined;
  };
}

/** Group a vendor's operations into one API, the source of its client and its manifest. */
export function vendor(
  declaration: string | { readonly name: string; readonly manifestBase?: string },
  ...operations: readonly [Operation, ...Operation[]]
): Vendor {
  const name = typeof declaration === "string" ? declaration : declaration.name;
  const manifestBase = typeof declaration === "string" ? undefined : declaration.manifestBase;
  if (
    manifestBase !== undefined &&
    (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(manifestBase) ||
      manifestBase.split("/").some((segment) => segment === "." || segment === ".."))
  )
    throw new Error("A vendor manifestBase must be an absolute path prefix without dot segments or a trailing slash.");
  if (
    !name.trim() ||
    operations.length === 0 ||
    new Set(operations.map((op) => op.identifier)).size !== operations.length
  )
    throw new Error("A vendor needs a name and operations with unique identifiers.");
  return {
    api: HttpApi.make(name).add(HttpApiGroup.make("operations", { topLevel: true }).add(...operations)),
    ...(manifestBase === undefined ? {} : { manifestBase }),
  };
}

/** One answer, after every check: the only thing a provider reads. */
interface Answer {
  readonly status: number;
  /** The JSON body after the vendor's `result` hook and the connection's ResultSafety; `undefined` when empty. */
  readonly data: unknown;
  readonly prefix?: PrefixResult;
}

interface SendOptions {
  /** Success-only bounded streaming, without exposing a response or bypassing safety. */
  readonly prefix?: SuccessPrefix;
  /** Auxiliary ownership; replay and capacity still follow the core's physical-request classification. */
  readonly effect?: "read";
  /**
   * A name in the tool's construction-declared writeSteps, never fresh capacity.
   * Each step/item can be reserved once. The implicit default is `write`.
   */
  readonly step?: string;
  /** An identity in this step's fixed, validated-input-derived item set. Never an attempt counter. */
  readonly item?: string;
  /** Named facts the vendor's error rules read for this request, such as Google's `revisionGuarded`. */
  readonly flags?: Readonly<Record<string, true>>;
}

/** Send one operation and settle its answer. */
type Send<R = CallServices> = <Op extends Operation>(
  operation: Op,
  request: RequestOf<Op>,
  options?: SendOptions,
) => Effect.Effect<Answer, HttpFailure, R>;

/** A request addressed by its actual method and path; safety resolves the canonical operation. */
type PathRequest = WriteRequest & {
  readonly headers?: Readonly<Record<string, string>>;
  readonly emptyForm?: true;
  /** Pre-framed bodies are for single requests, never bulk identifying content. */
  readonly rawBody?: string | Uint8Array<ArrayBuffer> | FormData;
};

export interface ConnectOptions {
  readonly errors: VendorErrors<any>;
  readonly safety: ResultSafety;
  /**
   * Unwrap a vendor envelope or fail an in-band refusal, before redaction.
   * `withheld` says whether this operation's failures may quote vendor text.
   */
  readonly result?: (
    body: unknown,
    answer: {
      readonly status: number;
      /** The decoded representation, so a legacy adapter can distinguish text from a JSON string. */
      readonly bodyFormat: "json" | "text" | "empty";
      readonly headers: Headers;
      readonly operation: OperationRef;
      readonly withheld: boolean;
      readonly prefix?: PrefixResult;
    },
  ) => Effect.Effect<unknown, HttpFailure, RequestSecrets>;
}

/** A vendor bound to one connection: its transport, its failure table, and its value-safety boundary. */
export interface Connection<R = CallServices> {
  readonly provider: string;
  readonly errors: VendorErrors<any>;
  readonly safety: ResultSafety;
  readonly send: Send<R>;
  /** A hatch's request: the same route as `send`, addressed by a path the guarded client confines. */
  readonly sendPath: (request: PathRequest, options?: SendOptions) => Effect.Effect<Answer, HttpFailure, R>;
  /** Send the snapshotted request derived for this item, never a request supplied by the running program. */
  readonly sendItem: (step: string, item: string) => Effect.Effect<Answer, HttpFailure, R>;
}

type Method<R> = (request: unknown) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, R>;

/**
 * Bind a vendor to one connection's guarded client. The typed client is built
 * once, on first use, and lives as long as the connection.
 */
export function connect<R>(
  vendor: Vendor,
  guarded: GuardedClient<R>,
  options: ConnectOptions,
): Connection<R | CallServices> {
  validateVendorErrors(options.errors);
  const textBodies = vendor.textBodies ? { ...vendor.textBodies } : undefined;
  const binaryBodies = vendor.binaryBodies ? { ...vendor.binaryBodies } : undefined;
  if (binaryBodies && (!binaryBodies.review.trim() || typeof binaryBodies.forResponse !== "function"))
    throw new Error("Binary bodies require a nonempty vendor review and a response contract selector.");
  if (textBodies && (!textBodies.review.trim() || typeof textBodies.forResponse !== "function"))
    throw new Error("Text bodies require a nonempty vendor review and a response contract selector.");
  let built: Record<string, Method<R>> | undefined;
  // HttpApiClient closes over the services it is built in (its middleware
  // lookup), and the client outlives every call. Build it with none, so it
  // holds no caller's context, signal, credentials or request scope (INV-7);
  // its endpoints read each call's services when they run.
  const construct = HttpApiClient.makeWith(vendor.api, { httpClient: guarded.client }).pipe(
    Effect.setContext(Context.empty()),
  );
  const client = Effect.suspend(() =>
    built
      ? Effect.succeed(built)
      : construct.pipe(Effect.map((made) => (built = made as unknown as Record<string, Method<R>>))),
  );

  const settle = (
    operation: OperationRef,
    response: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpFailure, R>,
    sendOptions: SendOptions | undefined,
  ): Effect.Effect<Answer, HttpFailure, R | CallServices> =>
    Effect.suspend(() => {
      // The transport names the request it handed to `fetch` here; whatever
      // its answer settles into is recorded on it in the ledger, so the
      // write-outcome rule can tell the write's own failure from a later one.
      const sent: { reservation?: Dispatch; dispatch?: Dispatch } = {};
      return Effect.gen(function* () {
        const authored = yield* ReadTool;
        if (authored !== undefined && operation.method !== "GET" && operation.method !== "HEAD" && !authored.review)
          return yield* Effect.die(new Error("A read tool sending a method other than GET or HEAD requires a review."));
        if ((yield* Classification) === "write" && sendOptions?.effect !== "read") {
          const ledger = yield* Dispatches;
          const capacity = yield* WriteCapacity;
          // Reserve before request encoding, authentication, or any asynchronous preparation.
          const slot = yield* Effect.sync(() => reserveWrite(ledger, capacity, { ...sendOptions, operation }));
          if (slot instanceof RequestRefused || slot instanceof ResendRefused) return yield* Effect.fail(slot);
          sent.reservation = slot;
        }
        const secrets = yield* RequestSecrets;
        const reply = yield* Effect.flatMap(response, (response) => {
          const contentType = secrets.redact(String(response.headers["content-type"] ?? "")).toLowerCase();
          const binary =
            response.status >= 200 &&
            response.status <= 299 &&
            binaryBodies?.forResponse(response.status, operation, contentType) === true;
          return guarded
            .read(response, undefined, binary ? "bytes" : undefined, sendOptions?.prefix)
            .pipe(
              Effect.catchDefect((defect) =>
                Effect.die(
                  sendOptions?.prefix && options.safety.withholdsErrors(operation)
                    ? new Error("A prefix hook withholding vendor text failed.")
                    : defect,
                ),
              ),
            );
        });
        // Header-derived format decisions see only redacted Content-Type.
        const headers = new Headers(secrets.redact([...reply.headers]));
        // Whole, before a detail line trims it or a projection extracts from it.
        const parsed =
          reply.bytes !== undefined
            ? {
                value:
                  reply.bytes.length === 0
                    ? null
                    : {
                        contentType: secrets.redact(reply.headers.get("content-type") ?? "").toLowerCase(),
                        bytes: reply.bytes.length,
                        base64: secrets.encode(reply.bytes),
                      },
                format: "json" as const,
              }
            : parse(
                reply.text,
                (value) =>
                  reply.prefix?.truncated && typeof value === "string"
                    ? secrets.redactOpenTail(value)
                    : secrets.redact(value),
                textBodies?.forResponse(reply.status, operation, (headers.get("content-type") ?? "").toLowerCase()),
              );

        if (reply.status < 200 || reply.status > 299) {
          return yield* Effect.fail(
            new StatusFailure({
              status: reply.status,
              headers,
              body: parsed?.value,
              ...(parsed ? {} : { unreadable: true as const }),
              operation,
            }),
          );
        }
        if (!parsed) return yield* Effect.fail(new UnreadableBody());
        const withheld = options.safety.withholdsErrors(operation);
        const kept = options.result
          ? yield* Effect.suspend(() =>
              options.result!(parsed.value, {
                status: reply.status,
                bodyFormat: parsed.format,
                headers,
                operation: { ...operation },
                withheld,
                ...(reply.prefix ? { prefix: reply.prefix } : {}),
              }),
            ).pipe(
              Effect.catch((failure): Effect.Effect<never, HttpFailure> => {
                if (failure._tag === "StatusFailure") return Effect.fail(new StatusFailure({ ...failure, operation }));
                if (!withheld || failure._tag === "UnreadableBody") return Effect.fail(failure);
                return Effect.die(
                  new Error("A result hook withholding vendor text must report an in-band refusal as StatusFailure."),
                );
              }),
            )
          : parsed.value;
        return {
          status: reply.status,
          data: options.safety.redact(kept, operation),
          ...(reply.prefix ? { prefix: reply.prefix } : {}),
        };
      }).pipe(
        Effect.tapError((failure) =>
          Effect.sync(() => {
            const slot = sent.dispatch ?? sent.reservation;
            if (slot && slot.failure === undefined && failure._tag !== "ResendRefused") slot.failure = failure;
          }),
        ),
        Effect.provideService(RequestFacts, {
          effect: sendOptions?.effect === "read" ? "read" : "call",
          ...(sendOptions?.step === undefined ? {} : { step: sendOptions.step }),
          ...(sendOptions?.item === undefined ? {} : { item: sendOptions.item }),
          operation,
          ...(sendOptions?.prefix ? { successPrefix: true as const } : {}),
          sent,
        }),
      );
    });

  const connection: Connection<R | CallServices> = {
    provider: guarded.provider,
    errors: options.errors,
    safety: options.safety,
    send: (operation, request, sendOptions) => {
      // Every endpoint carries both; the constraint type erases them.
      const declared = operation as unknown as { readonly method: string; readonly path: string };
      const ref: OperationRef = {
        method: declared.method,
        template: declared.path,
        ...(sendOptions?.flags ? { flags: sendOptions.flags } : {}),
      };
      return settle(
        ref,
        client.pipe(
          Effect.flatMap((methods) => methods[operation.identifier]!({ ...request, responseMode: "response-only" })),
          // The guarded client fails only with HttpFailure. Anything else is a
          // request the vendor's own Schemas could not encode: a provider bug.
          Effect.catch((error: unknown) => (isHttpFailure(error) ? Effect.fail(error) : Effect.die(error))),
        ),
        sendOptions,
      );
    },
    sendItem: (step, item) =>
      Effect.gen(function* () {
        const request = (yield* WriteCapacity).get(step)?.get(item);
        if (!request)
          return yield* Effect.fail(new RequestRefused({ message: "This write item has no declared request." }));
        return yield* connection.sendPath(request, { step, item });
      }),
    sendPath: (request, sendOptions) => {
      const { method, path } = request;
      if (
        request.rawBody !== undefined &&
        (sendOptions?.item !== undefined ||
          request.json !== undefined ||
          request.form !== undefined ||
          request.emptyForm)
      )
        return Effect.fail(
          new RequestRefused({ message: "A raw body cannot accompany a bulk item or another body encoding." }),
        );
      return Effect.flatMap(options.safety.resolve(method, path), (operation) =>
        settle(
          { ...operation, ...(sendOptions?.flags ? { flags: sendOptions.flags } : {}) },
          Effect.suspend(() => {
            let built = HttpClientRequest.make(method)(
              path,
              request.query ? { urlParams: parameterPairs(request.query) } : {},
            );
            if (request.headers) built = HttpClientRequest.setHeaders(built, request.headers);
            if (request.form !== undefined && (Object.keys(request.form).length > 0 || request.emptyForm === true)) {
              built = HttpClientRequest.bodyText(
                built,
                new URLSearchParams(parameterPairs(request.form)).toString(),
                "application/x-www-form-urlencoded",
              );
            }
            if (request.json !== undefined) built = HttpClientRequest.bodyText(built, request.json, "application/json");
            if (request.rawBody !== undefined) {
              const type = new Headers(request.headers).get("content-type") ?? undefined;
              built =
                typeof request.rawBody === "string"
                  ? HttpClientRequest.bodyText(built, request.rawBody, type)
                  : request.rawBody instanceof Uint8Array
                    ? HttpClientRequest.bodyUint8Array(built, request.rawBody, type)
                    : HttpClientRequest.bodyFormData(built, request.rawBody);
              // Body combinators supply defaults; an explicit reviewed media type wins.
              if (type !== undefined) built = HttpClientRequest.setHeader(built, "content-type", type);
            }
            return guarded.client.execute(built);
          }),
          sendOptions,
        ),
      );
    },
  };
  return connection;
}

function parse(
  text: string | undefined,
  redact: (value: unknown) => unknown,
  format?: "text" | "json-or-text",
): { value: unknown; format: "json" | "text" | "empty" } | undefined {
  if (text === undefined) return undefined;
  if (format === "text") return { value: redact(text), format: "text" };
  if (text.trim() === "")
    return format === "json-or-text" ? { value: redact(text), format: "text" } : { value: undefined, format: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return format === "json-or-text" ? { value: redact(text), format: "text" } : undefined;
  }
  return { value: redact(value), format: "json" };
}

/** The endpoint manifest drift checks compare against the vendor's published contract. */
export function manifest(vendor: Vendor): OpenApi.OpenAPISpec {
  const document = OpenApi.fromApi(vendor.indexed?.api() ?? vendor.api);
  return vendor.manifestBase === undefined
    ? document
    : {
        ...document,
        paths: Object.fromEntries(
          Object.entries(document.paths).map(([path, operation]) => [vendor.manifestBase + path, operation]),
        ),
      };
}

const METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;

/**
 * Every operation of `manifest(vendor)` as `"METHOD /path"`, sorted: the
 * `operations` of decision 0011's `ProviderKitFacts`, which
 * `providers:generate` writes into `drift.json`'s `generated.operations`.
 */
export function operations(vendor: Vendor): string[] {
  if (vendor.indexed) return [...vendor.indexed.operations];
  return Object.entries(manifest(vendor).paths)
    .flatMap(([path, item]) =>
      METHODS.filter((method) => (item as Record<string, unknown>)[method] !== undefined).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
    )
    .sort();
}
