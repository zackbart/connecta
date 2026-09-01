/** See documentation/vercel.md#no-sdk-on-purpose. */
import { api, defined, type ApiTool } from "../connectors/api.js";
import { remoteMcp } from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../errors.js";
import { withDeadline } from "../timeout.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  JsonSchema,
} from "../types.js";

/** Vercel's public REST origin. Override only for a proxy or test double. */
export const VERCEL_API_BASE_URL = "https://api.vercel.com";
/** Vercel's official hosted MCP endpoint. */
export const VERCEL_MCP_ENDPOINT = "https://mcp.vercel.com";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const VERCEL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_LOG_ROWS = 500;
const DEFAULT_RUNTIME_LOG_ROWS = 100;
const RUNTIME_LOG_TIMEOUT_MS = 10_000;

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
  /** Omit for backward compatibility; the hand-written API surface is the default. */
  surface?: "api";
  /** Default team id for scoped calls. Omit to use the token's personal account. */
  teamId?: string;
  /** API base override for a proxy or test double. */
  baseUrl?: string;
  /** Default page size for list tools. Defaults to 20; Vercel's local cap is 100. */
  defaultPageSize?: number;
}

/** Vercel's official hosted MCP surface, authenticated through OAuth. */
export interface VercelMcpOptions extends VercelCommonOptions {
  surface: "mcp";
}

/** Backward-compatible API options; existing consumers may extend this interface. */
export interface VercelOptions extends VercelApiOptions {}

/** Select one Vercel surface when deployment configuration constructs it. */
export type VercelConnectionOptions = VercelOptions | VercelMcpOptions;

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
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
function vercelFailure(
  status: number,
  headers: Headers,
  payload: unknown,
): ConnectorCallError {
  const detail = detailFor(payload, status);
  if (status === 429) {
    const wait = resetAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `${detail} Vercel meters endpoints separately; wait for the reported reset before retrying this operation.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (status === 401 || status === 403) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} The configured access token is invalid, expired, outside this team, or lacks the required scope. An operator must replace it or widen its Vercel scope.`,
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

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    if (contentType?.includes("stream+json") || contentType?.includes("ndjson")) {
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
        throw new ConnectorCallError(
          "connector_call_failed",
          "Vercel returned a malformed runtime-log stream.",
          { retryable: false },
        );
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
          "No Vercel access token is configured for this connector. An operator must add one on /credentials before any Vercel call can run.",
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
  parseSuccess?: (text: string) => unknown,
): Promise<any> {
  return await send(request, ctx, async (response) => {
    const text = await response.text();
    const payload = parseBody(text, response.headers.get("content-type"));
    if (!response.ok) {
      throw vercelFailure(response.status, response.headers, payload);
    }
    return parseSuccess ? parseSuccess(text) : payload;
  });
}

function teamQuery(
  args: JsonRecord,
  defaultTeamId: string | undefined,
): Record<string, string | number | boolean | undefined> {
  return {
    teamId: args["teamId"] === null
      ? undefined
      : args["teamId"] ?? defaultTeamId,
  };
}

function nextCursor(payload: unknown): string | null {
  const pagination = asRecord(asRecord(payload)["pagination"]);
  const next = pagination["next"];
  return next === undefined || next === null || next === "" ? null : String(next);
}

function page(payload: unknown): { hasMore: boolean; nextCursor: string | null } {
  const cursor = nextCursor(payload);
  return { hasMore: cursor !== null, nextCursor: cursor };
}

function projectTeam(value: unknown): JsonRecord {
  const team = asRecord(value);
  return compact({
    id: team["id"],
    slug: team["slug"],
    name: team["name"],
    avatar: team["avatar"],
    createdAt: team["createdAt"],
    membership: asRecord(team["membership"])["role"],
  });
}

function projectProject(value: unknown): JsonRecord {
  const project = asRecord(value);
  const link = asRecord(project["link"]);
  const targets = asRecord(project["targets"]);
  const production = asRecord(targets["production"]);
  return compact({
    id: project["id"],
    name: project["name"],
    accountId: project["accountId"],
    framework: project["framework"],
    createdAt: project["createdAt"],
    updatedAt: project["updatedAt"],
    paused: project["paused"] === true,
    productionBranch: project["productionBranch"] ?? link["productionBranch"],
    rootDirectory: project["rootDirectory"],
    nodeVersion: project["nodeVersion"],
    buildCommand: project["buildCommand"],
    installCommand: project["installCommand"],
    devCommand: project["devCommand"],
    outputDirectory: project["outputDirectory"],
    repository:
      Object.keys(link).length === 0
        ? undefined
        : compact({
            type: link["type"],
            org: link["org"],
            repo: link["repo"],
            repoId: link["repoId"],
          }),
    productionDeployment:
      Object.keys(production).length === 0
        ? undefined
        : compact({
            id: production["id"] ?? production["uid"],
            url: production["url"],
            state: production["readyState"] ?? production["state"],
            createdAt: production["createdAt"] ?? production["created"],
          }),
  });
}

function projectDeployment(value: unknown): JsonRecord {
  const deployment = asRecord(value);
  const creator = asRecord(deployment["creator"]);
  const meta = asRecord(deployment["meta"]);
  return compact({
    id: deployment["uid"] ?? deployment["id"],
    name: deployment["name"],
    url: deployment["url"],
    state: deployment["readyState"] ?? deployment["state"],
    target: deployment["target"],
    source: deployment["source"],
    createdAt: deployment["createdAt"] ?? deployment["created"],
    buildingAt: deployment["buildingAt"],
    readyAt: deployment["ready"] ?? deployment["readyAt"],
    projectId: deployment["projectId"],
    creator:
      Object.keys(creator).length === 0
        ? undefined
        : compact({
            id: creator["uid"] ?? creator["id"],
            username: creator["username"],
            email: creator["email"],
          }),
    git:
      meta["githubCommitRef"] || meta["gitlabCommitRef"] || meta["bitbucketCommitRef"]
        ? compact({
            branch:
              meta["githubCommitRef"] ??
              meta["gitlabCommitRef"] ??
              meta["bitbucketCommitRef"],
            sha:
              meta["githubCommitSha"] ??
              meta["gitlabCommitSha"] ??
              meta["bitbucketCommitSha"],
            message:
              meta["githubCommitMessage"] ??
              meta["gitlabCommitMessage"] ??
              meta["bitbucketCommitMessage"],
          })
        : undefined,
  });
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

const RAW_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "Return Vercel's untouched response instead of the lean projection.",
};

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

const CURSOR_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Opaque nextCursor returned by the previous page. Pass it back unchanged.",
};

function limitProperty(defaultPageSize: number): JsonSchema {
  return {
    type: "integer",
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    description: `Rows per request, 1 to ${MAX_PAGE_SIZE}. Defaults to this connector's ${defaultPageSize}.`,
  };
}

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean" },
    nextCursor: {
      type: ["string", "null"],
      description: "Pass back unchanged as cursor when hasMore is true.",
    },
  },
  required: ["hasMore", "nextCursor"],
};

