/** Infisical Universal Auth and a finite, reviewed REST secret-manager surface. */
import { apiConnector as api, defined as compact, type ApiTool } from "../../connectors/api-connector.js";
import { guardedFetch, retryAfterMs, type GuardedRequest } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import { keys, optionsOf } from "../../config-schema.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import type { ConnectorContext, JsonSchema } from "../../types.js";
import { requestTokenCache } from "../_shared/request-token.js";
import { skill } from "./skill.generated.js";

export const INFISICAL_API_BASE_URL = "https://app.infisical.com/api";
/** Connecta's response ceiling, before JSON parsing; not an Infisical limit. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export interface InfisicalOptions extends ProviderOptions {
  /** API base including /api; US cloud by default, EU cloud or self-hosted HTTPS allowed. */
  baseUrl?: string;
}
type Json = Record<string, unknown>;
function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Fixed prose only: downstream failures may contain submitted values or credentials. */
function failure(status: number, headers: Headers, login = false): ConnectorCallError {
  const detail = `Infisical returned HTTP ${status}.`;
  const wait = retryAfterMs(headers);
  const retry = wait === undefined ? {} : { retryAfterMs: wait };
  if (status === 429) return new ConnectorCallError("rate_limited", `${detail} Wait before retrying.`, retry);
  if (login && status >= 400 && status < 500)
    return new ConnectorCallError(
      "auth_required",
      `${detail} Infisical refused the machine identity login. An operator must check the client ID, secret, and trusted IPs in this connection.`,
    );
  if (status === 401)
    return new ConnectorCallError(
      "auth_required",
      `${detail} An operator must replace invalid or revoked machine identity credentials in this connection.`,
    );
  if (status === 403)
    return new ConnectorCallError(
      "auth_required",
      `${detail} An operator must add the machine identity to the project or widen its role for this environment and path.`,
    );
  if (status === 404)
    return new ConnectorCallError(
      "not_found",
      `${detail} Confirm the project ID with list_projects, the environment slug, and the path with list_folders.`,
    );
  if ([400, 409, 422].includes(status))
    return new ConnectorCallError("invalid_args", `${detail} Check the named tool's arguments.`);
  if (status >= 500) return new ConnectorCallError("unavailable", `${detail} Infisical is failing upstream.`, retry);
  return new ConnectorCallError("connector_call_failed", detail, { retryable: false });
}

