import { asRecord, asArray } from "../_shared/json.js";
// CCB v2 curated projections, bound numbered pages and reviewed POST data search.
import { Effect, Schema } from "effect";
import { type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { checked } from "../_shared/rest/kit.js";
import { refuseWithheldValues } from "../_shared/rest/value-safety.js";
import { Refusal } from "../../http/errors.js";
import { Integer, isMinChars, isMaxChars } from "../../http/json-schema.js";
import { read, list } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import type { CcbOptions } from "./index.js";
import {
  callCcb,
  DEFAULT_PER_PAGE,
  SEARCH_DOMAINS,
  CCB_INDEX,
  ccbPageInfo,
  type CcbRequest,
  type Query,
} from "./api.js";
type JsonRecord = Record<string, any>;

type IsAny<T> = 0 extends 1 & T ? true : false;
type Compact<T> = { [K in keyof T as IsAny<T[K]> extends true ? K : undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as IsAny<T[K]> extends true ? never : undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ) as Compact<T>;
}

/** An object that is empty after compaction reads as absent. */
function present(value: JsonRecord): JsonRecord | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function phones(value: unknown): JsonRecord | undefined {
  const phone = asRecord(value);
  return present(
    compact({
      mobile: phone["mobile"] || undefined,
      home: phone["home"] || undefined,
      work: phone["work"] || undefined,
    }),
  );
}

function address(value: unknown): JsonRecord | undefined {
  const row = asRecord(value);
  return present(
    compact({
      street: row["street"] || undefined,
      city: row["city"] || undefined,
      state: row["state"] || undefined,
      zip: row["zip"] || undefined,
      country: row["country_iso"] || undefined,
    }),
  );
}

function projectPerson(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    firstName: row["first_name"],
    lastName: row["last_name"],
    email: row["email"] || undefined,
    phones: phones(row["phone"]),
    birthday: row["birthday"],
    familyId: row["family_id"],
    familyPosition: row["family_position"],
    campusId: row["campus_id"],
    membershipTypeId: row["membership_type_id"],
    active: row["active"],
    deceased: row["deceased"],
  });
}

function projectIndividual(value: unknown): JsonRecord {
  const row = asRecord(value);
  const addresses = asRecord(row["addresses"]);
  return compact({
    ...projectPerson(row),
    gender: row["gender"],
    maritalStatus: row["marital_status"],
    homeAddress: address(addresses["home"]),
    mailingAddress: address(addresses["mailing"]),
    campusName: row["campus_name"],
    membershipTypeName: row["membership_type_name"],
    membershipDate: row["membership_date"],
    schoolGrade: row["school_grade"],
    baptized: row["baptized"],
    baptizedDate: row["baptized_date"],
    lastAttendedDate: row["last_attended_date"],
    limitedAccessUser: row["limited_access_user"],
    listed: row["listed"],
    created: row["created"],
    modified: row["modified"],
    customFields: present(
      Object.fromEntries(
        asArray(row["custom_fields"])
          .map(asRecord)
          .filter((field) => field["id"] !== undefined)
          .map((field) => [String(field["id"]), field["value"]]),
      ),
    ),
  });
}

function projectFamily(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    lastName: row["last_name"],
    address: address(row["address"]),
    members: Array.isArray(row["members"]) ? row["members"].map(projectPerson) : undefined,
  });
}

function ref(value: unknown): JsonRecord | undefined {
  const row = asRecord(value);
  return row["id"] === undefined && row["name"] === undefined
    ? undefined
    : compact({ id: row["id"], name: row["name"] });
}

function projectGroup(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    campusId: row["campus_id"],
    inactive: row["inactive"],
    groupType: asRecord(row["group_type"])["name"],
    interactionType: row["interaction_type"],
    membershipType: row["membership_type"],
    mainLeader: ref(row["main_leader"]),
    departmentId: asRecord(row["department"])["id"],
    description: row["description"],
    memberCount: row["member_count"],
    childcare: row["childcare"],
    listed: row["listed"],
    full: row["full"],
    meetDay: asRecord(row["meet_day"])["name"],
    meetTime: asRecord(row["meet_time"])["name"],
    area: asRecord(row["area"])["name"],
    address: address(row["address"]),
  });
}

