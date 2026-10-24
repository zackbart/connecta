// Breeze's curated surface: projections and profile encoders earn named tools; the standard hatch supplies coverage.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import { Integer, isMinChars, isMaxChars } from "../../http/json-schema.js";
import { RequestSecrets, Classification, type CallServices } from "../../http/services.js";
import { fieldsInput, fieldsProblem, selectFields } from "../../http/fields.js";
import { read, list, write as writeTool } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { asArray, asRecord, type JsonRecord, READ_ENDPOINTS } from "./api.js";
const DEFAULT_EVENT_LIMIT = 100;
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
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
const Row_list_people = Result_list_people.fields.people.value;
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
const Row_list_profile_fields = Result_list_profile_fields.fields.fields.value;
const Result_list_tags = Schema.Struct({
  "tags": Schema.Array(
    Schema.Struct({ "id": Schema.String, "name": Schema.String, "folderId": Schema.optionalKey(Schema.String) }),
  ),
});
const Row_list_tags = Result_list_tags.fields.tags.value;
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
const Row_list_events = Result_list_events.fields.events.value;
const SelectedEvent = Schema.Struct(
  Object.fromEntries(
    Object.entries(Row_list_events.fields).map(([name, schema]) => [name, Schema.optionalKey(schema)]),
  ),
);
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
const Row_list_attendance = Result_list_attendance.fields.attendance.value;
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
});
const Row_list_contributions = Result_list_contributions.fields.contributions.value;
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
const Row_list_funds = Result_list_funds.fields.funds.value;
const Result_add_person = Schema.Union([
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
  Schema.Struct({ ok: Schema.Literal(true) }),
]);
const Result_update_person = Schema.Union([
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
  Schema.Struct({ ok: Schema.Literal(true) }),
]);

function projected<O extends Schema.Top>(
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
function request(
  connection: Connection,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  verdict: "read" | "write",
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
    const answer = yield* connection.sendPath({
      method: "GET",
      path,
      template: path,
      query: Object.entries(query).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, String(value)] as const],
      ),
    });
    return answer.data;
  });
}

