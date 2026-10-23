// Named tools and projections retain their legacy catalog while the kit owns dispatch.
import { Effect, Schema } from "effect";
import { read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { RequestSecrets } from "../../http/services.js";
import type { JsonSchema } from "../../types.js";
import { checked, restKitTools, schema, catalogOrder } from "../_shared/rest/kit.js";
import type { Operation } from "../_shared/rest/operation-index.js";
import { inspectGraphqlQuery } from "./lib/graphql.js";
import {
  cloudflareRuntime,
  cloudflareIndex,
  SAFETY,
  READ_POSTS,
  WRITE_STEPS,
  UPLOADS,
  HEADERS,
  RawUpload,
  bytesFromBase64,
  record,
  text,
  invalid,
  describeErrors,
} from "./api.js";
import { settings } from "./api.js";
import type { CloudflareOptions } from "./index.js";
type JsonRecord = Record<string, unknown>;
const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  description: "Pass next as the param query argument for the following page.",
  properties: {
    hasMore: { type: "boolean", description: "Whether another page exists." },
    next: { type: "string", description: "The next page number or cursor." },
    param: { type: "string", description: "The query parameter that takes next." },
  },
  required: ["hasMore"],
};

const PAGING_INPUT: Record<string, JsonSchema> = {
  page: { type: "integer", minimum: 1, maximum: 10_000, description: "Page number; default 1." },
  perPage: {
    type: "integer",
    minimum: 5,
    maximum: 50,
    description: "Results per page; default 20, Cloudflare's max 50.",
  },
};