function projectMembership(value: unknown): JsonRecord {
  const row = asRecord(value);
  const person = asRecord(row["individual"]);
  const group = asRecord(row["group"]);
  return compact({
    groupId: row["group_id"],
    individualId: row["individual_id"],
    status: row["status"],
    dateAdded: row["date_added"],
    name: person["name"],
    email: person["email"] || undefined,
    phones: phones(person["phone"]),
    groupName: group["name"],
    groupType: asRecord(group["group_type"])["name"],
    groupInactive: group["inactive"],
  });
}

function projectOccurrence(value: unknown): JsonRecord {
  const row = asRecord(value);
  const event = asRecord(row["event"]);
  const group = asRecord(event["group"]);
  return compact({
    eventId: row["event_id"] ?? event["id"],
    occurrence: row["occurrence"],
    start: row["start"],
    end: row["end"],
    name: event["name"],
    campusId: event["campus_id"],
    recurs: event["recurs"],
    groupId: group["id"] === undefined ? undefined : Number(group["id"]),
    groupName: group["name"],
  });
}

function projectEvent(value: unknown): JsonRecord {
  const row = asRecord(value);
  const attendance = asRecord(row["attendance"]);
  return compact({
    id: row["id"],
    name: row["name"],
    description: row["description"],
    campusId: row["campus_id"],
    start: row["start"],
    end: row["end"],
    recurs: row["recurs"],
    recurEndDate: row["recur_end_date"],
    approvalStatus: row["approval_status"],
    address: address(row["address"]),
    guestCounts: present(compact({ ...asRecord(row["guest_counts"]) })),
    group: ref(row["group"]),
    attendance: present(
      compact({
        status: attendance["status"],
        totalAttendance: attendance["total_attendance"],
        visitors: attendance["visitors"],
      }),
    ),
  });
}

function projectAttendance(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    eventId: row["event_id"],
    occurrence: row["occurrence"],
    status: row["status"],
    totalAttendance: row["total_attendance"],
    visitors: row["visitors"],
    topic: row["topic"],
  });
}

function projectAttendee(value: unknown): JsonRecord {
  const row = asRecord(value);
  const person = asRecord(row["individual"]);
  return compact({
    individualId: row["individual_id"] ?? person["id"],
    name: person["name"],
    familyId: person["family_id"],
    occurrenceDate: row["occurrence_date"],
  });
}