function listSchema(key: string, item: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      [key]: { type: "array", items: item },
      page: PAGE_SCHEMA,
    },
    required: [key, "page"],
  };
}

const TEAM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    avatar: { type: ["string", "null"] },
    createdAt: { type: "number" },
    membership: { type: "string" },
  },
  required: ["id", "slug", "name"],
};

const PROJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    accountId: { type: "string" },
    framework: { type: ["string", "null"] },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    paused: { type: "boolean" },
    productionBranch: { type: "string" },
    rootDirectory: { type: ["string", "null"] },
    nodeVersion: { type: "string" },
    buildCommand: { type: ["string", "null"] },
    installCommand: { type: ["string", "null"] },
    devCommand: { type: ["string", "null"] },
    outputDirectory: { type: ["string", "null"] },
    repository: { type: "object" },
    productionDeployment: { type: "object" },
  },
  required: ["id", "name"],
};

const DEPLOYMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    url: { type: ["string", "null"] },
    state: { type: "string" },
    target: { type: ["string", "null"] },
    source: { type: "string" },
    createdAt: { type: "number" },
    buildingAt: { type: "number" },
    readyAt: { type: "number" },
    projectId: { type: "string" },
    creator: { type: "object" },
    git: { type: "object" },
  },
  required: ["id", "name", "state"],
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