function windowRows<T>(rows: readonly T[], cursor: string | undefined, limit: number) {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > rows.length)
    throw new ConnectorCallError("invalid_args", "This cursor no longer matches this list.");
  const end = start + limit;
  return {
    rows: rows.slice(start, end),
    page: { hasMore: end < rows.length, nextCursor: end < rows.length ? String(end) : null },
  };
}
export function breezeTools({
  connection,
  pageSize: defaultPageSize,
}: {
  connection: Connection;
  pageSize: number;
}): ApiTool[] {
  const get = (path: string, query: Record<string, string | number | boolean | undefined>) =>
    request(connection, path, query, "read");
  const write = (path: string, query: Record<string, string | number | boolean | undefined>) =>
    request(connection, path, query, "write");
  const limit = { default: defaultPageSize, max: 1000, description: "Items per page; pass nextCursor back unchanged." };
  const load_list_people = (args: JsonRecord) =>
    projected(Result_list_people, () =>
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
          people: rows.map(projectPerson),
          page: { hasMore, nextCursor: hasMore ? String(offset + rows.length) : null },
        };
      }),
    );
  const load_list_profile_fields = (_args: JsonRecord) =>
    projected(Result_list_profile_fields, () =>
      Effect.gen(function* () {
        const payload = yield* get("/profile", {});
        return { fields: projectProfileFields(payload) };
      }),
    );
  const load_list_tags = (args: JsonRecord) =>
    projected(Result_list_tags, () =>
      Effect.gen(function* () {
        return {
          tags: asArray(yield* get("/tags/list_tags", { folder_id: args["folderId"] })).map((value) => {
            const tag = asRecord(value);
            return compact({ id: idString(tag["id"]), name: tag["name"], folderId: idString(tag["folder_id"]) });
          }),
        };
      }),
    );
  const load_list_events = (args: JsonRecord) =>
    projected(Result_list_events, () =>
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
          events: rows.map(projectEvent),
          truncated: rows.length >= limit,
        };
      }),
    );
  const load_list_attendance = (args: JsonRecord) =>
    projected(Result_list_attendance, () =>
      Effect.gen(function* () {
        const wantDetails = args["includeNames"] === true;
        const rows = asArray(
          yield* get("/events/attendance/list", {
            instance_id: args["instanceId"],
            type: "person",
            details: wantDetails ? "true" : "false",
          }),
        );

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
    );
  const load_list_contributions = (args: JsonRecord) =>
    projected(Result_list_contributions, () =>
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
          contributions: redact(rows.map((row) => projectContribution(redact, row))),
        };
      }),
    );
  const load_list_funds = (_args: JsonRecord) =>
    projected(Result_list_funds, () =>
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
    );
  return [
    read(connection, {
      name: "get_account_summary",
      output: Result_get_account_summary,
      description:
        "Get the Breeze account's church name, subdomain, timezone, country, and currency. Use it to read giving amounts in the right currency.",
      input: Schema.Struct({}),
      fields: true,
      run: (_args) =>
        projected(Result_get_account_summary, () =>
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
    list(connection, {
      name: "list_people",
      description:
        "List people in Breeze, optionally filtered by tag or profile-field values, with id and names or full profile details. No name search; filter names in code.",
      filters: {
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
      },
      row: Row_list_people,
      limit,
      cursor: "bound",
      page: (args, cursor) =>
        load_list_people({ ...args, cursor }).pipe(
          Effect.map((result) => ({ rows: result.people, page: result.page })),
        ),
    }),
    read(connection, {
      name: "get_person",
      output: Result_get_person,
      description:
        "Get one person by Breeze id with profile details keyed by fieldId and family members. Decode fieldIds with list_profile_fields.",
      input: Schema.Struct({
        "personId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Breeze person id from list_people.",
        }),
        "includeDetails": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include profile details. Defaults to true." }),
        ),
      }),
      fields: true,
      run: (args) =>
        projected(Result_get_person, () =>
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
            return projectPerson(payload);
          }),
        ),
    }),
    list(connection, {
      name: "list_profile_fields",
      description:
        "List profile fields with fieldId, type, section, and option ids. Decodes person details and builds list_people filters and update_person values.",
      filters: {},
      row: Row_list_profile_fields,
      limit,
      cursor: "bound",
      page: (args, cursor) =>
        load_list_profile_fields(args).pipe(Effect.map((result) => windowRows(result.fields, cursor, args.limit))),
    }),
    list(connection, {
      name: "list_tags",
      description:
        "List Breeze tags with id, name, and folder. Tags model groups and lists; pass a tag id to list_people or breeze_api_write /tags/assign.",
      filters: {
        "folderId": Schema.optionalKey(
          Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
            description: "Only tags in this folder. Folders come from breeze_api_read /tags/list_folders.",
          }),
        ),
      },
      row: Row_list_tags,
      limit,
      cursor: "bound",
      page: (args, cursor) =>
        load_list_tags(args).pipe(Effect.map((result) => windowRows(result.tags, cursor, args.limit))),
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
            description: "Only events on this calendar from breeze_api_read /events/calendars/list.",
          }),
        ),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)).annotate({
            description: "Instances returned, 1 to Breeze's 1000. Defaults to 100.",
            default: 100,
          }),
        ),
        fields: Schema.optionalKey(fieldsInput("Dot paths to keep in each event item.")),
      }),
      output: Schema.Struct({
        items: Schema.Array(SelectedEvent),
        page: Schema.Struct({ hasMore: Schema.Literal(false) }),
        truncated: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      run: (args) =>
        Effect.gen(function* () {
          const error = fieldsProblem(args.fields, new Set(Object.keys(Row_list_events.fields)), "an event item");
          if (error) return yield* Effect.fail(new Refusal({ error }));
          const result = yield* load_list_events(args);
          return {
            items: selectFields(result.events, args.fields) as (typeof SelectedEvent.Type)[],
            page: { hasMore: false as const },
            ...(result.truncated ? { truncated: ["items[]"] } : {}),
          };
        }),
    }),
    list(connection, {
      name: "list_attendance",
      description:
        "List people checked in to one event instance, with check-in and check-out times. Not anonymous head counts; those come from breeze_api_read.",
      filters: {
        "instanceId": Schema.String.check(matches("^[0-9]+$"), isMaxChars(20)).annotate({
          description: "Event instance id (list_events id, not eventId).",
        }),
        "includeNames": Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "Add each attendee's name. Other vendor fields come from breeze_api_read.",
          }),
        ),
      },
      row: Row_list_attendance,
      limit,
      cursor: "bound",
      page: (args, cursor) =>
        load_list_attendance(args).pipe(Effect.map((result) => windowRows(result.attendance, cursor, args.limit))),
    }),
    list(connection, {
      name: "list_contributions",
      description:
        "List giving transactions between two dates with donor, amount, method, batch, and fund split, for exact client-side totals. Undocumented by Breeze since 2023.",
      filters: {
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
      },
      row: Row_list_contributions,
      limit,
      cursor: "bound",
      page: (args, cursor) =>
        load_list_contributions(args).pipe(
          Effect.map((result) => windowRows(result.contributions, cursor, args.limit)),
        ),
    }),
    list(connection, {
      name: "list_funds",
      description:
        "List giving funds with id, name, tax-deductible flag, and default flag. Supplies fundIds for list_contributions. Undocumented by Breeze since 2023.",
      filters: {},
      row: Row_list_funds,
      limit,
      cursor: "bound",
      page: (args, cursor) =>
        load_list_funds(args).pipe(Effect.map((result) => windowRows(result.funds, cursor, args.limit))),
    }),
    writeTool(connection, {
      name: "add_person",
      output: Result_add_person,
      destructive: false,
      writeSteps: { write: "once" },
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
      run: (args) =>
        projected(Result_add_person, () =>
          Effect.gen(function* () {
            const payload = yield* write("/people/add", {
              first: args["firstName"],
              last: args["lastName"],
              fields_json: args["fields"] === undefined ? undefined : fieldsJson(args["fields"]),
            });
            const person = Array.isArray(payload) ? payload[0] : payload;
            requireTrue(payload, "the person creation");
            if (!asRecord(person)["id"]) return { ok: true };
            return projectPerson(person);
          }),
        ),
    }),
    writeTool(connection, {
      name: "update_person",
      output: Result_update_person,
      destructive: true,
      writeSteps: { write: "once" },
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
      run: (args) =>
        projected(Result_update_person, () =>
          Effect.gen(function* () {
            const fields = fieldsJson(args["fields"]);
            const payload = yield* write("/people/update", { person_id: args["personId"], fields_json: fields });
            requireTrue(payload, "the person update");
            const person = Array.isArray(payload) ? payload[0] : payload;
            return asRecord(person)["id"] ? projectPerson(person) : { ok: true };
          }),
        ),
    }),
  ];
}
