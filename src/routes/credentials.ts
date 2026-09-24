import { Effect } from "effect";
import {
  credentialTestRule,
  describeCredentialTestMismatch,
  storedCredentialShape,
} from "../credential-rules.js";
import type {
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
} from "../types.js";
import {
  authorizedPerson,
  refuse,
  serveOperator,
  visibleRegistry,
  type Answer,
} from "./operator.js";
import {
  mayManageConnector,
  isSameOrigin,
  msg,
  privateJson,
  type RouteContext,
} from "./shared.js";

type CredentialInput =
  | { kind: "single"; value: string }
  | { kind: "multiple"; values: ConnectorCredentialValues };

/** The longest body, in characters, a credential write accepts. */
const MAX_BODY_CHARS = 20_000;

/**
 * The most UTF-8 a body within MAX_BODY_CHARS can take. No UTF-16 unit costs
 * more than three bytes, and a malformed sequence decodes to one U+FFFD per
 * at most three bytes, so a body past this many bytes is past the character
 * limit too — and reading stops there, instead of buffering whatever a client
 * cares to send before measuring it.
 */
const MAX_BODY_BYTES = MAX_BODY_CHARS * 3;

/** The body as text, or undefined once it is longer than MAX_BODY_CHARS. */
async function boundedText(request: Request): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return text.length > MAX_BODY_CHARS ? undefined : text;
}

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
  if (
    !body.values ||
    typeof body.values !== "object" ||
    Array.isArray(body.values)
  ) {
    return refuse("values must be an object", 400);
  }
  const rawValues = body.values as Record<string, unknown>;
  const expected = new Set(config.fields.map((field) => field.name));
  const unexpected = Object.keys(rawValues).find(
    (field) => !expected.has(field),
  );
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
): Effect.Effect<CredentialInput, Answer> {
  return Effect.gen(function* () {
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      return yield* refuse("Content-Type must be application/json", 415);
    }
    const raw = yield* Effect.promise(() => boundedText(request));
    if (raw === undefined) return yield* refuse("request body is too large", 413);
    let body: { value?: unknown; values?: unknown } | null;
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return yield* refuse("invalid JSON body", 400);
    }
    // `null` parses, but a credential cannot be read from it.
    if (body === null) return yield* refuse("invalid JSON body", 400);
    return yield* credentialInput(body, config);
  });
}

function credentialRequest(
  context: RouteContext,
  connectorId: string,
  action: string | undefined,
): Effect.Effect<Response, Answer> {
  const { request, baseUrl, opts } = context;
  return Effect.gen(function* () {
    const vault = opts.credentialVault;
    if (!vault) return yield* refuse("credential storage is not configured", 503);
    if (!isSameOrigin(request, baseUrl)) {
      return yield* refuse("same-origin request required", 403);
    }
    const authz = yield* authorizedPerson(context, "credential management");
    const registry = yield* visibleRegistry(context, authz);

    const connector = registry.getConnector(connectorId);
    const credential = connector?.credential;
    if (!connector || !credential) return yield* refuse("unknown credential slot", 404);
    if (!mayManageConnector(authz, connector)) {
      return yield* refuse("credential management is not permitted", 403);
    }
    const personal = connector.authScope === "personal";
    if (personal && !authz.principalKey) return yield* refuse("forbidden", 403);
    const owner = personal ? authz.principalKey : undefined;
    const updatedBy = authz.identity.principal
      ? `${authz.identity.principal.namespace}:${authz.identity.principal.id}`
      : authz.actor.id ?? authz.actor.kind;

    if (action === "test") {
      if (request.method !== "POST") return yield* refuse("method not allowed", 405);
      // The declared credential shape picks the hook — the same single rule the
      // Credentials page asks for its Test affordance, so a shown button reaches
      // that reads the shape the credential was stored in.
      const { mode, mismatch } = credentialTestRule(connector);
      if (!mode) {
        return yield* refuse(
          mismatch
            ? "this connector cannot test its credential: " +
                describeCredentialTestMismatch(mismatch)
            : "this connector does not support credential testing",
          400,
        );
      }
      // Whatever goes wrong past this point is the test's result, not the
      // route's: the page shows it beside the Test button. Only `ok` leaves
      // the host. A hook's message, and anything it throws, can quote the
      // downstream's reply, and that reply can quote the credential it just
      // rejected — so the text goes to the deployment's log and the page
      // says a fixed sentence for the outcome instead.
      const logged = (ok: boolean, detail: string | undefined) => {
        if (!detail) return;
        const line = `[connecta] connector "${connectorId}" credential test ${ok ? "passed" : "failed"}: ${detail}`;
        if (ok) opts.logger.info(line);
        else opts.logger.warn(line);
      };
      return yield* Effect.tryPromise({
        try: async () => {
          const values = await vault.getAll(connectorId, owner);
          const shape = storedCredentialShape(credential, values);
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
            return privateJson(
              { error: shape.message, problem: "credential_mismatch" },
              { status: 409 },
            );
          }
          const storedValues = values!;
          const ctx = registry.contextFor(connectorId, baseUrl);
          const result =
            mode === "multiple"
              ? await connector.testCredentials!(storedValues, ctx)
              : await connector.testCredential!(
                  // The single-value shape check above guarantees this key.
                  storedValues.value!,
                  ctx,
                );
          const ok = result?.ok === true;
          logged(ok, result?.message);
          return privateJson({ ok });
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          logged(false, msg(error));
          return Effect.succeed(privateJson({ ok: false }));
        }),
      );
    }

    if (action) return yield* refuse("not found", 404);
    if (request.method === "PUT") {
      const input = yield* readCredentialInput(request, credential);
      return yield* Effect.tryPromise({
        try: async () => {
          const metadata =
            input.kind === "single"
              ? await vault.set(connectorId, input.value, updatedBy, owner)
              : await vault.setAll(connectorId, input.values, updatedBy, owner);
          await registry.invalidateStored(connectorId);
          return privateJson({ credential: metadata });
        },
        catch: (error) => error,
      }).pipe(Effect.catch((error) => refuse(msg(error), 400)));
    }
    if (request.method === "DELETE") {
      yield* Effect.promise(() => vault.delete(connectorId, owner));
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

export async function routeCredentials(
  context: RouteContext,
): Promise<Response | null> {
  const match =
    /^\/ui\/credentials\/([a-z0-9_-]+)(?:\/([a-z]+))?$/.exec(context.path);
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
