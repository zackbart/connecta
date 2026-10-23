// Breeze's step-1 tools: preserve catalog, projections, raw modes, and hatch names.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import { Integer, isMinChars, isMaxChars } from "../../http/json-schema.js";
import { RequestSecrets, Classification, type CallServices } from "../../http/services.js";
import { read, write as writeTool } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import {
  asArray,
  asRecord,
  type JsonRecord,
  READ_ENDPOINTS,
  LEGACY_HATCH,
  withoutCalendarFeeds,
  normalizedPath,
  readEndpointFor,
  queryPairs,
} from "./api.js";

const DEFAULT_EVENT_LIMIT = 100;
const DEFAULT_LOG_LIMIT = 100;
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const EmptyInput = Schema.Record(Schema.String, Schema.Never);
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Breeze writes "no time" as MySQL's zero date; a projection says null. */
function timestamp(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "" || value.startsWith("0000-00-00")) {
    return null;
  }
  return value;
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return value === true || value === 1 || value === "1";
}

function idString(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function projectPersonSummary(value: unknown): JsonRecord {
  const person = asRecord(value);
  return compact({
    id: idString(person["id"]),
    firstName: person["first_name"],
    forceFirstName: person["force_first_name"],
    lastName: person["last_name"],
  });
}

function projectFamilyMember(value: unknown): JsonRecord {
  const member = asRecord(value);
  const details = asRecord(member["details"]);
  return compact({
    personId: idString(member["person_id"] ?? details["id"]),
    familyId: idString(member["family_id"]),
    role: member["role_name"],
    firstName: details["first_name"],
    lastName: details["last_name"],
  });
}

/** Drops photo paths; keeps the profile-field `details` map Breeze returned. */
function projectPerson(value: unknown): JsonRecord {
  const person = asRecord(value);
  const family = asArray(person["family"]);
  const details = person["details"];
  return compact({
    ...projectPersonSummary(person),
    nickName: person["nick_name"] || undefined,
    middleName: person["middle_name"] || undefined,
    maidenName: person["maiden_name"] || undefined,
    details: details && typeof details === "object" && !Array.isArray(details) ? details : undefined,
    family: family.length ? family.map(projectFamilyMember) : undefined,
  });
}

function projectProfileFields(value: unknown): JsonRecord[] {
  const fields: JsonRecord[] = [];
  for (const sectionValue of asArray(value)) {
    const section = asRecord(sectionValue);
    for (const fieldValue of asArray(section["fields"])) {
      const field = asRecord(fieldValue);
      const options = asArray(field["options"]).map((optionValue) => {
        const option = asRecord(optionValue);
        return compact({
          optionId: idString(option["option_id"] ?? option["id"]),
          name: option["name"],
        });
      });
      fields.push(
        compact({
          fieldId: idString(field["field_id"]),
          name: field["name"],
          type: field["field_type"],
          section: section["name"],
          options: options.length ? options : undefined,
        }),
      );
    }
  }
  return fields;
}

function projectEvent(value: unknown): JsonRecord {
  const event = asRecord(value);
  return compact({
    id: idString(event["id"]),
    eventId: idString(event["event_id"]),
    name: event["name"],
    calendarId: idString(event["category_id"]),
    startsAt: timestamp(event["start_datetime"]),
    endsAt: timestamp(event["end_datetime"]),
  });
}

function projectContribution(redact: <T>(value: T) => T, value: unknown): JsonRecord {
  const payment = asRecord(value);
  const paidOn = payment["paid_on"];
  const safePaidOn = typeof paidOn === "string" ? redact(paidOn) : undefined;
  return compact({
    id: idString(payment["id"]),
    // Extract only from unchanged public text; a redacted source yields no extracted fragment.
    paidOn:
      safePaidOn === undefined
        ? undefined
        : safePaidOn !== paidOn || safePaidOn.includes("[redacted]")
          ? "[redacted]"
          : (/^\d{4}-\d{2}-\d{2}/.exec(safePaidOn)?.[0] ?? safePaidOn),
    amount: idString(payment["amount"]),
    method: payment["method"],
    methodId: idString(payment["method_id"]),
    personId: idString(payment["person_id"]),
    firstName: payment["first_name"],
    lastName: payment["last_name"],
    envelopeNumber: idString(payment["envelope_number"]),
    batchNumber: idString(payment["num"] ?? payment["batch_num"]),
    note: payment["note"] || undefined,
    funds: asArray(payment["funds"]).map((fundValue) => {
      const fund = asRecord(fundValue);
      return compact({
        fundId: idString(fund["fund_id"]),
        name: fund["fund_name"],
        amount: idString(fund["amount"]),
        taxDeductible: flag(fund["tax_deductible"]),
      });
    }),
  });
}

/**
 * Sum decimal strings in integer cents, so a giving total never inherits
 * floating-point error. Null when any amount is not a plain decimal.
 */
function totalAmount(amounts: unknown[]): string | null {
  let cents = 0;
  for (const amount of amounts) {
    const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount ?? "").trim());
    if (!match) return null;
    const value = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
    cents += match[1] ? -value : value;
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function parsedObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const DETAIL_FIELD_TYPES = new Set(["email", "phone", "address", "family_role"]);

function fieldsJson(value: unknown): string {
  const fields = asArray(value).map((row) => {
    const field = asRecord(row);
    const type = String(field["type"]);
    const needsDetails = DETAIL_FIELD_TYPES.has(type);
    if (needsDetails && !field["details"]) {
      throw new ConnectorCallError(
        "invalid_args",
        `A ${type} field carries its value in details; field ${String(field["fieldId"])} has none.`,
      );
    }
    if (!needsDetails && field["response"] === undefined) {
      throw new ConnectorCallError(
        "invalid_args",
        `A ${type} field needs a response; field ${String(field["fieldId"])} has none.`,
      );
    }
    return compact({
      field_id: field["fieldId"],
      field_type: type,
      response: field["response"] ?? (needsDetails ? true : undefined),
      details: field["details"],
    });
  });
  return JSON.stringify(fields);
}

function requireTrue(payload: unknown, action: string): void {
  if (payload === false) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `Breeze answered false to ${action}. Breeze gives no reason; check the target and confirm the ids with their list tools before any fresh call.`,
      { retryable: false },
    );
  }
}

