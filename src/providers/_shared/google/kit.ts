// Google Workspace on the provider kit (decision 0010; C.7 step 1 under 0011).
// Shared by every Workspace product; never its own export. `workspace.ts`
// keeps the options, the subject rule and the legacy Promise client for
// products that have not migrated; `service-account.ts` keeps the private
// token exchange. This module adds what a kit product needs: the Google error
// table, the delegated machine grant, a value-safety resolver over the
// product's own operations, a request adapter that keeps the legacy request
// bytes and write wording, and the step-1 catalog bridge.

import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../../connectors/api-connector.js";
import { callClassification } from "../../../call-classification.js";
import { deriveContext } from "../../../derived-context.js";
import { ConnectorCallError } from "../../../errors.js";
import {
  Refusal,
  StatusFailure,
  toConnectorCallError,
  type HttpFailure,
  type VendorErrors,
} from "../../../http/errors.js";
import type { GrantRenewal } from "../../../http/oauth.js";
import type { SafetyOptions } from "../../../http/safety.js";
import { Classification, Dispatches, Signal, type CallServices, type Dispatch } from "../../../http/services.js";
import { read, write } from "../../../http/tools.js";
import type { Connection, Operation as VendorOperation } from "../../../http/vendor.js";
import { callMemo, Operation } from "../../../runtime/call.js";
import type { ConnectorContext, JsonSchema } from "../../../types.js";
import { providerFailureMessage, unsentAfterUnauthorized } from "../../../write-outcome.js";
import { delegatedToken, forgetDelegatedToken, type DelegatedTokenRequest } from "./service-account.js";
import { subjectFor, workspaceConnection, type GoogleWorkspaceOptions, type WorkspaceConnection } from "./workspace.js";
import { tagWorkspaceSubject } from "../../../workspace-subject.js";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- Errors ------------------------------------------------------------------------

/** How a product reads an HTTP 404 (H11): absence, or possibly a permission gap. */
type NotFoundMeaning = "absent" | "ambiguous";

/** What one product's failures name: its display name, its console API name, its scopes. */
export interface GoogleProduct {
  /** Product name in messages: "Gmail", "Google Forms". */
  readonly provider: string;
  /** The API's console name, for an "enable the … API" message. */
  readonly api: string;
  /** Exactly the scopes this product requests; the delegation grant must list them. */
  readonly scopes: readonly string[];
  readonly notFound: NotFoundMeaning;
}

/** Google's machine-readable reasons: `errors[].reason`, `details[].reason`, then `status`. */
export interface GoogleFacts extends Record<string, readonly string[]> {
  readonly reasons: readonly string[];
}

function reasonsOf(tokens: unknown): string[] {
  const error = asRecord(asRecord(tokens)["error"]);
  const reasons = new Set<string>();
  for (const entry of [...asArray(error["errors"]), ...asArray(error["details"])]) {
    const reason = asRecord(entry)["reason"];
    if (typeof reason === "string") reasons.add(reason);
  }
  if (typeof error["status"] === "string") reasons.add(error["status"]);
  return [...reasons];
}

/** The canonical and legacy spellings of a refused precondition. */
const PRECONDITION_REASONS = ["FAILED_PRECONDITION", "failedPrecondition"];
/** Concurrency aborts, which a revision-checked write also answers with. */
const ABORTED_REASONS = ["ABORTED", "aborted"];

/**
 * Google's failure table, in the legacy client's order: Google's own
 * specific reasons decide first, whatever the status; only a refused
 * precondition or an abort with nothing more specific to say is left for
 * the revision guard (the `revisionGuarded` request flag), then the status.
 * Each verdict's words are the legacy client's, so the messages stay.
 */