export const infisical = defineProvider<InfisicalOptions>({
  name: "infisical",
  title: "Infisical",
  readme: "Infisical",
  kind: "api",
  skill,
  options: optionsOf<InfisicalOptions>()({ ...PROVIDER_COMMON, ...keys("baseUrl") }),
  bundle: {
    baselineGzip: 27673,
    maxGzip: 87673,
    note: "./providers/infisical starts at 27,673 B gzip (#677): guarded transport, Universal Auth request-local flights and eight named tools, with no MCP client or Effect runtime. The cap uses the measured baseline plus the existing 60,000 B headroom policy.",
  },
  create(id, options, provider) {
    if (options.baseUrl !== undefined && (typeof options.baseUrl !== "string" || !options.baseUrl.trim()))
      throw new Error("baseUrl must be a non-empty absolute HTTPS URL including /api.");
    const baseUrl = options.baseUrl?.trim() ?? INFISICAL_API_BASE_URL;
    const send = guardedFetch({
      provider: "Infisical",
      baseUrl,
      headers: { Accept: "application/json" },
      maxResponseBytes: MAX_RESPONSE_BYTES,
      authenticate: () => ({}),
    });
    async function exchange(clientId: string, clientSecret: string, ctx: ConnectorContext) {
      const issuedAt = Date.now();
      return await send(
        { method: "POST", path: "/v1/auth/universal-auth/login", body: { clientId, clientSecret } },
        ctx,
        async (response) => {
          if (!response.ok) {
            await response.bytes();
            throw failure(response.status, response.headers, true);
          }
          const parsed = await response.jsonResult();
          const body = asRecord("value" in parsed ? parsed.value : undefined);
          const accessToken = body["accessToken"],
            expiresIn = body["expiresIn"];
          if (
            typeof accessToken !== "string" ||
            !/^[\x21-\x7e]+$/.test(accessToken) ||
            typeof expiresIn !== "number" ||
            !Number.isFinite(expiresIn) ||
            expiresIn < 0 ||
            !Number.isSafeInteger(Math.ceil(expiresIn * 1000))
          )
            throw new ConnectorCallError("connector_call_failed", "Infisical returned a malformed login response.", {
              retryable: false,
            });
          const ttl = expiresIn === 0 ? 3_600_000 : expiresIn * 1000;
          return { accessToken, expiresAt: issuedAt + (expiresIn === 0 ? ttl : ttl - Math.min(60_000, ttl / 10)) };
        },
      );
    }
    const tokens = requestTokenCache(async (ctx) => {
      const values = await ctx.credential?.getAll();
      const clientId = values?.["clientId"]?.trim(),
        clientSecret = values?.["clientSecret"]?.trim();
      if (!clientId || !clientSecret)
        throw new ConnectorCallError(
          "auth_required",
          "No Infisical machine identity is configured. Call authorize_connector for recovery options; an operator adds the Universal Auth client ID and secret in this connection.",
        );
      return {
        key: JSON.stringify([clientId, clientSecret]),
        mint: (loginCtx: ConnectorContext) => exchange(clientId, clientSecret, loginCtx),
      };
    });
    const call = async (request: GuardedRequest, ctx: ConnectorContext): Promise<unknown> => {
      try {
        const attempt = (token: string) =>
          send({ ...request, headers: { Authorization: `Bearer ${token}` } }, ctx, async (response) => {
            // Even failures are drained through the bound; their text is never rendered.
            if (!response.ok) {
              await response.bytes();
              return { rejected: response.status === 401, error: failure(response.status, response.headers) };
            }
            const parsed = await response.jsonResult();
            if (!("value" in parsed) && request.method !== "GET") return { rejected: false, value: undefined };
            if (!("value" in parsed))
              throw new ConnectorCallError("connector_call_failed", "Infisical returned malformed JSON.", {
                retryable: false,
              });
            return { rejected: false, value: parsed.value };
          });
        const token = await tokens.token(ctx);
        let result = await attempt(token);
        if (result.rejected) result = await attempt(await tokens.token(ctx, token));
        if (result.error) throw result.error;
        return result.value;
      } catch (error) {
        if (error instanceof ConnectorCallError && error.message.includes("response ceiling"))
          throw new ConnectorCallError(
            "connector_call_failed",
            "Infisical's response exceeded 8 MiB. Narrow secretPath, drop recursive, or omit includeValues.",
            { retryable: false },
          );
        throw error;
      }
    };
    return api(id, {
      ...provider.connectorOptions,
      title: options.title ?? "Infisical",
      description: `Infisical secrets management — ${options.purpose}`,
      credential: {
        label: "Machine identity",
        description: "Universal Auth credentials. Project membership and roles bound this connection's access.",
        fields: [
          { name: "clientId", label: "Client ID", inputType: "text", placeholder: "Universal Auth client ID" },
          { name: "clientSecret", label: "Client secret", inputType: "password", placeholder: "Paste client secret" },
        ],
      },
      async testCredentials(values, ctx) {
        const clientId = values["clientId"]?.trim(),
          clientSecret = values["clientSecret"]?.trim();
        if (!clientId || !clientSecret) return { ok: false, message: "Client ID and client secret are both required." };
        try {
          await exchange(clientId, clientSecret, ctx);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof ConnectorCallError ? error.message : "Infisical login failed.",
          };
        }
      },
      usageGuide: provider.usageGuide({
        context: [`Use this Infisical machine identity at ${baseUrl} for ${options.purpose}.`],
        summary: "Find projects and environments first; secret values are omitted from lists unless requested.",
      }),
      tools: tools(call),
    });
  },
});