function projectNote(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    individualId: row["individual_id"],
    note: row["note"],
    date: row["date"],
    sharingLevel: row["sharing_level"],
    context: row["context"],
    contextId: row["context_id"],
    creator: ref(row["creator"]),
  });
}
const PERSON_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "firstName": Schema.optionalKey(Schema.String),
  "lastName": Schema.optionalKey(Schema.String),
  "email": Schema.optionalKey(Schema.String),
  "phones": Schema.optionalKey(
    Schema.Struct({
      "mobile": Schema.optionalKey(Schema.String),
      "home": Schema.optionalKey(Schema.String),
      "work": Schema.optionalKey(Schema.String),
    }),
  ),
  "birthday": Schema.optionalKey(Schema.String),
  "familyId": Schema.optionalKey(Integer),
  "familyPosition": Schema.optionalKey(Schema.String),
  "campusId": Schema.optionalKey(Integer),
  "membershipTypeId": Schema.optionalKey(Integer),
  "active": Schema.optionalKey(Schema.Boolean),
  "deceased": Schema.optionalKey(Schema.String),
});
const INDIVIDUAL_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "firstName": Schema.optionalKey(Schema.String),
  "lastName": Schema.optionalKey(Schema.String),
  "email": Schema.optionalKey(Schema.String),
  "phones": Schema.optionalKey(
    Schema.Struct({
      "mobile": Schema.optionalKey(Schema.String),
      "home": Schema.optionalKey(Schema.String),
      "work": Schema.optionalKey(Schema.String),
    }),
  ),
  "birthday": Schema.optionalKey(Schema.String),
  "familyId": Schema.optionalKey(Integer),
  "familyPosition": Schema.optionalKey(Schema.String),
  "campusId": Schema.optionalKey(Integer),
  "membershipTypeId": Schema.optionalKey(Integer),
  "active": Schema.optionalKey(Schema.Boolean),
  "deceased": Schema.optionalKey(Schema.String),
  "gender": Schema.optionalKey(Schema.String),
  "maritalStatus": Schema.optionalKey(Schema.String),
  "homeAddress": Schema.optionalKey(
    Schema.Struct({
      "street": Schema.optionalKey(Schema.String),
      "city": Schema.optionalKey(Schema.String),
      "state": Schema.optionalKey(Schema.String),
      "zip": Schema.optionalKey(Schema.String),
      "country": Schema.optionalKey(Schema.String),
    }),
  ),
  "mailingAddress": Schema.optionalKey(
    Schema.Struct({
      "street": Schema.optionalKey(Schema.String),
      "city": Schema.optionalKey(Schema.String),
      "state": Schema.optionalKey(Schema.String),
      "zip": Schema.optionalKey(Schema.String),
      "country": Schema.optionalKey(Schema.String),
    }),
  ),
  "campusName": Schema.optionalKey(Schema.String),
  "membershipTypeName": Schema.optionalKey(Schema.String),
  "membershipDate": Schema.optionalKey(Schema.String),
  "schoolGrade": Schema.optionalKey(Schema.String),
  "baptized": Schema.optionalKey(Schema.Boolean),
  "baptizedDate": Schema.optionalKey(Schema.String),
  "lastAttendedDate": Schema.optionalKey(Schema.String),
  "limitedAccessUser": Schema.optionalKey(Schema.Boolean),
  "listed": Schema.optionalKey(Schema.Boolean),
  "created": Schema.optionalKey(Schema.String),
  "modified": Schema.optionalKey(Schema.String),
  "customFields": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const FAMILY_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "lastName": Schema.optionalKey(Schema.String),
  "address": Schema.optionalKey(
    Schema.Struct({
      "street": Schema.optionalKey(Schema.String),
      "city": Schema.optionalKey(Schema.String),
      "state": Schema.optionalKey(Schema.String),
      "zip": Schema.optionalKey(Schema.String),
      "country": Schema.optionalKey(Schema.String),
    }),
  ),
  "members": Schema.optionalKey(Schema.Array(PERSON_SCHEMA)),
});
const GROUP_DETAIL_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "campusId": Schema.optionalKey(Integer),
  "inactive": Schema.optionalKey(Schema.Boolean),
  "groupType": Schema.optionalKey(Schema.String),
  "interactionType": Schema.optionalKey(Schema.String),
  "membershipType": Schema.optionalKey(Schema.String),
  "mainLeader": Schema.optionalKey(
    Schema.Struct({ "id": Schema.optionalKey(Integer), "name": Schema.optionalKey(Schema.String) }),
  ),
  "departmentId": Schema.optionalKey(Integer),
  "description": Schema.optionalKey(Schema.String),
  "memberCount": Schema.optionalKey(Integer),
  "childcare": Schema.optionalKey(Schema.Boolean),
  "listed": Schema.optionalKey(Schema.Boolean),
  "full": Schema.optionalKey(Schema.Boolean),
  "meetDay": Schema.optionalKey(Schema.String),
  "meetTime": Schema.optionalKey(Schema.String),
  "area": Schema.optionalKey(Schema.String),
  "address": Schema.optionalKey(
    Schema.Struct({
      "street": Schema.optionalKey(Schema.String),
      "city": Schema.optionalKey(Schema.String),
      "state": Schema.optionalKey(Schema.String),
      "zip": Schema.optionalKey(Schema.String),
      "country": Schema.optionalKey(Schema.String),
    }),
  ),
});
const MEMBERSHIP_SCHEMA = Schema.Struct({
  "groupId": Schema.optionalKey(Integer),
  "individualId": Schema.optionalKey(Integer),
  "status": Schema.optionalKey(Schema.String),
  "dateAdded": Schema.optionalKey(Schema.String),
  "name": Schema.optionalKey(Schema.String),
  "email": Schema.optionalKey(Schema.String),
  "phones": Schema.optionalKey(
    Schema.Struct({
      "mobile": Schema.optionalKey(Schema.String),
      "home": Schema.optionalKey(Schema.String),
      "work": Schema.optionalKey(Schema.String),
    }),
  ),
  "groupName": Schema.optionalKey(Schema.String),
  "groupType": Schema.optionalKey(Schema.String),
  "groupInactive": Schema.optionalKey(Schema.Boolean),
});
const OCCURRENCE_SCHEMA = Schema.Struct({
  "eventId": Schema.optionalKey(Integer),
  "occurrence": Schema.optionalKey(Schema.String),
  "start": Schema.optionalKey(Schema.String),
  "end": Schema.optionalKey(Schema.String),
  "name": Schema.optionalKey(Schema.String),
  "campusId": Schema.optionalKey(Integer),
  "recurs": Schema.optionalKey(Schema.Boolean),
  "groupId": Schema.optionalKey(Integer),
  "groupName": Schema.optionalKey(Schema.String),
});
const EVENT_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "description": Schema.optionalKey(Schema.String),
  "campusId": Schema.optionalKey(Integer),
  "start": Schema.optionalKey(Schema.String),
  "end": Schema.optionalKey(Schema.String),
  "recurs": Schema.optionalKey(Schema.Boolean),
  "recurEndDate": Schema.optionalKey(Schema.String),
  "approvalStatus": Schema.optionalKey(Schema.String),
  "address": Schema.optionalKey(
    Schema.Struct({
      "street": Schema.optionalKey(Schema.String),
      "city": Schema.optionalKey(Schema.String),
      "state": Schema.optionalKey(Schema.String),
      "zip": Schema.optionalKey(Schema.String),
      "country": Schema.optionalKey(Schema.String),
    }),
  ),
  "guestCounts": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "group": Schema.optionalKey(
    Schema.Struct({ "id": Schema.optionalKey(Integer), "name": Schema.optionalKey(Schema.String) }),
  ),
  "attendance": Schema.optionalKey(
    Schema.Struct({
      "status": Schema.optionalKey(Schema.String),
      "totalAttendance": Schema.optionalKey(Integer),
      "visitors": Schema.optionalKey(Integer),
    }),
  ),
});
const ATTENDANCE_SCHEMA = Schema.Struct({
  "eventId": Schema.optionalKey(Integer),
  "occurrence": Schema.optionalKey(Schema.String),
  "status": Schema.optionalKey(Schema.String),
  "totalAttendance": Schema.optionalKey(Integer),
  "visitors": Schema.optionalKey(Integer),
  "topic": Schema.optionalKey(Schema.String),
});
const ATTENDEE_SCHEMA = Schema.Struct({
  "individualId": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "familyId": Schema.optionalKey(Integer),
  "occurrenceDate": Schema.optionalKey(Schema.String),
});
const NOTE_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "individualId": Schema.optionalKey(Integer),
  "note": Schema.optionalKey(Schema.String),
  "date": Schema.optionalKey(Schema.String),
  "sharingLevel": Schema.optionalKey(Schema.String),
  "context": Schema.optionalKey(Schema.String),
  "contextId": Schema.optionalKey(Integer),
  "creator": Schema.optionalKey(
    Schema.Struct({ "id": Schema.optionalKey(Integer), "name": Schema.optionalKey(Schema.String) }),
  ),
});
const ME_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "email": Schema.optionalKey(Schema.String),
  "username": Schema.optionalKey(Schema.String),
  "familyId": Schema.optionalKey(Integer),
  "campusId": Schema.optionalKey(Integer),
  "userTypes": Schema.optionalKey(Schema.Array(Schema.String)),
});
function compactDate(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/-/g, "") : undefined;
}

