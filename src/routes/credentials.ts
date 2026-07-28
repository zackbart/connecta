import {
  credentialTestRule,
  describeCredentialTestMismatch,
  storedCredentialShape,
} from "../credentials.js";
import type {
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
} from "../types.js";
import {
  authorizeUiAdmin,
  isSameOrigin,
  msg,
  privateJson,
  type RouteContext,
} from "./shared.js";

type CredentialInput =
  | { kind: "single"; value: string }
  | { kind: "multiple"; values: ConnectorCredentialValues };

async function readCredentialInput(
  request: Request,
  config: ConnectorCredentialConfig,
): Promise<
  { ok: true; input: CredentialInput } | { ok: false; response: Response }
> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return {
      ok: false,
      response: privateJson(
        { error: "Content-Type must be application/json" },
        { status: 415 },
      ),
    };
  }
  const raw = await request.text();
  if (raw.length > 20_000) {
    return {
      ok: false,
      response: privateJson(
        { error: "request body is too large" },
        { status: 413 },
      ),
    };
  }
  try {
    const body = JSON.parse(raw) as {
      value?: unknown;
      values?: unknown;
    };
    if (!config.fields?.length) {
      if (typeof body.value !== "string" || !body.value.trim()) {
        return {
          ok: false,
          response: privateJson(
            { error: "value must be a non-empty string" },
            { status: 400 },
          ),
        };
      }
      return { ok: true, input: { kind: "single", value: body.value } };
    }
    if (
      !body.values ||
      typeof body.values !== "object" ||
      Array.isArray(body.values)
    ) {
      return {
        ok: false,
        response: privateJson(
          { error: "values must be an object" },
          { status: 400 },
        ),
      };
    }
    const rawValues = body.values as Record<string, unknown>;
    const expected = new Set(config.fields.map((field) => field.name));
    const unexpected = Object.keys(rawValues).find(
      (field) => !expected.has(field),
    );
    if (unexpected) {
      return {
        ok: false,
        response: privateJson(
          { error: `unexpected credential field "${unexpected}"` },
          { status: 400 },
        ),
      };
    }
    const values: ConnectorCredentialValues = {};
    for (const field of config.fields) {
      const value = rawValues[field.name];
      if (typeof value !== "string" || !value.trim()) {
        return {
          ok: false,
          response: privateJson(
            { error: `${field.name} must be a non-empty string` },
            { status: 400 },
          ),
        };
      }
      values[field.name] = value;
    }
    return { ok: true, input: { kind: "multiple", values } };
  } catch {
    return {
      ok: false,
      response: privateJson({ error: "invalid JSON body" }, { status: 400 }),
    };
  }
}

async function handleCredentialRequest(
  context: RouteContext,
  connectorId: string,
  action: string | undefined,
): Promise<Response> {
  const { request, baseUrl, opts } = context;
  if (!opts.credentialVault) {
    return privateJson(
      { error: "credential storage is not configured" },
      { status: 503 },
    );
  }
  if (!isSameOrigin(request, baseUrl)) {
    return privateJson(
      { error: "same-origin request required" },
      { status: 403 },
    );
  }
  const admin = await authorizeUiAdmin(
    request,
    baseUrl,
    opts.auth,
    opts.logger,
  );
  if (!admin.ok) return admin.response;

  const connector = opts.registry.getConnector(connectorId);
  if (!connector?.credential) {
    return privateJson({ error: "unknown credential slot" }, { status: 404 });
  }

  if (action === "test") {
    if (request.method !== "POST") {
      return privateJson({ error: "method not allowed" }, { status: 405 });
    }
    // The declared credential shape picks the hook — the same single rule the
    // Credentials page asks for its Test affordance, so a shown button reaches
    // that reads the shape the credential was stored in.
    const rule = credentialTestRule(connector);
    if (!rule.mode) {
      return privateJson(
        {
          error: rule.mismatch
            ? "this connector cannot test its credential: " +
              describeCredentialTestMismatch(rule.mismatch)
            : "this connector does not support credential testing",
        },
        { status: 400 },
      );
    }
    try {
      const values = await opts.credentialVault.getAll(connectorId);
      const shape = storedCredentialShape(connector.credential, values);
      if (shape.state === "missing") {
        return privateJson(
          {
            error:
              rule.mode === "multiple"
                ? "configure the credentials before testing them"
                : "configure the credential before testing it",
          },
          { status: 409 },
        );
      }
      if (shape.state === "mismatch") {
        return privateJson({ error: shape.message }, { status: 409 });
      }
      const storedValues = values!;
      const ctx = opts.registry.contextFor(connectorId, baseUrl);
      const result =
        rule.mode === "multiple"
          ? await connector.testCredentials!(storedValues, ctx)
          : await connector.testCredential!(
              // The single-value shape check above guarantees this key.
              storedValues.value!,
              ctx,
            );
      return privateJson(result);
    } catch (err) {
      return privateJson({ ok: false, message: msg(err) });
    }
  }

  if (action) {
    return privateJson({ error: "not found" }, { status: 404 });
  }
  if (request.method === "PUT") {
    const input = await readCredentialInput(request, connector.credential);
    if (!input.ok) return input.response;
    try {
      const metadata =
        input.input.kind === "single"
          ? await opts.credentialVault.set(
              connectorId,
              input.input.value,
              admin.userId,
            )
          : await opts.credentialVault.setAll(
              connectorId,
              input.input.values,
              admin.userId,
            );
      await opts.registry.invalidateStored(connectorId);
      return privateJson({ credential: metadata });
    } catch (err) {
      return privateJson({ error: msg(err) }, { status: 400 });
    }
  }
  if (request.method === "DELETE") {
    await opts.credentialVault.delete(connectorId);
    await opts.registry.invalidateStored(connectorId);
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  return privateJson({ error: "method not allowed" }, { status: 405 });
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
  return handleCredentialRequest(context, connectorId, match[2]);
}