export function googleErrors(product: GoogleProduct): VendorErrors<GoogleFacts> {
  const { provider, api, scopes, notFound } = product;
  const has = (facts: GoogleFacts, names: readonly string[]) => names.some((name) => facts.reasons.includes(name));
  return {
    provider,
    facts: (tokens) => ({ reasons: reasonsOf(tokens) }),
    detail: ({ status, body }) => {
      const message = asRecord(asRecord(body)["error"])["message"];
      // The body arrives redacted whole, before anything here cuts it.
      const said = typeof message === "string" ? message.trim().slice(0, 500) : "";
      return said ? `${provider}: ${said}` : `${provider} returned HTTP ${status}.`;
    },
    classify: [
      // Every 3xx the transport lets through (300, 304, 305, 306) is a redirect first.
      ({ status }) =>
        status >= 300 && status < 400
          ? {
              code: "connector_call_failed",
              retryable: false,
              words: () =>
                `${provider} answered HTTP ${status} with a redirect; this connection talks to exactly one origin and never forwards its credential to another.`,
            }
          : undefined,
      ({ status }) =>
        status === 401
          ? {
              code: "auth_required",
              words: (detail) =>
                `${detail} Google rejected a freshly minted delegated token. The domain-wide delegation grant or the service account may have been revoked.`,
            }
          : undefined,
      ({ facts }) =>
        has(facts, ["accessNotConfigured", "SERVICE_DISABLED"])
          ? {
              code: "connector_call_failed",
              retryable: false,
              words: (detail) =>
                `${detail} The ${api} is not enabled in the service account's Google Cloud project; an operator enables it there.`,
            }
          : undefined,
      ({ status, facts, retryAfterMs }) =>
        status === 429 || has(facts, ["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"])
          ? {
              code: "rate_limited",
              retryAfterMs,
              words: (detail) => `${detail} Google meters this API per user and per project.`,
              advice: "; wait before retrying",
            }
          : undefined,
      ({ facts }) =>
        has(facts, ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"])
          ? {
              code: "provider_permission_denied",
              words: (detail) =>
                `${detail} The delegated token lacks a scope this call needs. The Admin console's domain-wide delegation entry must list exactly: ${scopes.join(",")}.`,
            }
          : undefined,
      ({ facts }) =>
        has(facts, ["exportSizeLimitExceeded"])
          ? {
              code: "connector_call_failed",
              retryable: false,
              words: (detail) =>
                `${detail} The item is larger than Google will export in this format. Download the original file instead, or export a smaller part.`,
            }
          : undefined,
      ({ facts }) =>
        has(facts, ["domainPolicy"])
          ? {
              code: "provider_permission_denied",
              retryable: false,
              words: (detail) =>
                `${detail} A Workspace domain policy forbids this action for this account; only a Workspace administrator can change that.`,
            }
          : undefined,
      ({ facts }) =>
        has(facts, ["insufficientFilePermissions", "forbidden"])
          ? {
              code: "provider_permission_denied",
              retryable: false,
              words: (detail) =>
                `${detail} This account does not have the permission on this item that the action needs — it may be shared view-only, or not shared with this user. Its owner can grant more.`,
            }
          : undefined,
      // A write that named the revision it was made against hears "the item
      // moved on" as a refused precondition or an abort. Fixed words, so no
      // provider ever matches on Google's prose.
      ({ status, facts, operation }) =>
        operation.flags?.["revisionGuarded"] === true &&
        (status === 400 || status === 409) &&
        has(facts, [...PRECONDITION_REASONS, ...ABORTED_REASONS])
          ? {
              code: "conflict",
              words: () => `${provider} refused the write because the item changed after the revision it named.`,
              advice: " Re-read it for the current revision, reapply the change, and retry.",
            }
          : undefined,
      // Google uses the same reason for a product switched off for this user
      // and for a stale write, so the classification asserts neither.
      ({ status, facts }) =>
        status === 400 && has(facts, PRECONDITION_REASONS)
          ? {
              code: "connector_call_failed",
              retryable: false,
              words: (detail) => `${detail} Google refused the request's precondition; its message says which.`,
            }
          : undefined,
    ],
    statuses: {
      401: () => ({ code: "auth_required" }),
      403: () => ({
        code: "provider_permission_denied",
        retryable: false,
        words: (detail) =>
          `${detail} Google refused the request; the account may lack access to this item, or a Workspace policy may block it. Google does not say which. Ask the item owner to grant access or a Workspace administrator to review the policy.`,
      }),
      404: () =>
        notFound === "absent"
          ? { code: "not_found", words: (detail) => `${detail} Re-read the id from a list or search tool.` }
          : {
              code: "connector_call_failed",
              retryable: false,
              words: (detail) =>
                `${detail} The id is unknown or not visible to this account; Google does not distinguish them.`,
            },
      400: () => ({ code: "invalid_args" }),
      422: () => ({ code: "invalid_args" }),
      serverError: ({ retryAfterMs }) => ({
        code: "unavailable",
        retryAfterMs,
        words: (detail) => `${detail} Google is failing upstream.`,
      }),
      otherwise: () => ({ code: "connector_call_failed", retryable: false }),
    },
    unreadable: `${provider} returned a successful response that is not JSON.`,
  };
}

// --- Value safety ------------------------------------------------------------------

/** One declared operation as a matcher over actual paths: `:name` matches one encoded segment. */
function templateMatcher(template: string): RegExp {
  const segments = template.split("/").map((segment) => {
    const parameter = /^:([A-Za-z0-9_]+)(.*)$/.exec(segment);
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return parameter ? `[^/]+${literal(parameter[2]!)}` : literal(segment);
  });
  return new RegExp(`^${segments.join("/")}$`);
}

/**
 * Google's value safety. Workspace answers are the user's own documents and
 * mail, returned to the user who can open them; no response carries a
 * credential or a stored secret, and the token a request sent is redacted by
 * the kit's sent-secret pass before anything reads a body. So no field is
 * rewritten and failures keep Google's (redacted) message, as they did on the
 * legacy client. Every request resolves to one of the product's declared
 * operations, so a path no tool declares never reaches the network.
 */
export function googleSafety(provider: string, operations: readonly VendorOperation[]): SafetyOptions {
  const declared = operations.map((operation) => {
    const { method, path } = operation as unknown as { readonly method: string; readonly path: string };
    return { method, template: path, matcher: templateMatcher(path) };
  });
  return {
    reviewed: {
      resolve: (method, path) => {
        const found = declared.find((entry) => entry.method === method && entry.matcher.test(path));
        if (!found)
          throw new ConnectorCallError(
            "invalid_args",
            `This ${provider} operation is not one the connection declares.`,
          );
        return { method: found.method, template: found.template };
      },
      redact: (data) => data,
      withholdsErrors: () => false,
    },
    sensitiveFields: { names: [], choice: "drop" },
  };
}

// --- The delegated grant -----------------------------------------------------------

const connections = new WeakMap<object, WorkspaceConnection>();

/**
 * The checked shared options, parsed once per construction: every definition
 * callback receives the same validated options object, and the key is
 * decoded and checked only the first time.
 */
export function workspaceOf(factory: string, options: Readonly<GoogleWorkspaceOptions>): WorkspaceConnection {
  let connection = connections.get(options);
  if (!connection) {
    connection = workspaceConnection(factory, options as GoogleWorkspaceOptions);
    connections.set(options, connection);
  }
  return connection;
}

/**
 * A machine grant over the service account's delegated tokens. Built at
 * construction, outside every caller context (INV-7); each send evaluates it
 * with that call's services. The subject resolves once per call, from
 * deployment config and the admitted caller only, before any token is
 * minted. Tokens are the shared in-memory cache's: only token strings and
 * expiries cross requests.
 */
export function googleGrant(product: GoogleProduct, connection: WorkspaceConnection) {
  const { provider, scopes } = product;
  const errors = googleErrors(product);
  const subjectKey = {};
  return Effect.gen(function* () {
    const operation = yield* Effect.serviceOption(Operation);
    const ctx = Option.isSome(operation) ? operation.value : undefined;
    if (!ctx)
      return yield* Effect.die(new Error(`${provider} needs the call's connector context to resolve its subject.`));
    const callSignal = yield* Signal;
    // One resolution per call: a tool that sends several requests acts as one account throughout.
    const tokenRequest = async (): Promise<DelegatedTokenRequest> => ({
      account: connection.account,
      subject: await callMemo(ctx, subjectKey, () => subjectFor(provider, connection.subject, ctx)),
      scopes,
    });
    const use = <A>(work: (view: ConnectorContext) => Promise<A>): Effect.Effect<A, HttpFailure> =>
      Effect.tryPromise({
        try: (interrupted) =>
          work(deriveContext(ctx, { signal: callSignal ? AbortSignal.any([callSignal, interrupted]) : interrupted })),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
        ),
      );
    return {
      token: use(async (view) => delegatedToken(await tokenRequest(), view)),
      // The token a 401 refused is forgotten, never a newer one, then minted anew.
      refresh: (stale: string) =>
        use(async (view) => {
          const request = await tokenRequest();
          await forgetDelegatedToken(request, stale);
          return delegatedToken(request, view);
        }),
      // Unreachable with GOOGLE_GRANT_RENEWAL, which answers a replay's 401 from its body.
      rejected: Effect.suspend(() =>
        Effect.fail(
          new Refusal({
            error: toConnectorCallError(
              new StatusFailure({
                status: 401,
                headers: new Headers(),
                body: undefined,
                operation: { method: "GET", template: "" },
              }),
              errors,
              { classification: "read", dispatches: [] },
            ),
          }),
        ),
      ),
      discard: (rejected: string) =>
        use(async () => forgetDelegatedToken(await tokenRequest(), rejected)).pipe(Effect.ignore),
    };
  });
}

/**
 * Renewal as the legacy client did it: a read's 401 earns one fresh token
 * and one replay, and a second 401 is answered from its own body; a write's
 * 401 forgets its token and is never sent again, and the next call mints.
 */
export const GOOGLE_GRANT_RENEWAL: GrantRenewal = { replayRejection: "answer", writeRenewal: "discard" };

/** Tag the built connector with whose account it acts as (#837, decisions/0006). */
export function tagWorkspace(factory: string) {
  return (connector: object, options: Readonly<GoogleWorkspaceOptions>): void => {
    tagWorkspaceSubject(connector, workspaceOf(factory, options).subject);
  };
}

// --- Requests ----------------------------------------------------------------------

type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;

/** A request as the legacy client spelled it: provider-relative path, query, JSON or raw body. */
export interface GoogleRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** JSON body, serialized as the legacy transport did. */
  readonly body?: unknown;
  /** A pre-framed body with its own Content-Type header, such as a multipart upload. */
  readonly rawBody?: string | Uint8Array<ArrayBuffer>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GoogleRequestOptions {
  /**
   * The write names the revision it was made against (Docs, Slides, Forms
   * `writeControl.requiredRevisionId`): a stale one maps to `conflict`.
   */
  readonly revisionGuarded?: boolean;
  /** A lookup inside a write tool, which consumes no write step (the kit's auxiliary read). */
  readonly effect?: "read";
  /** One of the tool's declared write steps, for a tool that sends more than one write. */
  readonly step?: string;
}

/**
 * How far a failed request got, as the legacy client reported it, so a
 * product can tell a refusal or a request that never left from one whose
 * write may have applied.
 */
export interface GoogleOutcome {
  readonly dispatched: boolean;
  readonly status?: number;
  readonly phase:
    | "before-send"
    | "awaiting-response"
    | "reading-body"
    | "redirected"
    | "server-error"
    | "refused"
    | "unauthorized";
}

const outcomes = new WeakMap<object, GoogleOutcome>();

/** The phase of a failure a Google request returned; undefined for anything else. */
export function googleOutcomeOf(failure: unknown): GoogleOutcome | undefined {
  return failure !== null && typeof failure === "object" ? outcomes.get(failure) : undefined;
}

function noted<T extends object>(failure: T, outcome: GoogleOutcome): T {
  outcomes.set(failure, Object.freeze({ ...outcome }));
  return failure;
}

/** Query pairs as the legacy transport encoded them: undefined dropped, arrays repeated, values stringified. */
function queryPairs(query: GoogleRequest["query"]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) pairs.push([key, String(item)]);
    else pairs.push([key, String(value)]);
  }
  return pairs;
}

