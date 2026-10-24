// Curated, projected tools; the standard hatch covers the pinned REST API.
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { list, read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { RequestSecrets } from "../../http/services.js";
import type { JsonSchema } from "../../types.js";
import { checked, schema } from "../_shared/rest/kit.js";
import type { Operation } from "../_shared/rest/operation-index.js";
import { inspectGraphqlQuery } from "./lib/graphql.js";
import {
  cloudflareRuntime,
  cloudflareIndex,
  SAFETY,
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
import { cloudflarePage } from "../../http/hatch-paging.js";
import { isMinChars, isMaxChars } from "../../http/json-schema.js";
type JsonRecord = Record<string, unknown>;
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
          data: {
            description: "Cloudflare's response envelope after value safety: result, errors, messages, success.",
          },
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
          const { status, data } = yield* runtime.sendEnvelope(preparedUpload);
          return { status, data };
        }),
    },
  ];

  return [
    ...["accounts", "zones"].map((noun) => {
      const zone = noun === "zones";
      const filters = {
        name: Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(zone ? 253 : 200)).annotate({
            description: zone ? "Exact domain name, e.g. example.com." : "Exact account name.",
          }),
        ),
        ...(zone
          ? {
              status: Schema.optionalKey(Schema.Literals(["initializing", "pending", "active", "moved"])),
              accountId: Schema.optionalKey(
                Schema.String.check(isMinChars(1), isMaxChars(64)).annotate({
                  description: "Only zones in this account.",
                }),
              ),
            }
          : {}),
      };
      const row = Schema.Struct(
        zone
          ? {
              id: Schema.optionalKey(Schema.String),
              name: Schema.optionalKey(Schema.String),
              status: Schema.optionalKey(Schema.NullOr(Schema.String)),
              paused: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
              type: Schema.optionalKey(Schema.NullOr(Schema.String)),
              accountId: Schema.optionalKey(Schema.NullOr(Schema.String)),
              accountName: Schema.optionalKey(Schema.NullOr(Schema.String)),
              nameServers: Schema.optionalKey(Schema.Array(Schema.String)),
              plan: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }
          : {
              id: Schema.optionalKey(Schema.String),
              name: Schema.optionalKey(Schema.String),
              type: Schema.optionalKey(Schema.NullOr(Schema.String)),
            },
      );
      const tool = list(connection, {
        name: `list_${noun}`,
        description: zone
          ? "List Cloudflare zones (domains) by name, status or account; only pinned zones. Resolves domain names to zone/account ids for DNS, cache and analytics."
          : "List Cloudflare accounts by name; only pinned accounts. Resolves account ids for zones, Workers, KV and R2.",
        filters,
        row,
        limit: { default: 20, max: 50, description: "Results per page: 5 to 50; default 20." },
        cursor: "bound",
        total: true,
        page: (args, cursor) =>
          Effect.gen(function* () {
            if (args.limit < 5)
              yield* checked(() => invalid("Cloudflare account and zone lists require limit from 5 to 50."));
            const page = cursor === undefined ? 1 : Number(cursor);
            if (!Number.isSafeInteger(page) || page < 1)
              yield* checked(() => invalid("This cursor contains no valid Cloudflare page."));
            const query: JsonRecord = { page, per_page: args.limit };
            if (args.name !== undefined) query["name"] = args.name;
            if ("status" in args && args.status !== undefined) query["status"] = args.status;
            if ("accountId" in args && args.accountId !== undefined) query["account.id"] = args.accountId;
            const answer = yield* runtime.sendEnvelope(runtime.call("GET", `/${noun}`, { query }));
            const body = record(answer.data),
              info = record(body["result_info"]);
            const rows = body["result"];
            if (!Array.isArray(rows))
              yield* checked(() => {
                throw new ConnectorCallError(
                  "connector_call_failed",
                  "Cloudflare returned a list without a result array.",
                  { retryable: false },
                );
              });
            const next = yield* checked(() => cloudflarePage.next(body, { path: `/${noun}`, query, headers: {} }));
            const total = pin ? undefined : info["total_count"];
            if (total !== undefined && (!Number.isSafeInteger(total) || (total as number) < 0))
              yield* checked(() => {
                throw new ConnectorCallError(
                  "connector_call_failed",
                  "Cloudflare returned an invalid exact list total.",
                  { retryable: false },
                );
              });
            return {
              rows: (rows as unknown[]).map((item) =>
                zone
                  ? projectZone(item)
                  : { id: record(item)["id"], name: record(item)["name"], type: record(item)["type"] ?? null },
              ),
              page: {
                hasMore: next !== undefined && next !== null,
                nextCursor: typeof next === "number" ? String(next) : null,
                ...(typeof total === "number" ? { total } : {}),
              },
            };
          }),
      });
      (tool.inputSchema as { properties: Record<string, { minimum?: number }> }).properties["limit"]!.minimum = 5;
      return tool;
    }),
    ...declarations.map((declaration) => {
      const spec = {
        writeSteps: WRITE_STEPS,
        name: declaration.name,
        description: declaration.description,
        input:
          Object.keys(declaration.inputSchema.properties ?? {}).length === 0
            ? Schema.Struct({})
            : schema(declaration.inputSchema),
        output: schema(declaration.outputSchema),
        run: (args: unknown) => declaration.run(args as JsonRecord),
      };
      const tool = declaration.annotations.readOnlyHint
        ? read(connection, {
            fields: true,
            ...spec,
            review:
              "Credential verification, GraphQL query-only inspection and account/zone lists are read-only; every pin is checked before dispatch.",
          })
        : write(connection, { ...spec, destructive: true });
      return tool;
    }),
  ];
}
