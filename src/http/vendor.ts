// Internal prototype for decision 0010 (B.4). Unreachable from src/index.ts.
//
// A vendor is an `HttpApi`: endpoints with Schemas for path params, query,
// and payload, from which requests are encoded and the endpoint manifest is
// derived. This is the only kit module that imports effect/http-api, which
// 4.0.5 annotates unstable; providers declare operations through the names
// re-exported here, so an upstream change is absorbed in this file.
//
// The typed client runs in `response-only` mode, and `Send` hands providers a
// bounded `Reply`, never a response. HttpApiClient's own decoding would read
// the whole body without a ceiling, quote the body in a SchemaError, and fail
// an empty 200; status meaning, bounded reads, and in-band refusals stay the
// kit's (src/http/client.ts, src/http/tools.ts).

import { Effect, type Schema } from "effect";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import type { GuardedClient, Reply } from "./client.js";
import type { HttpFailure } from "./errors.js";
import type { CallServices } from "./services.js";

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

/** Send one operation and read its answer under the connection's ceiling. */
export type Send<R = CallServices> = <Op extends Operation>(
  operation: Op,
  request: RequestOf<Op>,
) => Effect.Effect<Reply, HttpFailure, R>;

type Method<R> = (request: unknown) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, R>;

/** Bind a vendor to one connection's guarded client. The typed client is built once, on first use. */
export function connect<R>(vendor: Vendor, guarded: GuardedClient<R>): Send<R> {
  let built: Record<string, Method<R>> | undefined;
  const client = Effect.suspend(() =>
    built
      ? Effect.succeed(built)
      : HttpApiClient.makeWith(vendor.api, { httpClient: guarded.client }).pipe(
          Effect.map((made) => (built = made as unknown as Record<string, Method<R>>)),
        ),
  );
  return (operation, request) =>
    client.pipe(
      Effect.flatMap((methods) => methods[operation.identifier]!({ ...request, responseMode: "response-only" })),
      // The guarded client fails only with HttpFailure. Anything else is a
      // request the vendor's own Schemas could not encode: a provider bug.
      Effect.catch((error: unknown) => (isHttpFailure(error) ? Effect.fail(error) : Effect.die(error))),
      Effect.flatMap(guarded.read),
    );
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