const matches = (pattern: string) =>
  Schema.makeFilter((value: string) => new RegExp(pattern).test(value), { toJsonSchema: () => ({ pattern }) });
const Result_breeze_api_get = Schema.Struct({
  "result": Schema.Unknown.pipe(
    Schema.annotateKey({ description: "Breeze's response, less calendar feed addresses and embed keys." }),
  ),
});
const Result_breeze_api_mutate = Schema.Struct({
  "result": Schema.Unknown.pipe(
    Schema.annotateKey({ description: "Breeze's response, less calendar feed addresses and embed keys." }),
  ),
});
const Result_get_account_summary = Schema.Struct({
  "id": Schema.optionalKey(Schema.String),
  "name": Schema.String,
  "subdomain": Schema.optionalKey(Schema.String),
  "timezone": Schema.optionalKey(Schema.String),
  "country": Schema.optionalKey(Schema.String),
  "currency": Schema.optionalKey(Schema.String),
});
const Result_list_people = Schema.Struct({
  "people": Schema.Array(
    Schema.Struct({
      "id": Schema.String,
      "firstName": Schema.optionalKey(Schema.String),
      "forceFirstName": Schema.optionalKey(Schema.String.annotate({ description: "Breeze's display first name." })),
      "lastName": Schema.optionalKey(Schema.String),
      "nickName": Schema.optionalKey(Schema.String),
      "middleName": Schema.optionalKey(Schema.String),
      "maidenName": Schema.optionalKey(Schema.String),
      "details": Schema.optionalKey(ObjectValue.annotate({ description: "Values keyed by profile fieldId." })),
      "family": Schema.optionalKey(Schema.Array(ObjectValue)),
    }),
  ),
  "page": Schema.Struct({
    "hasMore": Schema.Boolean.annotate({ description: "True when the page came back full." }),
    "nextCursor": Schema.Union([Schema.String, Schema.Null]),
  }),
});
const Result_get_person = Schema.Struct({
  "id": Schema.String,
  "firstName": Schema.optionalKey(Schema.String),
  "forceFirstName": Schema.optionalKey(Schema.String.annotate({ description: "Breeze's display first name." })),
  "lastName": Schema.optionalKey(Schema.String),
  "nickName": Schema.optionalKey(Schema.String),
  "middleName": Schema.optionalKey(Schema.String),
  "maidenName": Schema.optionalKey(Schema.String),
  "details": Schema.optionalKey(ObjectValue.annotate({ description: "Values keyed by profile fieldId." })),
  "family": Schema.optionalKey(Schema.Array(ObjectValue)),
});
const Result_list_profile_fields = Schema.Struct({
  "fields": Schema.Array(
    Schema.Struct({
      "fieldId": Schema.String,
      "name": Schema.String,
      "type": Schema.String,
      "section": Schema.optionalKey(Schema.String),
      "options": Schema.optionalKey(Schema.Array(ObjectValue)),
    }),
  ),
});
const Result_list_tags = Schema.Struct({
  "tags": Schema.Array(
    Schema.Struct({ "id": Schema.String, "name": Schema.String, "folderId": Schema.optionalKey(Schema.String) }),
  ),
});
const Result_list_events = Schema.Struct({
  "events": Schema.Array(
    Schema.Struct({
      "id": Schema.String.annotate({ description: "Instance id." }),
      "eventId": Schema.optionalKey(Schema.String.annotate({ description: "Series id." })),
      "name": Schema.String,
      "calendarId": Schema.optionalKey(Schema.String),
      "startsAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
      "endsAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    }),
  ),
  "truncated": Schema.Boolean.annotate({ description: "True when the result filled limit; narrow the range." }),
});
const Result_list_calendars = Schema.Struct({
  "calendars": Schema.Array(
    Schema.Struct({ "id": Schema.String, "name": Schema.String, "color": Schema.optionalKey(Schema.String) }),
  ),
});
const Result_list_attendance = Schema.Struct({
  "attendance": Schema.Array(
    Schema.Struct({
      "personId": Schema.String,
      "firstName": Schema.optionalKey(Schema.String),
      "lastName": Schema.optionalKey(Schema.String),
      "checkedInAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
      "checkedOutAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    }),
  ),
});
const Result_list_forms = Schema.Struct({
  "forms": Schema.Array(
    Schema.Struct({
      "id": Schema.String,
      "name": Schema.String,
      "slug": Schema.optionalKey(Schema.String),
      "archived": Schema.optionalKey(Schema.Boolean),
      "createdAt": Schema.optionalKey(Schema.String),
    }),
  ),
});
const Result_list_form_fields = Schema.Struct({
  "fields": Schema.Array(
    Schema.Struct({
      "fieldId": Schema.String,
      "name": Schema.String,
      "type": Schema.optionalKey(Schema.String),
      "options": Schema.optionalKey(Schema.Array(ObjectValue)),
    }),
  ),
});
const Result_list_form_entries = Schema.Struct({
  "entries": Schema.Array(
    Schema.Struct({
      "id": Schema.String,
      "personId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
      "createdAt": Schema.optionalKey(Schema.String),
      "responses": Schema.optionalKey(ObjectValue),
    }),
  ),
});
const Result_list_volunteers = Schema.Struct({
  "volunteers": Schema.Array(
    Schema.Struct({
      "personId": Schema.String,
      "roleIds": Schema.Array(Schema.String),
      "response": Schema.optionalKey(Schema.String),
      "comment": Schema.optionalKey(Schema.String),
      "rsvpedAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    }),
  ),
});
const Result_list_volunteer_roles = Schema.Struct({
  "roles": Schema.Array(
    Schema.Struct({ "id": Schema.String, "name": Schema.String, "quantity": Schema.optionalKey(Schema.Finite) }),
  ),
});
const Result_list_account_log = Schema.Struct({
  "entries": Schema.Array(
    Schema.Struct({
      "id": Schema.String,
      "action": Schema.String,
      "userId": Schema.optionalKey(Schema.String),
      "object": Schema.optionalKey(
        Schema.Unknown.pipe(Schema.annotateKey({ description: "Parsed object_json, usually the affected id." })),
      ),
      "createdAt": Schema.optionalKey(Schema.String),
      "details": Schema.optionalKey(Schema.Unknown),
    }),
  ),
  "truncated": Schema.Boolean.annotate({ description: "True when the result filled limit; narrow the range." }),
});
const Result_list_contributions = Schema.Struct({
  "contributions": Schema.Array(
    Schema.Struct({
      "id": Schema.String,
      "paidOn": Schema.optionalKey(Schema.String),
      "amount": Schema.String,
      "method": Schema.optionalKey(Schema.String),
      "personId": Schema.optionalKey(Schema.String),
      "firstName": Schema.optionalKey(Schema.String),
      "lastName": Schema.optionalKey(Schema.String),
      "batchNumber": Schema.optionalKey(Schema.String),
      "funds": Schema.optionalKey(Schema.Array(ObjectValue)),
    }),
  ),
  "count": Integer,
  "totalAmount": Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Exact decimal sum." }),
});
const Result_list_funds = Schema.Struct({
  "funds": Schema.Array(
    Schema.Struct({
      "id": Schema.String,
      "name": Schema.String,
      "taxDeductible": Schema.optionalKey(Schema.Boolean),
      "isDefault": Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const Result_add_person = Schema.Struct({
  "id": Schema.String,
  "firstName": Schema.optionalKey(Schema.String),
  "forceFirstName": Schema.optionalKey(Schema.String.annotate({ description: "Breeze's display first name." })),
  "lastName": Schema.optionalKey(Schema.String),
  "nickName": Schema.optionalKey(Schema.String),
  "middleName": Schema.optionalKey(Schema.String),
  "maidenName": Schema.optionalKey(Schema.String),
  "details": Schema.optionalKey(ObjectValue.annotate({ description: "Values keyed by profile fieldId." })),
  "family": Schema.optionalKey(Schema.Array(ObjectValue)),
});
const Result_update_person = Schema.Struct({
  "id": Schema.String,
  "firstName": Schema.optionalKey(Schema.String),
  "forceFirstName": Schema.optionalKey(Schema.String.annotate({ description: "Breeze's display first name." })),
  "lastName": Schema.optionalKey(Schema.String),
  "nickName": Schema.optionalKey(Schema.String),
  "middleName": Schema.optionalKey(Schema.String),
  "maidenName": Schema.optionalKey(Schema.String),
  "details": Schema.optionalKey(ObjectValue.annotate({ description: "Values keyed by profile fieldId." })),
  "family": Schema.optionalKey(Schema.Array(ObjectValue)),
});
const Result_assign_tag = Schema.Struct({ "assigned": Schema.Boolean });
const Result_unassign_tag = Schema.Struct({ "unassigned": Schema.Boolean });
const Result_record_check_in = Schema.Struct({ "checkedIn": Schema.Boolean });

/** One explicitly classified GET. No method-derived read verdict and no caller-provided capacity. */
function request(
  connection: Connection,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  verdict: "read" | "write",
  raw = false,
) {
  return Effect.gen(function* () {
    if (verdict !== "read" && verdict !== "write")
      return yield* Effect.die(new Error("A Breeze GET requires an explicit verdict."));
    if (verdict === "write" && (yield* Classification) !== "write")
      return yield* Effect.fail(
        new Refusal({ error: new ConnectorCallError("invalid_args", "A Breeze write cannot run as a read.") }),
      );
    if (verdict === "read") {
      const template = /^\/people\/\d+$/.test(path) ? "/people/{id}" : path;
      const allowed = READ_ENDPOINTS.get(template);
      if (!allowed || Object.keys(query).some((name) => !allowed.includes(name)))
        return yield* Effect.die(new Error("A Breeze read has no reviewed endpoint/parameter verdict."));
    }
    const answer = yield* connection.sendPath(
      {
        method: "GET",
        path,
        template: path,
        query: Object.entries(query).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, String(value)] as const],
        ),
      },
      raw ? { flags: LEGACY_HATCH } : undefined,
    );
    return answer.data;
  });
}

/** Step 1 retains raw's historical output schemas and vendor-shaped malformed-answer behaviour. */
function legacyResult<O extends Schema.Top>(
  output: O,
  run: () => Effect.Effect<unknown, HttpFailure, CallServices>,
): Effect.Effect<O["Type"], HttpFailure, CallServices> {
  void output;
  return Effect.suspend(run).pipe(
    Effect.map((value) => value as O["Type"]),
    Effect.catchDefect((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
}

/** Equivalent legacy catalog spellings until step 2; the Schema still owns every constraint. */
function legacyCatalog(tool: ApiTool): ApiTool {
  const schema = tool.inputSchema as Record<string, any>;
  if (schema.type === "object" && !schema.properties) {
    // Record<string, never> is exactly a closed empty object; Struct({}) also admits scalars.
    const original = { type: "object", properties: {}, required: [], additionalProperties: false };
    Object.keys(schema).forEach((key) => delete schema[key]);
    Object.assign(schema, original);
  }
  const properties = schema.properties;
  if (tool.name === "breeze_api_get" || tool.name === "breeze_api_mutate") {
    const value = properties.query.items.properties.value;
    // All five union branches are disjoint and have no branch-specific constraints.
    properties.query.items.properties.value = {
      type: value.anyOf.map((branch: { type: string }) => branch.type),
      description: value.description,
    };
  }
  if (tool.name === "list_contributions")
    for (const name of ["fundIds", "methodIds", "batchNumbers"]) {
      const { description, ...array } = properties[name];
      properties[name] = { ...array, description };
    }
  return tool;
}

export function breezeTools({
  connection,
  pageSize: defaultPageSize,
}: {
  connection: Connection;
  pageSize: number;
}): ApiTool[] {
  const get = (
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    options?: { raw?: boolean },
  ) => request(connection, path, query, "read", options?.raw);
  const write = (
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    options?: { raw?: boolean },
  ) => request(connection, path, query, "write", options?.raw);
  return [
    read(connection, {
      name: "breeze_api_get",
      description:
        "Call a reviewed Breeze read endpoint and return its response as sent, less calendar feed addresses. Refuses every path and parameter not on the read allowlist, since Breeze writes are GETs too.",
      input: Schema.Struct({
        "path": Schema.String.check(isMinChars(2), isMaxChars(100)).annotate({
          description: "Path below /api, e.g. /tags/list_folders. No query string.",
        }),
        "query": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "name": Schema.String.check(isMinChars(1), isMaxChars(64)).annotate({
                description: "Parameter name, e.g. fields_json.",
              }),
              "value": Schema.Union([
                Schema.String,
                Schema.Finite,
                Schema.Boolean,
                ObjectValue,
                Schema.Array(Schema.Unknown),
              ])

                .annotate({ description: "Value; objects and arrays are JSON-encoded for *_json parameters." }),
            }),
          )
            .check(Schema.isMaxLength(30))
            .annotate({ description: "Query parameters as name/value pairs." }),
        ),
      }),
      output: Result_breeze_api_get,

      run: (args) =>
        legacyResult(Result_breeze_api_get, () =>
          Effect.gen(function* () {
            const path = normalizedPath(args["path"]);
            const allowed = readEndpointFor(path);
            const query = queryPairs(args["query"]);
            const stray = Object.keys(query).filter((name) => !allowed.includes(name));
            if (stray.length) {
              throw new ConnectorCallError(
                "invalid_args",
                `breeze_api_get refuses ${stray.join(", ")} on ${path}; its reviewed parameters are ${allowed.join(", ") || "none"}. Use breeze_api_mutate for anything else.`,
              );
            }
            return { result: withoutCalendarFeeds(path, yield* get(path, query, { raw: true })) };
          }),
        ),
    }),
    writeTool(connection, {
      name: "breeze_api_mutate",
      description:
        "Call any Breeze API endpoint, including writes and undocumented routes, and return its response as sent, less calendar feed addresses. The approval-gated hatch; Breeze takes writes as GET query parameters.",
      input: Schema.Struct({
        "path": Schema.String.check(isMinChars(2), isMaxChars(100)).annotate({
          description: "Path below /api, e.g. /tags/list_folders. No query string.",
        }),
        "query": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "name": Schema.String.check(isMinChars(1), isMaxChars(64)).annotate({
                description: "Parameter name, e.g. fields_json.",
              }),
              "value": Schema.Union([
                Schema.String,
                Schema.Finite,
                Schema.Boolean,
                ObjectValue,
                Schema.Array(Schema.Unknown),
              ])

                .annotate({ description: "Value; objects and arrays are JSON-encoded for *_json parameters." }),
            }),
          )
            .check(Schema.isMaxLength(30))
            .annotate({ description: "Query parameters as name/value pairs." }),
        ),
      }),
      output: Result_breeze_api_mutate,
      destructive: true,
      writeSteps: { write: "once" },
      run: (args) =>
        legacyResult(Result_breeze_api_mutate, () =>
          Effect.gen(function* () {
            const path = normalizedPath(args["path"]);
            return { result: withoutCalendarFeeds(path, yield* write(path, queryPairs(args["query"]), { raw: true })) };
          }),
        ),
    }),
    read(connection, {
      name: "get_account_summary",
      description:
        "Get the Breeze account's church name, subdomain, timezone, country, and currency. Use it to read giving amounts in the right currency.",
      input: EmptyInput,
      output: Result_get_account_summary,

      run: (_args) =>
        legacyResult(Result_get_account_summary, () =>
          Effect.gen(function* () {
            const account = asRecord(yield* get("/account/summary", {}));
            const details = asRecord(account["details"]);
            const country = asRecord(details["country"]);
            return compact({
              id: idString(account["id"]),
              name: account["name"],
              subdomain: account["subdomain"],
              timezone: details["timezone"],
              country: country["name"],
              currency: country["currency"],
            });
          }),
        ),
    }),
    read(connection, {
      name: "list_people",
      description:
        "List people in Breeze, optionally filtered by tag or profile-field values, with id and names or full profile details. No name search; filter names in code.",
      input: Schema.Struct({
        "tagId": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
            description: "Only people carrying this tag id from list_tags.",
          }),
        ),
        "filter": Schema.optionalKey(
          ObjectValue.annotate({
            description:
              'Breeze filter_json: profile fieldId to option ids joined by \'-\', e.g. {"2000138015":"226-227"}.',
          }),
        ),
        "includeDetails": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include every profile field (slower, larger). Defaults to false." }),
        ),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)).annotate({
            description: `People per page, 1 to connecta's 1000. Defaults to ${defaultPageSize}.`,
          }),
        ),
        "cursor": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]+$")).annotate({
            description: "Opaque nextCursor from the previous page.",
          }),
        ),
        "raw": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Return Breeze's untouched rows instead of the lean projection." }),
        ),
      }),
      output: Result_list_people,

      run: (args) =>
        legacyResult(Result_list_people, () =>
          Effect.gen(function* () {
            const filter = { ...asRecord(args["filter"]) };
            if (args["tagId"] !== undefined) {
              if (filter["tag_contains"] !== undefined) {
                throw new ConnectorCallError("invalid_args", "Pass tagId or filter.tag_contains, not both.");
              }
              filter["tag_contains"] = `y_${args["tagId"]}`;
            }
            const limit: number = args["limit"] ?? defaultPageSize;
            const offset = args["cursor"] === undefined ? 0 : Number(args["cursor"]);
            const rows = asArray(
              yield* get("/people", {
                details: args["includeDetails"] === true ? 1 : 0,
                filter_json: Object.keys(filter).length ? JSON.stringify(filter) : undefined,
                limit,
                offset,
              }),
            );
            // Breeze returns no total, so a full page is the only "maybe more"
            // signal it gives; the page after an exact multiple comes back empty.
            const hasMore = rows.length >= limit;
            return {
              people: args["raw"] === true ? rows : rows.map(projectPerson),
              page: { hasMore, nextCursor: hasMore ? String(offset + rows.length) : null },
            };
          }),
        ),
    }),
    read(connection, {
      name: "get_person",
      description:
        "Get one person by Breeze id with profile details keyed by fieldId and family members. Decode fieldIds with list_profile_fields.",
      input: Schema.Struct({
        "personId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Breeze person id from list_people.",
        }),
        "includeDetails": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include profile details. Defaults to true." }),
        ),
        "raw": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Return Breeze's untouched rows instead of the lean projection." }),
        ),
      }),
      output: Result_get_person,

      run: (args) =>
        legacyResult(Result_get_person, () =>
          Effect.gen(function* () {
            const payload = yield* get(`/people/${args["personId"]}`, {
              details: args["includeDetails"] === false ? 0 : 1,
            });
            // An account-wide key cannot be refused a person, so an empty answer
            // is an absence rather than a permission gap.
            if (!asRecord(payload)["id"]) {
              throw new ConnectorCallError(
                "not_found",
                `Breeze has no person ${args["personId"]}. Re-read the id from list_people.`,
              );
            }
            return args["raw"] === true ? payload : projectPerson(payload);
          }),
        ),
    }),
    read(connection, {
      name: "list_profile_fields",
      description:
        "List profile fields with fieldId, type, section, and option ids. Decodes person details and builds list_people filters and update_person values.",
      input: Schema.Struct({
        "raw": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Return Breeze's untouched rows instead of the lean projection." }),
        ),
      }),
      output: Result_list_profile_fields,

      run: (args) =>
        legacyResult(Result_list_profile_fields, () =>
          Effect.gen(function* () {
            const payload = yield* get("/profile", {});
            return { fields: args["raw"] === true ? asArray(payload) : projectProfileFields(payload) };
          }),
        ),
    }),
    read(connection, {
      name: "list_tags",
      description:
        "List Breeze tags with id, name, and folder. Tags model groups and lists; pass a tag id to list_people or assign_tag.",
      input: Schema.Struct({
        "folderId": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
            description: "Only tags in this folder. Folders come from breeze_api_get /tags/list_folders.",
          }),
        ),
      }),
      output: Result_list_tags,

      run: (args) =>
        legacyResult(Result_list_tags, () =>
          Effect.gen(function* () {
            return {
              tags: asArray(yield* get("/tags/list_tags", { folder_id: args["folderId"] })).map((value) => {
                const tag = asRecord(value);
                return compact({ id: idString(tag["id"]), name: tag["name"], folderId: idString(tag["folder_id"]) });
              }),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_events",
      description:
        "List event instances between two dates with instance id, series id, calendar, and times. Breeze caches this list for up to 15 minutes.",
      input: Schema.Struct({
        "start": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).annotate({
            description: "First day, YYYY-MM-DD. Defaults to the first of this month.",
          }),
        ),
        "end": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).annotate({
            description: "Last day, YYYY-MM-DD. Defaults to the end of this month.",
          }),
        ),
        "calendarId": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
            description: "Only events on this calendar from list_calendars.",
          }),
        ),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)).annotate({
            description: "Instances returned, 1 to Breeze's 1000. Defaults to 100.",
          }),
        ),
        "raw": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Return Breeze's untouched rows instead of the lean projection." }),
        ),
      }),
      output: Result_list_events,

      run: (args) =>
        legacyResult(Result_list_events, () =>
          Effect.gen(function* () {
            const limit: number = args["limit"] ?? DEFAULT_EVENT_LIMIT;
            const rows = asArray(
              yield* get("/events", {
                start: args["start"],
                end: args["end"],
                category_id: args["calendarId"],
                limit,
              }),
            );
            return {
              events: args["raw"] === true ? rows : rows.map(projectEvent),
              truncated: rows.length >= limit,
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_calendars",
      description:
        "List Breeze event calendars with id, name, and color. Omits each calendar's private iCal feed address, which works without a key.",
      input: EmptyInput,
      output: Result_list_calendars,

      run: (_args) =>
        legacyResult(Result_list_calendars, () =>
          Effect.gen(function* () {
            return {
              calendars: asArray(yield* get("/events/calendars/list", {})).map((value) => {
                const calendar = asRecord(value);
                return compact({
                  id: idString(calendar["id"]) ?? "0",
                  name: calendar["name"],
                  color: calendar["color"],
                });
              }),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_attendance",
      description:
        "List people checked in to one event instance, with check-in and check-out times. Not anonymous head counts; those come from breeze_api_get.",
      input: Schema.Struct({
        "instanceId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Event instance id (list_events id, not eventId).",
        }),
        "includeNames": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Add each attendee's name. Contact details need raw." }),
        ),
        "raw": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Return Breeze's untouched rows instead of the lean projection." }),
        ),
      }),
      output: Result_list_attendance,

      run: (args) =>
        legacyResult(Result_list_attendance, () =>
          Effect.gen(function* () {
            const wantDetails = args["includeNames"] === true || args["raw"] === true;
            const rows = asArray(
              yield* get("/events/attendance/list", {
                instance_id: args["instanceId"],
                type: "person",
                details: wantDetails ? "true" : "false",
              }),
            );
            if (args["raw"] === true) return { attendance: rows };
            return {
              attendance: rows.map((value) => {
                const record = asRecord(value);
                const person = asRecord(record["details"]);
                return compact({
                  personId: idString(record["person_id"]),
                  firstName: person["first_name"],
                  lastName: person["last_name"],
                  checkedInAt: timestamp(record["created_on"]),
                  checkedOutAt: timestamp(record["check_out"]),
                });
              }),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_forms",
      description: "List Breeze forms with id, name, and URL slug. Active forms by default; archived ones on request.",
      input: Schema.Struct({
        "archived": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "List archived forms instead of active ones." }),
        ),
      }),
      output: Result_list_forms,

      run: (args) =>
        legacyResult(Result_list_forms, () =>
          Effect.gen(function* () {
            return {
              forms: asArray(yield* get("/forms/list_forms", { is_archived: args["archived"] === true ? 1 : 0 })).map(
                (value) => {
                  const form = asRecord(value);
                  return compact({
                    id: idString(form["id"]),
                    name: form["name"],
                    slug: form["url_slug"],
                    archived: flag(form["is_archived"]),
                    createdAt: form["created_on"],
                  });
                },
              ),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_form_fields",
      description:
        "List one form's fields with fieldId, name, type, and options. Decodes the responses list_form_entries returns.",
      input: Schema.Struct({
        "formId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Form id from list_forms.",
        }),
      }),
      output: Result_list_form_fields,

      run: (args) =>
        legacyResult(Result_list_form_fields, () =>
          Effect.gen(function* () {
            return {
              // Form fields share the profile-field row shape, minus a section.
              fields: projectProfileFields([
                { fields: yield* get("/forms/list_form_fields", { form_id: args["formId"] }) },
              ]),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_form_entries",
      description:
        "List one form's entries with entry id, person id, and submission time; responses keyed by form fieldId on request. Not paginated.",
      input: Schema.Struct({
        "formId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Form id from list_forms.",
        }),
        "includeResponses": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include each entry's answers keyed by fieldId." }),
        ),
      }),
      output: Result_list_form_entries,

      run: (args) =>
        legacyResult(Result_list_form_entries, () =>
          Effect.gen(function* () {
            return {
              entries: asArray(
                yield* get("/forms/list_form_entries", {
                  form_id: args["formId"],
                  details: args["includeResponses"] === true ? 1 : 0,
                }),
              ).map((value) => {
                const entry = asRecord(value);
                return compact({
                  id: idString(entry["id"]),
                  personId: idString(entry["person_id"]) ?? null,
                  createdAt: entry["created_on"],
                  responses: args["includeResponses"] === true ? entry["response"] : undefined,
                });
              }),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_volunteers",
      description: "List people scheduled to volunteer at one event instance, with their role ids and RSVP state.",
      input: Schema.Struct({
        "instanceId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Event instance id (list_events id, not eventId).",
        }),
      }),
      output: Result_list_volunteers,

      run: (args) =>
        legacyResult(Result_list_volunteers, () =>
          Effect.gen(function* () {
            return {
              volunteers: asArray(yield* get("/volunteers/list", { instance_id: args["instanceId"] })).map((value) => {
                const volunteer = asRecord(value);
                return compact({
                  personId: idString(volunteer["person_id"]),
                  roleIds: asArray(volunteer["role_ids"]).map(String),
                  response: idString(volunteer["response"]),
                  comment: volunteer["comment"] || undefined,
                  rsvpedAt: timestamp(volunteer["rsvped_on"]),
                });
              }),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_volunteer_roles",
      description: "List the volunteer roles defined on one event instance with id, name, and quantity needed.",
      input: Schema.Struct({
        "instanceId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Event instance id (list_events id, not eventId).",
        }),
      }),
      output: Result_list_volunteer_roles,

      run: (args) =>
        legacyResult(Result_list_volunteer_roles, () =>
          Effect.gen(function* () {
            const secrets = yield* RequestSecrets;
            const redact = <T>(value: T): T => secrets.redact(value);
            return {
              roles: asArray(
                yield* get("/volunteers/list_roles", { instance_id: args["instanceId"], show_quantity: 1 }),
              ).map((value) => {
                const role = asRecord(value);
                const quantity = Number(redact(role["quantity"]));
                return compact({
                  id: idString(role["id"]),
                  name: role["name"],
                  quantity: Number.isFinite(quantity) ? quantity : undefined,
                });
              }),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_account_log",
      description:
        "List logged account actions of one type, such as person_updated or contribution_added, with object ids and times. The way to find what changed since a date.",
      input: Schema.Struct({
        "action": Schema.String.check(matches("^[a-z_]+$"), isMaxChars(40)).annotate({
          description: "Logged action, e.g. person_updated, tag_assign, contribution_added; the guide lists all.",
        }),
        "start": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).annotate({
            description: "Only actions on or after this day, YYYY-MM-DD.",
          }),
        ),
        "end": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).annotate({
            description: "Only actions on or before this day, YYYY-MM-DD.",
          }),
        ),
        "userId": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
            description: "Only actions by this Breeze user id.",
          }),
        ),
        "includeDetails": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include Breeze's unstandardized description." }),
        ),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3000)).annotate({
            description: "Rows returned, 1 to Breeze's 3000. Defaults to 100.",
          }),
        ),
      }),
      output: Result_list_account_log,

      run: (args) =>
        legacyResult(Result_list_account_log, () =>
          Effect.gen(function* () {
            const limit: number = args["limit"] ?? DEFAULT_LOG_LIMIT;
            const rows = asArray(
              yield* get("/account/list_log", {
                action: args["action"],
                start: args["start"],
                end: args["end"],
                user_id: args["userId"],
                details: args["includeDetails"] === true ? 1 : 0,
                limit,
              }),
            );
            return {
              entries: rows.map((value) => {
                const entry = asRecord(value);
                return compact({
                  id: idString(entry["id"]),
                  action: entry["action"],
                  userId: idString(entry["user_id"]),
                  object: parsedObject(entry["object_json"]),
                  createdAt: entry["created_on"],
                  details: args["includeDetails"] === true ? entry["details"] : undefined,
                });
              }),
              truncated: rows.length >= limit,
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_contributions",
      description:
        "List giving transactions between two dates with donor, amount, method, batch, and fund split, plus a count and exact total. Undocumented by Breeze since 2023.",
      input: Schema.Struct({
        "start": Schema.String.check(matches("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).annotate({
          description: "First gift date, YYYY-MM-DD.",
        }),
        "end": Schema.String.check(matches("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).annotate({
          description: "Last gift date, YYYY-MM-DD.",
        }),
        "personId": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
            description: "Only this donor's gifts.",
          }),
        ),
        "includeFamily": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "With personId, include the donor's family." }),
        ),
        "amountMin": Schema.optionalKey(
          Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "Gift amount at least this." }),
        ),
        "amountMax": Schema.optionalKey(
          Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "Gift amount at most this." }),
        ),
        "fundIds": Schema.optionalKey(
          Schema.Array(Schema.String.check(matches("^[0-9]+$")).annotate({ description: "Numeric id." }))
            .check(Schema.isMinLength(1), Schema.isMaxLength(50))
            .annotate({ description: "Only gifts to these funds from list_funds." }),
        ),
        "methodIds": Schema.optionalKey(
          Schema.Array(Schema.String.check(matches("^[0-9]+$")).annotate({ description: "Numeric id." }))
            .check(Schema.isMinLength(1), Schema.isMaxLength(50))
            .annotate({ description: "Only these payment method ids." }),
        ),
        "batchNumbers": Schema.optionalKey(
          Schema.Array(Schema.String.check(matches("^[0-9]+$")).annotate({ description: "Numeric id." }))
            .check(Schema.isMinLength(1), Schema.isMaxLength(50))
            .annotate({ description: "Only these batch numbers." }),
        ),
        "envelopeNumber": Schema.optionalKey(
          Schema.String.check(isMaxChars(20)).annotate({ description: "Only this envelope number." }),
        ),
        "raw": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Return Breeze's untouched rows instead of the lean projection." }),
        ),
      }),
      output: Result_list_contributions,

      run: (args) =>
        legacyResult(Result_list_contributions, () =>
          Effect.gen(function* () {
            const secrets = yield* RequestSecrets;
            const redact = <T>(value: T): T => secrets.redact(value);

            if (args["includeFamily"] === true && args["personId"] === undefined) {
              throw new ConnectorCallError("invalid_args", "includeFamily needs a personId.");
            }
            const joined = (value: unknown) => (Array.isArray(value) ? value.join("-") : undefined);
            // Breeze's 2023 table says DD-MM-YYYY while its own example request
            // sends 2022-1-15; the server parses both, so the unambiguous ISO day
            // is what the schema accepts and what goes on the wire.
            const rows = asArray(
              yield* get("/giving/list", {
                start: args["start"],
                end: args["end"],
                person_id: args["personId"],
                include_family: args["includeFamily"] === true ? 1 : undefined,
                amount_min: args["amountMin"],
                amount_max: args["amountMax"],
                fund_ids: joined(args["fundIds"]),
                method_ids: joined(args["methodIds"]),
                batches: joined(args["batchNumbers"]),
                envelope_number: args["envelopeNumber"],
              }),
            );
            return {
              contributions: redact(args["raw"] === true ? rows : rows.map((row) => projectContribution(redact, row))),
              count: rows.length,
              totalAmount: totalAmount(rows.map((row) => redact(asRecord(row)["amount"]))),
            };
          }),
        ),
    }),
    read(connection, {
      name: "list_funds",
      description:
        "List giving funds with id, name, tax-deductible flag, and default flag. Supplies fundIds for list_contributions. Undocumented by Breeze since 2023.",
      input: EmptyInput,
      output: Result_list_funds,

      run: (_args) =>
        legacyResult(Result_list_funds, () =>
          Effect.gen(function* () {
            return {
              funds: asArray(yield* get("/funds/list", {})).map((value) => {
                const fund = asRecord(value);
                return compact({
                  id: idString(fund["id"]),
                  name: fund["name"],
                  taxDeductible: flag(fund["tax_deductible"]),
                  isDefault: flag(fund["is_default"]),
                });
              }),
            };
          }),
        ),
    }),
    writeTool(connection, {
      name: "add_person",
      description:
        "Create a new person profile with a first and last name and optional profile values. Does not check for duplicates; search list_people first.",
      input: Schema.Struct({
        "firstName": Schema.String.check(isMinChars(1), isMaxChars(100)).annotate({ description: "First name." }),
        "lastName": Schema.String.check(isMinChars(1), isMaxChars(100)).annotate({ description: "Last name." }),
        "fields": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "fieldId": Schema.String.check(matches("^[0-9]+$")).annotate({ description: "Profile fieldId." }),
              "type": Schema.Literals([
                "text",
                "textarea",
                "radio",
                "checkbox",
                "date",
                "birthdate",
                "email",
                "phone",
                "address",
                "family_role",
              ]).annotate({ description: "radio covers multiple choice and dropdown." }),
              "response": Schema.optionalKey(
                Schema.Union([Schema.String, Schema.Boolean]).annotate({
                  description: "Text, M/D/YYYY date, or option id; true for detail types.",
                }),
              ),
              "details": Schema.optionalKey(
                ObjectValue.annotate({
                  description:
                    "email {address}; phone {phone_mobile|phone_home|phone_work}; address {street_address,city,state,zip}; family_role {person_id,role_id 1-5}.",
                }),
              ),
            }),
          )
            .check(Schema.isMinLength(1), Schema.isMaxLength(50))
            .annotate({ description: "Profile values to set. fieldId and option ids come from list_profile_fields." }),
        ),
      }),
      output: Result_add_person,
      destructive: false,
      writeSteps: { write: "once" },
      run: (args) =>
        legacyResult(Result_add_person, () =>
          Effect.gen(function* () {
            const payload = yield* write("/people/add", {
              first: args["firstName"],
              last: args["lastName"],
              fields_json: args["fields"] === undefined ? undefined : fieldsJson(args["fields"]),
            });
            const person = Array.isArray(payload) ? payload[0] : payload;
            if (!asRecord(person)["id"]) {
              throw new ConnectorCallError(
                "connector_call_failed",
                "Breeze accepted the new person without returning it; check list_people before retrying so it is not added twice.",
                { retryable: false },
              );
            }
            return projectPerson(person);
          }),
        ),
    }),
    writeTool(connection, {
      name: "update_person",
      description:
        "Set profile values on one person: contact details, multiple choice, dates, text, or family role. Replaces each named field's value.",
      input: Schema.Struct({
        "personId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Breeze person id from list_people.",
        }),
        "fields": Schema.Array(
          Schema.Struct({
            "fieldId": Schema.String.check(matches("^[0-9]+$")).annotate({ description: "Profile fieldId." }),
            "type": Schema.Literals([
              "text",
              "textarea",
              "radio",
              "checkbox",
              "date",
              "birthdate",
              "email",
              "phone",
              "address",
              "family_role",
            ]).annotate({ description: "radio covers multiple choice and dropdown." }),
            "response": Schema.optionalKey(
              Schema.Union([Schema.String, Schema.Boolean]).annotate({
                description: "Text, M/D/YYYY date, or option id; true for detail types.",
              }),
            ),
            "details": Schema.optionalKey(
              ObjectValue.annotate({
                description:
                  "email {address}; phone {phone_mobile|phone_home|phone_work}; address {street_address,city,state,zip}; family_role {person_id,role_id 1-5}.",
              }),
            ),
          }),
        )
          .check(Schema.isMinLength(1), Schema.isMaxLength(50))
          .annotate({ description: "Profile values to set. fieldId and option ids come from list_profile_fields." }),
      }),
      output: Result_update_person,
      destructive: true,
      writeSteps: { write: "once" },
      run: (args) =>
        legacyResult(Result_update_person, () =>
          Effect.gen(function* () {
            const fields = fieldsJson(args["fields"]);
            const payload = yield* write("/people/update", { person_id: args["personId"], fields_json: fields });
            requireTrue(payload, "the person update");
            const person = Array.isArray(payload) ? payload[0] : payload;
            return asRecord(person)["id"] ? projectPerson(person) : { id: String(args["personId"]) };
          }),
        ),
    }),
    writeTool(connection, {
      name: "assign_tag",
      description:
        "Add one tag to one person. Tag ids come from list_tags; adding a tag the person already has changes nothing.",
      input: Schema.Struct({
        "personId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Breeze person id from list_people.",
        }),
        "tagId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Tag id from list_tags.",
        }),
      }),
      output: Result_assign_tag,
      destructive: false,
      writeSteps: { write: "once" },
      run: (args) =>
        legacyResult(Result_assign_tag, () =>
          Effect.gen(function* () {
            requireTrue(
              yield* write("/tags/assign", { person_id: args["personId"], tag_id: args["tagId"] }),
              "the tag assignment",
            );
            return { assigned: true };
          }),
        ),
    }),
    writeTool(connection, {
      name: "unassign_tag",
      description: "Remove one tag from one person. The tag itself and its other people are untouched.",
      input: Schema.Struct({
        "personId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Breeze person id from list_people.",
        }),
        "tagId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Tag id from list_tags.",
        }),
      }),
      output: Result_unassign_tag,
      destructive: true,
      writeSteps: { write: "once" },
      run: (args) =>
        legacyResult(Result_unassign_tag, () =>
          Effect.gen(function* () {
            requireTrue(
              yield* write("/tags/unassign", { person_id: args["personId"], tag_id: args["tagId"] }),
              "the tag removal",
            );
            return { unassigned: true };
          }),
        ),
    }),
    writeTool(connection, {
      name: "record_check_in",
      description:
        "Record one person's attendance at one event instance. Check-out and removing a record go through breeze_api_mutate.",
      input: Schema.Struct({
        "personId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Breeze person id from list_people.",
        }),
        "instanceId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Event instance id (list_events id, not eventId).",
        }),
      }),
      output: Result_record_check_in,
      destructive: false,
      writeSteps: { write: "once" },
      run: (args) =>
        legacyResult(Result_record_check_in, () =>
          Effect.gen(function* () {
            requireTrue(
              yield* write("/events/attendance/add", {
                person_id: args["personId"],
                instance_id: args["instanceId"],
                direction: "in",
              }),
              "the check-in",
            );
            return { checkedIn: true };
          }),
        ),
    }),
  ].map(legacyCatalog);
}