function namedInput(
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function queryPairs(value: unknown): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  for (const row of asArray(value)) {
    const pair = asRecord(row);
    if (typeof pair["name"] !== "string") continue;
    const item = pair["value"];
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
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
  description: "Endpoint-specific request headers. Credential, cookie, host, framing, and content-type headers are connector-owned.",
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
    throw new ConnectorCallError(
      "invalid_args",
      "Provide exactly one of textBody or base64Body for a Vercel upload.",
    );
  }
  if (hasText) return args["textBody"];
  try {
    return Uint8Array.from(atob(args["base64Body"]), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new ConnectorCallError(
      "invalid_args",
      "base64Body is not valid base64.",
    );
  }
}

function rawRequest(
  args: JsonRecord,
  defaultTeamId: string | undefined,
): Pick<GuardedRequest, "path" | "query"> {
  const query = queryPairs(args["query"]);
  if (
    args["personalAccount"] === true &&
    (query["teamId"] !== undefined || query["slug"] !== undefined)
  ) {
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

const PERSONAL_ACCOUNT_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "True omits the configured default team. Do not combine with a teamId or slug query parameter.",
};

function tools(
  send: GuardedTransport,
  defaultPageSize: number,
  defaultTeamId: string | undefined,
): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true } as const;
  const team = (args: JsonRecord) => teamQuery(args, defaultTeamId);
  const limit = (args: JsonRecord) => args["limit"] ?? defaultPageSize;
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
          (await callVercel(
            send,
            { method: "GET", ...rawRequest(args, defaultTeamId) },
            ctx,
          )) ?? null,
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
          )) ?? null,
      }),
    },
    {
      name: "list_teams",
      description:
        "List teams the access token can reach. Supplies teamId for project, deployment, domain, environment, and raw API calls.",
      annotations: readOnly,
      inputSchema: namedInput(
        { limit: limitProperty(defaultPageSize), cursor: CURSOR_PROPERTY },
        [],
      ),
      outputSchema: listSchema("teams", TEAM_SCHEMA),
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          { method: "GET", path: "/v2/teams", query: { limit: limit(args), until: args["cursor"] } },
          ctx,
        );
        return { teams: asArray(asRecord(payload)["teams"]).map(projectTeam), page: page(payload) };
      },
    },
    {
      name: "list_projects",
      description:
        "List or search Vercel projects with repository, framework, and production-deployment identity. Returns lean project summaries.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          teamId: TEAM_ID_PROPERTY,
          search: { type: "string", description: "Case-insensitive project-name search." },
          limit: limitProperty(defaultPageSize),
          cursor: CURSOR_PROPERTY,
          raw: RAW_PROPERTY,
        },
        [],
      ),
      outputSchema: listSchema("projects", PROJECT_SCHEMA),
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          {
            method: "GET",
            path: "/v10/projects",
            query: { ...team(args), search: args["search"], limit: limit(args), from: args["cursor"] },
          },
          ctx,
        );
        const projects = asArray(asRecord(payload)["projects"]);
        return {
          projects: args["raw"] === true ? projects : projects.map(projectProject),
          page: page(payload),
        };
      },
    },
    {
      name: "get_project",
      description:
        "Get one Vercel project by id or name, including build settings, Git identity, and current production deployment.",
      annotations: readOnly,
      inputSchema: namedInput(
        { projectId: PROJECT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY, raw: RAW_PROPERTY },
        ["projectId"],
      ),
      outputSchema: PROJECT_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          { method: "GET", path: `/v9/projects/${encodeURIComponent(args["projectId"])}`, query: team(args) },
          ctx,
        );
        return args["raw"] === true ? payload : projectProject(payload);
      },
    },
    {
      name: "list_deployments",
      description:
        "List Vercel deployments, filtered by project, target, state, branch, or commit SHA. Returns ids needed by log and lifecycle tools.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          teamId: TEAM_ID_PROPERTY,
          projectId: { ...PROJECT_ID_PROPERTY, description: "Project id or name. Omit to list the whole account or team." },
          target: { type: "string", description: "Deployment target, usually production or preview." },
          state: {
            type: "string",
            enum: ["BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED", "BLOCKED"],
            description: "Exact Vercel deployment state.",
          },
          branch: { type: "string", description: "Git branch name." },
          sha: { type: "string", description: "Git commit SHA." },
          limit: limitProperty(defaultPageSize),
          cursor: CURSOR_PROPERTY,
          raw: RAW_PROPERTY,
        },
        [],
      ),
      outputSchema: listSchema("deployments", DEPLOYMENT_SCHEMA),
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          {
            method: "GET",
            path: "/v7/deployments",
            query: {
              ...team(args), projectId: args["projectId"], target: args["target"],
              state: args["state"], branch: args["branch"], sha: args["sha"],
              limit: limit(args), until: args["cursor"],
            },
          },
          ctx,
        );
        const deployments = asArray(asRecord(payload)["deployments"]);
        return {
          deployments: args["raw"] === true
            ? deployments
            : deployments.map(projectDeployment),
          page: page(payload),
        };
      },
    },
    {
      name: "get_deployment",
      description:
        "Get one Vercel deployment by id or hostname, including its state, target, creator, Git commit, and timestamps.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          deploymentId: { ...DEPLOYMENT_ID_PROPERTY, description: "Deployment id or deployment hostname." },
          teamId: TEAM_ID_PROPERTY,
          raw: RAW_PROPERTY,
        },
        ["deploymentId"],
      ),
      outputSchema: DEPLOYMENT_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          { method: "GET", path: `/v13/deployments/${encodeURIComponent(args["deploymentId"])}`, query: team(args) },
          ctx,
        );
        return args["raw"] === true ? payload : projectDeployment(payload);
      },
    },
    {
      name: "get_build_logs",
      description:
        "Get bounded build events for one deployment, including stdout, stderr, command, exit, and deployment-state records. Does not follow live output.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          deploymentId: DEPLOYMENT_ID_PROPERTY,
          teamId: TEAM_ID_PROPERTY,
          direction: { type: "string", enum: ["forward", "backward"], description: "Chronological direction. Defaults to forward." },
          limit: { type: "integer", minimum: 1, maximum: 1000, description: "Events per request, 1 to this connector's 1,000-event cap. Defaults to 100." },
          since: { type: "number", description: "Only events at or after this JavaScript timestamp." },
          until: { type: "number", description: "Only events at or before this JavaScript timestamp." },
          raw: RAW_PROPERTY,
        },
        ["deploymentId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" }, createdAt: { type: "number" },
                message: { type: "string" }, payload: { type: "object" },
              },
              required: ["type"],
            },
          },
        },
        required: ["events"],
      },
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          {
            method: "GET",
            path: `/v3/deployments/${encodeURIComponent(args["deploymentId"])}/events`,
            query: {
              ...team(args), direction: args["direction"] ?? "forward", follow: 0,
              builds: 1, limit: args["limit"] ?? 100, since: args["since"], until: args["until"],
            },
          },
          ctx,
        );
        if (args["raw"] === true) return { events: asArray(payload) };
        const events = asArray(payload).map((value) => {
          const event = asRecord(value);
          const eventPayload = asRecord(event["payload"]);
          return compact({
            type: event["type"] ?? "unknown",
            createdAt: event["created"] ?? event["date"],
            message: eventPayload["text"] ?? eventPayload["message"],
            payload: Object.keys(eventPayload).length === 0 ? undefined : eventPayload,
          });
        });
        return { events };
      },
    },
    {
      name: "get_runtime_logs",
      description:
        "Get a bounded runtime-log snapshot for one deployment. Returns at most 500 rows and stops a stream that stays open past 10 seconds.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY,
          deploymentId: DEPLOYMENT_ID_PROPERTY,
          teamId: TEAM_ID_PROPERTY,
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_RUNTIME_LOG_ROWS,
            description: `Rows returned, 1 to ${MAX_RUNTIME_LOG_ROWS}. Defaults to ${DEFAULT_RUNTIME_LOG_ROWS}.`,
          },
        },
        ["projectId", "deploymentId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          logs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                level: { type: "string" }, message: { type: "string" },
                timestampInMs: { type: "number" }, source: { type: "string" },
                domain: { type: "string" }, requestMethod: { type: "string" },
                requestPath: { type: "string" }, responseStatusCode: { type: "number" },
                messageTruncated: { type: "boolean" },
              },
              required: ["level", "message", "timestampInMs", "source"],
            },
          },
        },
        required: ["logs"],
      },
      handler: async (args, ctx) => {
        const payload = await withDeadline(
          (signal) => callVercel(
            send,
            {
              method: "GET",
              path: `/v1/projects/${encodeURIComponent(args["projectId"])}/deployments/${encodeURIComponent(args["deploymentId"])}/runtime-logs`,
              query: team(args), headers: { Accept: "application/stream+json" },
            },
            { ...ctx, signal },
            parseStreamRows,
          ),
          {
            timeoutMs: RUNTIME_LOG_TIMEOUT_MS,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            timeoutError: new ConnectorCallError(
              "unavailable",
              `Vercel's runtime-log stream stayed open past this connector's ${RUNTIME_LOG_TIMEOUT_MS / 1_000}-second bound. Retry for a fresh snapshot.`,
            ),
          },
        );
        const requested = args["limit"] ?? DEFAULT_RUNTIME_LOG_ROWS;
        return { logs: asArray(payload).slice(0, requested) };
      },
    },
    {
      name: "list_project_domains",
      description:
        "List domains assigned to one Vercel project, including verification challenges, redirects, branch bindings, and custom-environment bindings.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY,
          verified: { type: "boolean", description: "Filter by verification state." },
          limit: limitProperty(defaultPageSize), cursor: CURSOR_PROPERTY, raw: RAW_PROPERTY,
        },
        ["projectId"],
      ),
      outputSchema: listSchema("domains", DOMAIN_SCHEMA),
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          {
            method: "GET", path: `/v9/projects/${encodeURIComponent(args["projectId"])}/domains`,
            query: { ...team(args), verified: args["verified"], limit: limit(args), until: args["cursor"] },
          },
          ctx,
        );
        const domains = asArray(asRecord(payload)["domains"]);
        return {
          domains: args["raw"] === true ? domains : domains.map(projectDomain),
          page: page(payload),
        };
      },
    },
    {
      name: "add_project_domain",
      description:
        "Add a domain, redirect, Git-branch domain, or custom-environment domain to a Vercel project. An unverified result includes its DNS challenge.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          projectId: PROJECT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY,
          domain: { type: "string", minLength: 1, description: "Domain name to add." },
          gitBranch: { type: "string", description: "Bind this domain to one Git branch." },
          customEnvironmentId: { type: "string", description: "Bind this domain to one custom environment." },
          redirect: { type: "string", description: "Target domain for a redirect." },
          redirectStatusCode: { type: "integer", enum: [301, 302, 307, 308], description: "Redirect status; only valid with redirect." },
        },
        ["projectId", "domain"],
      ),
      outputSchema: DOMAIN_SCHEMA,
      handler: async (args, ctx) => projectDomain(await callVercel(
        send,
        {
          method: "POST", path: `/v10/projects/${encodeURIComponent(args["projectId"])}/domains`, query: team(args),
          body: compact({ name: args["domain"], gitBranch: args["gitBranch"], customEnvironmentId: args["customEnvironmentId"], redirect: args["redirect"], redirectStatusCode: args["redirectStatusCode"] }),
        },
        ctx,
      )),
    },
    {
      name: "verify_project_domain",
      description:
        "Ask Vercel to verify a project's pending domain after its DNS challenge has been completed. Returns the current domain state.",
      annotations: destructive,
      inputSchema: namedInput(
        { projectId: PROJECT_ID_PROPERTY, domain: { type: "string", minLength: 1, description: "Pending domain name from list_project_domains." }, teamId: TEAM_ID_PROPERTY },
        ["projectId", "domain"],
      ),
      outputSchema: DOMAIN_SCHEMA,
      handler: async (args, ctx) => projectDomain(await callVercel(
        send,
        { method: "POST", path: `/v9/projects/${encodeURIComponent(args["projectId"])}/domains/${encodeURIComponent(args["domain"])}/verify`, query: team(args) },
        ctx,
      )),
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
        type: "object", properties: { removed: { type: "boolean" }, domain: { type: "string" } }, required: ["removed", "domain"],
      },
      handler: async (args, ctx) => {
        await callVercel(
          send,
          {
            method: "DELETE", path: `/v9/projects/${encodeURIComponent(args["projectId"])}/domains/${encodeURIComponent(args["domain"])}`,
            query: team(args), body: args["removeRedirects"] === undefined ? undefined : { removeRedirects: args["removeRedirects"] },
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
          projectId: PROJECT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY,
          gitBranch: { type: "string", description: "Preview branch filter." },
          customEnvironmentId: { type: "string", description: "Custom environment filter." },
        },
        ["projectId"],
      ),
      outputSchema: {
        type: "object", properties: { variables: { type: "array", items: ENV_SCHEMA } }, required: ["variables"],
      },
      handler: async (args, ctx) => {
        const payload = await callVercel(
          send,
          {
            method: "GET", path: `/v10/projects/${encodeURIComponent(args["projectId"])}/env`,
            query: { ...team(args), gitBranch: args["gitBranch"], customEnvironmentId: args["customEnvironmentId"], decrypt: "false" },
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
          projectId: PROJECT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY,
          key: { type: "string", minLength: 1, maxLength: 256, description: "Environment variable name." },
          value: { type: "string", maxLength: 65536, description: "New value. Vercel's total project-environment payload is capped at 64 KB." },
          type: { type: "string", enum: ["plain", "encrypted", "sensitive"], description: "Storage type. Sensitive values cannot be read back." },
          targets: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["production", "preview", "development"] }, description: "Default Vercel environments that receive this value." },
          gitBranch: { type: "string", description: "Optional preview-only Git branch." },
          customEnvironmentIds: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 }, description: "Custom environment ids that receive this value." },
          comment: { type: "string", maxLength: 500, description: "Operator-facing note explaining the variable." },
        },
        ["projectId", "key", "value", "type", "targets"],
      ),
      outputSchema: ENV_SCHEMA,
      handler: async (args, ctx) => {
        const payload = asRecord(await callVercel(
          send,
          {
            method: "POST", path: `/v10/projects/${encodeURIComponent(args["projectId"])}/env`,
            query: { ...team(args), upsert: "true" },
            body: compact({ key: args["key"], value: args["value"], type: args["type"], target: args["targets"], gitBranch: args["gitBranch"], customEnvironmentIds: args["customEnvironmentIds"], comment: args["comment"] }),
          },
          ctx,
        ));
        const failed = asArray(payload["failed"]);
        if (failed.length > 0) {
          const error = asRecord(asRecord(failed[0])["error"]);
          const code = typeof error["code"] === "string" ? `${error["code"]}: ` : "";
          const message = typeof error["message"] === "string"
            ? error["message"]
            : "Vercel rejected the environment-variable write.";
          throw new ConnectorCallError("invalid_args", `Vercel ${code}${message}`);
        }
        const created = Array.isArray(payload["created"])
          ? payload["created"][0]
          : payload["created"];
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
          projectId: PROJECT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY,
          envVarId: { type: "string", minLength: 1, description: "Environment-variable id from list_project_env_vars." },
          key: { type: "string", minLength: 1, maxLength: 256, description: "Replacement variable name." },
          value: { type: "string", maxLength: 65536, description: "Replacement value." },
          type: { type: "string", enum: ["plain", "encrypted", "sensitive"], description: "Replacement storage type." },
          targets: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["production", "preview", "development"] }, description: "Replacement default environments." },
          gitBranch: { type: ["string", "null"], description: "Replacement preview branch, or null to clear it." },
          customEnvironmentIds: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 }, description: "Replacement custom environment ids." },
          comment: { type: "string", maxLength: 500, description: "Replacement operator-facing note." },
        },
        ["projectId", "envVarId"],
      ),
      outputSchema: ENV_SCHEMA,
      handler: async (args, ctx) => {
        const body = compact({ key: args["key"], value: args["value"], type: args["type"], target: args["targets"], gitBranch: args["gitBranch"], customEnvironmentIds: args["customEnvironmentIds"], comment: args["comment"] });
        if (Object.keys(body).length === 0) {
          throw new ConnectorCallError("invalid_args", "Nothing to update: provide key, value, type, targets, gitBranch, customEnvironmentIds, or comment.");
        }
        return projectEnvironmentVariable(await callVercel(
          send,
          { method: "PATCH", path: `/v9/projects/${encodeURIComponent(args["projectId"])}/env/${encodeURIComponent(args["envVarId"])}`, query: team(args), body },
          ctx,
        ));
      },
    },
    {
      name: "delete_project_env_var",
      description:
        "Delete one environment variable from a Vercel project by id. Existing deployments keep their embedded value; future deployments do not.",
      annotations: destructive,
      inputSchema: namedInput(
        { projectId: PROJECT_ID_PROPERTY, envVarId: { type: "string", minLength: 1, description: "Environment-variable id from list_project_env_vars." }, teamId: TEAM_ID_PROPERTY },
        ["projectId", "envVarId"],
      ),
      outputSchema: { type: "object", properties: { deleted: { type: "boolean" }, envVarId: { type: "string" } }, required: ["deleted", "envVarId"] },
      handler: async (args, ctx) => {
        await callVercel(send, { method: "DELETE", path: `/v9/projects/${encodeURIComponent(args["projectId"])}/env/${encodeURIComponent(args["envVarId"])}`, query: team(args) }, ctx);
        return { deleted: true, envVarId: args["envVarId"] };
      },
    },
    {
      name: "promote_deployment",
      description:
        "Promote an existing Vercel deployment to production without rebuilding it. The deployment must belong to the named project.",
      annotations: destructive,
      inputSchema: namedInput(
        { projectId: PROJECT_ID_PROPERTY, deploymentId: DEPLOYMENT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY },
        ["projectId", "deploymentId"],
      ),
      outputSchema: { type: "object", properties: { promoted: { type: "boolean" }, deploymentId: { type: "string" } }, required: ["promoted", "deploymentId"] },
      handler: async (args, ctx) => {
        await callVercel(send, { method: "POST", path: `/v10/projects/${encodeURIComponent(args["projectId"])}/promote/${encodeURIComponent(args["deploymentId"])}`, query: team(args) }, ctx);
        return { promoted: true, deploymentId: args["deploymentId"] };
      },
    },
    {
      name: "cancel_deployment",
      description:
        "Cancel a queued, initializing, or building Vercel deployment. A deployment that is already ready, failed, canceled, or deleted cannot be canceled.",
      annotations: destructive,
      inputSchema: namedInput(
        { deploymentId: DEPLOYMENT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY },
        ["deploymentId"],
      ),
      outputSchema: DEPLOYMENT_SCHEMA,
      handler: async (args, ctx) => projectDeployment(await callVercel(
        send,
        { method: "PATCH", path: `/v12/deployments/${encodeURIComponent(args["deploymentId"])}/cancel`, query: team(args) },
        ctx,
      )),
    },
    {
      name: "delete_deployment",
      description:
        "Permanently delete one Vercel deployment and its deployment URL. This cannot be undone; use cancel_deployment for work still running.",
      annotations: destructive,
      inputSchema: namedInput(
        { deploymentId: DEPLOYMENT_ID_PROPERTY, teamId: TEAM_ID_PROPERTY },
        ["deploymentId"],
      ),
      outputSchema: { type: "object", properties: { deleted: { type: "boolean" }, deploymentId: { type: "string" } }, required: ["deleted", "deploymentId"] },
      handler: async (args, ctx) => {
        await callVercel(send, { method: "DELETE", path: `/v13/deployments/${encodeURIComponent(args["deploymentId"])}`, query: team(args) }, ctx);
        return { deleted: true, deploymentId: args["deploymentId"] };
      },
    },
  ];
}