export function ccbTools({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<CcbOptions>;
}): ApiTool[] {
  const limit = {
    default: options.defaultPerPage ?? DEFAULT_PER_PAGE,
    max: 100,
    values: [25, 50, 75, 100],
    description: "Allowed page sizes are 25, 50, 75, and 100. The vendor default is 25.",
  };
  const request = (req: CcbRequest) => callCcb(connection, req);
  const id = (value: unknown) => encodeURIComponent(String(value));
  const one = (path: string, project: (row: unknown) => JsonRecord, query: Query = {}) =>
    request({ method: "GET", path, query }).pipe(Effect.map(({ body }) => project(body)));
  const fetchPage = (
    path: string,
    args: JsonRecord,
    project: (row: unknown) => JsonRecord,
    query: Query = {},
    cursor?: string,
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      const size = Number(args.limit ?? limit.default);
      let page = 1;
      if (cursor) {
        const saved = JSON.parse(cursor);
        if (saved.revision !== CCB_INDEX.revision)
          return yield* fail(
            new ConnectorCallError(
              "invalid_args",
              "This CCB cursor belongs to a different API revision; start a new list.",
            ),
          );
        if (!Number.isSafeInteger(saved.page) || saved.page < 1)
          return yield* fail(new ConnectorCallError("invalid_args", "This CCB cursor contains no valid page number."));
        if (saved.limit !== size)
          return yield* fail(
            new ConnectorCallError("invalid_args", "Keep the same limit when continuing this CCB page."),
          );
        page = saved.page;
      }
      const answer = yield* request({
        method: body === undefined ? "GET" : "POST",
        path,
        query: { ...query, page, per_page: size },
        ...(body === undefined ? {} : { body }),
      });
      if (
        path === "/search/schedules_totals/results" &&
        answer.body &&
        typeof answer.body === "object" &&
        !Array.isArray(answer.body)
      )
        return { rows: [project(answer.body)], page: { hasMore: false, nextCursor: null } };
      if (!Array.isArray(answer.body))
        return yield* fail(
          new ConnectorCallError("connector_call_failed", "CCB returned a list without an array.", {
            retryable: false,
          }),
        );
      const rows = answer.body;
      const totalText = answer.headers.get("x-total");
      const total = yield* checked(() => {
        if (totalText === null || totalText === "") return undefined;
        if (!/^(0|[1-9]\d*)$/.test(totalText) || !Number.isSafeInteger(Number(totalText)))
          throw new ConnectorCallError("connector_call_failed", "CCB returned an invalid exact total.", {
            retryable: false,
          });
        return Number(totalText);
      });
      const next = yield* checked(() => ccbPageInfo(Object.fromEntries(answer.headers), page, size, rows.length));
      return {
        rows: rows.map(project),
        page: {
          ...(total === undefined ? {} : { total }),
          hasMore: next !== null,
          nextCursor: next === null ? null : JSON.stringify({ page: next, limit: size, revision: CCB_INDEX.revision }),
        },
      };
    });
  return [
    read(connection, {
      name: "get_me",
      description:
        "Get the CCB individual the access token belongs to. Under Identity Auth that is the signed-in person whose permissions every call carries.",
      input: Schema.Struct({}),
      output: ME_SCHEMA,
      fields: true,
      run: () =>
        Effect.gen(function* () {
          const { body } = yield* request({ method: "GET", path: "/me" });
          const row = asRecord(body);
          return compact({
            id: row["id"],
            name: row["name"],
            email: row["email"] || undefined,
            username: row["username"],
            familyId: row["family_id"],
            campusId: row["campus_id"],
            userTypes: Array.isArray(row["user_types"]) ? row["user_types"] : undefined,
          });
        }),
    }),
    list(connection, {
      name: "list_individuals",
      description:
        "Find CCB individuals by partial name, phone, or email. Returns lean profiles with family and campus ids; not the advanced search.",
      filters: {
        "query": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({
            description: "Partial name, phone number, or email. Omit to page everyone.",
          }),
        ),
        "includeInactive": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include inactive individuals." }),
        ),
        "includeDeceased": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include deceased individuals." }),
        ),
        "campusScope": Schema.optionalKey(
          Schema.Literals(["all", "current", "other"]).annotate({
            description: "Campuses to search relative to the connection's own.",
          }),
        ),
      },
      row: PERSON_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            "/individuals",
            args,
            projectPerson,
            {
              name: args["query"],
              include_inactive: args["includeInactive"],
              include_deceased: args["includeDeceased"],
              campus_scope: args["campusScope"],
            },
            cursor,
          );
        }),
    }),
    read(connection, {
      name: "get_individual",
      description:
        "Get one CCB individual's profile: contact, addresses, membership, and custom fields. CCB allows one call a second; prefer list_individuals for many people.",
      input: Schema.Struct({
        "individualId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Individual id from list_individuals.",
        }),
      }),
      output: INDIVIDUAL_SCHEMA,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/individuals/${id(args["individualId"])}`, projectIndividual, {});
        }),
    }),
    list(connection, {
      name: "list_families",
      description:
        "Find CCB families by partial last name, email, or mobile phone. Returns family ids and addresses; get_family lists the members.",
      filters: {
        "lastName": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial last name." }),
        ),
        "email": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial email." }),
        ),
        "phone": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(50)).annotate({ description: "Partial mobile phone." }),
        ),
      },
      row: FAMILY_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            "/families",
            args,
            projectFamily,
            {
              last_name: args["lastName"],
              email: args["email"],
              phone: args["phone"],
            },
            cursor,
          );
        }),
    }),
    read(connection, {
      name: "get_family",
      description: "Get one CCB family with every member's lean profile and family position.",
      input: Schema.Struct({
        "familyId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Family id from an individual's familyId or list_families.",
        }),
        "includeInactive": Schema.optionalKey(Schema.Boolean.annotate({ description: "Include inactive members." })),
        "includeDeceased": Schema.optionalKey(Schema.Boolean.annotate({ description: "Include deceased members." })),
      }),
      output: FAMILY_SCHEMA,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/families/${id(args["familyId"])}`, projectFamily, {
            include_inactive: args["includeInactive"],
            include_deceased: args["includeDeceased"],
          });
        }),
    }),
    list(connection, {
      name: "list_groups",
      description:
        "List or search CCB groups by partial name, optionally for one campus. Returns group type, leader, and membership mode.",
      filters: {
        "name": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial group name." }),
        ),
        "campusId": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Only groups at this campus." }),
        ),
      },
      row: GROUP_DETAIL_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            "/groups",
            args,
            projectGroup,
            {
              name: args["name"],
              campus_ids: args["campusId"] === undefined ? undefined : [args["campusId"]],
            },
            cursor,
          );
        }),
    }),
    read(connection, {
      name: "get_group",
      description: "Get one CCB group: description, member count, meeting day, time, area, and address.",
      input: Schema.Struct({
        "groupId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Group id from list_groups.",
        }),
      }),
      output: GROUP_DETAIL_SCHEMA,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/groups/${id(args["groupId"])}`, projectGroup, {});
        }),
    }),
    list(connection, {
      name: "list_group_members",
      description:
        "List one CCB group's participants with role and date added. Filter by leader or member status, or partial name.",
      filters: {
        "groupId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Group id from list_groups.",
        }),
        "status": Schema.optionalKey(
          Schema.Literals(["all", "leader", "member"]).annotate({ description: "Participant role filter." }),
        ),
        "name": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial participant name." }),
        ),
      },
      row: MEMBERSHIP_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            `/groups/${id(args["groupId"])}/members`,
            args,
            projectMembership,
            {
              status: args["status"],
              name: args["name"],
            },
            cursor,
          );
        }),
    }),
    list(connection, {
      name: "list_individual_groups",
      description:
        "List the CCB groups one individual belongs to, with their role. Defaults to member and leader roles.",
      filters: {
        "individualId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Individual id." }),
        "includeInactive": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "List inactive groups instead of active ones." }),
        ),
      },
      row: MEMBERSHIP_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            `/individuals/${id(args["individualId"])}/groups`,
            args,
            projectMembership,
            {
              inactive: args["includeInactive"],
            },
            cursor,
          );
        }),
    }),
    list(connection, {
      name: "list_events",
      description:
        "List CCB event occurrences by name and time range. Each row's eventId and occurrence feed the attendance tools.",
      filters: {
        "name": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial event name." }),
        ),
        "range": Schema.optionalKey(
          Schema.Literals(["ALL", "PAST", "CURRENT", "FUTURE"]).annotate({
            description: "Time range relative to now.",
          }),
        ),
      },
      row: OCCURRENCE_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            "/events",
            args,
            projectOccurrence,
            {
              name: args["name"],
              range_type: args["range"],
            },
            cursor,
          );
        }),
    }),
    read(connection, {
      name: "get_event",
      description: "Get one CCB event's details, optionally for one occurrence with its attendance totals.",
      input: Schema.Struct({
        "eventId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Event id from list_events.",
        }),
        "occurrence": Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-?\\d{2}-?\\d{2}$")).annotate({
            description: "Occurrence date, YYYYMMDD or YYYY-MM-DD. Omit for the series.",
          }),
        ),
        "withAttendance": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Add attendance totals for the occurrence." }),
        ),
      }),
      output: EVENT_SCHEMA,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/events/${id(args["eventId"])}`, projectEvent, {
            occurrence: compactDate(args["occurrence"]),
            attendance_info: args["withAttendance"],
          });
        }),
    }),
    read(connection, {
      name: "get_event_attendance",
      description:
        "Get one CCB event occurrence's attendance summary: met or not, totals, visitors, topic. Drops leader notes and prayer requests from the named projection.",
      input: Schema.Struct({
        "eventId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Event id from list_events.",
        }),
        "occurrence": Schema.String.check(pattern("^\\d{4}-?\\d{2}-?\\d{2}$")).annotate({
          description: "Occurrence date, YYYYMMDD or YYYY-MM-DD, from list_events.",
        }),
      }),
      output: ATTENDANCE_SCHEMA,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(
            `/events/${id(args["eventId"])}/attendance/${compactDate(args["occurrence"])}`,
            projectAttendance,
            {},
          );
        }),
    }),
    list(connection, {
      name: "list_event_attendees",
      description: "List who attended one CCB event occurrence. Returns individual ids and names.",
      filters: {
        "eventId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Event id from list_events.",
        }),
        "occurrence": Schema.String.check(pattern("^\\d{4}-?\\d{2}-?\\d{2}$")).annotate({
          description: "Occurrence date, YYYYMMDD or YYYY-MM-DD, from list_events.",
        }),
      },
      row: ATTENDEE_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            `/events/${id(args["eventId"])}/attendance/${compactDate(args["occurrence"])}/attendees`,
            args,
            projectAttendee,
            {},
            cursor,
          );
        }),
    }),
    list(connection, {
      name: "list_individual_notes",
      description:
        "List the notes on one CCB individual that the connection may read, with sharing level and context. Pastoral content; reduce before returning.",
      filters: {
        "individualId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Individual id." }),
        "context": Schema.optionalKey(
          Schema.Literals(["GROUP", "DEPARTMENT", "PROCESS_QUEUE", "GENERAL"]).annotate({
            description: "Only notes in this context.",
          }),
        ),
      },
      row: NOTE_SCHEMA,
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          return yield* fetchPage(
            `/individuals/${id(args["individualId"])}/notes`,
            args,
            projectNote,
            {
              context: args["context"] === undefined ? undefined : [args["context"]],
              include_creator: true,
            },
            cursor,
          );
        }),
    }),
    read(connection, {
      name: "get_giving_metrics",
      description:
        "Get gift counts by period for one CCB individual or family, over at most 12 months. No per-gift amounts or transactions; pledges and scheduled gifts are available through indexed reads.",
      input: Schema.Struct({
        "individualId": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "Individual id. Exactly one of individualId or familyId.",
          }),
        ),
        "familyId": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "Family id. Exactly one of individualId or familyId.",
          }),
        ),
        "start": Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}$")).annotate({
            description: "Start date, YYYY-MM-DD. CCB caps the range at 12 months.",
          }),
        ),
        "end": Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}$")).annotate({
            description: "End date, YYYY-MM-DD.",
          }),
        ),
      }),
      output: Schema.Struct({
        "periods": Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              "start": Schema.optionalKey(Schema.String),
              "count": Schema.optionalKey(Integer),
              "members": Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({ "individualId": Schema.optionalKey(Integer), "count": Schema.optionalKey(Integer) }),
                ),
              ),
            }),
          ),
        ),
      }),
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          const individual = args["individualId"] !== undefined;
          if (individual === (args["familyId"] !== undefined)) {
            return yield* fail(new ConnectorCallError("invalid_args", "Pass exactly one of individualId or familyId."));
          }
          if (
            typeof args["start"] === "string" &&
            typeof args["end"] === "string" &&
            Date.parse(args["end"]) - Date.parse(args["start"]) > 366 * DAY_MS
          ) {
            return yield* fail(
              new ConnectorCallError(
                "invalid_args",
                "CCB caps giving metrics at a 12-month range; narrow start and end.",
              ),
            );
          }
          const path = individual
            ? `/individuals/${id(args["individualId"])}/metrics/giving`
            : `/families/${id(args["familyId"])}/metrics/giving`;
          const { body } = yield* request({ method: "GET", path, query: { start: args["start"], end: args["end"] } });
          const rows = asArray(body);

          return {
            periods: rows.map((value) => {
              const row = asRecord(value);
              return compact({
                start: row["start"] ?? row["date"],
                count: row["count"],
                members: Array.isArray(row["members"])
                  ? row["members"].map((member) => {
                      const item = asRecord(member);
                      return compact({ individualId: item["id"], count: item["count"] });
                    })
                  : undefined,
              });
            }),
          };
        }),
    }),
    list(connection, {
      name: "search_records",
      review: "CCB documents the indexed advanced-search result POSTs as read-only data searches.",
      description:
        "Search CCB church records with a reviewed read-only POST. Returns common identifiers, name, status and contact summaries; use the indexed read hatch for domain-specific response fields.",
      filters: {
        domain: Schema.String.check(pattern(`^(${SEARCH_DOMAINS.join("|")})$`)).annotate({
          description: "Reviewed advanced-search domain; the pattern lists every allowed value.",
        }),
        body: Schema.Record(Schema.String, Schema.Unknown).annotate({
          description: "Vendor search configuration and filters; get the operation details before choosing them.",
        }),
      },
      row: Schema.Struct({
        id: Schema.optionalKey(Integer),
        name: Schema.optionalKey(Schema.String),
        individualId: Schema.optionalKey(Integer),
        groupId: Schema.optionalKey(Integer),
        status: Schema.optionalKey(Schema.String),
        active: Schema.optionalKey(Schema.Boolean),
        campusId: Schema.optionalKey(Integer),
        familyId: Schema.optionalKey(Integer),
        membershipTypeId: Schema.optionalKey(Integer),
        email: Schema.optionalKey(Schema.String),
        counts: Schema.optionalKey(
          Schema.Struct({
            stillNeeded: Schema.optionalKey(Integer),
            needed: Schema.optionalKey(Integer),
            accepted: Schema.optionalKey(Integer),
            checkedIn: Schema.optionalKey(Integer),
            declined: Schema.optionalKey(Integer),
            pending: Schema.optionalKey(Integer),
          }),
        ),
      }),
      limit,
      total: true,
      cursor: "bound",
      page: (args, cursor) =>
        checked(() => refuseWithheldValues(args.body, "search_records")).pipe(
          Effect.andThen(
            fetchPage(
              "/search/" + args.domain + "/results",
              args,
              (value) => {
                const row = asRecord(value);
                return compact({
                  id: row.id,
                  name: row.name ?? row.title,
                  individualId: row.individual_id,
                  groupId: row.group_id,
                  status: row.status,
                  active: row.active,
                  campusId: row.campus_id,
                  familyId: row.family_id,
                  membershipTypeId: row.membership_type_id,
                  email: row.email,
                  counts:
                    args.domain === "schedules_totals"
                      ? compact({
                          stillNeeded: row.still_needed,
                          needed: row.needed,
                          accepted: row.accepted,
                          checkedIn: row.checked_in,
                          declined: row.declined,
                          pending: row.pending,
                        })
                      : undefined,
                });
              },
              {},
              cursor,
              args.body,
            ),
          ),
        ),
    }),
  ];
}
const DAY_MS = 86400000;
const fail = (error: ConnectorCallError) => Effect.fail(new Refusal({ error }));
const pattern = (source: string) =>
  Schema.makeFilter((value: string) => new RegExp(source).test(value), { toJsonSchema: () => ({ pattern: source }) });
