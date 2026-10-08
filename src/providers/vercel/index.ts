import { skill } from "./skill.generated.js";
import { HOSTED_REST_OPERATIONS, UNCOVERED_REST_OPERATIONS } from "./mcp-ownership.js";
/**
 * No `@vercel/sdk` on purpose — not a dependency and not an optional peer.
 * Direct fetch keeps the root Workers-safe, avoids shipping the SDK's generated
 * model graph, and lets the reviewed named operations and the REST hatches share
 * one guarded transport. The trade is API drift, handled explicitly rather than
 * by the SDK's version bumps: `src/providers/vercel/drift.json` records the
 * method, versioned path, spec revision, and request/response digest for every
 * fixed endpoint, and `npm run providers:check -- --provider vercel` compares
 * those rows with Vercel's published OpenAPI document at
 * https://openapi.vercel.sh/ without needing a credential.
 */
import { apiConnector as api, type ApiTool } from "../../connectors/api-connector.js";
import { remoteMcp } from "../../connectors/remote-mcp.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type {
  Connector,
  ToolClassification,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  JsonSchema,
} from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineProvider, type ProviderContext } from "../../provider.js";

/** Vercel's public REST origin. Override only for a proxy or test double. */
export const VERCEL_API_BASE_URL = "https://api.vercel.com";
/** Vercel's official hosted MCP endpoint. */
export const VERCEL_MCP_ENDPOINT = "https://mcp.vercel.com";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const VERCEL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface VercelCommonOptions {
  /** Human-readable display name; defaults identify the selected surface. */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which Vercel account or team this connection operates, and for whom. */
  purpose: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
}

/** Connecta's maintained hand-written Vercel REST surface. */
export interface VercelApiOptions extends VercelCommonOptions {
  /** Select the REST complement explicitly; hosted MCP is the default. */
  surface: "api";
  /** Default team id for scoped calls. Omit to use the token's personal account. */
  teamId?: string;
  /** API base override for a proxy or test double. */
  baseUrl?: string;
  /** @deprecated List pagination is owned by hosted MCP. Retained for configuration compatibility; no effect on the REST complement. */
  defaultPageSize?: number;
}

/** Vercel's official hosted MCP surface, authenticated through OAuth. */
export interface VercelMcpOptions extends VercelCommonOptions {
  surface?: "mcp";
}

/** Backward-compatible API options; existing consumers may extend this interface. */
export interface VercelOptions extends VercelApiOptions {}

/** Select one Vercel surface when deployment configuration constructs it. */
export type VercelConnectionOptions = VercelOptions | VercelMcpOptions;

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function detailFor(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const error = asRecord(root["error"]);
  const code = typeof error["code"] === "string" ? error["code"] : undefined;
  const message =
    typeof error["message"] === "string" && error["message"].trim()
      ? error["message"].trim()
      : typeof root["message"] === "string" && root["message"].trim()
        ? root["message"].trim()
        : `Vercel returned HTTP ${status}.`;
  return code ? `Vercel ${code}: ${message}` : message;
}

function resetAfterMs(headers: Headers): number | undefined {
  const retryAfter = retryAfterMs(headers);
  if (retryAfter !== undefined) return retryAfter;
  const raw = headers.get("x-ratelimit-reset");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, Math.trunc(seconds * 1_000 - Date.now()));
}