function apiUsageGuide(
  purpose: string,
  teamId: string | undefined,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  return `# Vercel usage

Account purpose: ${purpose}

## Scope before action

${
  teamId
    ? `This connection defaults to team \`${teamId}\`. Every named account-scoped tool accepts a \`teamId\` override; pass \`null\` to target the token owner's personal account.`
    : "This connection defaults to the token owner's personal account. Call `list_teams`, then pass `teamId`, for team-owned resources."
}

Project names are accepted where Vercel accepts an id or name, but deployment,
environment-variable, and team ids are opaque. Read them from their list tool
and pass them back unchanged.

## Diagnose deployments in order

- Read \`get_deployment\` first. Its state says whether logs can still change.
- Use \`get_build_logs\` for install, build, and framework output.
- Use \`get_runtime_logs\` for application requests after a deployment runs.
- \`promote_deployment\` moves an existing build to production. It does not
  rebuild it. A rebuild or Git deployment belongs in \`vercel_api_mutate\`.

## Environment values

\`list_project_env_vars\` never decrypts or returns values. It reports names,
targets, visibility, branch bindings, and ids. The create and update tools take
values only as write input, and their projected results omit them. Environment
changes apply to future deployments, not deployments that already exist.

## Named tools and the REST hatches

Use named tools when one exists. They validate arguments and return smaller,
stable objects. \`vercel_api_get\` reaches every other GET endpoint and
\`vercel_api_mutate\` reaches JSON POST, PUT, PATCH, and DELETE endpoints.
\`vercel_api_upload\` sends explicit text or base64 bytes and never reads a
local file. Paths include Vercel's API version, such as \`/v1/edge-config\`,
and query parameters are name/value pairs. Pass \`personalAccount: true\` to
omit this connection's default team. No hatch accepts an absolute URL.

## Pagination and rate limits

List tools return \`page.hasMore\` and \`page.nextCursor\`. Pass the cursor back
unchanged. Vercel meters endpoints separately and returns the reset in response
headers. A rate-limit failure carries that delay when Vercel supplies it.
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

/** Reads reviewed against Vercel's official MCP tool reference. */
const MCP_READ_ONLY_TOOLS = new Set([
  "search_vercel_documentation",
  "list_teams",
  "list_projects",
  "get_project",
  "list_deployments",
  "get_deployment",
  "get_deployment_build_logs",
  "get_runtime_logs",
  "get_runtime_errors",
  "get_web_analytics",
  "list_agent_run_projects",
  "list_agent_runs",
  "get_agent_run",
  "get_agent_run_trace",
  "check_domain_availability_and_price",
  "get_purchase_quote",
  "get_domain_order",
  "list_toolbar_threads",
  "get_toolbar_thread",
  // Returns CLI guidance. Any later CLI execution is outside this MCP call.
  "use_vercel_cli",
]);

/** Writes reviewed against Vercel's official MCP tool reference. */
const MCP_WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> =
  new Map([
    // These only append state.
    ["reply_to_toolbar_thread", "additive"],
    ["add_toolbar_reaction", "additive"],
    // Deploying to production, billing, access grants, imports, and edits can
    // all change existing state, even where the provider uses a create verb.
    ["deploy_to_vercel", "destructive"],
    ["buy_pro", "destructive"],
    ["buy_credits", "destructive"],
    ["buy_addon", "destructive"],
    ["buy_domain", "destructive"],
    ["get_access_to_vercel_url", "destructive"],
    // A GET against application code is not guaranteed to be observational.
    ["web_fetch_vercel_url", "destructive"],
    ["import-claude-design-from-url", "destructive"],
    ["change_toolbar_thread_resolve_status", "destructive"],
    ["edit_toolbar_message", "destructive"],
  ]);

/** Release-reviewed Vercel MCP inventory and safety verdicts. */
export const VERCEL_MCP_VETTED_CATALOG = vettedCatalog({
  reads: MCP_READ_ONLY_TOOLS,
  writes: MCP_WRITE_TOOLS,
});

function mcpUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  return `# Vercel MCP usage

