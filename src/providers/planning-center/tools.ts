// Curated Planning Center workflows over the standard provider kit.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import { Integer, isMinChars, emptyRequired } from "../../http/json-schema.js";
import { read, write, list as standardList } from "../../http/tools.js";
import type { CallServices } from "../../http/services.js";
import type { Connection } from "../../http/vendor.js";
import { PLANNING_CENTER_APPS, MAX_PAGE_SIZE, planningCenterCall, type Call, type PlanningCenterApp } from "./api.js";
import type { PlanningCenterOptions } from "./index.js";
import { excludedApps } from "./lib/guide.js";
import {
  asRecord,
  compact,
  resources,
  indexIncluded,
  relId,
  related,
  relatedMany,
  pick,
  attribute,
  writeDocument,
  pageOf,
  type JsonRecord,
  type Query,
  type Resource,
  type Included,
} from "./lib/json-api.js";
const fail = (
  code: ConstructorParameters<typeof ConnectorCallError>[0],
  message: string,
  options?: ConstructorParameters<typeof ConnectorCallError>[2],
) => Effect.fail(new Refusal({ error: new ConnectorCallError(code, message, options) }));
const pattern = (source: string) =>
  Schema.makeFilter((value: unknown) => typeof value !== "string" || new RegExp(source).test(value), {
    toJsonSchema: () => ({ pattern: source }),
  });
const STRING = Schema.String;
const NULLABLE_STRING = Schema.Union([Schema.String, Schema.Null]);
const INTEGER = Integer;
const NULLABLE_INTEGER = Schema.Union([Integer, Schema.Null]);
const BOOLEAN = Schema.Boolean;
const ARRAY = Schema.Array(Schema.Unknown).annotate({ toJsonSchema: () => ({ type: "array" }) });
const OBJECT = Schema.Record(Schema.String, Schema.Unknown);

function struct(properties: Record<string, Schema.Codec<any>>, required: readonly string[]) {
  return Schema.Struct(
    Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        required.includes(key) ? value : Schema.optionalKey(value),
      ]),
    ),
  );
}
function record(
  properties: Record<string, Schema.Codec<any>>,
  required: readonly string[] = ["id"],
): Schema.Codec<any> {
  const out = struct(properties, required);
  // The legacy catalog explicitly spells empty required arrays on output records.
  return required.length ? out : emptyRequired(out);
}
const input = (properties: Record<string, Schema.Codec<any>>, required: readonly string[] = []) =>
  struct(properties, required);
// Preserve the explicit legacy additive annotation while the kit owns the verdict.
const additive: typeof write = (connection, spec) => {
  const tool = write(connection, spec);
  tool.annotations = { readOnlyHint: false, destructiveHint: false };
  return tool;
};

function idProperty(description: string): Schema.Codec<any> {
  return Schema.String.check(pattern("^[0-9]+$")).annotate({ description });
}

const DATE_PROPERTY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}(T[0-9:.]+(Z|[+-]\\d{2}:?\\d{2})?)?$";

function dateProperty(description: string): Schema.Codec<any> {
  return Schema.String.check(pattern(DATE_PROPERTY_PATTERN)).annotate({
    description: `${description} ISO 8601 date or date-time; a bare date is the organization's local day.`,
  });
}

function orderProperty(values: readonly string[]): Schema.Codec<any> {
  return Schema.Literals(values.flatMap((value) => [value, `-${value}`])).annotate({
    description: "Sort attribute; a leading '-' reverses it.",
  });
}

// --- Output records ---------------------------------------------------------

const PERSON_SUMMARY: Record<string, Schema.Codec<any>> = {
  id: STRING,
  name: STRING,
  first_name: STRING,
  last_name: STRING,
  nickname: NULLABLE_STRING,
  status: STRING,
  membership: NULLABLE_STRING,
  child: BOOLEAN,
  primary_email: NULLABLE_STRING,
  primary_phone: NULLABLE_STRING,
  updated_at: STRING,
};

const PERSON_SUMMARY_SCHEMA = record(PERSON_SUMMARY);

const PERSON_SCHEMA = record({
  ...PERSON_SUMMARY,
  given_name: NULLABLE_STRING,
  middle_name: NULLABLE_STRING,
  birthdate: NULLABLE_STRING,
  anniversary: NULLABLE_STRING,
  gender: NULLABLE_STRING,
  grade: NULLABLE_INTEGER,
  inactivated_at: NULLABLE_STRING,
  created_at: STRING,
  primary_campus: OBJECT,
  emails: ARRAY,
  phone_numbers: ARRAY,
  addresses: ARRAY,
  households: ARRAY,
});

const CARD_SCHEMA = record({
  id: STRING,
  stage: STRING,
  person_id: NULLABLE_STRING,
  person_name: NULLABLE_STRING,
  assignee_id: NULLABLE_STRING,
  current_step_id: NULLABLE_STRING,
  current_step_name: NULLABLE_STRING,
  moved_to_step_at: NULLABLE_STRING,
  snooze_until: NULLABLE_STRING,
  overdue: BOOLEAN,
  completed_at: NULLABLE_STRING,
  removed_at: NULLABLE_STRING,
});

const NOTE_SCHEMA = record({
  id: STRING,
  note: STRING,
  note_category_id: STRING,
  category: NULLABLE_STRING,
  person_id: STRING,
  display_date: NULLABLE_STRING,
  created_at: STRING,
  created_by_id: NULLABLE_STRING,
});