/** Map Vercel failures by the caller's useful next move. */
function vercelFailure(status: number, headers: Headers, payload: unknown): ConnectorCallError {
  const detail = detailFor(payload, status);
  if (status === 429) {
    const wait = resetAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `${detail} Vercel meters endpoints separately; wait for the reported reset before retrying this operation.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} The configured access token is invalid, expired, outside this team, or lacks the required scope. An operator must replace it or widen its Vercel scope.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} Vercel refused access to this team or resource. Ask the team administrator to grant access and an operator to widen the configured token's Vercel scope.`,
    );
  }
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
      `${detail} Confirm the project, deployment, domain, or environment-variable id with its list tool.`,
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return new ConnectorCallError("invalid_args", detail);
  }
  if (status >= 500) {
    const wait = resetAfterMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `${detail} Vercel is failing upstream.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError("connector_call_failed", detail, {
    retryable: false,
  });
}

function parseBody(text: string, contentType: string | null, strict = false): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    if (contentType?.includes("stream+json") || contentType?.includes("ndjson")) {
      if (strict) return parseStreamRows(text);
      const rows: unknown[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          rows.push({ message: line });
        }
      }
      return rows;
    }
    if (strict) {
      throw new ConnectorCallError("connector_call_failed", "Vercel returned a malformed successful response.", {
        retryable: false,
      });
    }
    return text;
  }
}

function parseStreamRows(text: string): unknown[] {
  if (!text.trim()) return [];
  try {
    const payload = JSON.parse(text);
    return Array.isArray(payload) ? payload : [payload];
  } catch {
    const rows: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        throw new ConnectorCallError("connector_call_failed", "Vercel returned a malformed runtime-log stream.", {
          retryable: false,
        });
      }
    }
    return rows;
  }
}

function vercelTransport(baseUrl: string): GuardedTransport {
  return guardedFetch({
    provider: "Vercel",
    baseUrl,
    headers: { Accept: "application/json" },
    maxResponseBytes: VERCEL_MAX_RESPONSE_BYTES,
    authenticate: async (ctx) => {
      const token = (await ctx.credential?.get())?.trim();
      if (!token) {
        throw new ConnectorCallError(
          "auth_required",
          "No Vercel access token is configured for this connector. Call authorize_connector for recovery options. When available, an operator can add the token in this connection in the operator UI.",
        );
      }
      return { Authorization: `Bearer ${token}` };
    },
  });
}

async function callVercel(
  send: GuardedTransport,
  request: GuardedRequest,
  ctx: ConnectorContext,
  success: { parse?: (text: string) => unknown; raw?: boolean } = {},
): Promise<any> {
  return await send(request, ctx, async (response) => {
    const text = await response.text();
    if (!response.ok) {
      throw vercelFailure(response.status, response.headers, parseBody(text, response.headers.get("content-type")));
    }
    return success.parse ? success.parse(text) : parseBody(text, response.headers.get("content-type"), !success.raw);
  });
}

function teamQuery(
  args: JsonRecord,
  defaultTeamId: string | undefined,
): Record<string, string | number | boolean | undefined> {
  return {
    teamId: args["teamId"] === null ? undefined : (args["teamId"] ?? defaultTeamId),
  };
}

function projectDomain(value: unknown): JsonRecord {
  const domain = asRecord(value);
  return compact({
    name: domain["name"],
    apexName: domain["apexName"],
    projectId: domain["projectId"],
    verified: domain["verified"] === true,
    verification: domain["verification"],
    redirect: domain["redirect"],
    redirectStatusCode: domain["redirectStatusCode"],
    gitBranch: domain["gitBranch"],
    customEnvironmentId: domain["customEnvironmentId"],
    createdAt: domain["createdAt"],
    updatedAt: domain["updatedAt"],
  });
}

/** Deliberately omits `value`, even if a raw Vercel response happens to carry it. */
function projectEnvironmentVariable(value: unknown): JsonRecord {
  const variable = asRecord(value);
  return compact({
    id: variable["id"],
    key: variable["key"],
    type: variable["type"],
    visibility: variable["visibility"],
    target: variable["target"],
    gitBranch: variable["gitBranch"],
    customEnvironmentIds: variable["customEnvironmentIds"],
    comment: variable["comment"],
    createdAt: variable["createdAt"],
    updatedAt: variable["updatedAt"],
  });
}

const TEAM_ID_PROPERTY: JsonSchema = {
  type: ["string", "null"],
  minLength: 1,
  description: "Vercel team id. Omit for the configured default; pass null for the token owner's personal account.",
};

const PROJECT_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Project id or project name from list_projects.",
};

const DEPLOYMENT_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Deployment id from list_deployments.",
};

const DOMAIN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    apexName: { type: "string" },
    projectId: { type: "string" },
    verified: { type: "boolean" },
    verification: { type: "array" },
    redirect: { type: ["string", "null"] },
    redirectStatusCode: { type: ["integer", "null"] },
    gitBranch: { type: ["string", "null"] },
    customEnvironmentId: { type: ["string", "null"] },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["name", "projectId", "verified"],
};

const ENV_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    type: { type: "string" },
    visibility: { type: "string" },
    target: { type: ["array", "string"], items: { type: "string" } },
    gitBranch: { type: ["string", "null"] },
    customEnvironmentIds: { type: "array", items: { type: "string" } },
    comment: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["id", "key", "type"],
};

function namedInput(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function queryPairs(value: unknown): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  for (const row of asArray(value)) {
    const pair = asRecord(row);
    if (typeof pair["name"] !== "string") continue;
    const item = pair["value"];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      query[pair["name"]] = item;
    }
  }
  return query;
}

const QUERY_PROPERTY: JsonSchema = {
  type: "array",
  description: "Provider query parameters as name/value pairs.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "Query parameter name." },
      value: {
        type: ["string", "number", "boolean"],
        description: "Query parameter value; guarded transport stringifies it once.",
      },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

const HEADERS_PROPERTY: JsonSchema = {
  type: "array",
  description:
    "Endpoint-specific request headers. Credential, cookie, host, framing, and content-type headers are connector-owned.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "HTTP header name." },
      value: { type: "string", description: "HTTP header value." },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

const FORBIDDEN_HATCH_HEADERS = new Set([
  "authorization",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "transfer-encoding",
]);

function headerPairs(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of asArray(value)) {
    const pair = asRecord(row);
    if (typeof pair["name"] === "string" && typeof pair["value"] === "string") {
      const normalized = pair["name"].trim().toLowerCase();
      if (FORBIDDEN_HATCH_HEADERS.has(normalized)) {
        throw new ConnectorCallError(
          "invalid_args",
          `A Vercel upload may not set the ${normalized} header; the connector owns credentials, cookies, origin, framing, and content type.`,
        );
      }
      headers[pair["name"]] = pair["value"];
    }
  }
  return headers;
}

function uploadBody(args: JsonRecord): Uint8Array | string {
  const hasText = typeof args["textBody"] === "string";
  const hasBase64 = typeof args["base64Body"] === "string";
  if (hasText === hasBase64) {
    throw new ConnectorCallError("invalid_args", "Provide exactly one of textBody or base64Body for a Vercel upload.");
  }
  if (hasText) return args["textBody"];
  try {
    return Uint8Array.from(atob(args["base64Body"]), (character) => character.charCodeAt(0));
  } catch {
    throw new ConnectorCallError("invalid_args", "base64Body is not valid base64.");
  }
}

function rawRequest(args: JsonRecord, defaultTeamId: string | undefined): Pick<GuardedRequest, "path" | "query"> {
  const method = args["method"] ?? "GET";
  let path: string;
  try {
    path = decodeURIComponent(new URL(`https://api.vercel.com${String(args["path"])}`).pathname).replace(
      /\/{2,}/g,
      "/",
    );
  } catch {
    throw new ConnectorCallError("invalid_args", "The REST path contains an invalid escape or URL.");
  }
  const matches = ([verb, pattern]: readonly [string, RegExp, string | null]) => verb === method && pattern.test(path);
  const canonical = VERCEL_EXACT_CANONICAL_ROUTES.find(matches) ?? VERCEL_CANONICAL_ROUTES.find(matches);
  if (canonical?.[2]) {
    throw new ConnectorCallError(
      "invalid_args",
      `Use ${canonical[2]} on its owning connector. The REST complement cannot repeat that operation.`,
    );
  }
  const query = queryPairs(args["query"]);
  if (args["personalAccount"] === true && (query["teamId"] !== undefined || query["slug"] !== undefined)) {
    throw new ConnectorCallError(
      "invalid_args",
      "personalAccount cannot be combined with a teamId or slug query parameter.",
    );
  }
  if (
    args["personalAccount"] !== true &&
    defaultTeamId &&
    query["teamId"] === undefined &&
    query["slug"] === undefined
  ) {
    query["teamId"] = defaultTeamId;
  }
  return { path: String(args["path"]), query };
}

