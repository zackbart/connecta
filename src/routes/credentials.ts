import { failureRecord, logFailure } from "../operator-record.js";
import { Effect } from "effect";
import { claimConnectorScopeCleanup, closeConnectorScope } from "../connector-scope.js";
import { credentialReads } from "../credential-reads.js";
import { credentialTestRule, describeCredentialTestMismatch, storedCredentialShape } from "../credential-rules.js";
import {
  credentialFailureClass,
  credentialTestOutcome,
  writeVerification,
  type CredentialVerification,
} from "../credential-verification.js";
import { requestReads } from "../runtime/request-scope.js";
import { withDeadlineEffect } from "../runtime/run.js";
import type { ConnectorCredentialConfig, ConnectorCredentialValues } from "../types.js";
import { authorizedPerson, refuse, serveOperator, managementRegistry, type Answer } from "./operator.js";
import { boundedText, mayManageConnector, isSameOrigin, msg, privateJson, type RouteContext } from "./shared.js";

type CredentialInput = { kind: "single"; value: string } | { kind: "multiple"; values: ConnectorCredentialValues };

/**
 * How a save treats its value. `test` tests the candidate in memory and
 * stores it only if the test passes; `skip` stores it unverified, which is
 * also what a body without `verify` asks for.
 */
type SaveMode = "test" | "skip";

/** The longest body, in characters, a credential write accepts. */
const MAX_BODY_CHARS = 20_000;

/** Field-by-field checks, in words the Credentials page shows as written. */
function credentialInput(
  body: { value?: unknown; values?: unknown },
  config: ConnectorCredentialConfig,
): Effect.Effect<CredentialInput, Answer> {
  if (!config.fields?.length) {
    if (typeof body.value !== "string" || !body.value.trim()) {
      return refuse("value must be a non-empty string", 400);
    }
    return Effect.succeed({ kind: "single", value: body.value });
  }
  if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
    return refuse("values must be an object", 400);
  }
  const rawValues = body.values as Record<string, unknown>;
  const expected = new Set(config.fields.map((field) => field.name));
  const unexpected = Object.keys(rawValues).find((field) => !expected.has(field));
  if (unexpected) {
    return refuse(`unexpected credential field "${unexpected}"`, 400);
  }
  const values: ConnectorCredentialValues = {};
  for (const field of config.fields) {
    const value = rawValues[field.name];
    if (typeof value !== "string" || !value.trim()) {
      return refuse(`${field.name} must be a non-empty string`, 400);
    }
    values[field.name] = value;
  }
  return Effect.succeed({ kind: "multiple", values });
}

function readCredentialInput(
  request: Request,
  config: ConnectorCredentialConfig,
): Effect.Effect<{ input: CredentialInput; verify: SaveMode }, Answer> {
  return Effect.gen(function* () {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return yield* refuse("Content-Type must be application/json", 415);
    }
    const raw = yield* Effect.promise(() => boundedText(request, MAX_BODY_CHARS));
    if (raw === undefined) return yield* refuse("request body is too large", 413);
    let body: { value?: unknown; values?: unknown; verify?: unknown } | null;
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return yield* refuse("invalid JSON body", 400);
    }
    // `null` parses, but a credential cannot be read from it.
    if (body === null) return yield* refuse("invalid JSON body", 400);
    if (body.verify !== undefined && body.verify !== "test" && body.verify !== "skip") {
      return yield* refuse('verify must be "test" or "skip"', 400);
    }
    const input = yield* credentialInput(body, config);
    return { input, verify: body.verify ?? "skip" };
  });
}

/** The test hook's refusal when the declared shape picks none, in the page's words. */
function untestable(mismatch: ReturnType<typeof credentialTestRule>["mismatch"]): Effect.Effect<never, Answer> {
  return refuse(
    mismatch
      ? "this connector cannot test its credential: " + describeCredentialTestMismatch(mismatch)
      : "this connector does not support credential testing",
    400,
  );
}