function closed(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export function cloudflareTools({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<CloudflareOptions>;
}) {
  const configured = settings(options),
    pin = configured.pin,
    operations = cloudflareIndex;
  const runtime = cloudflareRuntime(connection, configured);
  const projectZone = (value: unknown): JsonRecord => {
    const zone = record(value);
    const account = record(zone["account"]);
    return {
      id: zone["id"],
      name: zone["name"],
      status: zone["status"] ?? null,
      paused: zone["paused"] ?? null,
      type: zone["type"] ?? null,
      accountId: account["id"] ?? null,
      accountName: account["name"] ?? null,
      nameServers: Array.isArray(zone["name_servers"]) ? zone["name_servers"] : [],
      plan: record(zone["plan"])["name"] ?? null,
    };
  };

  const declarations = [
    {
      name: "verify_credential",
      description:
        "Verify the configured Cloudflare credential and report its status. Call this first when another call fails with auth_required.",
      annotations: { readOnlyHint: true },
      inputSchema: closed({}),
      outputSchema: {
        type: "object",
        properties: {
          auth: { type: "string", enum: ["apiToken", "globalApiKey"] },
          status: { type: ["string", "null"], description: '"active" for a usable credential.' },
          id: { type: ["string", "null"] },
          email: { type: ["string", "null"], description: "The Global API Key's user." },
          expiresOn: { type: ["string", "null"] },
          scope: { type: "string", enum: ["user", "account"], description: "Who owns the token." },
          accountId: { type: "string" },
        },
        required: ["auth", "status", "scope"],
      },
      run: () => runtime.verify(),
    },
    {
      name: "list_accounts",
      description:
        "List the Cloudflare accounts this credential reaches (only pinned ones when the connector is pinned). Supplies account ids for /accounts/{account_id} paths.",
      annotations: { readOnlyHint: true },
      inputSchema: closed({
        name: { type: "string", minLength: 1, maxLength: 200, description: "Exact account name." },
        ...PAGING_INPUT,
      }),
      outputSchema: {
        type: "object",
        properties: {
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" }, type: { type: "string" } },
            },
          },
          page: PAGE_SCHEMA,
        },
        required: ["accounts"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const query: JsonRecord = { page: args["page"] ?? 1, per_page: args["perPage"] ?? 20 };
          if (typeof args["name"] === "string") query["name"] = args["name"];
          const { data, page: next } = yield* runtime.read("GET", "/accounts", { query });
          return {
            accounts: (Array.isArray(data) ? data : []).map((item) => {
              const account = record(item);
              return { id: account["id"], name: account["name"], type: account["type"] ?? null };
            }),
            ...(next ? { page: next } : {}),
          };
        }),
    },
    {
      name: "list_zones",
      description:
        "List Cloudflare zones (domains) by name, status, or account; only pinned ones when the connector is pinned. Supplies zone ids for /zones/{zone_id} paths.",
      annotations: { readOnlyHint: true },
      inputSchema: closed({
        name: { type: "string", minLength: 1, maxLength: 253, description: "Exact domain name, e.g. example.com." },
        status: {
          type: "string",
          enum: ["initializing", "pending", "active", "moved"],
          description: "Only zones in this status.",
        },
        accountId: { type: "string", minLength: 1, maxLength: 64, description: "Only zones in this account." },
        ...PAGING_INPUT,
      }),
      outputSchema: {
        type: "object",
        properties: {
          zones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                status: { type: ["string", "null"] },
                accountId: { type: ["string", "null"] },
                nameServers: { type: "array" },
              },
            },
          },
          page: PAGE_SCHEMA,
        },
        required: ["zones"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const query: JsonRecord = { page: args["page"] ?? 1, per_page: args["perPage"] ?? 20 };
          if (typeof args["name"] === "string") query["name"] = args["name"];
          if (typeof args["status"] === "string") query["status"] = args["status"];
          if (typeof args["accountId"] === "string") query["account.id"] = args["accountId"];
          const { data, page: next } = yield* runtime.read("GET", "/zones", { query });
          return { zones: (Array.isArray(data) ? data : []).map(projectZone), ...(next ? { page: next } : {}) };
        }),
    },
    {
      name: "graphql_query",
      description:
        "Run a read-only GraphQL Analytics API query (POST /graphql). Mutations and subscriptions are refused before sending; filter by zoneTag or accountTag.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          query: { type: "string", minLength: 1, maxLength: 20_000, description: "A GraphQL query document." },
          variables: { type: "object", description: "Variables the query declares, as JSON." },
          operationName: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Which query to run when the document has several.",
          },
        },
        ["query"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          data: { description: "The query result." },
          errors: { type: "array", description: "GraphQL errors, when Cloudflare returned partial data." },
        },
        required: ["data"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const source = String(args["query"]);
          const variables = record(args["variables"]);
          const scoped = yield* checked(() =>
            inspectGraphqlQuery(source, variables, {
              strict: pin !== undefined,
              ...(typeof args["operationName"] === "string" ? { operationName: args["operationName"] } : {}),
            }),
          );
          if (pin) {
            yield* checked(() => {
              if (scoped.openTags.length > 0) {
                invalid(
                  `A pinned connector filters GraphQL by zoneTag or accountTag equality or _in, not ${scoped.openTags.join(", ")}.`,
                );
              }
              if (scoped.unscopedFields.length > 0 || scoped.accountTags.length + scoped.zoneTags.length === 0) {
                invalid(
                  "A pinned connector's GraphQL queries filter every accounts and zones field by a pinned accountTag or zoneTag.",
                );
              }
              for (const account of scoped.accountTags) runtime.assertAccount(account);
            });
            for (const zone of scoped.zoneTags) yield* runtime.assertZone(zone);
          }
          const graphql: Operation = Object.freeze({
            method: "POST",
            path: "/graphql",
            operationId: "graphql",
            summary: "GraphQL Analytics API",
            tag: "graphql",
            server: undefined,
            row: -1,
          });
          const body: JsonRecord = { query: source };
          if (args["variables"] !== undefined) body["variables"] = variables;
          if (typeof args["operationName"] === "string") body["operationName"] = args["operationName"];
          const response = yield* runtime.send({
            method: "POST",
            path: "/graphql",
            op: graphql,
            params: {},
            query: {},
            body,
          });
          const document = record(response.data);
          const errors = Array.isArray(document["errors"]) ? document["errors"] : [];
          if ((document["data"] === undefined || document["data"] === null) && errors.length > 0) {
            const redacted = (yield* RequestSecrets).redact(errors) as Parameters<typeof describeErrors>[0];
            return yield* checked(() => invalid(`Cloudflare GraphQL rejected the query: ${describeErrors(redacted)}`));
          }
          return { data: document["data"] ?? null, ...(errors.length > 0 ? { errors } : {}) };
        }),
    },
    {
      name: "cloudflare_api_upload",
      description:
        "Upload text, base64 bytes, or multipart parts to a reviewed Cloudflare upload operation. Covers Workers scripts, KV values, R2 objects, Pages, Images, Stream, DNS import, and Snippets; never reads local files.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          method: { type: "string", enum: ["POST", "PUT", "PATCH"], description: "The operation's HTTP method." },
          path: {
            type: "string",
            minLength: 2,
            maxLength: 2048,
            description: "Concrete path from cloudflare_api_search; encode a / inside an R2 or KV key as %2F.",
          },
          query: { type: "object", description: "Query parameters as JSON, named as details lists them." },
          headers: {
            type: "object",
            description: "Optional R2 headers.",
            properties: Object.fromEntries(
              Object.entries(HEADERS).map(([name, description]) => [
                name,
                { type: "string", minLength: 1, maxLength: 40, description },
              ]),
            ),
            additionalProperties: false,
          },
          contentType: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Content-Type of a text or base64 body.",
          },
          textBody: { type: "string", description: "A UTF-8 body; exclusive with base64Body and parts." },
          base64Body: { type: "string", description: "Body bytes as base64; exclusive with textBody and parts." },
          parts: {
            type: "array",
            maxItems: 100,
            description: "multipart/form-data parts; a part with fileName is sent as a file.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", minLength: 1, maxLength: 200, description: "Form field name, e.g. metadata." },
                text: { type: "string", description: "Text value; exclusive with base64." },
                base64: { type: "string", description: "Bytes as base64; exclusive with text." },
                fileName: {
                  type: "string",
                  minLength: 1,
                  maxLength: 500,
                  description: "Send as a file with this name.",
                },
                contentType: { type: "string", minLength: 1, maxLength: 200, description: "The part's Content-Type." },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "integer", description: "HTTP status." },
          data: { description: "Cloudflare's result." },
        },
        required: ["status", "data"],
      },
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const preparedUpload = yield* checked(() => {
            const method = String(args["method"]) as "POST" | "PUT" | "PATCH";
            const prepared = runtime.call(method, String(args["path"]), {
              query: record(args["query"]),
              ...(Object.keys(record(args["headers"])).length
                ? { headers: record(args["headers"]) as Record<string, string> }
                : {}),
            });
            const refusal = SAFETY.refusal(prepared.method, prepared.op.path) ?? runtime.refuse(prepared);
            if (refusal) invalid(refusal);
            if (!UPLOADS.some(([verb, template]) => verb === prepared.op.method && template === prepared.op.path)) {
              invalid(
                `${prepared.op.method} ${prepared.op.path} is not a reviewed upload operation; JSON writes go through cloudflare_api_write.`,
              );
            }
            const accepted = operations
              .contract(prepared.op)
              .parameters.filter((parameter) => parameter.in === "query");
            for (const name of Object.keys(prepared.query)) {
              if (!accepted.some((parameter) => parameter.name === name)) {
                invalid(
                  `${prepared.op.path} has no query parameter ${name}; it accepts ${accepted.map((parameter) => parameter.name).join(", ") || "none"}.`,
                );
              }
            }
            const parts = Array.isArray(args["parts"]) ? args["parts"].map(record) : [];
            const textBody = typeof args["textBody"] === "string" ? args["textBody"] : undefined;
            const base64Body = typeof args["base64Body"] === "string" ? args["base64Body"] : undefined;
            if (Number(parts.length > 0) + Number(textBody !== undefined) + Number(base64Body !== undefined) !== 1) {
              invalid("cloudflare_api_upload needs exactly one body: textBody, base64Body, or parts.");
            }
            let upload: RawUpload;
            if (parts.length > 0) {
              const form = new FormData();
              for (const part of parts) {
                const name = String(part["name"]);
                const value = typeof part["text"] === "string" ? part["text"] : undefined;
                const bytes = typeof part["base64"] === "string" ? part["base64"] : undefined;
                if (Number(value !== undefined) + Number(bytes !== undefined) !== 1) {
                  invalid(`Multipart part ${name} needs exactly one of text or base64.`);
                }
                const fileName = text(part["fileName"]);
                const type = text(part["contentType"]);
                if (fileName || type || bytes !== undefined) {
                  const blob = new Blob([value ?? bytesFromBase64(bytes!, `part ${name}`)], {
                    type: type ?? "application/octet-stream",
                  });
                  form.append(name, blob, fileName ?? name);
                } else {
                  form.append(name, value!);
                }
              }
              upload = new RawUpload(form, undefined);
            } else {
              upload = new RawUpload(
                textBody ?? bytesFromBase64(base64Body!, "base64Body"),
                text(args["contentType"]) ??
                  (textBody !== undefined ? "text/plain; charset=utf-8" : "application/octet-stream"),
              );
            }
            return { ...prepared, body: upload };
          });
          const { status, data } = yield* runtime.send(preparedUpload);
          return { status, data };
        }),
    },
  ];

  return [
    ...restKitTools({
      vendor: "cloudflare",
      title: "Cloudflare",
      index: operations,
      valueSafety: SAFETY,
      readPosts: READ_POSTS,
      headers: HEADERS,
      textBodies: true,
      path: runtime.fillDefaults,
      scope: runtime.scope,
      refuse: runtime.refuse,
      checkServer: runtime.checkServer,
      pathExample: "/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records",
      upload: "Send multipart, binary, and file bodies with cloudflare_api_upload.",
      bodyHint: "a string for text, SQL, or script operations, a list of objects for NDJSON",
      connection,
      writeSteps: WRITE_STEPS,
      send: runtime.send,
    }),
    ...declarations.map((declaration) => {
      const spec = {
        writeSteps: WRITE_STEPS,
        name: declaration.name,
        description: declaration.description,
        input:
          Object.keys(declaration.inputSchema.properties ?? {}).length === 0
            ? Schema.Record(Schema.String, Schema.Never)
            : schema(declaration.inputSchema),
        output: schema(declaration.outputSchema),
        run: (args: unknown) => declaration.run(args as JsonRecord),
      };
      const tool = declaration.annotations.readOnlyHint
        ? read(connection, {
            ...spec,
            review:
              "Credential verification, GraphQL query-only inspection and account/zone lists are read-only; every pin is checked before dispatch.",
          })
        : write(connection, { ...spec, destructive: true });
      Object.assign(tool, {
        inputSchema: catalogOrder(tool.inputSchema, declaration.inputSchema),
        outputSchema: catalogOrder(tool.outputSchema, declaration.outputSchema),
      });
      return tool;
    }),
  ];
}