function hostedRestRoute(
  [method, path, name]: readonly [string, string, string],
  anyVersion: boolean,
): [string, RegExp, string] {
  const pattern = path
    .replace(/\/+$/, "")
    .split("/")
    .map((segment, index) => {
      if (anyVersion && index === 1 && /^v\d+$/.test(segment)) return "v\\d+";
      if (/^\{[^}]+\}$/.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return [method, new RegExp(`^${pattern}\\/?$`), `MCP ${name}`];
}

// Resolve actual published method/path/version contracts first, including
// uncovered concrete endpoints. An id wildcard cannot consume a REST gap.
const VERCEL_EXACT_CANONICAL_ROUTES: readonly [string, RegExp, string | null][] = [
  ...UNCOVERED_REST_OPERATIONS.map(([method, path]): [string, RegExp, null] => [
    method,
    hostedRestRoute([method, path, ""], false)[1],
    null,
  ]),
  ...HOSTED_REST_OPERATIONS.map((operation) => hostedRestRoute(operation, false)),
];

// Version-independent matches keep a raw hatch from restoring a removed
// duplicate by selecting an older REST version. Env routes also protect the
// value-safe named API implementations from an unprojected response.
const VERCEL_CANONICAL_ROUTES: readonly [string, RegExp, string][] = [
  // Specific published routes precede generic id patterns (e.g. projects/traces).
  ...HOSTED_REST_OPERATIONS.map((operation) => hostedRestRoute(operation, true)),
  ["GET", /^\/v\d+\/teams\/?$/, "MCP list_teams"],
  ["GET", /^\/v\d+\/projects\/?$/, "MCP list_projects"],
  ["GET", /^\/v\d+\/projects\/[^/]+\/?$/, "MCP get_project"],
  ["GET", /^\/v\d+\/deployments\/?$/, "MCP list_deployments"],
  ["GET", /^\/v\d+\/deployments\/[^/]+\/?$/, "MCP get_deployment"],
  ["GET", /^\/v\d+\/deployments\/[^/]+\/events\/?$/, "MCP get_deployment_build_logs or list_deployment_events"],
  ["GET", /^\/v\d+\/projects\/[^/]+\/deployments\/[^/]+\/runtime-logs\/?$/, "MCP get_runtime_logs"],
  ["GET", /^\/v\d+\/projects\/[^/]+\/domains\/?$/, "MCP list_project_domains"],
  ["POST", /^\/v\d+\/projects\/[^/]+\/domains\/?$/, "MCP add_project_domain"],
  ["PATCH", /^\/v\d+\/deployments\/[^/]+\/cancel\/?$/, "MCP cancel_deployment"],
  ["POST", /^\/v\d+\/files\/?$/, "MCP upload_file"],
  ["POST", /^\/v\d+\/deployments\/?$/, "MCP create_deployment"],
  ["DELETE", /^\/v\d+\/deployments\/[^/]+\/?$/, "API delete_deployment"],
  ["POST", /^\/v\d+\/projects\/[^/]+\/promote\/[^/]+\/?$/, "MCP request_promote"],
  ["POST", /^\/v\d+\/projects\/[^/]+\/domains\/[^/]+\/verify\/?$/, "API verify_project_domain"],
  ["DELETE", /^\/v\d+\/projects\/[^/]+\/domains\/[^/]+\/?$/, "API remove_project_domain"],
  ["GET", /^\/v\d+\/projects\/[^/]+\/env(?:\/[^/]+)?\/?$/, "API list_project_env_vars"],
  ["POST", /^\/v\d+\/projects\/[^/]+\/env\/?$/, "API upsert_project_env_var"],
  ["PATCH", /^\/v\d+\/projects\/[^/]+\/env\/[^/]+\/?$/, "API update_project_env_var"],
  ["DELETE", /^\/v\d+\/projects\/[^/]+\/env\/[^/]+\/?$/, "API delete_project_env_var"],
];

const API_OWNED_MCP_TOOLS = new Set([
  "filter_project_envs",
  "get_project_env",
  "create_project_env",
  "edit_project_env",
]);

/** Preserve vendor contracts for retained tools and refuse hidden direct calls. */
function vercelCatalog(connector: Connector): Connector {
  return Object.assign(Object.create(connector) as Connector, connector, {
    async listTools(ctx: ConnectorContext) {
      const tools = (await connector.listTools(ctx)).filter((tool) => !API_OWNED_MCP_TOOLS.has(tool.name));
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
        throw new ConnectorCallError("connector_call_failed", "Vercel returned duplicate tool names.", {
          retryable: false,
        });
      }
      return tools;
    },
    async callTool(name: string, args: unknown, ctx: ConnectorContext, options?: Parameters<Connector["callTool"]>[3]) {
      if (API_OWNED_MCP_TOOLS.has(name)) {
        throw new ConnectorCallError(
          "invalid_args",
          "Project environment variables belong to the value-safe Vercel REST complement.",
        );
      }
      return await connector.callTool(name, args, ctx, options);
    },
  });
}

const PERSONAL_ACCOUNT_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "True omits the configured default team. Do not combine with a teamId or slug query parameter.",
};