function segment(value: string): string {
  if (value === "." || value === "..")
    throw new ConnectorCallError("invalid_args", "A secret key cannot be a URL dot segment.");
  return encodeURIComponent(value);
}

function projectProject(value: unknown): Json {
  const project = asRecord(value);
  return compact({
    id: project["id"],
    name: project["name"],
    slug: project["slug"],
    description: project["description"] || undefined,
    type: project["type"],
    environments: asArray(project["environments"]).map((env) => {
      const record = asRecord(env);
      return compact({ slug: record["slug"], name: record["name"], id: record["id"] });
    }),
    createdAt: project["createdAt"],
    updatedAt: project["updatedAt"],
  });
}

function projectSecret(value: unknown): Json {
  const secret = asRecord(value);
  return compact({
    id: secret["id"],
    key: secret["secretKey"],
    value: secret["secretValueHidden"] === true ? undefined : secret["secretValue"],
    valueHidden: secret["secretValueHidden"] === true ? true : undefined,
    comment: secret["secretComment"] || undefined,
    environment: secret["environment"],
    path: secret["secretPath"],
    type: secret["type"],
    version: secret["version"],
    tags: asArray(secret["tags"])
      .map((tag) => asRecord(tag)["slug"])
      .filter(Boolean),
    updatedAt: secret["updatedAt"],
  });
}

function withoutValues(secret: Json): Json {
  const { value: _value, valueHidden: _hidden, ...rest } = secret;
  return rest;
}

/** Join a folder path and a child name or walk-relative path into an absolute path. */
function joinPath(base: string, rest: string): string {
  const head = base.replace(/\/+$/, "");
  const tail = rest.replace(/^\/+/, "");
  return tail ? `${head}/${tail}` : head || "/";
}

/**
 * Infisical omits a path from flat listings and gives recursive ones a path
 * relative to the listed folder; both become absolute here.
 */
function projectFolder(value: unknown, parent?: string): Json {
  const folder = asRecord(value);
  const name = typeof folder["name"] === "string" ? folder["name"] : undefined;
  const relative = typeof folder["relativePath"] === "string" ? folder["relativePath"] : undefined;
  return compact({
    id: folder["id"],
    name,
    path:
      parent === undefined
        ? folder["path"]
        : relative !== undefined
          ? joinPath(parent, relative)
          : name !== undefined
            ? joinPath(parent, name)
            : undefined,
    description: folder["description"] || undefined,
    updatedAt: folder["updatedAt"],
  });
}

const projectId = { type: "string", minLength: 1, description: "Project ID from list_projects." } as const;
const environment = {
  type: "string",
  minLength: 1,
  description: "Environment slug, e.g. dev, staging, prod. list_projects shows each project's environments.",
} as const;
const secretPath = {
  type: "string",
  pattern: "^/",
  description: "Absolute folder path beginning with /. Defaults to /.",
  default: "/",
} as const;
const secretName = { type: "string", minLength: 1, description: "Secret key, e.g. DATABASE_URL." } as const;
const secretType = {
  type: "string",
  enum: ["shared", "personal"],
  description: "shared (default) or the caller's personal override.",
} as const;