function credentialRequest(
  context: RouteContext,
  connectorId: string,
  action: string | undefined,
): Effect.Effect<Response, Answer> {
  const { request, baseUrl, opts } = context;
  return Effect.gen(function* () {
    const vault = opts.config.vault;
    if (!vault) return yield* refuse("credential storage is not configured", 503);
    if (!isSameOrigin(request, baseUrl)) {
      return yield* refuse("same-origin request required", 403);
    }
    const authz = yield* authorizedPerson(context, "credential management");
    const registry = yield* managementRegistry(context, authz);

    const connector = registry.getConnector(connectorId);
    const credential = connector?.credential;
    if (!connector || !credential) return yield* refuse("unknown credential slot", 404);
    if (!mayManageConnector(opts, authz, connector)) {
      return yield* refuse("credential management is not permitted", 403);
    }
    const personal = connector.authScope === "personal";
    if (personal && !authz.principalKey) return yield* refuse("forbidden", 403);
    const owner = personal ? authz.principalKey : undefined;
    const updatedBy = authz.identity.principal
      ? `${authz.identity.principal.namespace}:${authz.identity.principal.id}`
      : (authz.actor.id ?? authz.actor.kind);

    /**
     * Run the connector's test hook on `values` — the stored credential or an
     * unsaved candidate, which stays in this request's memory — under the
     * deployment's probe deadline. Settles to an outcome class and never
     * fails: whatever goes wrong is the test's result, not the route's. Each
     * run gets its own context and request scope, so concurrent tests share
     * no connection.
     *
     * Only the class leaves. A hook's message, and anything it throws, can
     * quote the downstream's reply, and that reply can quote the credential
     * it just rejected — so neither the page nor the log repeats it (INV-6):
     * the page says fixed copy for the class, and the log records a
     * failure's class.
     */
    const runTest = (mode: "single" | "multiple", values: ConnectorCredentialValues) => {
      const timeoutError = new Error("credential test timed out");
      return withDeadlineEffect(
        (signal) =>
          Effect.tryPromise({
            try: async () => {
              const ctx = registry.contextFor(connectorId, baseUrl, {}, { signal });
              const releaseCleanup = claimConnectorScopeCleanup(ctx, connectorId);
              try {
                const result =
                  mode === "multiple"
                    ? await connector.testCredentials!(values, ctx)
                    : // The single-value shape guarantees this key.
                      await connector.testCredential!(values.value!, ctx);
                // A hook that turned the deadline's abort into a result still ran out of time.
                return signal.reason === timeoutError ? "timeout" : credentialTestOutcome(result);
              } finally {
                releaseCleanup();
                await closeConnectorScope(connector, ctx, context.defer);
              }
            },
            catch: (error) => (signal.reason === timeoutError ? timeoutError : error),
          }),
        { timeoutMs: opts.config.discovery.probeTimeoutMs, timeoutError },
      ).pipe(
        Effect.catch((error) => {
          if (error === timeoutError) return Effect.succeed("timeout" as const);
          logFailure(opts.config.logger, "credential test threw", failureRecord({ connector: connectorId }, error));
          return Effect.succeed(credentialFailureClass(error));
        }),
        Effect.map((outcome) => {
          if (outcome !== "ok")
            logFailure(opts.config.logger, "credential test failed", failureRecord({ connector: connectorId }));
          return outcome;
        }),
      );
    };
    /**
     * Record what was observed about the credential stored at `updatedAt`,
     * or (`null`) forget it, in the connector's own owner-partitioned
     * storage. Best effort: a lost record only leaves status saying the
     * credential is not verified, so it never fails the request.
     */
    const record = (outcome: CredentialVerification["outcome"] | null, updatedAt?: string) =>
      Effect.promise(() =>
        writeVerification(registry.contextFor(connectorId, baseUrl).storage, outcome, updatedAt).catch(
          (error: unknown) =>
            void logFailure(
              opts.config.logger,
              "credential verification record failed",
              failureRecord({ connector: connectorId }, error),
            ),
        ),
      );

    if (action === "test") {
      if (request.method !== "POST") return yield* refuse("method not allowed", 405);
      // The declared credential shape picks the hook — the same single rule the
      // Credentials page asks for its Test affordance, so a shown button reaches
      // that reads the shape the credential was stored in.
      const { mode, mismatch } = credentialTestRule(connector);
      if (!mode) return yield* untestable(mismatch);
      // One envelope read gives both the values tested and the save they
      // came from, so the record can never vouch for a later replacement.
      const reads = credentialReads(vault, requestReads({}));
      const stored = yield* Effect.tryPromise({
        try: async () => ({
          values: await reads.getAll(connectorId, owner),
          metadata: await reads.metadata(connectorId, owner),
        }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          logFailure(opts.config.logger, "credential test threw", failureRecord({ connector: connectorId }, error));
          return Effect.succeed(undefined);
        }),
      );
      if (!stored) return privateJson({ ok: false, failure: "failed" });
      const shape = storedCredentialShape(credential, stored.values);
      // Both refusals are the route's own words, and each carries the
      // problem kind the page keys its copy and fix prompt off.
      if (shape.state === "missing") {
        return privateJson(
          {
            error:
              mode === "multiple"
                ? "configure the credentials before testing them"
                : "configure the credential before testing it",
            problem: "credential_required",
          },
          { status: 409 },
        );
      }
      if (shape.state === "mismatch") {
        return privateJson({ error: shape.message, problem: "credential_mismatch" }, { status: 409 });
      }
      const outcome = yield* runTest(mode, stored.values!);
      if (stored.metadata) yield* record(outcome, stored.metadata.updatedAt);
      return privateJson(outcome === "ok" ? { ok: true } : { ok: false, failure: outcome });
    }

    if (action) return yield* refuse("not found", 404);
    if (request.method === "PUT") {
      const { input, verify } = yield* readCredentialInput(request, credential);
      const values: ConnectorCredentialValues = input.kind === "single" ? { value: input.value } : input.values;
      if (verify === "test") {
        // Test then save: the candidate is tested in memory and stored only
        // if the test passes. A failure stores nothing and names its class;
        // the operator may still save it unverified with `verify: "skip"`,
        // so an outage at the vendor never blocks a replacement.
        const { mode, mismatch } = credentialTestRule(connector);
        if (!mode) return yield* untestable(mismatch);
        const outcome = yield* runTest(mode, values);
        if (outcome !== "ok") return privateJson({ saved: false, failure: outcome });
      }
      const metadata = yield* Effect.tryPromise({
        try: () =>
          input.kind === "single"
            ? vault.set(connectorId, input.value, updatedBy, owner)
            : vault.setAll(connectorId, input.values, updatedBy, owner),
        catch: (error) => error,
      }).pipe(Effect.catch((error) => refuse(msg(error), 400)));
      const verification = yield* record(verify === "test" ? "ok" : "unverified", metadata.updatedAt);
      yield* Effect.promise(() => registry.invalidateStored(connectorId));
      return privateJson({ saved: true, credential: metadata, ...(verification ? { verification } : {}) });
    }
    if (request.method === "DELETE") {
      // Clearing nothing is refused, as testing nothing is, so the route
      // agrees with the operator contract, which offers `clear` only once a
      // value is stored in the caller's partition. A value that cannot
      // be read may still be cleared: removing it is how one recovers.
      const stored = yield* Effect.tryPromise({
        try: () => vault.metadata(connectorId, owner),
        catch: (error) => error,
      }).pipe(Effect.orElseSucceed(() => "unreadable" as const));
      if (stored === null) {
        return privateJson(
          { error: "no credential is stored to clear", problem: "credential_required" },
          { status: 409 },
        );
      }
      yield* Effect.promise(() => vault.delete(connectorId, owner));
      // A record about a value no longer stored would match nothing anyway;
      // removing it keeps the partition clean.
      yield* record(null);
      yield* Effect.promise(() => registry.invalidateStored(connectorId));
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    return yield* refuse("method not allowed", 405);
  });
}

export async function routeCredentials(context: RouteContext): Promise<Response | null> {
  const match = /^\/ui\/credentials\/([a-z0-9_-]+)(?:\/([a-z]+))?$/.exec(context.path);
  if (!match) return null;
  const connectorId = match[1];
  if (!connectorId) return null;
  // Never opt these mutation routes into the server's wildcard CORS
  // preflight behavior.
  if (context.request.method === "OPTIONS") {
    return privateJson({ error: "method not allowed" }, { status: 405 });
  }
  // No signal: a write that has started runs through to its invalidation.
  return serveOperator(credentialRequest(context, connectorId, match[2]));
}
