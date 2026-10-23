// Vercel's unchanged declarations and projections, with kit-owned call services.
import { Effect } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import type { JsonSchema } from "../../types.js";
import { schema, catalogOrder, restKitTools, typedParams } from "../_shared/rest/kit.js";
import type { RestCall } from "../_shared/rest/tools.js";
import type { RestMethod } from "../_shared/rest/operation-index.js";
import { refuseWithheldUpload } from "../_shared/rest/value-safety.js";
import { rowStop, type LogLimits } from "./lib/logs.js";
import { checked } from "../_shared/rest/kit.js";
import {
  admit,
  compact,
  defaultTeam,
  isRecord,
  invalid,
  named,
  queryOf,
  queryPairs,
  record,
  reviewedCode,
  restCall,
  scope,
  sendVercel,
  text,
  vercelIndex,
  vercelSafety,
  READ_POSTS,
  refuse,
  checkServer,
  vercelPage,
  type JsonRecord,
} from "./api.js";
import type { VercelTokenOptions } from "./index.js";
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_TEXT = 4_000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
function promise<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
}
function clamp(value: unknown): { text?: string; textTruncated?: true } {
  if (typeof value !== "string") return {};
  return value.length > MAX_LOG_TEXT ? { text: value.slice(0, MAX_LOG_TEXT), textTruncated: true } : { text: value };
}

const TEAM_ID: JsonSchema = {
  type: ["string", "null"],
  minLength: 1,
  description: "Vercel team id. Omit for the connection's default; null for the token owner's personal account.",
};

const PROJECT_ID: JsonSchema = { type: "string", minLength: 1, description: "Project id or name." };

const ENV_VAR_ID: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Environment-variable id from list_project_env_vars.",
};

const TARGETS: JsonSchema = {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: {
    type: "string",
    enum: ["production", "preview", "development"],
    description: "A default Vercel environment.",
  },
  description: "Default Vercel environments that receive this value.",
};

const CUSTOM_ENVIRONMENT_IDS: JsonSchema = {
  type: "array",
  uniqueItems: true,
  items: { type: "string", minLength: 1, description: "A custom environment id." },
  description: "Custom environment ids that receive this value.",
};

const ENV_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    type: { type: "string" },
    target: { type: ["array", "string"], items: { type: "string" } },
    gitBranch: { type: ["string", "null"] },
    customEnvironmentIds: { type: "array", items: { type: "string" } },
    comment: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["id", "key", "type"],
};

/** Deliberately omits `value`, even though redaction already removed it. */
function envMetadata(value: unknown): JsonRecord {
  const variable = record(value);
  return compact({
    id: variable["id"],
    key: variable["key"],
    type: variable["type"],
    target: variable["target"],
    gitBranch: variable["gitBranch"],
    customEnvironmentIds: variable["customEnvironmentIds"],
    comment: variable["comment"],
    createdAt: variable["createdAt"],
    updatedAt: variable["updatedAt"],
  });
}