function result(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, additionalProperties: false };
}
const string: JsonSchema = { type: "string" };
const number: JsonSchema = { type: "number" };
const strings: JsonSchema = { type: "array", items: string };
const PROJECT = result({
  id: string,
  name: string,
  slug: string,
  description: string,
  type: string,
  environments: { type: "array", items: result({ slug: string, name: string, id: string }) },
  createdAt: string,
  updatedAt: string,
});
const FOLDER = result({ id: string, name: string, path: string, description: string, updatedAt: string });
const SECRET_METADATA = {
  id: string,
  key: string,
  comment: string,
  environment: string,
  path: string,
  type: string,
  version: number,
  tags: strings,
  updatedAt: string,
};
const SECRET = result({ ...SECRET_METADATA, value: string, valueHidden: { type: "boolean" } });
const SECRET_LIST = { type: "array", items: SECRET };
const APPROVAL = result({ id: string, status: string });
const PROJECTS_RESULT = result({ projects: { type: "array", items: PROJECT } });
const FOLDERS_RESULT = result({ folders: { type: "array", items: FOLDER } });
const SECRETS_RESULT = result({
  secrets: SECRET_LIST,
  imports: { type: "array", items: result({ environment: string, path: string, secrets: SECRET_LIST }) },
});
const SECRET_RESULT = result({ secret: SECRET });
const WRITE_RESULT = result({ secret: result(SECRET_METADATA), pendingApproval: APPROVAL, ok: { type: "boolean" } });
const FOLDER_RESULT = result({ folder: FOLDER, pendingApproval: APPROVAL, ok: { type: "boolean" } });
function tools(call: (request: GuardedRequest, ctx: ConnectorContext) => Promise<unknown>): ApiTool[] {
  return [
    {
      name: "list_projects",
      description: "List Infisical secret-manager projects with their IDs and environment slugs.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      outputSchema: PROJECTS_RESULT,
      annotations: { readOnlyHint: true },
      handler: async (_args: Json, ctx: ConnectorContext) => {
        const payload = await call({ method: "GET", path: "/v1/projects", query: { type: "secret-manager" } }, ctx);
        return { projects: asArray(asRecord(payload)["projects"]).map(projectProject) };
      },
    },
    {
      name: "list_folders",
      description: "List folders in an Infisical project environment at a path.",
      inputSchema: {
        type: "object",
        properties: {
          projectId,
          environment,
          path: secretPath,
          recursive: { type: "boolean", description: "Include every nested folder below path." },
        },
        required: ["projectId", "environment"],
        additionalProperties: false,
      },
      outputSchema: FOLDERS_RESULT,
      annotations: { readOnlyHint: true },
      handler: async (
        args: { projectId: string; environment: string; path?: string; recursive?: boolean },
        ctx: ConnectorContext,
      ) => {
        const payload = await call(
          {
            method: "GET",
            path: "/v2/folders",
            query: {
              projectId: args.projectId,
              environment: args.environment,
              path: args.path ?? "/",
              recursive: args.recursive,
            },
          },
          ctx,
        );
        const parent = args.path ?? "/";
        return { folders: asArray(asRecord(payload)["folders"]).map((folder) => projectFolder(folder, parent)) };
      },
    },
    {
      name: "list_secrets",
      description:
        "List secrets in an Infisical project environment and path. Returns keys and metadata; values only with includeValues.",
      inputSchema: {
        type: "object",
        properties: {
          projectId,
          environment,
          secretPath,
          recursive: { type: "boolean", description: "Include secrets in every nested folder." },
          includeValues: { type: "boolean", description: "Return secret values. Defaults to false." },
          includeImports: {
            type: "boolean",
            description: "Include secrets imported from other paths. Defaults to true.",
          },
          expandReferences: {
            type: "boolean",
            description: "Expand ${env.KEY} references in values. Defaults to true.",
          },
          tagSlugs: { type: "array", items: { type: "string" }, description: "Only secrets with these tag slugs." },
        },
        required: ["projectId", "environment"],
        additionalProperties: false,
      },
      outputSchema: SECRETS_RESULT,
      annotations: { readOnlyHint: true },
      handler: async (
        args: {
          projectId: string;
          environment: string;
          secretPath?: string;
          recursive?: boolean;
          includeValues?: boolean;
          includeImports?: boolean;
          expandReferences?: boolean;
          tagSlugs?: string[];
        },
        ctx: ConnectorContext,
      ) => {
        const includeValues = args.includeValues === true;
        const payload = asRecord(
          await call(
            {
              method: "GET",
              path: "/v4/secrets",
              query: {
                projectId: args.projectId,
                environment: args.environment,
                secretPath: args.secretPath ?? "/",
                recursive: args.recursive,
                viewSecretValue: includeValues,
                expandSecretReferences: includeValues ? (args.expandReferences ?? true) : false,
                includeImports: args.includeImports ?? true,
                tagSlugs: args.tagSlugs?.length ? args.tagSlugs.join(",") : undefined,
              },
            },
            ctx,
          ),
        );
        const shape = (secret: unknown) =>
          includeValues ? projectSecret(secret) : withoutValues(projectSecret(secret));
        const imports = asArray(payload["imports"]).map((entry) => {
          const record = asRecord(entry);
          return compact({
            environment: record["environment"],
            path: record["secretPath"],
            secrets: asArray(record["secrets"]).map(shape),
          });
        });
        return compact({
          secrets: asArray(payload["secrets"]).map(shape),
          imports: imports.length ? imports : undefined,
        });
      },
    },
    {
      name: "get_secret",
      description: "Read one Infisical secret, including its value, by key.",
      inputSchema: {
        type: "object",
        properties: {
          projectId,
          environment,
          secretName,
          secretPath,
          version: { type: "integer", minimum: 1, description: "A past version to read. Omit for the current one." },
          type: secretType,
          expandReferences: { type: "boolean", description: "Expand ${env.KEY} references. Defaults to true." },
        },
        required: ["projectId", "environment", "secretName"],
        additionalProperties: false,
      },
      outputSchema: SECRET_RESULT,
      annotations: { readOnlyHint: true },
      handler: async (
        args: {
          projectId: string;
          environment: string;
          secretName: string;
          secretPath?: string;
          version?: number;
          type?: string;
          expandReferences?: boolean;
        },
        ctx: ConnectorContext,
      ) => {
        const payload = await call(
          {
            method: "GET",
            path: `/v4/secrets/${segment(args.secretName)}`,
            query: {
              projectId: args.projectId,
              environment: args.environment,
              secretPath: args.secretPath ?? "/",
              version: args.version,
              type: args.type,
              expandSecretReferences: args.expandReferences ?? true,
            },
          },
          ctx,
        );
        return { secret: projectSecret(asRecord(payload)["secret"]) };
      },
    },
    {
      name: "create_secret",
      description: "Create a secret in an Infisical project environment and path.",
      inputSchema: {
        type: "object",
        properties: {
          projectId,
          environment,
          secretName,
          secretValue: { type: "string", description: "The value. May reference others as ${env.KEY}." },
          secretPath,
          secretComment: { type: "string", description: "Optional note shown beside the secret." },
          type: secretType,
        },
        required: ["projectId", "environment", "secretName", "secretValue"],
        additionalProperties: false,
      },
      outputSchema: WRITE_RESULT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: async (
        args: {
          projectId: string;
          environment: string;
          secretName: string;
          secretValue: string;
          secretPath?: string;
          secretComment?: string;
          type?: string;
        },
        ctx: ConnectorContext,
      ) => {
        const payload = asRecord(
          await call(
            {
              method: "POST",
              path: `/v4/secrets/${segment(args.secretName)}`,
              body: {
                projectId: args.projectId,
                environment: args.environment,
                secretValue: args.secretValue,
                secretPath: args.secretPath ?? "/",
                secretComment: args.secretComment,
                type: args.type,
              },
            },
            ctx,
          ),
        );
        return writeResult(payload);
      },
    },
    {
      name: "update_secret",
      description: "Update an Infisical secret's value, comment, or name. Only the fields passed change.",
      inputSchema: {
        type: "object",
        properties: {
          projectId,
          environment,
          secretName,
          secretPath,
          secretValue: { type: "string", description: "New value." },
          secretComment: { type: "string", description: "New comment." },
          newSecretName: { type: "string", minLength: 1, description: "Rename the secret to this key." },
          type: secretType,
        },
        required: ["projectId", "environment", "secretName"],
        additionalProperties: false,
      },
      outputSchema: WRITE_RESULT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      handler: async (
        args: {
          projectId: string;
          environment: string;
          secretName: string;
          secretPath?: string;
          secretValue?: string;
          secretComment?: string;
          newSecretName?: string;
          type?: string;
        },
        ctx: ConnectorContext,
      ) => {
        // Checked here rather than with a schema anyOf, which would hide the
        // argument list from discovery.
        if (args.secretValue === undefined && args.secretComment === undefined && args.newSecretName === undefined) {
          throw new ConnectorCallError("invalid_args", "Pass secretValue, secretComment, or newSecretName.");
        }
        const payload = asRecord(
          await call(
            {
              method: "PATCH",
              path: `/v4/secrets/${segment(args.secretName)}`,
              body: {
                projectId: args.projectId,
                environment: args.environment,
                secretPath: args.secretPath ?? "/",
                secretValue: args.secretValue,
                secretComment: args.secretComment,
                newSecretName: args.newSecretName,
                type: args.type,
              },
            },
            ctx,
          ),
        );
        return writeResult(payload);
      },
    },
    {
      name: "delete_secret",
      description: "Delete an Infisical secret from a project environment and path.",
      inputSchema: {
        type: "object",
        properties: { projectId, environment, secretName, secretPath, type: secretType },
        required: ["projectId", "environment", "secretName"],
        additionalProperties: false,
      },
      outputSchema: WRITE_RESULT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      handler: async (
        args: { projectId: string; environment: string; secretName: string; secretPath?: string; type?: string },
        ctx: ConnectorContext,
      ) => {
        const payload = asRecord(
          await call(
            {
              method: "DELETE",
              path: `/v4/secrets/${segment(args.secretName)}`,
              body: {
                projectId: args.projectId,
                environment: args.environment,
                secretPath: args.secretPath ?? "/",
                type: args.type,
              },
            },
            ctx,
          ),
        );
        return writeResult(payload);
      },
    },
    {
      name: "create_folder",
      description: "Create a folder in an Infisical project environment.",
      inputSchema: {
        type: "object",
        properties: {
          projectId,
          environment,
          name: { type: "string", minLength: 1, description: "Folder name." },
          path: { type: "string", pattern: "^/", description: "Absolute parent path beginning with /. Defaults to /." },
          description: { type: "string", description: "Optional folder description." },
        },
        required: ["projectId", "environment", "name"],
        additionalProperties: false,
      },
      outputSchema: FOLDER_RESULT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: async (
        args: { projectId: string; environment: string; name: string; path?: string; description?: string },
        ctx: ConnectorContext,
      ) => {
        const payload = await call(
          {
            method: "POST",
            path: "/v2/folders",
            body: {
              projectId: args.projectId,
              environment: args.environment,
              name: args.name,
              path: args.path ?? "/",
              description: args.description,
            },
          },
          ctx,
        );
        const body = asRecord(payload);
        return body["approval"]
          ? writeResult(body)
          : body["folder"]
            ? { folder: projectFolder(body["folder"], args.path ?? "/") }
            : { ok: true };
      },
    },
  ];
}
/**
 * Writes return the secret, or an approval request when the environment has a
 * change policy. The written value is omitted: the caller supplied it.
 */
function writeResult(payload: Json): Json {
  if (payload["approval"]) {
    const approval = asRecord(payload["approval"]);
    return { pendingApproval: compact({ id: approval["id"], status: approval["status"] }) };
  }
  if (payload["secret"]) return { secret: withoutValues(projectSecret(payload["secret"])) };
  // An unrecognized shape may still carry the value; report success only.
  return { ok: true };
}