function tools(send: GuardedTransport, defaultTeamId: string | undefined): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true } as const;
  const team = (args: JsonRecord) => teamQuery(args, defaultTeamId);
  return [
    {
      name: "vercel_api_get",
      description:
        "Call any Vercel REST GET endpoint and return its untouched response. Use named reads first for smaller results and stable projections.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          path: {
            type: "string",
            minLength: 1,
            description: "Path below api.vercel.com beginning with '/', including its API version. No query string.",
          },
          query: QUERY_PROPERTY,
          personalAccount: PERSONAL_ACCOUNT_PROPERTY,
        },
        ["path"],
      ),
      outputSchema: {
        type: "object",
        properties: { result: { description: "Vercel's untouched response body." } },
        required: ["result"],
      },
      handler: async (args, ctx) => ({
        result:
          (await callVercel(send, { method: "GET", ...rawRequest(args, defaultTeamId) }, ctx, { raw: true })) ?? null,
      }),
    },
    {
      name: "vercel_api_mutate",
      description:
        "Call any JSON Vercel REST mutation endpoint. The approval-gated hatch for API operations the named tools do not cover; no file uploads.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          method: {
            type: "string",
            enum: ["POST", "PUT", "PATCH", "DELETE"],
            description: "HTTP mutation method required by the Vercel endpoint.",
          },
          path: {
            type: "string",
            minLength: 1,
            description: "Path below api.vercel.com beginning with '/', including its API version. No query string.",
          },
          query: QUERY_PROPERTY,
          personalAccount: PERSONAL_ACCOUNT_PROPERTY,
          body: {
            type: ["object", "array", "string", "number", "boolean", "null"],
            description: "JSON body exactly as documented by Vercel. Omit when the endpoint has no body.",
          },
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: { result: { description: "Vercel's untouched response body, or null for an empty response." } },
        required: ["result"],
      },
      handler: async (args, ctx) => ({
        result:
          (await callVercel(
            send,
            {
              method: args["method"],
              ...rawRequest(args, defaultTeamId),
              ...(args["body"] !== undefined ? { body: args["body"] } : {}),
            },
            ctx,
            { raw: true },
          )) ?? null,
      }),
    },
    {
      name: "vercel_api_upload",
      description:
        "Upload explicit text or base64 bytes to a Vercel POST or PUT endpoint. Covers deployment files and other raw-body APIs; reads no local files.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          method: {
            type: "string",
            enum: ["POST", "PUT"],
            description: "Upload method required by the Vercel endpoint.",
          },
          path: {
            type: "string",
            minLength: 1,
            description: "Path below api.vercel.com beginning with '/', including its API version. No query string.",
          },
          query: QUERY_PROPERTY,
          personalAccount: PERSONAL_ACCOUNT_PROPERTY,
          headers: HEADERS_PROPERTY,
          contentType: {
            type: "string",
            minLength: 1,
            description: "Content-Type for the raw body, such as application/octet-stream.",
          },
          textBody: {
            type: "string",
            description: "Raw UTF-8 body. Exclusive with base64Body.",
          },
          base64Body: {
            type: "string",
            description: "Base64-encoded bytes. Exclusive with textBody.",
          },
        },
        ["method", "path", "contentType"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          result: {
            description: "Vercel's untouched upload response body, or null for an empty response.",
          },
        },
        required: ["result"],
      },
      handler: async (args, ctx) => ({
        result:
          (await callVercel(
            send,
            {
              method: args["method"],
              ...rawRequest(args, defaultTeamId),
              headers: {
                ...headerPairs(args["headers"]),
                "Content-Type": args["contentType"],
              },
              rawBody: uploadBody(args),
            },
            ctx,
            { raw: true },
          )) ?? null,
      }),
    },
    {
      name: "verify_project_domain",
      description:
        "Ask Vercel to verify a project's pending domain after its DNS challenge has been completed. Returns the current domain state.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY,
          domain: { type: "string", minLength: 1, description: "Pending domain name from list_project_domains." },
          teamId: TEAM_ID_PROPERTY,
        },
        ["projectId", "domain"],
      ),
      outputSchema: DOMAIN_SCHEMA,
      handler: async (args, ctx) =>
        projectDomain(
          await callVercel(
            send,
            {
              method: "POST",
              path: `/v9/projects/${encodeURIComponent(args["projectId"])}/domains/${encodeURIComponent(args["domain"])}/verify`,
              query: team(args),
            },
            ctx,
          ),
        ),
    },
    {
      name: "remove_project_domain",
      description:
        "Remove a domain from one Vercel project. Optionally remove project domains that redirect to it; this does not delete the account-level domain.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY,
          domain: { type: "string", minLength: 1, description: "Project domain name from list_project_domains." },
          removeRedirects: { type: "boolean", description: "Also remove project domains that redirect to this one." },
          teamId: TEAM_ID_PROPERTY,
        },
        ["projectId", "domain"],
      ),
      outputSchema: {
        type: "object",
        properties: { removed: { type: "boolean" }, domain: { type: "string" } },
        required: ["removed", "domain"],
      },
      handler: async (args, ctx) => {
        await callVercel(
          send,
          {
            method: "DELETE",
            path: `/v9/projects/${encodeURIComponent(args["projectId"])}/domains/${encodeURIComponent(args["domain"])}`,
            query: team(args),
            body: args["removeRedirects"] === undefined ? undefined : { removeRedirects: args["removeRedirects"] },
          },
          ctx,
        );
        return { removed: true, domain: args["domain"] };
      },
    },
    {
      name: "list_project_env_vars",
      description:
        "List a project's environment-variable metadata without decrypting or returning values. Includes targets, visibility, branches, and custom environments.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY,
          teamId: TEAM_ID_PROPERTY,
          gitBranch: { type: "string", description: "Preview branch filter." },
          customEnvironmentId: { type: "string", description: "Custom environment filter." },
        },
        ["projectId"],
      ),
      outputSchema: {
        type: "object",
        properties: { variables: { type: "array", items: ENV_SCHEMA } },
        required: ["variables"],
      },
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          {
            method: "GET",
            path: `/v10/projects/${encodeURIComponent(args["projectId"])}/env`,
            query: {
              ...team(args),
              gitBranch: args["gitBranch"],
              customEnvironmentId: args["customEnvironmentId"],
              decrypt: "false",
            },
          },
          ctx,
        );
        return { variables: asArray(asRecord(payload)["envs"]).map(projectEnvironmentVariable) };
      },
    },
    {
      name: "upsert_project_env_var",
      description:
        "Create or replace one Vercel project environment variable. Changes affect only future deployments; trigger a new deployment separately.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY,
          teamId: TEAM_ID_PROPERTY,
          key: { type: "string", minLength: 1, maxLength: 256, description: "Environment variable name." },
          value: {
            type: "string",
            maxLength: 65536,
            description: "New value. Vercel's total project-environment payload is capped at 64 KB.",
          },
          type: {
            type: "string",
            enum: ["plain", "encrypted", "sensitive"],
            description: "Storage type. Sensitive values cannot be read back.",
          },
          targets: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", enum: ["production", "preview", "development"] },
            description: "Default Vercel environments that receive this value.",
          },
          gitBranch: { type: "string", description: "Optional preview-only Git branch." },
          customEnvironmentIds: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
            description: "Custom environment ids that receive this value.",
          },
          comment: { type: "string", maxLength: 500, description: "Operator-facing note explaining the variable." },
          upsert: {
            type: "boolean",
            description:
              "Defaults to true. Set false for create-only behavior that refuses to overwrite an existing variable.",
          },
        },
        ["projectId", "key", "value", "type", "targets"],
      ),
      outputSchema: ENV_SCHEMA,
      handler: async (args, ctx) => {
        const payload = asRecord(
          await callVercel(
            send,
            {
              method: "POST",
              path: `/v10/projects/${encodeURIComponent(args["projectId"])}/env`,
              query: { ...team(args), upsert: args["upsert"] === false ? "false" : "true" },
              body: compact({
                key: args["key"],
                value: args["value"],
                type: args["type"],
                target: args["targets"],
                gitBranch: args["gitBranch"],
                customEnvironmentIds: args["customEnvironmentIds"],
                comment: args["comment"],
              }),
            },
            ctx,
          ),
        );
        const failed = asArray(payload["failed"]);
        if (failed.length > 0) {
          const error = asRecord(asRecord(failed[0])["error"]);
          const code = typeof error["code"] === "string" ? `${error["code"]}: ` : "";
          const message =
            typeof error["message"] === "string" ? error["message"] : "Vercel rejected the environment-variable write.";
          throw new ConnectorCallError("invalid_args", `Vercel ${code}${message}`);
        }
        const created = Array.isArray(payload["created"]) ? payload["created"][0] : payload["created"];
        const result = projectEnvironmentVariable(created ?? payload);
        if (!result["id"] || !result["key"] || !result["type"]) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "Vercel accepted the environment-variable write without returning the created variable.",
            { retryable: false },
          );
        }
        return result;
      },
    },
    {
      name: "update_project_env_var",
      description:
        "Update one Vercel project environment variable by id. Send only fields that should change; deployments keep their previous values.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY,
          teamId: TEAM_ID_PROPERTY,
          envVarId: {
            type: "string",
            minLength: 1,
            description: "Environment-variable id from list_project_env_vars.",
          },
          key: { type: "string", minLength: 1, maxLength: 256, description: "Replacement variable name." },
          value: { type: "string", maxLength: 65536, description: "Replacement value." },
          type: { type: "string", enum: ["plain", "encrypted", "sensitive"], description: "Replacement storage type." },
          targets: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", enum: ["production", "preview", "development"] },
            description: "Replacement default environments.",
          },
          gitBranch: { type: ["string", "null"], description: "Replacement preview branch, or null to clear it." },
          customEnvironmentIds: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
            description: "Replacement custom environment ids.",
          },
          comment: { type: "string", maxLength: 500, description: "Replacement operator-facing note." },
        },
        ["projectId", "envVarId"],
      ),
      outputSchema: ENV_SCHEMA,
      handler: async (args, ctx) => {
        const body = compact({
          key: args["key"],
          value: args["value"],
          type: args["type"],
          target: args["targets"],
          gitBranch: args["gitBranch"],
          customEnvironmentIds: args["customEnvironmentIds"],
          comment: args["comment"],
        });
        if (Object.keys(body).length === 0) {
          throw new ConnectorCallError(
            "invalid_args",
            "Nothing to update: provide key, value, type, targets, gitBranch, customEnvironmentIds, or comment.",
          );
        }
        return projectEnvironmentVariable(
          await callVercel(
            send,
            {
              method: "PATCH",
              path: `/v9/projects/${encodeURIComponent(args["projectId"])}/env/${encodeURIComponent(args["envVarId"])}`,
              query: team(args),
              body,
            },
            ctx,
          ),
        );
      },
    },
    {
      name: "delete_project_env_var",
      description:
        "Delete one environment variable from a Vercel project by id. Existing deployments keep their embedded value; future deployments do not.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY,
          envVarId: {
            type: "string",
            minLength: 1,
            description: "Environment-variable id from list_project_env_vars.",
          },
          teamId: TEAM_ID_PROPERTY,
        },
        ["projectId", "envVarId"],
      ),
      outputSchema: {
        type: "object",
        properties: { deleted: { type: "boolean" }, envVarId: { type: "string" } },
        required: ["deleted", "envVarId"],
      },
      handler: async (args, ctx) => {
        await callVercel(
          send,
          {
            method: "DELETE",
            path: `/v9/projects/${encodeURIComponent(args["projectId"])}/env/${encodeURIComponent(args["envVarId"])}`,
            query: team(args),
          },
          ctx,
        );
        return { deleted: true, envVarId: args["envVarId"] };
      },
    },
    {
      name: "delete_deployment",
      description:
        "Permanently delete one Vercel deployment and its deployment URL. This cannot be undone; use cancel_deployment for work still running.",
      annotations: destructive,
      inputSchema: namedInput({ deploymentId: DEPLOYMENT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY }, ["deploymentId"]),
      outputSchema: {
        type: "object",
        properties: { deleted: { type: "boolean" }, deploymentId: { type: "string" } },
        required: ["deleted", "deploymentId"],
      },
      handler: async (args, ctx) => {
        await callVercel(
          send,
          { method: "DELETE", path: `/v13/deployments/${encodeURIComponent(args["deploymentId"])}`, query: team(args) },
          ctx,
        );
        return { deleted: true, deploymentId: args["deploymentId"] };
      },
    },
  ];
}

