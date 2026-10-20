// Internal prototype for decision 0010 (B.4). Unreachable from src/index.ts.
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
// one route: bounded read, status (with its operation, so value safety
// decides what a failure may quote), JSON, the vendor's `result` hook, then
// the connection's ResultSafety. A provider cannot reach a body earlier.

import { Effect, type Schema } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import type { GuardedClient } from "./client.js";
import { StatusFailure, UnreadableBody, type HttpFailure, type OperationRef, type VendorErrors } from "./errors.js";
import type { ResultSafety } from "./safety.js";
import { RequestFacts, type CallServices } from "./services.js";

/** Declare a GET operation: `get("getCharge", "/charges/:chargeId", { params, query, success })`. */
export const get = HttpApiEndpoint.get;

type Operation = HttpApiEndpoint.ConstraintRequest;

type Part<Key extends string, S> = [S] extends [never]
  ? {}
  : { readonly [K in Key]: S extends Schema.Top ? S["Type"] : never };

/** What one call to an operation supplies, typed from its Schemas. */
type RequestOf<Op extends Operation> = Part<"params", Op["~Params"]> &
  Part<"query", Op["~Query"]> &
  Part<"payload", Op["~Payload"]>;

export interface Vendor {
  // The group type is erased here: kit callers name operations, never groups.
  readonly api: HttpApi.HttpApi<string, any>;
}

/** Group a vendor's operations into one API, the source of its client and its manifest. */
export function vendor(name: string, ...operations: readonly [Operation, ...Operation[]]): Vendor {
  return { api: HttpApi.make(name).add(HttpApiGroup.make("operations", { topLevel: true }).add(...operations)) };
}

/** One answer, after every check: the only thing a provider reads. */
interface Answer {
  readonly status: number;
  /** The JSON body after the vendor's `result` hook and the connection's ResultSafety; `undefined` when empty. */
  readonly data: unknown;
}

interface SendOptions {
  /** An auxiliary lookup inside a write tool: it is not the write, and may be replayed after a 401. Never inferred. */
  readonly effect?: "read";
  /** Named facts the vendor's error rules read for this request, such as Google's `revisionGuarded`. */
  readonly flags?: Readonly<Record<string, true>>;
}

/** Send one operation and settle its answer. */
type Send<R = CallServices> = <Op extends Operation>(
  operation: Op,
  request: RequestOf<Op>,
  options?: SendOptions,
) => Effect.Effect<Answer, HttpFailure, R>;

/** A request a hatch addresses by path; `template` is its index's operation. */
interface PathRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly template: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Form fields, sent `application/x-www-form-urlencoded` as URLSearchParams encodes them. */
  readonly form?: Readonly<Record<string, string>>;
}

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
      readonly headers: Headers;
      readonly operation: OperationRef;
      readonly withheld: boolean;
    },
  ) => Effect.Effect<unknown, HttpFailure>;
}

/** A vendor bound to one connection: its transport, its failure table, and its value-safety boundary. */
export interface Connection<R = CallServices> {
  readonly provider: string;
  readonly errors: VendorErrors<any>;
  readonly safety: ResultSafety;
  readonly send: Send<R>;
  /** A hatch's request: the same route as `send`, addressed by a path the guarded client confines. */
  readonly sendPath: (request: PathRequest, options?: SendOptions) => Effect.Effect<Answer, HttpFailure, R>;
}

type Method<R> = (request: unknown) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, R>;

/** Bind a vendor to one connection's guarded client. The typed client is built once, on first use. */
export function connect<R>(vendor: Vendor, guarded: GuardedClient<R>, options: ConnectOptions): Connection<R> {
  let built: Record<string, Method<R>> | undefined;
  const client = Effect.suspend(() =>
    built
      ? Effect.succeed(built)
      : HttpApiClient.makeWith(vendor.api, { httpClient: guarded.client }).pipe(
          Effect.map((made) => (built = made as unknown as Record<string, Method<R>>)),
        ),
  );

  const settle = (
    operation: OperationRef,
    response: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpFailure, R>,
    sendOptions: SendOptions | undefined,
  ): Effect.Effect<Answer, HttpFailure, R> =>
    Effect.gen(function* () {
      const reply = yield* Effect.flatMap(response, guarded.read);
      const parsed = parse(reply.text);
      if (reply.status < 200 || reply.status > 299) {
        return yield* Effect.fail(
          new StatusFailure({ status: reply.status, headers: reply.headers, body: parsed?.value, operation }),
        );
      }
      if (!parsed) return yield* Effect.fail(new UnreadableBody());
      const kept = options.result
        ? yield* options.result(parsed.value, {
            status: reply.status,
            headers: reply.headers,
            operation,
            withheld: options.safety.withholdsErrors(operation),
          })
        : parsed.value;
      return { status: reply.status, data: options.safety.redact(kept, operation) };
    }).pipe(
      Effect.provideService(RequestFacts, {
        effect: sendOptions?.effect === "read" ? "read" : "call",
        operation,
      }),
    );

  return {
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
    sendPath: (request, sendOptions) => {
      let built = HttpClientRequest.make(request.method)(
        request.path,
        request.query ? { urlParams: request.query } : {},
      );
      if (request.form && Object.keys(request.form).length > 0) {
        built = HttpClientRequest.bodyText(
          built,
          new URLSearchParams(request.form).toString(),
          "application/x-www-form-urlencoded",
        );
      }
      return settle(
        {
          method: request.method,
          template: request.template,
          ...(sendOptions?.flags ? { flags: sendOptions.flags } : {}),
        },
        guarded.client.execute(built),
        sendOptions,
      );
    },
  };
}

function parse(text: string | undefined): { value: unknown } | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === "") return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

const TAGS = new Set([
  "RequestRefused",
  "TransportFailure",
  "RedirectRefused",
  "ResponseTooLarge",
  "StatusFailure",
  "UnreadableBody",
  "Refusal",
]);

function isHttpFailure(error: unknown): error is HttpFailure {
  return typeof error === "object" && error !== null && TAGS.has((error as { _tag?: unknown })._tag as string);
}

/** The endpoint manifest drift checks compare against the vendor's published contract. */
export function manifest(vendor: Vendor): OpenApi.OpenAPISpec {
  return OpenApi.fromApi(vendor.api);
}
