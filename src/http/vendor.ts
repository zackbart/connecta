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
// one route: bounded read, JSON, the request's sent secrets redacted from the
// whole body before anything can cut or extract from it (#911), status (with
// its operation, so value safety decides what a failure may quote), the
// vendor's `result` hook, then the connection's ResultSafety. A provider
// cannot reach a body earlier.

import { Effect, type Schema } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import { parameterPairs } from "./write-request.js";
import type { GuardedClient } from "./client.js";
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
  WriteCapacity,
  reserveWrite,
  type WriteRequest,
  type CallServices,
  type Dispatch,
} from "./services.js";

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

/** A request a hatch addresses by path; `template` is its index's operation. */
type PathRequest = WriteRequest;

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
  /** Send the snapshotted request derived for this item, never a request supplied by the running program. */
  readonly sendItem: (step: string, item: string) => Effect.Effect<Answer, HttpFailure, R>;
}

type Method<R> = (request: unknown) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, R>;

/** Bind a vendor to one connection's guarded client. The typed client is built once, on first use. */
export function connect<R>(
  vendor: Vendor,
  guarded: GuardedClient<R>,
  options: ConnectOptions,
): Connection<R | CallServices> {
  validateVendorErrors(options.errors);
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
  ): Effect.Effect<Answer, HttpFailure, R | CallServices> =>
    Effect.suspend(() => {
      // The transport names the request it handed to `fetch` here; whatever
      // its answer settles into is recorded on it in the ledger, so the
      // write-outcome rule can tell the write's own failure from a later one.
      const sent: { reservation?: Dispatch; dispatch?: Dispatch } = {};
      return Effect.gen(function* () {
        if ((yield* Classification) === "write" && sendOptions?.effect !== "read") {
          const ledger = yield* Dispatches;
          const capacity = yield* WriteCapacity;
          // Reserve before request encoding, authentication, or any asynchronous preparation.
          const slot = yield* Effect.sync(() => reserveWrite(ledger, capacity, { ...sendOptions, operation }));
          if (slot instanceof RequestRefused || slot instanceof ResendRefused) return yield* Effect.fail(slot);
          sent.reservation = slot;
        }
        const reply = yield* Effect.flatMap(response, guarded.read);
        // Whole, before a detail line trims it or a projection extracts from it.
        const secrets = yield* RequestSecrets;
        const parsed = parse(reply.text, (value) => secrets.redact(value));
        if (reply.status < 200 || reply.status > 299) {
          return yield* Effect.fail(
            new StatusFailure({
              status: reply.status,
              headers: reply.headers,
              body: parsed?.value,
              ...(parsed ? {} : { unreadable: true as const }),
              operation,
            }),
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
      return settle(
        {
          method: request.method,
          template: request.template,
          ...(sendOptions?.flags ? { flags: sendOptions.flags } : {}),
        },
        Effect.suspend(() => {
          let built = HttpClientRequest.make(request.method)(
            request.path,
            request.query ? { urlParams: parameterPairs(request.query) } : {},
          );
          if (request.form && Object.keys(request.form).length > 0) {
            built = HttpClientRequest.bodyText(
              built,
              new URLSearchParams(parameterPairs(request.form)).toString(),
              "application/x-www-form-urlencoded",
            );
          }
          if (request.json !== undefined) built = HttpClientRequest.bodyText(built, request.json, "application/json");
          return guarded.client.execute(built);
        }),
        sendOptions,
      );
    },
  };
  return connection;
}

function parse(text: string | undefined, redact: (value: unknown) => unknown): { value: unknown } | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === "") return { value: undefined };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return { value: redact(value) };
}

/** The endpoint manifest drift checks compare against the vendor's published contract. */
export function manifest(vendor: Vendor): OpenApi.OpenAPISpec {
  return OpenApi.fromApi(vendor.api);
}

const METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;

/**
 * Every operation of `manifest(vendor)` as `"METHOD /path"`, sorted: the
 * `operations` of decision 0011's `ProviderKitFacts`, which
 * `providers:generate` writes into `drift.json`'s `generated.operations`.
 */
export function operations(vendor: Vendor): string[] {
  return Object.entries(manifest(vendor).paths)
    .flatMap(([path, item]) =>
      METHODS.filter((method) => (item as Record<string, unknown>)[method] !== undefined).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
    )
    .sort();
}