function apiUsageGuide(purpose: string, teamId: string | undefined, instructions: string | undefined): string {
  const accountInstructions = instructions?.trim();
  return `# Vercel usage

Account purpose: ${purpose}

## Scope before action

${
  teamId
    ? `This connection defaults to team \`${teamId}${skill.fragments.guide_0}`
    : "This connection defaults to the token owner's personal account. Use hosted MCP `list_teams`, then pass `teamId`, for team-owned resources."
}${skill.fragments.guide_1}${
    accountInstructions ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n` : ""
  }`;
}

/**
 * Reviewed in #705's provider audit against https://vercel.com/docs/mcp/vercel-mcp/tools.
 * Retains the release-reviewed inventory, including names absent from today's
 * public reference. Live annotations were not reverified without credentials.
 * No schema digest is asserted without a captured schema to review.
 */
const VERCEL_MCP_CLASSIFICATION: ToolClassification = {
  tools: {
    "request_promote": {
      verdict: "destructive",
      reason:
        "The rolling-releases MCP reference promotes an existing deployment to production; replaces the authored REST promotion write.",
    },
    "list_project_domains": {
      verdict: "read",
      reason: "The projects MCP reference lists project-domain metadata; formerly the named REST read.",
    },
    "add_project_domain": {
      verdict: "destructive",
      reason: "Attaches a domain to a project; preserves the former REST write classification.",
    },
    "cancel_deployment": {
      verdict: "destructive",
      reason: "Cancels an existing deployment, even if the vendor claims read-only access.",
    },
    "upload_file": { verdict: "destructive", reason: "Uploads deployment file bytes and creates vendor state." },
    "create_deployment": {
      verdict: "destructive",
      reason: "Creates a preview or production deployment from Git or files.",
    },
    "list_deployment_events": {
      verdict: "read",
      reason: "Reads build events using the documented deployments catalog.",
    },
    "search_vercel_documentation": {
      "verdict": "read",
      "reason": "Retrieves Vercel vercel documentation information without changing vendor state.",
    },
    "list_teams": { "verdict": "read", "reason": "Retrieves Vercel teams information without changing vendor state." },
    "list_projects": {
      "verdict": "read",
      "reason": "Retrieves Vercel projects information without changing vendor state.",
    },
    "get_project": {
      "verdict": "read",
      "reason": "Retrieves Vercel project information without changing vendor state.",
    },
    "list_deployments": {
      "verdict": "read",
      "reason": "Retrieves Vercel deployments information without changing vendor state.",
    },
    "get_deployment": {
      "verdict": "read",
      "reason": "Retrieves Vercel deployment information without changing vendor state.",
    },
    "get_deployment_build_logs": {
      "verdict": "read",
      "reason": "Retrieves Vercel deployment build logs information without changing vendor state.",
    },
    "get_runtime_logs": {
      "verdict": "read",
      "reason": "Retrieves Vercel runtime logs information without changing vendor state.",
    },
    "get_runtime_errors": {
      "verdict": "read",
      "reason": "Retrieves Vercel runtime errors information without changing vendor state.",
    },
    "get_web_analytics": {
      "verdict": "read",
      "reason": "Retrieves Vercel web analytics information without changing vendor state.",
    },
    "list_agent_run_projects": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent run projects information without changing vendor state.",
    },
    "list_agent_runs": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent runs information without changing vendor state.",
    },
    "get_agent_run": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent run information without changing vendor state.",
    },
    "get_agent_run_trace": {
      "verdict": "read",
      "reason": "Retrieves Vercel agent run trace information without changing vendor state.",
    },
    "check_domain_availability_and_price": {
      "verdict": "read",
      "reason": "Retrieves Vercel check domain availability and price information without changing vendor state.",
    },
    "get_purchase_quote": {
      "verdict": "read",
      "reason": "Reads a purchase quote; billing changes require a separate purchase tool.",
    },
    "get_domain_order": {
      "verdict": "read",
      "reason": "Retrieves Vercel domain order information without changing vendor state.",
    },
    "list_toolbar_threads": {
      "verdict": "read",
      "reason": "Retrieves Vercel toolbar threads information without changing vendor state.",
    },
    "get_toolbar_thread": {
      "verdict": "read",
      "reason": "Retrieves Vercel toolbar thread information without changing vendor state.",
    },
    "use_vercel_cli": {
      "verdict": "read",
      "reason": "Returns CLI guidance only; any subsequent CLI execution is outside this tool.",
    },
    "reply_to_toolbar_thread": {
      "verdict": "write",
      "reason": "reply to toolbar thread creates or appends Vercel state; it has side effects.",
    },
    "add_toolbar_reaction": {
      "verdict": "write",
      "reason": "add toolbar reaction creates or appends Vercel state; it has side effects.",
    },
    "deploy_to_vercel": {
      "verdict": "destructive",
      "reason": "Can change a live deployment and the project serving production traffic.",
    },
    "buy_pro": { "verdict": "destructive", "reason": "buy pro changes existing Vercel state or removes it." },
    "buy_credits": { "verdict": "destructive", "reason": "buy credits changes existing Vercel state or removes it." },
    "buy_addon": { "verdict": "destructive", "reason": "buy addon changes existing Vercel state or removes it." },
    "buy_domain": { "verdict": "destructive", "reason": "buy domain changes existing Vercel state or removes it." },
    "get_access_to_vercel_url": {
      "verdict": "destructive",
      "reason": "Creates an access grant; the returned access URL is a credential.",
    },
    "web_fetch_vercel_url": {
      "verdict": "destructive",
      "reason": "Invokes application code, whose side effects cannot be established from HTTP GET alone.",
    },
    "import-claude-design-from-url": {
      "verdict": "destructive",
      "reason": "Imports into a project and can change existing live project state.",
    },
    "change_toolbar_thread_resolve_status": {
      "verdict": "destructive",
      "reason": "change toolbar thread resolve status changes existing Vercel state or removes it.",
    },
    "edit_toolbar_message": {
      "verdict": "destructive",
      "reason": "edit toolbar message changes existing Vercel state or removes it.",
    },
  },
};