const PLAN_PERSON_SCHEMA = record({
  id: STRING,
  name: STRING,
  status: STRING,
  team_position_name: NULLABLE_STRING,
  team_id: NULLABLE_STRING,
  team_name: NULLABLE_STRING,
  person_id: NULLABLE_STRING,
  decline_reason: NULLABLE_STRING,
});

const ITEM_SCHEMA = record({
  id: STRING,
  sequence: INTEGER,
  item_type: STRING,
  title: STRING,
  length: NULLABLE_INTEGER,
  key_name: NULLABLE_STRING,
  service_position: NULLABLE_STRING,
  song_id: NULLABLE_STRING,
  arrangement_id: NULLABLE_STRING,
});

const MEMBERSHIP_SCHEMA = record({
  id: STRING,
  role: STRING,
  joined_at: NULLABLE_STRING,
  person_id: STRING,
  first_name: STRING,
  last_name: STRING,
});

const DESIGNATIONS: Schema.Codec<any> = Schema.Array(
  record({ fund_id: NULLABLE_STRING, fund: NULLABLE_STRING, amount_cents: INTEGER }, ["amount_cents"]),
);

const DONATION_SCHEMA = record({
  id: STRING,
  amount_cents: INTEGER,
  amount_currency: STRING,
  fee_cents: NULLABLE_INTEGER,
  received_at: NULLABLE_STRING,
  payment_method: NULLABLE_STRING,
  payment_status: NULLABLE_STRING,
  refunded: BOOLEAN,
  person_id: NULLABLE_STRING,
  batch_id: NULLABLE_STRING,
  campus_id: NULLABLE_STRING,
  designations: DESIGNATIONS,
});

// --- Projections ------------------------------------------------------------

function primaryOf(rows: Resource[], key: string): string | null {
  const primary = rows.find((row) => attribute(row, "primary") === true) ?? rows[0];
  const value = attribute(primary, key);
  return typeof value === "string" ? value : null;
}

function personSummary(person: Resource, index: Included): JsonRecord {
  return {
    ...pick(person, ["name", "first_name", "last_name", "nickname", "status", "membership", "child"]),
    primary_email: primaryOf(relatedMany(person, "emails", index), "address"),
    primary_phone: primaryOf(relatedMany(person, "phone_numbers", index), "number"),
    ...pick(person, ["updated_at"]),
    id: person.id,
  };
}

function personRecord(person: Resource, index: Included): JsonRecord {
  const campus = related(person, "primary_campus", index);
  return compact({
    ...personSummary(person, index),
    ...pick(person, [
      "given_name",
      "middle_name",
      "birthdate",
      "anniversary",
      "gender",
      "grade",
      "inactivated_at",
      "created_at",
    ]),
    id: person.id,
    primary_campus: campus
      ? { id: campus.id, name: attribute(campus, "name") }
      : relId(person, "primary_campus")
        ? { id: relId(person, "primary_campus") }
        : undefined,
    emails: relatedMany(person, "emails", index).map((email) => pick(email, ["address", "location", "primary"])),
    phone_numbers: relatedMany(person, "phone_numbers", index).map((phone) =>
      pick(phone, ["number", "location", "primary"]),
    ),
    addresses: relatedMany(person, "addresses", index).map((address) =>
      pick(address, ["street_line_1", "street_line_2", "city", "state", "zip", "country_code", "location", "primary"]),
    ),
    households: relatedMany(person, "households", index).map((household) =>
      pick(household, ["name", "primary_contact_id", "member_count"]),
    ),
  });
}

function cardRecord(card: Resource, index: Included): JsonRecord {
  const person = related(card, "person", index);
  const step = related(card, "current_step", index);
  return {
    ...pick(card, ["stage"]),
    person_id: relId(card, "person") ?? null,
    person_name: attribute(person, "name") ?? null,
    assignee_id: relId(card, "assignee") ?? null,
    current_step_id: relId(card, "current_step") ?? null,
    current_step_name: attribute(step, "name") ?? null,
    ...pick(card, ["moved_to_step_at", "snooze_until", "overdue", "completed_at", "removed_at"]),
    id: card.id,
  };
}

function noteRecord(note: Resource, index: Included): JsonRecord {
  // `include=category` sideloads what the resource itself calls
  // `note_category`; the flat `note_category_id` settles it either way.
  const category =
    related(note, "category", index) ??
    related(note, "note_category", index) ??
    index.get(`NoteCategory:${String(attribute(note, "note_category_id"))}`);
  return {
    ...pick(note, ["note", "note_category_id", "person_id", "display_date", "created_at", "created_by_id"]),
    category: attribute(category, "name") ?? null,
  };
}

function planPersonRecord(member: Resource, index: Included): JsonRecord {
  const team = related(member, "team", index);
  return {
    ...pick(member, ["name", "status", "team_position_name", "decline_reason"]),
    team_id: relId(member, "team") ?? null,
    team_name: attribute(team, "name") ?? null,
    person_id: relId(member, "person") ?? null,
  };
}

function itemRecord(item: Resource): JsonRecord {
  return {
    ...pick(item, ["sequence", "item_type", "title", "length", "key_name", "service_position"]),
    song_id: relId(item, "song") ?? null,
    arrangement_id: relId(item, "arrangement") ?? null,
  };
}

function membershipRecord(membership: Resource, index: Included): JsonRecord {
  const person = related(membership, "person", index);
  return {
    ...pick(membership, ["role", "joined_at"]),
    person_id: relId(membership, "person") ?? null,
    first_name: attribute(person, "first_name") ?? null,
    last_name: attribute(person, "last_name") ?? null,
  };
}