/**
 * Words the legacy client gave a served write whose answer proves nothing:
 * no answer, a 5xx, a redirect, or a 2xx whose reply could not be read. Only
 * the message and retry flag are its; the core still decides the outcome,
 * which for each of these is unknown.
 */
function unknownWrite(message: string): Refusal {
  return new Refusal({ error: new ConnectorCallError("connector_call_failed", message, { retryable: false }) });
}

/** A product's request path over its kit connection, keeping the legacy request and failure shapes. */
export interface GoogleClient {
  /** One JSON request; the parsed body, `undefined` for an empty one. */
  readonly json: (
    request: GoogleRequest,
    options?: GoogleRequestOptions,
  ) => Effect.Effect<unknown, HttpFailure, CallServices>;
  /**
   * A reviewed binary answer, after the connection's byte ceiling, sent-secret
   * pass, result hook and value safety. `data` is the safe binary envelope
   * (or the product result hook's projection), never the transport's raw bytes.
   * A product selects `googleBytes` in its vendor's `binaryBodies` review.
   */
  readonly bytes: (
    request: GoogleRequest,
    accept?: string,
    options?: GoogleRequestOptions & { readonly maxBytes?: number },
  ) => ReturnType<Connection["sendPath"]>;
}

export function googleClient(connection: Connection, provider: string): GoogleClient {
  const send = (
    request: GoogleRequest,
    accept: string,
    options: (GoogleRequestOptions & { readonly maxBytes?: number }) | undefined,
    binary = false,
  ) =>
    Effect.gen(function* () {
      const active = yield* Effect.serviceOption(Operation);
      const callWrite = (yield* Classification) === "write";
      const dispatches = yield* Dispatches;
      const signal = yield* Signal;
      // Match the legacy wording rule even for direct calls: their GET
      // lookups have no served verdict. Physical write accounting stays the
      // core's Classification; only these Google-specific words use this.
      const served = Option.isSome(active) ? callClassification(active.value) : undefined;
      const write = (served ?? (request.method === "GET" ? "read" : "write")) === "write";
      const operation = yield* connection.safety.resolve(request.method, request.path);
      return yield* connection
        .sendPath(
          {
            method: request.method,
            path: request.path,
            template: operation.template,
            query: queryPairs(request.query),
            headers: { accept, ...request.headers },
            ...(request.body !== undefined ? { json: JSON.stringify(request.body) } : {}),
            ...(request.rawBody !== undefined ? { rawBody: request.rawBody } : {}),
          },
          {
            ...(options?.revisionGuarded || binary
              ? {
                  flags: {
                    ...(options?.revisionGuarded ? { revisionGuarded: true as const } : {}),
                    ...(binary ? { googleBytes: true as const } : {}),
                  },
                }
              : {}),
            ...(binary && options?.maxBytes !== undefined ? { prefix: { maxBytes: options.maxBytes } } : {}),
            ...(options?.effect ? { effect: options.effect } : {}),
            ...(options?.step ? { step: options.step } : {}),
          },
        )
        .pipe(
          Effect.catch((failure) =>
            Effect.fail(
              settled(
                failure,
                dispatches.find((entry) => entry.failure === failure),
                write,
                callWrite,
                signal,
              ),
            ),
          ),
        );
    });

  function settled(
    failure: HttpFailure,
    own: Dispatch | undefined,
    write: boolean,
    callWrite: boolean,
    signal: AbortSignal | undefined,
  ): HttpFailure {
    const status = own?.status;
    const dispatched = own?.request?.dispatched === true;
    const at = (phase: GoogleOutcome["phase"], code = status) =>
      ({ dispatched, phase, ...(code === undefined ? {} : { status: code }) }) as GoogleOutcome;
    if (!dispatched) return noted(failure, { dispatched: false, phase: "before-send" });
    switch (failure._tag) {
      case "StatusFailure": {
        const code = failure.status;
        if (code >= 300 && code < 400)
          return noted(
            write
              ? unknownWrite(
                  `${provider} answered HTTP ${code} with a redirect, which this connection does not follow, so whether the request was applied is unknown. Re-read its target before repeating it.`,
                )
              : failure,
            at("redirected", code),
          );
        if (write && code >= 500)
          return noted(
            unknownWrite(
              `${provider} answered HTTP ${code} after receiving the request, so its outcome is unknown — it may have been applied. Re-read its target before repeating it.`,
            ),
            at("server-error", code),
          );
        if (callWrite && own?.request?.auxiliary !== true && code === 401) {
          // Never sent again (INV-9); the next call mints a fresh token.
          const refusal = toConnectorCallError(failure, connection.errors, {
            classification: "write",
            dispatches: [own!],
            withholds: connection.safety.withholdsErrors,
            signal,
          });
          return noted(new Refusal({ error: unsentAfterUnauthorized(provider, refusal) }), at("unauthorized", 401));
        }
        return noted(failure, at("refused", code));
      }
      case "RedirectRefused":
        return noted(
          write
            ? unknownWrite(
                `${provider} answered HTTP ${failure.status} with a redirect, which this connection does not follow, so whether the request was applied is unknown. Re-read its target before repeating it.`,
              )
            : failure,
          at("redirected", failure.status),
        );
      case "TransportFailure":
        return noted(
          write
            ? unknownWrite(
                `${provider} was sent the request but no answer came back, so it may or may not have been applied. Re-read its target before repeating it.`,
              )
            : failure,
          at("awaiting-response", undefined),
        );
      case "ResponseTooLarge":
      case "UnreadableBody":
        // An error status keeps its meaning whatever went wrong reading it.
        if (status !== undefined && status >= 400)
          return noted(failure, at(write && status >= 500 ? "server-error" : "refused"));
        return noted(
          write
            ? unknownWrite(
                `${provider} accepted the request but its reply could not be read; the change probably applied. Re-read before repeating it.`,
              )
            : failure,
          at("reading-body"),
        );
      default:
        return noted(failure, at("refused"));
    }
  }

  return {
    json: (request, options) => Effect.map(send(request, "application/json", options), (answer) => answer.data),
    bytes: (request, accept = "*/*", options) => send(request, accept, options, true),
  };
}