function mcpUsageGuide(purpose: string, instructions: string | undefined): string {
  const accountInstructions = instructions?.trim();
  return `${skill.fragments.guide_2}${purpose}${skill.fragments.guide_3}${
    accountInstructions ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n` : ""
  }`;
}

function vercelMcp(id: string, purpose: string, options: VercelMcpOptions, provider: ProviderContext): Connector {
  const connector = remoteMcp(id, {
    url: VERCEL_MCP_ENDPOINT,
    ...provider.connectorOptions,
    title: options.title ?? "Vercel (MCP)",
    description: `Vercel's official hosted MCP surface: ${purpose}`,
    auth: { type: "oauth" },
    requireHttps: true,
    classify: provider.classify,
    usageGuide: {
      content: mcpUsageGuide(purpose, options.instructions),
      summary: "Official MCP. Live Vercel schemas, id resolution, deployment diagnosis, purchases, and access grants.",
      required: true,
    },
  });
  return vercelCatalog(connector);
}

function vercelApi(id: string, purpose: string, options: VercelApiOptions): Connector {
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(defaultPageSize) || defaultPageSize < 1 || defaultPageSize > MAX_PAGE_SIZE) {
    throw new Error(`vercel() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const teamId = options.teamId?.trim() || undefined;
  const send = vercelTransport(options.baseUrl ?? VERCEL_API_BASE_URL);

  return api(id, {
    ...(options.authScope ? { authScope: options.authScope } : {}),
    title: options.title ?? "Vercel",
    description: `Vercel account and deployments: ${purpose}`,
    credential: {
      label: "Vercel access token",
      description:
        "Access token from Vercel Account Settings → Tokens. Choose the personal account or team scope this deployment needs and set an expiration date. The connector never sends it anywhere except api.vercel.com or the configured baseUrl proxy.",
      placeholder: "Paste Vercel access token",
    },
    testCredential: async (value, ctx) => {
      try {
        const payload = asRecord(
          await callVercel(
            send,
            { method: "GET", path: "/v2/user" },
            { ...ctx, credential: { get: async () => value, getAll: async () => ({ value }) } },
          ),
        );
        const user = asRecord(payload["user"] ?? payload);
        const identity = user["username"] ?? user["email"] ?? user["name"] ?? user["id"] ?? "Vercel user";
        return { ok: true, message: `Authenticated as ${identity}.` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof ConnectorCallError ? error.message : "Vercel rejected the token.",
        };
      }
    },
    usageGuide: {
      content: apiUsageGuide(purpose, teamId, options.instructions),
      summary:
        "Team scoping, deployment diagnosis, value-safe environment variables, REST hatches, and cursor pagination.",
      required: true,
    },
    ...(options.callAdmission ? { callAdmission: options.callAdmission } : {}),
    tools: tools(send, teamId),
    ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
  });
}

/** The closed options vercel() accepts; see `assertKnownOptions`. */
const VERCEL_OPTIONS = variants(
  "surface",
  {
    api: optionsOf<VercelApiOptions>()({
      ...PROVIDER_COMMON,
      ...keys("surface", "teamId", "baseUrl", "defaultPageSize"),
    }).shape,
    mcp: optionsOf<VercelMcpOptions>()({ ...PROVIDER_COMMON, ...keys("surface") }).shape,
  },
  "mcp",
);

/** A maintained Vercel connection using the selected provider surface. */
export const vercel = defineProvider<VercelConnectionOptions>({
  name: "vercel",
  title: "Vercel",
  kind: "composed",
  readme: "Vercel",
  bundle: { "baselineGzip": 143649, "maxGzip": 203649 },
  skill,
  options: VERCEL_OPTIONS,
  classify: VERCEL_MCP_CLASSIFICATION,
  create: vercelConnector,
});

function vercelConnector(id: string, options: VercelConnectionOptions, provider: ProviderContext): Connector {
  const purpose = options.purpose.trim();
  return options.surface === "api" ? vercelApi(id, purpose, options) : vercelMcp(id, purpose, options, provider);
}

/** @deprecated Read `vercel.definition.classify` instead. Kept for existing imports. */
export const VERCEL_MCP_VETTED_CATALOG = reviewedCatalog(vercel.definition.classify!, 'defineProvider("vercel")');