Official MCP surface: tool names, descriptions, argument schemas, and result
schemas come from Vercel's live server. Connecta preserves that catalog and
only fills in release-reviewed safety annotations when Vercel leaves them out.

Account purpose: ${purpose}

- Discover the live catalog before assuming a tool exists. Vercel can change
  the surface independently of a Connecta release, and account features may
  affect what the authorization can reach.
- Resolve team, project, deployment, run, thread, and order ids with the list
  and get tools. Do not guess opaque ids.
- Diagnose deployments with \`get_deployment\`, then build logs, runtime error
  clusters, and runtime logs. Narrow time windows before raising result limits.
- Purchase tools change billing. Read a quote first and carry its price,
  idempotency key, and requested term into the confirmed purchase unchanged.
- \`get_access_to_vercel_url\` creates a temporary access grant. Treat the URL
  it returns as a credential and do not expose it outside the requested task.
- \`deploy_to_vercel\` and \`import-claude-design-from-url\` can create or update
  live projects. Read the target and deployment mode before approving them.
- An \`auth_required\` failure means this connector's OAuth grant is missing or
  expired. Run \`authorize_connector\` for this connector id, then retry.
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

function vercelMcp(
  id: string,
  purpose: string,
  options: VercelMcpOptions,
): Connector {
  const connector = remoteMcp(id, {
    url: VERCEL_MCP_ENDPOINT,
    ...defined({
      authScope: options.authScope,
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? "Vercel (MCP)",
    description: `Vercel's official hosted MCP surface: ${purpose}`,
    auth: { type: "oauth" },
    requireHttps: true,
    usageGuide: {
      content: mcpUsageGuide(purpose, options.instructions),
      summary:
        "Official MCP. Live Vercel schemas, id resolution, deployment diagnosis, purchases, and access grants.",
      required: true,
    },
  });
  return withVettedCatalog(connector, VERCEL_MCP_VETTED_CATALOG);
}

function vercelApi(
  id: string,
  purpose: string,
  options: VercelApiOptions,
): Connector {
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(defaultPageSize) ||
    defaultPageSize < 1 ||
    defaultPageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(
      `vercel() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
    );
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
        const payload = asRecord(await callVercel(
          send,
          { method: "GET", path: "/v2/user" },
          { ...ctx, credential: { get: async () => value, getAll: async () => ({ value }) } },
        ));
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
    ...(options.callAdmission
      ? { callAdmission: options.callAdmission }
      : {}),
    tools: tools(send, defaultPageSize, teamId),
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
}

/** A maintained Vercel connection using the selected provider surface. */
export function vercel(id: string, options: VercelConnectionOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("vercel() requires a non-empty account purpose.");
  }
  return options.surface === "mcp"
    ? vercelMcp(id, purpose, options)
    : vercelApi(id, purpose, options);
}