/**
 * Reword a failure a Google request returned, keeping its verdict, its
 * provenance and its phase: what a product adds after an uncertain create.
 */
export function googleFailureMessage(
  connection: Connection,
  failure: HttpFailure,
  message: (current: string) => string,
): Effect.Effect<never, HttpFailure, CallServices> {
  return Effect.gen(function* () {
    const error = toConnectorCallError(failure, connection.errors, {
      classification: yield* Classification,
      dispatches: yield* Dispatches,
      withholds: connection.safety.withholdsErrors,
      signal: yield* Signal,
    });
    const reworded = new Refusal({ error: providerFailureMessage(error, message(error.message)) });
    const outcome = googleOutcomeOf(failure);
    return yield* Effect.fail(outcome ? noted(reworded, outcome) : reworded);
  });
}

// --- Tools -------------------------------------------------------------------------

/** A legacy declaration: its catalog bytes, and its program over the call's own context. */
export interface GoogleToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly annotations: NonNullable<ApiTool["annotations"]>;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  /** Fixed write steps; the kit snapshots and freezes them at construction. Absent keeps the single implicit step. */
  readonly writeSteps?: Readonly<Record<string, "once">>;
  readonly run: (args: Record<string, any>, ctx: ConnectorContext) => Effect.Effect<unknown, HttpFailure, CallServices>;
}