function closed(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function segment(value: unknown): string {
  return encodeURIComponent(String(value));
}

function decodeUpload(args: JsonRecord): Uint8Array {
  const hasText = typeof args["textBody"] === "string";
  const hasBase64 = typeof args["base64Body"] === "string";
  if (hasText === hasBase64) invalid("Provide exactly one of textBody or base64Body for a Vercel upload.");
  let bytes: Uint8Array;
  if (hasText) bytes = new TextEncoder().encode(args["textBody"] as string);
  else {
    try {
      bytes = Uint8Array.from(atob(args["base64Body"] as string), (character) => character.charCodeAt(0));
    } catch {
      return invalid("base64Body is not valid base64.");
    }
  }
  if (bytes.length > MAX_UPLOAD_BYTES)
    invalid(`A Vercel upload through Connecta is at most ${MAX_UPLOAD_BYTES} bytes.`);
  return bytes;
}

async function sha1(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function vercelTools({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<VercelTokenOptions>;
}): ApiTool[] {
  const teamId = defaultTeam(options);
  const makeCall = (method: RestMethod, path: string, input: Parameters<typeof restCall>[2] = {}) =>
    restCall(method, path, input, teamId);
  const send = (method: RestMethod, path: string, input: Parameters<typeof restCall>[2] = {}) =>
    checked(() => makeCall(method, path, input)).pipe(
      Effect.flatMap((call) => {
        const operation = named.find(
          (op) => op.method === call.method && op.path.replace(/:([^/]+)/g, "{$1}") === call.op.path,
        );
        if (!operation) throw new Error("A named Vercel call has no declared operation.");
        return admit(call).pipe(
          Effect.flatMap(() =>
            connection.send(operation, {
              params: typedParams(call.params),
              query: queryOf(call),
              payload: call.body,
            }),
          ),
          Effect.map((answer) => {
            const page = vercelPage(vercelIndex, answer.data, call);
            return { ...answer, data: answer.data ?? null, ...(page ? { page } : {}) };
          }),
        );
      }),
    );
  const boundedRows = (call: RestCall, limits: LogLimits) => {
    const operation = named.find(
      (op) => op.method === call.method && op.path.replace(/:([^/]+)/g, "{$1}") === call.op.path,
    )!;
    return connection
      .send(
        operation,
        { params: typedParams(call.params), query: queryOf(call), payload: undefined },
        { flags: { log: true }, prefix: { maxBytes: MAX_LOG_BYTES, timeoutMs: limits.waitMs, stop: rowStop(limits) } },
      )
      .pipe(
        Effect.map((answer) => ({
          rows: Array.isArray(answer.data) ? answer.data : [],
          stopped: answer.prefix?.stopped === "stop" ? ("rows" as const) : (answer.prefix?.stopped ?? ("end" as const)),
        })),
      );
  };
  const declarations = [
    {
      name: "list_teams",
      description:
        "List the Vercel teams this token can reach, with ids and slugs to pass as teamId. Also names the connection's default team.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Most teams per page; default 20." },
          until: { type: "number", description: "page.next from the previous page: a millisecond timestamp." },
        },
        [],
      ),
      outputSchema: {
        type: "object",
        properties: {
          teams: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                slug: { type: "string" },
                name: { type: ["string", "null"] },
                role: { type: "string" },
              },
              required: ["id", "slug"],
            },
          },
          defaultTeamId: { type: ["string", "null"], description: "The team operations use when teamId is omitted." },
          page: {
            type: "object",
            properties: { hasMore: { type: "boolean" }, next: { type: "string" }, param: { type: "string" } },
            required: ["hasMore"],
          },
        },
        required: ["teams", "defaultTeamId"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const result = yield* send("GET", "/v2/teams", {
            query: compact({ limit: args["limit"] ?? 20, until: args["until"] }),
          });
          const teams = Array.isArray(record(result.data)["teams"]) ? (record(result.data)["teams"] as unknown[]) : [];
          return {
            teams: teams.map((team) => {
              const entry = record(team);
              return compact({
                id: entry["id"],
                slug: entry["slug"],
                name: entry["name"] ?? null,
                role: record(entry["membership"])["role"],
              });
            }),
            defaultTeamId: teamId ?? null,
            ...(result.page ? { page: result.page } : {}),
          };
        }),
    },
    {
      name: "list_project_env_vars",
      description:
        "List a project's environment-variable metadata without decrypting or returning values: keys, types, targets, branches, and custom environments.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          teamId: TEAM_ID,
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
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const { data } = yield* send("GET", `/v10/projects/${segment(args["projectId"])}/env`, {
            query: compact({
              teamId: args["teamId"],
              gitBranch: args["gitBranch"],
              customEnvironmentId: args["customEnvironmentId"],
              decrypt: "false",
            }),
          });
          const envs = record(data)["envs"];
          return { variables: (Array.isArray(envs) ? envs : []).map(envMetadata) };
        }),
    },
    {
      name: "upsert_project_env_var",
      description:
        "Create or replace one Vercel project environment variable. Changes affect only future deployments; returns metadata without the value.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          teamId: TEAM_ID,
          key: { type: "string", minLength: 1, maxLength: 256, description: "Environment variable name." },
          value: {
            type: "string",
            maxLength: 65536,
            description: "New value; write input only. Vercel caps a project's environment at 64 KB.",
          },
          type: {
            type: "string",
            enum: ["plain", "encrypted", "sensitive"],
            description: "Storage type. Sensitive values cannot be read back.",
          },
          targets: TARGETS,
          gitBranch: { type: "string", description: "Optional preview-only Git branch." },
          customEnvironmentIds: CUSTOM_ENVIRONMENT_IDS,
          comment: { type: "string", maxLength: 500, description: "Operator-facing note explaining the variable." },
          upsert: {
            type: "boolean",
            description: "Defaults to true. False refuses to overwrite an existing variable.",
          },
        },
        ["projectId", "key", "value", "type", "targets"],
      ),
      outputSchema: ENV_SCHEMA,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const { data } = yield* send("POST", `/v10/projects/${segment(args["projectId"])}/env`, {
            query: compact({ teamId: args["teamId"], upsert: args["upsert"] === false ? "false" : "true" }),
            body: compact({
              key: args["key"],
              value: args["value"],
              type: args["type"],
              target: args["targets"],
              gitBranch: args["gitBranch"],
              customEnvironmentIds: args["customEnvironmentIds"],
              comment: args["comment"],
            }),
          });
          const payload = record(data);
          const failed = Array.isArray(payload["failed"]) ? payload["failed"] : [];
          if (failed.length > 0) {
            // Vercel's message can quote the existing value: only a reviewed code is named.
            const code = reviewedCode(record(record(failed[0])["error"])["code"]);
            throw new ConnectorCallError(
              "invalid_args",
              code === "ENV_ALREADY_EXISTS" || code === "ENV_CONFLICT"
                ? `Vercel ${code}: a variable with this key already targets one of these environments. Pass upsert: true to replace it, or update it by id with update_project_env_var.`
                : `Vercel rejected the environment-variable write${code ? ` (${code})` : ""}; its message is withheld because it can quote stored values.`,
            );
          }
          const created = Array.isArray(payload["created"]) ? payload["created"][0] : payload["created"];
          const result = envMetadata(created ?? payload);
          if (!result["id"] || !result["key"] || !result["type"]) {
            throw new ConnectorCallError(
              "connector_call_failed",
              "Vercel accepted the environment-variable write without returning the created variable.",
              { retryable: false },
            );
          }
          return result;
        }),
    },
    {
      name: "update_project_env_var",
      description:
        "Update one Vercel project environment variable by id, sending only the fields that change. Deployments keep their previous values.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          teamId: TEAM_ID,
          envVarId: ENV_VAR_ID,
          key: { type: "string", minLength: 1, maxLength: 256, description: "Replacement variable name." },
          value: { type: "string", maxLength: 65536, description: "Replacement value; write input only." },
          type: { type: "string", enum: ["plain", "encrypted", "sensitive"], description: "Replacement storage type." },
          targets: { ...TARGETS, description: "Replacement default environments." },
          gitBranch: { type: ["string", "null"], description: "Replacement preview branch, or null to clear it." },
          customEnvironmentIds: { ...CUSTOM_ENVIRONMENT_IDS, description: "Replacement custom environment ids." },
          comment: { type: "string", maxLength: 500, description: "Replacement operator-facing note." },
        },
        ["projectId", "envVarId"],
      ),
      outputSchema: ENV_SCHEMA,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
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
            invalid(
              "Nothing to update: provide key, value, type, targets, gitBranch, customEnvironmentIds, or comment.",
            );
          }
          const { data } = yield* send(
            "PATCH",
            `/v9/projects/${segment(args["projectId"])}/env/${segment(args["envVarId"])}`,
            { query: compact({ teamId: args["teamId"] }), body },
          );
          return envMetadata(data);
        }),
    },
    {
      name: "delete_project_env_var",
      description:
        "Delete one environment variable from a Vercel project by id. Existing deployments keep their embedded value; future deployments do not.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed({ projectId: PROJECT_ID, teamId: TEAM_ID, envVarId: ENV_VAR_ID }, ["projectId", "envVarId"]),
      outputSchema: {
        type: "object",
        properties: { deleted: { type: "boolean" }, envVarId: { type: "string" } },
        required: ["deleted", "envVarId"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          yield* send("DELETE", `/v9/projects/${segment(args["projectId"])}/env/${segment(args["envVarId"])}`, {
            query: compact({ teamId: args["teamId"] }),
          });
          return { deleted: true, envVarId: args["envVarId"] };
        }),
    },
    {
      name: "get_deployment_build_logs",
      description:
        "Read a deployment's build events and log lines, without following live output. Bounded by limit and 1 MB; filter by build, time, or direction.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          deploymentId: { type: "string", minLength: 1, description: "Deployment id (dpl_…) or hostname." },
          teamId: TEAM_ID,
          buildId: { type: "string", minLength: 1, description: "Only this build's events (bld_…)." },
          direction: {
            type: "string",
            enum: ["forward", "backward"],
            description: "forward (default) reads oldest first; backward reads the newest first.",
          },
          limit: { type: "integer", minimum: 1, maximum: 2000, description: "Most events; default 200." },
          since: { type: "number", description: "Only events at or after this millisecond timestamp." },
          until: { type: "number", description: "Only events at or before this millisecond timestamp." },
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
                created: { type: "number" },
                type: { type: "string", description: "stdout, stderr, command, exit, deployment-state, and so on." },
                text: { type: "string" },
                textTruncated: { type: "boolean" },
                info: { type: "object", description: "Build step, entrypoint, and path when Vercel sends them." },
              },
            },
          },
          truncated: { type: "boolean", description: "True when the 1 MB or time cap stopped the read early." },
        },
        required: ["events", "truncated"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const call = makeCall("GET", `/v3/deployments/${segment(args["deploymentId"])}/events`, {
            query: compact({
              teamId: args["teamId"],
              name: args["buildId"],
              direction: args["direction"],
              limit: args["limit"] ?? 200,
              since: args["since"],
              until: args["until"],
              follow: 0,
            }),
          });
          const { rows, stopped } = yield* boundedRows(call, { waitMs: 20_000 });
          return {
            events: rows.map((row) => {
              const event = record(row);
              const payload = record(event["payload"]);
              const raw = isRecord(payload["info"])
                ? payload["info"]
                : isRecord(event["info"])
                  ? event["info"]
                  : undefined;
              const info = raw
                ? compact({
                    type: text(raw["type"]),
                    name: text(raw["name"]),
                    step: text(raw["step"]),
                    entrypoint: text(raw["entrypoint"]),
                    path: text(raw["path"]),
                    readyState: text(raw["readyState"]),
                  })
                : undefined;
              return compact({
                created: event["created"] ?? payload["created"] ?? payload["date"],
                type: event["type"],
                ...clamp(payload["text"] ?? event["text"]),
                info,
              });
            }),
            truncated: stopped !== "end",
          };
        }),
    },
    {
      name: "get_runtime_logs",
      description:
        "Collect a deployment's runtime log stream for at most waitMs or maxRows, then stop. Returns level, message, request path, and status per row.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          projectId: PROJECT_ID,
          deploymentId: { type: "string", minLength: 1, description: "Deployment id (dpl_…)." },
          teamId: TEAM_ID,
          waitMs: {
            type: "integer",
            minimum: 1000,
            maximum: 20000,
            description: "How long to collect the stream; default 5000.",
          },
          maxRows: { type: "integer", minimum: 1, maximum: 1000, description: "Most rows returned; default 200." },
          levels: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "string",
              enum: ["debug", "info", "warning", "error", "fatal", "trace"],
              description: "A log level to keep.",
            },
            description: "Keep only these levels.",
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
                timestampInMs: { type: "number" },
                level: { type: "string" },
                source: { type: "string" },
                text: { type: "string" },
                textTruncated: { type: "boolean" },
                requestMethod: { type: "string" },
                requestPath: { type: "string" },
                responseStatusCode: { type: "number" },
                domain: { type: "string" },
              },
            },
          },
          stopped: {
            type: "string",
            enum: ["end", "time", "bytes", "rows"],
            description: "Why collection stopped.",
          },
        },
        required: ["logs", "stopped"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const call = makeCall(
            "GET",
            `/v1/projects/${segment(args["projectId"])}/deployments/${segment(args["deploymentId"])}/runtime-logs`,
            { query: compact({ teamId: args["teamId"] }) },
          );
          const waitMs = typeof args["waitMs"] === "number" ? args["waitMs"] : 5_000;
          const maxRows = typeof args["maxRows"] === "number" ? args["maxRows"] : 200;
          const levels = Array.isArray(args["levels"]) ? new Set(args["levels"]) : undefined;
          const keep = (row: unknown) => !levels || levels.has(record(row)["level"]);
          const { rows, stopped } = yield* boundedRows(call, { waitMs, maxRows, accept: keep });
          const logs = rows
            .map(record)
            .filter(keep)
            .map((row) =>
              compact({
                timestampInMs: row["timestampInMs"],
                level: row["level"],
                source: row["source"],
                ...clamp(row["message"]),
                requestMethod: row["requestMethod"],
                requestPath: row["requestPath"],
                responseStatusCode: row["responseStatusCode"],
                domain: row["domain"],
              }),
            );
          return { logs: logs.slice(0, maxRows), stopped: logs.length > maxRows ? "rows" : stopped };
        }),
    },
    {
      name: "vercel_api_upload",
      description:
        "Upload explicit text or base64 bytes to a Vercel octet-stream operation, such as POST /v2/files for deployment files. Reads no local files.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          method: { type: "string", enum: ["POST", "PUT"], description: "The operation's HTTP method." },
          path: {
            type: "string",
            minLength: 2,
            maxLength: 2048,
            description: "Concrete path of an octet-stream operation from vercel_api_search, e.g. /v2/files.",
          },
          query: { type: "object", description: "Query parameters as JSON, named as vercel_api_details lists them." },
          contentType: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Content-Type of the bytes; default application/octet-stream.",
          },
          textBody: { type: "string", description: "Raw UTF-8 body. Exclusive with base64Body." },
          base64Body: { type: "string", description: "Base64-encoded bytes. Exclusive with textBody." },
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "integer", description: "HTTP status." },
          data: { description: "Vercel's response body." },
          digest: { type: "string", description: "SHA-1 of the bytes, sent as x-vercel-digest for /v2/files." },
        },
        required: ["status", "data"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const call = makeCall(args["method"] as RestMethod, String(args["path"]), {
            query: isRecord(args["query"]) ? args["query"] : {},
          });
          const framing = vercelIndex.bodyType(call.op) ?? "";
          if (!/octet-stream|^multipart\//.test(framing))
            invalid(`${call.method} ${call.op.path} is not an upload; call it with vercel_api_write.`);
          const refusal = refuse(call);
          if (refusal) invalid(refusal);
          const bytes = decodeUpload(args);
          yield* admit(call);
          yield* promise(() => refuseWithheldUpload(bytes, "Vercel"));
          vercelIndex.check(call.op, call.query, String(args["base64Body"] ?? args["textBody"]));
          const digest = call.op.path === "/v2/files" ? yield* promise(() => sha1(bytes)) : undefined;
          const answer = yield* connection.sendPath(
            {
              method: call.method,
              path: call.path,
              template: call.op.path,
              query: queryPairs(call),
              headers: {
                "Content-Type":
                  typeof args["contentType"] === "string" ? args["contentType"] : "application/octet-stream",
                ...(digest ? { "x-vercel-digest": digest } : {}),
              },
              rawBody: new Uint8Array(bytes),
            },
            { flags: { upload: true } },
          );
          return { status: answer.status, data: answer.data ?? null, ...(digest ? { digest } : {}) };
        }),
    },
  ];

  return [
    ...restKitTools({
      vendor: "vercel",
      title: "Vercel",
      index: vercelIndex,
      valueSafety: vercelSafety,
      readPosts: READ_POSTS,
      refuse,
      checkServer,
      scope: (call) => scope(call, teamId),
      upload: "Send raw bytes with vercel_api_upload.",
      connection,
      send: (call) => sendVercel(connection, call),
    }),
    ...declarations.map((declaration) => {
      const spec = {
        name: declaration.name,
        description: declaration.description,
        input: schema(declaration.inputSchema),
        output: schema(declaration.outputSchema),
        run: (args: unknown) =>
          declaration
            .run(args as JsonRecord)
            .pipe(
              Effect.catchDefect((error) =>
                error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
              ),
            ),
      };
      const tool = declaration.annotations.readOnlyHint
        ? read(connection, spec)
        : write(connection, { ...spec, destructive: true });
      Object.assign(tool, {
        inputSchema: catalogOrder(tool.inputSchema, declaration.inputSchema),
        outputSchema: catalogOrder(tool.outputSchema, declaration.outputSchema),
      });
      return tool;
    }),
  ];
}