function designations(owner: Resource, index: Included): JsonRecord[] {
  return relatedMany(owner, "designations", index).map((designation) => {
    const fund = related(designation, "fund", index);
    return {
      fund_id: relId(designation, "fund") ?? null,
      fund: attribute(fund, "name") ?? null,
      amount_cents: attribute(designation, "amount_cents"),
    };
  });
}

function donationRecord(donation: Resource, index: Included): JsonRecord {
  return {
    ...pick(donation, [
      "amount_cents",
      "amount_currency",
      "fee_cents",
      "received_at",
      "payment_method",
      "payment_status",
      "refunded",
    ]),
    person_id: relId(donation, "person") ?? null,
    batch_id: relId(donation, "batch") ?? null,
    campus_id: relId(donation, "campus") ?? null,
    designations: designations(donation, index),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ListToolSpec {
  name: string;
  description: string;
  item: Schema.Codec<any>;
  properties?: Record<string, Schema.Codec<any>>;
  required?: string[];
  path: (args: JsonRecord) => string;
  query?: (args: JsonRecord) => Query;
  include?: string;
  project: (resource: Resource, index: Included) => JsonRecord;
}

/** One native JSON:API page, with includes projected before fields selection. */
function listTool(connection: Connection, call: Call, defaultPageSize: number, spec: ListToolSpec): ApiTool {
  return standardList(connection, {
    name: spec.name,
    description: spec.description,
    filters: struct(spec.properties ?? {}, spec.required ?? []).fields,
    row: spec.item,
    limit: { default: defaultPageSize, max: MAX_PAGE_SIZE, description: "Rows per page, at most 100." },
    cursor: "bound",
    total: true,
    page: (args: JsonRecord, cursor) =>
      Effect.gen(function* () {
        const offset = cursor === undefined ? 0 : Number(cursor);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          (cursor !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(cursor))
        )
          return yield* fail("invalid_args", "This Planning Center cursor contains no valid offset.");
        const document = asRecord(
          yield* call({
            method: "GET",
            path: spec.path(args),
            query: {
              ...spec.query?.(args),
              include: spec.include,
              per_page: args["limit"],
              offset,
            },
          }),
        );
        if (!Array.isArray(document["data"]))
          return yield* fail("connector_call_failed", "Planning Center returned a list without a data array.");
        const page = yield* Effect.try({
          try: () => pageOf(document, offset),
          catch: (error) => new Refusal({ error: error as ConnectorCallError }),
        });
        const index = indexIncluded(document);
        return {
          rows: resources(document["data"]).map((row) => spec.project(row, index)),
          page: {
            hasMore: page.hasMore,
            nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
            ...(page.totalCount === null ? {} : { total: page.totalCount }),
          },
        };
      }),
  });
}

function segment(value: unknown): string {
  return encodeURIComponent(String(value));
}

/** The single resource a response carries, or a refusal to invent one. */
function created(document: unknown, what: string): Effect.Effect<Resource, Refusal> {
  return Effect.gen(function* () {
    const resource = resources(asRecord(document)["data"])[0];
    if (!resource) {
      return yield* fail("connector_call_failed", `Planning Center answered without the ${what} it should return.`, {
        retryable: false,
      });
    }
    return resource;
  });
}

/** `where[a][b][gte]` and `[lt]` for a half-open range on a (nested) attribute. */
function range(attribute: readonly string[], after: unknown, before: unknown): Query {
  const key = `where[${attribute.join("][")}]`;
  return {
    [`${key}[gte]`]: typeof after === "string" ? after : undefined,
    [`${key}[lt]`]: typeof before === "string" ? before : undefined,
  };
}

const PERSON_ID = idProperty("Person id from search_people. The same id resolves in every Planning Center product.");
const SERVICE_TYPE_ID = idProperty("Service type id from list_service_types.");
const PLAN_ID = idProperty("Plan id from list_plans.");

const PERSON_WRITE_PROPERTIES: Record<string, Schema.Codec<any>> = {
  firstName: Schema.String.check(isMinChars(1)).annotate({ description: "First name." }),
  lastName: Schema.String.check(isMinChars(1)).annotate({ description: "Last name." }),
  nickname: Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Nickname; null clears it." }),
  middleName: Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Middle name; null clears it." }),
  birthdate: Schema.Union([Schema.String, Schema.Null])
    .check(pattern("^\\d{4}-\\d{2}-\\d{2}$"))
    .annotate({ description: "Birthdate, YYYY-MM-DD; null clears it." }),
  anniversary: Schema.Union([Schema.String, Schema.Null])
    .check(pattern("^\\d{4}-\\d{2}-\\d{2}$"))
    .annotate({ description: "Anniversary, YYYY-MM-DD; null clears it." }),
  gender: Schema.Union([Schema.String, Schema.Null]).annotate({
    description: "Gender as the organization records it, e.g. Male or Female.",
  }),
  membership: Schema.Union([Schema.String, Schema.Null]).annotate({
    description: "Membership type, one of the organization's own values such as Member or Visitor.",
  }),
  child: Schema.Boolean.annotate({ description: "Whether the person is a child." }),
  primaryCampusId: Schema.String.check(pattern("^[0-9]+$")).annotate({
    description: "Campus id from /people/v2/campuses.",
  }),
};

function personAttributes(args: JsonRecord): JsonRecord {
  return {
    first_name: args["firstName"],
    last_name: args["lastName"],
    nickname: args["nickname"],
    middle_name: args["middleName"],
    birthdate: args["birthdate"],
    anniversary: args["anniversary"],
    gender: args["gender"],
    membership: args["membership"],
    child: args["child"],
    primary_campus_id: args["primaryCampusId"],
    status: args["status"],
  };
}

const WORKFLOW_CARD_ACTIONS = ["promote", "go_back", "skip_step", "snooze", "unsnooze", "remove", "restore"];

/** Each product's named tools: what `excludeApps` removes. */
interface Tools {
  apps: Record<PlanningCenterApp, ApiTool[]>;
}

function tools(connection: Connection, call: Call, defaultPageSize: number): Tools {
  const list = (spec: ListToolSpec) => listTool(connection, call, defaultPageSize, spec);
  // --- Hatches --------------------------------------------------------------

  // --- People ---------------------------------------------------------------
  const people: ApiTool[] = [
    read(connection, {
      fields: true,
      name: "get_me",
      description:
        "Get the Planning Center person this token acts as, with the organization's name and time zone. Supplies personId for my-schedule and assignee questions.",

      input: input({}),
      output: record({
        id: STRING,
        name: STRING,
        first_name: STRING,
        last_name: STRING,
        status: STRING,
        organization: record({ id: STRING, name: STRING, time_zone: STRING }),
      }),
      run: (_args): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          const document = asRecord(
            yield* call({ method: "GET", path: "/people/v2/me", query: { include: "organization" } }),
          );
          const me = yield* created(document, "person record");
          const organization = resources(document["included"]).find((row) => row.type === "Organization");
          return {
            ...pick(me, ["name", "first_name", "last_name", "status"]),
            ...(organization ? { organization: pick(organization, ["name", "time_zone"]) } : {}),
          };
        }),
    }),
    list({
      name: "search_people",
      description:
        "Search People profiles by name, email, or phone, with each person's primary email and phone. Omit search to list everyone; never searches custom fields or notes.",

      item: PERSON_SUMMARY_SCHEMA,
      properties: {
        search: Schema.String.check(isMinChars(1)).annotate({
          description: "Matches name, email address, or phone number.",
        }),
        status: Schema.Literals(["active", "inactive"]).annotate({ description: "Profile status." }),
        membership: Schema.String.check(isMinChars(1)).annotate({ description: "Exact membership type, e.g. Member." }),
        updatedSince: dateProperty("Only people updated at or after this time."),
        order: orderProperty(["last_name", "first_name", "created_at", "updated_at"]),
      },
      path: () => "/people/v2/people",
      query: (args) => ({
        "where[search_name_or_email_or_phone_number]": args["search"],
        "where[status]": args["status"],
        "where[membership]": args["membership"],
        "where[updated_at][gte]": args["updatedSince"],
        order: args["order"],
      }),
      include: "emails,phone_numbers",
      project: personSummary,
    }),
    read(connection, {
      fields: true,
      name: "get_person",
      description:
        "Get one person's profile with every email, phone number, address, household, and primary campus. Custom fields are list_person_field_data.",

      input: input({ personId: PERSON_ID }, ["personId"]),
      output: PERSON_SCHEMA,
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          const document = asRecord(
            yield* call({
              method: "GET",
              path: `/people/v2/people/${segment(args["personId"])}`,
              query: { include: "emails,phone_numbers,addresses,households,primary_campus" },
            }),
          );
          const person = yield* created(document, "person record");
          return personRecord(person, indexIncluded(document));
        }),
    }),
    additive(connection, {
      name: "create_person",
      description:
        "Create a People profile. Emails and phone numbers are separate records; add them after with pco_api_write: POST /people/v2/people/{person_id}/emails or POST /people/v2/people/{person_id}/phone_numbers.",
      destructive: false,
      input: input(PERSON_WRITE_PROPERTIES, ["firstName", "lastName"]),
      output: PERSON_SUMMARY_SCHEMA,
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          const document = yield* call({
            method: "POST",
            path: "/people/v2/people",
            body: writeDocument("Person", personAttributes(args)),
          });
          return personSummary(yield* created(document, "person"), new Map());
        }),
    }),
    write(connection, {
      name: "update_person",
      description:
        "Update fields on one People profile; omitted fields stay as they are. status inactive archives the person reversibly; this never deletes a profile.",
      destructive: true,
      input: input(
        {
          personId: PERSON_ID,
          ...PERSON_WRITE_PROPERTIES,
          status: Schema.Literals(["active", "inactive"]).annotate({
            description: "inactive archives the profile; active restores it.",
          }),
        },
        ["personId"],
      ),
      output: PERSON_SUMMARY_SCHEMA,
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          const attributes = compact(personAttributes(args));
          if (Object.keys(attributes).length === 0) {
            return yield* fail("invalid_args", "Nothing to update: provide at least one profile field.");
          }
          const document = yield* call({
            method: "PATCH",
            path: `/people/v2/people/${segment(args["personId"])}`,
            body: { data: { type: "Person", id: String(args["personId"]), attributes } },
          });
          return personSummary(yield* created(document, "person update"), new Map());
        }),
    }),
    list({
      name: "list_workflows",
      description:
        "List People workflows with their steps and ready, overdue, and unassigned card counts. Archived workflows are excluded unless asked for.",

      item: record({
        id: STRING,
        name: STRING,
        total_cards_count: INTEGER,
        total_ready_card_count: INTEGER,
        total_overdue_card_count: INTEGER,
        total_unassigned_card_count: INTEGER,
        my_ready_card_count: INTEGER,
        archived_at: NULLABLE_STRING,
        steps: ARRAY,
      }),
      properties: {
        name: Schema.String.check(isMinChars(1)).annotate({
          description: "Exact workflow name; end it with % for a prefix match.",
        }),
        includeArchived: Schema.Boolean.annotate({ description: "Include archived workflows." }),
      },
      path: () => "/people/v2/workflows",
      query: (args) => ({
        "where[name]": args["name"],
        filter: args["includeArchived"] === true ? undefined : "not_archived",
      }),
      include: "steps",
      project: (row, index) => ({
        ...pick(row, [
          "name",
          "total_cards_count",
          "total_ready_card_count",
          "total_overdue_card_count",
          "total_unassigned_card_count",
          "my_ready_card_count",
          "archived_at",
        ]),
        steps: relatedMany(row, "steps", index)
          .map((step) => pick(step, ["name", "sequence"]))
          .sort((a, b) => Number(a["sequence"] ?? 0) - Number(b["sequence"] ?? 0)),
      }),
    }),
    list({
      name: "list_workflow_cards",
      description:
        "List the cards in one workflow with each card's person, assignee, and current step. Card actions need both the card id and its person_id.",

      item: CARD_SCHEMA,
      properties: {
        workflowId: idProperty("Workflow id from list_workflows."),
        stage: Schema.String.check(isMinChars(1)).annotate({
          description: "Card stage as Planning Center reports it, e.g. ready, snoozed, completed, removed.",
        }),
        stepId: idProperty("Only cards on this step (list_workflows steps[].id)."),
        assigneeId: idProperty("Only cards assigned to this person id."),
        overdue: Schema.Boolean.annotate({ description: "Only overdue (true) or on-time (false) cards." }),
        order: orderProperty(["created_at", "moved_to_step_at", "last_name"]),
      },
      required: ["workflowId"],
      path: (args) => `/people/v2/workflows/${segment(args["workflowId"])}/cards`,
      query: (args) => ({
        "where[stage]": args["stage"],
        "where[step_id]": args["stepId"],
        "where[assignee_id]": args["assigneeId"],
        "where[overdue]": args["overdue"],
        order: args["order"],
      }),
      include: "person,current_step",
      project: cardRecord,
    }),
    additive(connection, {
      name: "add_workflow_card",
      description:
        "Add a person to a workflow as a new card on its first step. Optionally assign it; the workflow's own step defaults apply otherwise.",
      destructive: false,
      input: input(
        {
          workflowId: idProperty("Workflow id from list_workflows."),
          personId: PERSON_ID,
          assigneeId: idProperty("Person id to assign the card to."),
        },
        ["workflowId", "personId"],
      ),
      output: CARD_SCHEMA,
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          return cardRecord(
            yield* created(
              yield* call({
                method: "POST",
                path: `/people/v2/workflows/${segment(args["workflowId"])}/cards`,
                body: writeDocument("WorkflowCard", { person_id: args["personId"], assignee_id: args["assigneeId"] }),
              }),
              "workflow card",
            ),
            new Map(),
          );
        }),
    }),
    write(connection, {
      name: "apply_workflow_card_action",
      description:
        "Promote, send back, skip a step on, snooze, unsnooze, remove, or restore one workflow card. Never emails; sending a card email is pco_api_write.",
      destructive: true,
      input: input(
        {
          personId: PERSON_ID.annotate({ description: "The card's person_id from list_workflow_cards." }),
          cardId: idProperty("Workflow card id from list_workflow_cards."),
          action: Schema.Literals([...WORKFLOW_CARD_ACTIONS]).annotate({
            description:
              "promote completes the step; skip_step moves on without completing it; go_back returns to the previous step.",
          }),
          snoozeDays: Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(365)).annotate({
            description: "Days to snooze; required with action snooze and refused otherwise.",
          }),
        },
        ["personId", "cardId", "action"],
      ),
      output: record({ ok: BOOLEAN }, ["ok"]),
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          const snooze = args["action"] === "snooze";
          if (snooze !== (args["snoozeDays"] !== undefined)) {
            return yield* fail(
              "invalid_args",
              snooze ? "action snooze needs snoozeDays." : "snoozeDays applies only to action snooze.",
            );
          }
          yield* call({
            method: "POST",
            path: `/people/v2/people/${segment(args["personId"])}/workflow_cards/${segment(args["cardId"])}/${String(args["action"])}`,
            ...(snooze ? { body: { data: { attributes: { duration: args["snoozeDays"] } } } } : {}),
          });
          return { ok: true };
        }),
    }),
    list({
      name: "list_person_notes",
      description:
        "List the notes on one person's profile with their category names, newest first by default. Workflow card notes are not profile notes.",

      item: NOTE_SCHEMA,
      properties: {
        personId: PERSON_ID,
        noteCategoryId: idProperty("Only notes in this category (/people/v2/note_categories)."),
        order: orderProperty(["created_at", "display_date"]),
      },
      required: ["personId"],
      path: (args) => `/people/v2/people/${segment(args["personId"])}/notes`,
      query: (args) => ({ "where[note_category_id]": args["noteCategoryId"], order: args["order"] ?? "-created_at" }),
      include: "category",
      project: noteRecord,
    }),
    additive(connection, {
      name: "add_person_note",
      description:
        "Add a note to a person's profile in a note category. Category subscribers may be notified; read categories at /people/v2/note_categories.",
      destructive: false,
      input: input(
        {
          personId: PERSON_ID,
          note: Schema.String.check(isMinChars(1)).annotate({ description: "Note text." }),
          noteCategoryId: idProperty("Note category id; Planning Center files every note under one."),
        },
        ["personId", "note", "noteCategoryId"],
      ),
      output: NOTE_SCHEMA,
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          return noteRecord(
            yield* created(
              yield* call({
                method: "POST",
                path: `/people/v2/people/${segment(args["personId"])}/notes`,
                body: writeDocument("Note", { note: args["note"], note_category_id: args["noteCategoryId"] }),
              }),
              "note",
            ),
            new Map(),
          );
        }),
    }),
    list({
      name: "list_person_field_data",
      description:
        "List one person's custom field values, each labeled with its field name and data type. Write with pco_api_write: POST /people/v2/people/{person_id}/field_data to create, or PATCH /people/v2/field_data/{field_datum_id} to update.",

      item: record({
        id: STRING,
        field_definition_id: STRING,
        field: NULLABLE_STRING,
        data_type: NULLABLE_STRING,
        value: NULLABLE_STRING,
        file_name: NULLABLE_STRING,
      }),
      properties: { personId: PERSON_ID },
      required: ["personId"],
      path: (args) => `/people/v2/people/${segment(args["personId"])}/field_data`,
      include: "field_definition",
      project: (row, index) => {
        const definition = related(row, "field_definition", index);
        return {
          id: row.id,
          field_definition_id: relId(row, "field_definition") ?? null,
          field: attribute(definition, "name") ?? null,
          data_type: attribute(definition, "data_type") ?? null,
          value: attribute(row, "value") ?? null,
          file_name: attribute(row, "file_name") ?? null,
        };
      },
    }),
  ];

  // --- Services -------------------------------------------------------------
  const services: ApiTool[] = [
    list({
      name: "list_service_types",
      description:
        "List Services service types — the recurring services such as Sunday Morning. Supplies serviceTypeId for plans and teams.",

      item: record({
        id: STRING,
        name: STRING,
        frequency: NULLABLE_STRING,
        sequence: NULLABLE_INTEGER,
        parent_id: NULLABLE_STRING,
      }),
      path: () => "/services/v2/service_types",
      query: () => ({ order: "sequence" }),
      project: (row) => ({ ...pick(row, ["name", "frequency", "sequence"]), parent_id: relId(row, "parent") ?? null }),
    }),
    list({
      name: "list_plans",
      description:
        "List one service type's plans (individual services) by date. Defaults to upcoming plans, soonest first; get_plan returns the order of service and team.",

      item: record({
        id: STRING,
        title: NULLABLE_STRING,
        series_title: NULLABLE_STRING,
        dates: STRING,
        sort_date: NULLABLE_STRING,
        items_count: INTEGER,
        plan_people_count: INTEGER,
        needed_positions_count: INTEGER,
        planning_center_url: STRING,
      }),
      properties: {
        serviceTypeId: SERVICE_TYPE_ID,
        when: Schema.Literals(["future", "past", "all"]).annotate({
          description: "future (default) sorts soonest first; past sorts most recent first.",
        }),
      },
      required: ["serviceTypeId"],
      path: (args) => `/services/v2/service_types/${segment(args["serviceTypeId"])}/plans`,
      query: (args) => {
        const when = args["when"] ?? "future";
        return {
          filter: when === "all" ? undefined : when,
          order: when === "past" ? "-sort_date" : "sort_date",
        };
      },
      project: (row) =>
        pick(row, [
          "title",
          "series_title",
          "dates",
          "sort_date",
          "items_count",
          "plan_people_count",
          "needed_positions_count",
          "planning_center_url",
        ]),
    }),
    read(connection, {
      fields: true,
      name: "get_plan",
      writeSteps: { plan: "once", items: "once", team: "once" },
      description:
        "Get one plan with its times, order of service, and scheduled team in a single call. Reports truncated sections past 100 rows; the hatch pages the remaining items and team.",

      input: input({ serviceTypeId: SERVICE_TYPE_ID, planId: PLAN_ID }, ["serviceTypeId", "planId"]),
      output: record(
        {
          id: STRING,
          service_type_id: STRING,
          title: NULLABLE_STRING,
          series_title: NULLABLE_STRING,
          dates: STRING,
          sort_date: NULLABLE_STRING,
          total_length: NULLABLE_INTEGER,
          needed_positions_count: NULLABLE_INTEGER,
          planning_center_url: STRING,
          times: ARRAY,
          items: Schema.Array(ITEM_SCHEMA),
          teamMembers: Schema.Array(PLAN_PERSON_SCHEMA),
          truncated: Schema.Array(STRING),
        },
        ["id", "service_type_id", "items", "teamMembers"],
      ),
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          const base = `/services/v2/service_types/${segment(args["serviceTypeId"])}/plans/${segment(args["planId"])}`;
          const [planDocument, itemDocument, teamDocument] = (yield* Effect.all(
            [
              call({ method: "GET", path: base, query: { include: "plan_times" } }, "plan"),
              call({ method: "GET", path: `${base}/items`, query: { per_page: MAX_PAGE_SIZE } }, "items"),
              call(
                { method: "GET", path: `${base}/team_members`, query: { include: "team", per_page: MAX_PAGE_SIZE } },
                "team",
              ),
            ],
            { concurrency: "unbounded" },
          )).map(asRecord) as [JsonRecord, JsonRecord, JsonRecord];
          const plan = yield* created(planDocument, "plan record");
          const items = resources(itemDocument["data"]);
          const members = resources(teamDocument["data"]);
          const truncated = yield* Effect.try({
            try: () => [
              ...(pageOf(itemDocument).hasMore ? ["items[]"] : []),
              ...(pageOf(teamDocument).hasMore ? ["teamMembers[]"] : []),
            ],
            catch: (error) => new Refusal({ error: error as ConnectorCallError }),
          });
          const planIndex = indexIncluded(planDocument);
          const teamIndex = indexIncluded(teamDocument);
          return {
            ...pick(plan, [
              "title",
              "series_title",
              "dates",
              "sort_date",
              "total_length",
              "needed_positions_count",
              "planning_center_url",
            ]),
            times: relatedMany(plan, "plan_times", planIndex).map((time) =>
              pick(time, ["name", "time_type", "starts_at", "ends_at"]),
            ),
            service_type_id: String(args["serviceTypeId"]),
            items: items.map(itemRecord).sort((a, b) => Number(a["sequence"] ?? 0) - Number(b["sequence"] ?? 0)),
            teamMembers: members.map((member) => planPersonRecord(member, teamIndex)),
            ...(truncated.length ? { truncated } : {}),
          };
        }),
    }),
    list({
      name: "list_teams",
      description:
        "List one service type's teams with their positions. Supplies teamId and position names for schedule_plan_person.",

      item: record({ id: STRING, name: STRING, archived_at: NULLABLE_STRING, positions: ARRAY }),
      properties: { serviceTypeId: SERVICE_TYPE_ID },
      required: ["serviceTypeId"],
      path: (args) => `/services/v2/service_types/${segment(args["serviceTypeId"])}/teams`,
      include: "team_positions",
      project: (row, index) => ({
        ...pick(row, ["name", "archived_at"]),
        positions: relatedMany(row, "team_positions", index).map((position) => pick(position, ["name"])),
      }),
    }),
    list({
      name: "list_person_schedules",
      description:
        "List where one person is scheduled to serve across every service type, with team, position, and response. Defaults to upcoming.",

      item: record({
        id: STRING,
        dates: STRING,
        sort_date: NULLABLE_STRING,
        service_type_name: STRING,
        team_name: NULLABLE_STRING,
        team_position_name: NULLABLE_STRING,
        status: STRING,
        decline_reason: NULLABLE_STRING,
        plan_id: NULLABLE_STRING,
      }),
      properties: {
        personId: PERSON_ID,
        when: Schema.Literals(["future", "past"]).annotate({ description: "future (default) or past schedules." }),
      },
      required: ["personId"],
      path: (args) => `/services/v2/people/${segment(args["personId"])}/schedules`,
      query: (args) => ({
        filter: args["when"] ?? "future",
        order: args["when"] === "past" ? "-starts_at" : "starts_at",
      }),
      project: (row) => ({
        ...pick(row, [
          "dates",
          "sort_date",
          "service_type_name",
          "team_name",
          "team_position_name",
          "status",
          "decline_reason",
        ]),
        plan_id: relId(row, "plan") ?? null,
      }),
    }),
    additive(connection, {
      name: "schedule_plan_person",
      description:
        "Schedule a person on a plan's team, unconfirmed by default. Prepares a notification only when asked; Planning Center sends it, not this call.",
      destructive: false,
      input: input(
        {
          serviceTypeId: SERVICE_TYPE_ID,
          planId: PLAN_ID,
          personId: PERSON_ID,
          teamId: idProperty("Team id from list_teams."),
          teamPositionName: Schema.String.check(isMinChars(1)).annotate({
            description: "Position name from list_teams positions[].name.",
          }),
          status: Schema.Literals(["U", "C"]).annotate({ description: "U unconfirmed (default) or C confirmed." }),
          prepareNotification: Schema.Boolean.annotate({
            description: "Queue Planning Center's scheduling notification for this person.",
          }),
          notes: Schema.String.annotate({ description: "Note shown to the person." }),
        },
        ["serviceTypeId", "planId", "personId", "teamId"],
      ),
      output: PLAN_PERSON_SCHEMA,
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          return planPersonRecord(
            yield* created(
              yield* call({
                method: "POST",
                path: `/services/v2/service_types/${segment(args["serviceTypeId"])}/plans/${segment(args["planId"])}/team_members`,
                body: writeDocument("PlanPerson", {
                  person_id: args["personId"],
                  team_id: args["teamId"],
                  team_position_name: args["teamPositionName"],
                  status: args["status"] ?? "U",
                  prepare_notification: args["prepareNotification"],
                  notes: args["notes"],
                }),
              }),
              "scheduled person",
            ),
            new Map(),
          );
        }),
    }),
  ];

  // --- Groups ---------------------------------------------------------------
  const groups: ApiTool[] = [
    list({
      name: "list_groups",
      description:
        "List Groups groups with type, schedule, and member count. Archived groups are excluded unless asked for; the API cannot create a group.",

      item: record({
        id: STRING,
        name: STRING,
        memberships_count: INTEGER,
        schedule: NULLABLE_STRING,
        group_type_id: NULLABLE_STRING,
        contact_email: NULLABLE_STRING,
        archived_at: NULLABLE_STRING,
        public_church_center_web_url: NULLABLE_STRING,
      }),
      properties: {
        name: Schema.String.check(isMinChars(1)).annotate({
          description: "Exact group name; end it with % for a prefix match.",
        }),
        groupTypeId: idProperty("Only groups of this type (/groups/v2/group_types)."),
        archived: Schema.Literals(["exclude", "include", "only"]).annotate({
          description: "Archived groups: exclude (default), include, or only.",
        }),
        order: orderProperty(["name", "created_at", "memberships_count"]),
      },
      path: () => "/groups/v2/groups",
      query: (args) => ({
        "where[name]": args["name"],
        "where[group_type][id]": args["groupTypeId"],
        "where[archive_status]":
          args["archived"] === "include" || args["archived"] === "only" ? args["archived"] : undefined,
        order: args["order"],
      }),
      project: (row) => ({
        ...pick(row, [
          "name",
          "memberships_count",
          "schedule",
          "contact_email",
          "archived_at",
          "public_church_center_web_url",
        ]),
        group_type_id: relId(row, "group_type") ?? null,
      }),
    }),
    list({
      name: "list_group_memberships",
      description:
        "List one group's members and leaders with their names and join dates. Contact details come from get_person with person_id.",

      item: MEMBERSHIP_SCHEMA,
      properties: {
        groupId: idProperty("Group id from list_groups."),
        role: Schema.Literals(["member", "leader"]).annotate({ description: "Only members or only leaders." }),
        order: orderProperty(["last_name", "first_name", "joined_at", "role"]),
      },
      required: ["groupId"],
      path: (args) => `/groups/v2/groups/${segment(args["groupId"])}/memberships`,
      query: (args) => ({ "where[role]": args["role"], order: args["order"] }),
      include: "person",
      project: membershipRecord,
    }),
    additive(connection, {
      name: "add_group_member",
      description:
        "Add a person to a group as a member or leader. Fails when they already belong; change a role or remove someone with pco_api_write.",
      destructive: false,
      input: input(
        {
          groupId: idProperty("Group id from list_groups."),
          personId: PERSON_ID,
          role: Schema.Literals(["member", "leader"]).annotate({ description: "Defaults to member." }),
          joinedAt: dateProperty("When they joined. Defaults to now."),
        },
        ["groupId", "personId"],
      ),
      output: MEMBERSHIP_SCHEMA,
      run: (args: JsonRecord): Effect.Effect<any, HttpFailure, CallServices> =>
        Effect.gen(function* () {
          const document = asRecord(
            yield* call({
              method: "POST",
              path: `/groups/v2/groups/${segment(args["groupId"])}/memberships`,
              query: { include: "person" },
              body: writeDocument("Membership", {
                person_id: args["personId"],
                role: args["role"] ?? "member",
                joined_at: args["joinedAt"],
              }),
            }),
          );
          return membershipRecord(yield* created(document, "membership"), indexIncluded(document));
        }),
    }),
  ];

  // --- Check-Ins (read-only product) -----------------------------------------
  const checkIns: ApiTool[] = [];

  // --- Calendar (events read-only) ------------------------------------------
  const calendar: ApiTool[] = [];

  // --- Registrations (read-only product) ------------------------------------
  const registrations: ApiTool[] = [];

  // --- Giving (reads; money moves only through pco_api_write) ---------------
  const giving: ApiTool[] = [
    list({
      name: "list_donations",
      description:
        "List Giving donations with their fund designations, newest first, by date, fund, or donor. Amounts are integer cents. Read-only.",

      item: DONATION_SCHEMA,
      properties: {
        personId: idProperty("Only this donor's donations."),
        receivedAfter: dateProperty("Only donations received at or after this time."),
        receivedBefore: dateProperty("Only donations received before this time."),
        fundId: idProperty("Only donations designated to this fund (list_funds)."),
        succeededOnly: Schema.Boolean.annotate({ description: "Exclude pending and failed card or ACH payments." }),
        order: orderProperty(["received_at", "created_at", "updated_at"]),
      },
      path: (args) =>
        args["personId"] ? `/giving/v2/people/${segment(args["personId"])}/donations` : "/giving/v2/donations",
      query: (args) => ({
        ...range(["received_at"], args["receivedAfter"], args["receivedBefore"]),
        "where[fund_id]": args["fundId"],
        filter: args["succeededOnly"] === true ? "succeeded" : undefined,
        order: args["order"] ?? "-received_at",
      }),
      include: "designations,designations.fund",
      project: donationRecord,
    }),
    list({
      name: "list_funds",
      description: "List Giving funds with ledger codes and visibility. Supplies fundId for donation filters.",

      item: record({
        id: STRING,
        name: STRING,
        ledger_code: NULLABLE_STRING,
        visibility: STRING,
        default: BOOLEAN,
        description: NULLABLE_STRING,
      }),
      path: () => "/giving/v2/funds",
      project: (row) => pick(row, ["name", "ledger_code", "visibility", "default", "description"]),
    }),
  ];

  // --- Webhooks -------------------------------------------------------------
  const webhooks: ApiTool[] = [];
  return {
    apps: {
      people,
      services,
      groups,
      "check-ins": checkIns,
      calendar,
      registrations,
      giving,
      publishing: [],
      webhooks,
      api: [],
    },
  };
}

export function planningCenterTools({
  connection,
  pageSize,
  options,
}: {
  connection: Connection;
  pageSize: number;
  options: Readonly<PlanningCenterOptions>;
}): ApiTool[] {
  const excluded = excludedApps(options.excludeApps);
  const surface = tools(connection, planningCenterCall(connection, options), pageSize);
  return PLANNING_CENTER_APPS.flatMap((app) => (excluded.has(app) ? [] : surface.apps[app]));
}