/** Arguments arrive validated against the exact legacy `inputSchema` by `api()` before any handler runs. */
const ARGUMENTS = Schema.Record(Schema.String, Schema.Unknown);

/**
 * The step-1 catalog bridge. The tool is a kit `read` or `write` (its
 * lease, write capacity, transport, failure mapping and result safety are
 * the kit's), but its catalog keeps the legacy declaration's bytes:
 * annotations, input and output schemas. `api()` validates every call, from
 * every entry path, against that exact input schema before the handler runs
 * (`callTool` in `src/connectors/api-connector.ts`, fail-closed), so the
 * decoder accepts whatever reaches it and keeps the caller's key order. Step
 * 2 replaces these schemas with Effect declarations (0011).
 */
export function googleTool(connection: Connection, declaration: GoogleToolDeclaration): ApiTool {
  const { annotations } = declaration;
  const spec = {
    name: declaration.name,
    description: declaration.description,
    input: ARGUMENTS,
    output: Schema.Unknown,
    ...(declaration.writeSteps ? { writeSteps: declaration.writeSteps } : {}),
    run: (args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const operation = yield* Effect.serviceOption(Operation);
        const ctx = Option.isSome(operation) ? operation.value : undefined;
        if (!ctx) return yield* Effect.die(new Error(`${declaration.name} needs the call's connector context.`));
        return yield* declaration.run(args, ctx);
      }).pipe(
        // A product's own refusals are thrown ConnectorCallErrors, as on the legacy client.
        Effect.catchDefect((defect) =>
          defect instanceof ConnectorCallError ? Effect.fail(new Refusal({ error: defect })) : Effect.die(defect),
        ),
      ),
  };
  const built =
    annotations.readOnlyHint === true && annotations.destructiveHint !== true
      ? read(connection, spec)
      : write(connection, { ...spec, destructive: annotations.destructiveHint === true });
  return Object.assign(built, {
    annotations: declaration.annotations,
    inputSchema: declaration.inputSchema,
    outputSchema: declaration.outputSchema,
  });
}
