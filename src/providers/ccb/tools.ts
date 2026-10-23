// CCB v2 kit tools and projections. Step 1 preserves the existing catalog, hatches, paging and raw modes.
import { Effect, Schema } from "effect";
import { defined, type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { Integer, isMinChars, isMaxChars } from "../../http/json-schema.js";
import { read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import type { CcbOptions } from "./index.js";
import { callCcb, DEFAULT_PER_PAGE, resolveScopes, SEARCH_DOMAINS, type CcbRequest, type Query } from "./api.js";
const Raw = Schema.Boolean.annotate({
  description:
    "Return CCB's rows instead of the lean projection. The guide says whether sensitive fields stay dropped.",
});
type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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

function headerInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

interface PageInfo {
  hasMore: boolean;
  nextPage: number | null;
  total: number | null;
}

/**
 * One branch for every list: `hasMore`, from `x-next-page` when CCB sends it
 * (empty on the last page), else `x-page` against `x-total-pages`, else — a
 * list that sent neither — a full page is read as "maybe more".
 */
function pageInfo(headers: Headers, page: number, perPage: number, rows: number): PageInfo {
  const current = headerInt(headers, "x-page") ?? page;
  const totalPages = headerInt(headers, "x-total-pages");
  let nextPage: number | null;
  if (headers.has("x-next-page")) nextPage = headerInt(headers, "x-next-page") ?? null;
  else if (totalPages !== undefined) nextPage = current < totalPages ? current + 1 : null;
  else nextPage = rows >= perPage ? current + 1 : null;
  return {
    hasMore: nextPage !== null,
    nextPage,
    total: headerInt(headers, "x-total") ?? null,
  };
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

function projectForm(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    title: row["title"],
    status: row["status"],
    campusId: row["campus_id"],
    start: row["start"],
    end: row["end"],
    public: row["public"],
    url: row["url"],
  });
}

function projectResponse(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    formId: row["form_id"],
    individualId: row["individual_id"],
    created: row["created"],
    paymentStatus: row["payment_status"],
    answers: asArray(row["answers"]).map((answer) => {
      const item = asRecord(answer);
      return compact({ questionId: item["question_id"], answer: item["answer"] });
    }),
  });
}

function projectProcess(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    campusId: row["campus_id"],
    ownerId: row["owner_id"],
    hidden: row["hidden"],
    archived: row["archived"],
    managers: Array.isArray(row["process_managers"]) ? row["process_managers"].map(ref).filter(Boolean) : undefined,
  });
}

function projectQueue(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    processId: row["process_id"],
    processName: row["process_name"] ?? asRecord(row["process"])["name"],
    description: row["description"] || undefined,
    assignedCount: row["assigned_count"],
    unassignedCount: row["unassigned_count"],
  });
}

function projectQueueIndividual(value: unknown): JsonRecord {
  const row = asRecord(value);
  const queue = asRecord(row["queue"]);
  const process = asRecord(row["process"]);
  return compact({
    queueIndividualId: row["queue_individual_id"],
    queueId: row["queue_id"],
    queueName: queue["name"],
    processId: process["id"] ?? queue["process_id"],
    processName: process["name"] ?? queue["process_name"],
    individualId: row["individual_id"],
    name: asRecord(row["individual"])["name"],
    status: row["status"],
    due: row["due"],
    created: row["created"],
    completed: row["completed"],
  });
}

function projectCategory(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    campus: ref(row["campus"]),
    organizer: ref(row["organizer"]),
    archived: row["archived"],
    teams: Array.isArray(row["teams"]) ? row["teams"].map(ref).filter(Boolean) : undefined,
  });
}

function projectSchedule(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    categoryId: row["category_id"],
    name: row["name"],
    start: row["start"],
    end: row["end"],
    needed: row["needed"],
    events: Array.isArray(row["events"])
      ? row["events"].map((event) => {
          const item = asRecord(event);
          return compact({ id: item["id"], name: item["name"], start: item["start"], end: item["end"] });
        })
      : undefined,
    metrics: present(compact({ ...asRecord(row["metrics"]) })),
  });
}

function projectAssignment(value: unknown): JsonRecord {
  const row = asRecord(value);
  const volunteer = asRecord(row["volunteer"]);
  const person = asRecord(volunteer["individual"]);
  return compact({
    id: row["id"],
    categoryId: row["category_id"],
    scheduleId: row["schedule_id"],
    eventId: row["event_id"],
    eventPositionId: row["event_position_id"],
    status: row["status"],
    statusReason: row["status_reason"] || undefined,
    dateNotified: row["date_notified"],
    individualId: person["id"],
    name: person["name"],
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

function projectPledge(value: unknown): JsonRecord {
  const row = asRecord(value);
  const recurrence = asRecord(row["recurrence"]);
  return compact({
    id: row["id"],
    campusId: row["campus_id"],
    fund: asRecord(row["coa"])["name"],
    pledged: row["pledged"],
    paid: row["paid"],
    expected: row["expected"],
    total: row["total"],
    frequency: recurrence["frequency"],
    start: row["start"],
    end: recurrence["end"],
  });
}

const PAGE_SCHEMA = Schema.Struct({
  "hasMore": Schema.optionalKey(Schema.Boolean),
  "nextPage": Schema.optionalKey(Schema.Union([Integer, Schema.Null])),
  "total": Schema.optionalKey(Schema.Union([Integer, Schema.Null])),
});
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
  "baptized": Schema.optionalKey(Schema.Boolean),
  "lastAttendedDate": Schema.optionalKey(Schema.String),
  "listed": Schema.optionalKey(Schema.Boolean),
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
const GROUP_SCHEMA = Schema.Struct({
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
const FORM_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "title": Schema.optionalKey(Schema.String),
  "status": Schema.optionalKey(Schema.String),
  "campusId": Schema.optionalKey(Integer),
  "start": Schema.optionalKey(Schema.String),
  "end": Schema.optionalKey(Schema.String),
  "public": Schema.optionalKey(Schema.Boolean),
  "url": Schema.optionalKey(Schema.String),
});
const RESPONSE_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "formId": Schema.optionalKey(Integer),
  "individualId": Schema.optionalKey(Integer),
  "created": Schema.optionalKey(Schema.String),
  "paymentStatus": Schema.optionalKey(Schema.String),
  "answers": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ "questionId": Schema.optionalKey(Integer), "answer": Schema.optionalKey(Schema.String) }),
    ),
  ),
});
const PROCESS_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "campusId": Schema.optionalKey(Integer),
  "ownerId": Schema.optionalKey(Integer),
  "hidden": Schema.optionalKey(Schema.Boolean),
  "archived": Schema.optionalKey(Schema.Boolean),
  "managers": Schema.optionalKey(
    Schema.Array(Schema.Struct({ "id": Schema.optionalKey(Integer), "name": Schema.optionalKey(Schema.String) })),
  ),
});
const QUEUE_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "processId": Schema.optionalKey(Integer),
  "processName": Schema.optionalKey(Schema.String),
  "description": Schema.optionalKey(Schema.String),
  "assignedCount": Schema.optionalKey(Integer),
  "unassignedCount": Schema.optionalKey(Integer),
});
const QUEUE_INDIVIDUAL_SCHEMA = Schema.Struct({
  "queueIndividualId": Schema.optionalKey(Integer),
  "queueId": Schema.optionalKey(Integer),
  "queueName": Schema.optionalKey(Schema.String),
  "processId": Schema.optionalKey(Integer),
  "processName": Schema.optionalKey(Schema.String),
  "individualId": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "status": Schema.optionalKey(Schema.String),
  "due": Schema.optionalKey(Schema.String),
  "created": Schema.optionalKey(Schema.String),
  "completed": Schema.optionalKey(Schema.String),
});
const CATEGORY_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "campus": Schema.optionalKey(
    Schema.Struct({ "id": Schema.optionalKey(Integer), "name": Schema.optionalKey(Schema.String) }),
  ),
  "organizer": Schema.optionalKey(
    Schema.Struct({ "id": Schema.optionalKey(Integer), "name": Schema.optionalKey(Schema.String) }),
  ),
  "archived": Schema.optionalKey(Schema.Boolean),
  "teams": Schema.optionalKey(
    Schema.Array(Schema.Struct({ "id": Schema.optionalKey(Integer), "name": Schema.optionalKey(Schema.String) })),
  ),
});
const SCHEDULE_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "categoryId": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
  "start": Schema.optionalKey(Schema.String),
  "end": Schema.optionalKey(Schema.String),
  "needed": Schema.optionalKey(Integer),
  "events": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        "id": Schema.optionalKey(Integer),
        "name": Schema.optionalKey(Schema.String),
        "start": Schema.optionalKey(Schema.String),
        "end": Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  "metrics": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const ASSIGNMENT_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "categoryId": Schema.optionalKey(Integer),
  "scheduleId": Schema.optionalKey(Integer),
  "eventId": Schema.optionalKey(Integer),
  "eventPositionId": Schema.optionalKey(Integer),
  "status": Schema.optionalKey(Schema.String),
  "statusReason": Schema.optionalKey(Schema.String),
  "dateNotified": Schema.optionalKey(Schema.String),
  "individualId": Schema.optionalKey(Integer),
  "name": Schema.optionalKey(Schema.String),
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
const PLEDGE_SCHEMA = Schema.Struct({
  "id": Schema.optionalKey(Integer),
  "campusId": Schema.optionalKey(Integer),
  "fund": Schema.optionalKey(Schema.String),
  "pledged": Schema.optionalKey(Schema.Finite),
  "paid": Schema.optionalKey(Schema.Finite),
  "expected": Schema.optionalKey(Schema.Finite),
  "total": Schema.optionalKey(Schema.Finite),
  "frequency": Schema.optionalKey(Schema.String),
  "start": Schema.optionalKey(Schema.String),
  "end": Schema.optionalKey(Schema.String),
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
const RESULT_OUTPUT = Schema.Struct({
  "result": Schema.Unknown.pipe(
    Schema.annotateKey({
      description: "CCB's response body, less the sensitive fields this connection drops, or null when empty.",
    }),
  ),
  "page": Schema.optionalKey(PAGE_SCHEMA),
});
function hatchPath(value: unknown): string {
  const path = String(value);
  // Judged after the same normalization the transport applies, and after
  // percent-decoding, so `/groups/../oauth/token` and `/%6Fauth/token` are
  // the token endpoint they resolve to.
  let resolved = path;
  try {
    resolved = new URL(`https://ccb.invalid${path.startsWith("/") ? path : `/${path}`}`).pathname;
    resolved = decodeURIComponent(resolved);
  } catch {
    // An unparseable path is refused by the transport's own confinement.
  }
  if (/^\/+oauth(\/|$)/i.test(path) || /^\/+oauth(\/|$)/i.test(resolved)) {
    throw new ConnectorCallError("invalid_args", "CCB /oauth paths belong to the connector's grant, not to API calls.");
  }
  return path;
}

/** Scalar query values only; the schema admits nothing else. */
function hatchQuery(value: unknown): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  for (const [name, item] of Object.entries(asRecord(value))) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      query[name] = item;
    }
  }
  return query;
}

function pageQuery(args: JsonRecord, defaultPerPage: number): { page: number; per_page: number } {
  return {
    page: typeof args["page"] === "number" ? args["page"] : 1,
    per_page: typeof args["perPage"] === "number" ? args["perPage"] : defaultPerPage,
  };
}

function compactDate(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/-/g, "") : undefined;
}

/** Step 1 retains page-number arguments, header precedence and the lean/raw output schemas. */
export function ccbTools({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<CcbOptions>;
}): ApiTool[] {
  const defaultPerPage = options.defaultPerPage ?? DEFAULT_PER_PAGE;
  const PerPage = Schema.Literals([25, 50, 75, 100]).annotate({
    description: `Rows per page. CCB accepts only these values; defaults to ${defaultPerPage}.`,
  });
  const request = (req: CcbRequest) => callCcb(connection, req);
  const list = <K extends string>(
    path: string,
    args: JsonRecord,
    key: K,
    project: (row: unknown) => JsonRecord,
    query: Query = {},
  ) =>
    Effect.gen(function* () {
      const paging = pageQuery(args, defaultPerPage);
      const { body, headers } = yield* request({ method: "GET", path, query: { ...query, ...paging } });
      const rows = asArray(body);
      return {
        [key]: args["raw"] === true ? rows : rows.map(project),
        page: pageInfo(headers, paging.page, paging.per_page, rows.length),
      } as Record<K, JsonRecord[]> & { page: PageInfo };
    });
  const one = (path: string, args: JsonRecord, project: (row: unknown) => JsonRecord, query: Query = {}) =>
    request({ method: "GET", path, query }).pipe(
      Effect.map(({ body }) => (args["raw"] === true ? (body as JsonRecord) : project(body))),
    );
  const id = (value: unknown) => encodeURIComponent(String(value));
  const tools: ApiTool[] = [
    read(connection, {
      name: "get_me",
      description:
        "Get the CCB individual the access token belongs to. Under Identity Auth that is the signed-in person whose permissions every call carries.",
      input: Schema.Record(Schema.String, Schema.Never),
      output: ME_SCHEMA,
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
    read(connection, {
      name: "list_individuals",
      description:
        "Find CCB individuals by partial name, phone, or email. Returns lean profiles with family and campus ids; not the advanced search.",
      input: Schema.Struct({
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
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "individuals": Schema.Array(PERSON_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/individuals", args, "individuals", projectPerson, {
            name: args["query"],
            include_inactive: args["includeInactive"],
            include_deceased: args["includeDeceased"],
            campus_scope: args["campusScope"],
          });
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
        "raw": Schema.optionalKey(Raw),
      }),
      output: INDIVIDUAL_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/individuals/${id(args["individualId"])}`, args, projectIndividual);
        }),
    }),
    read(connection, {
      name: "list_families",
      description:
        "Find CCB families by partial last name, email, or mobile phone. Returns family ids and addresses; get_family lists the members.",
      input: Schema.Struct({
        "lastName": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial last name." }),
        ),
        "email": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial email." }),
        ),
        "phone": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(50)).annotate({ description: "Partial mobile phone." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "families": Schema.Array(FAMILY_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/families", args, "families", projectFamily, {
            last_name: args["lastName"],
            email: args["email"],
            phone: args["phone"],
          });
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
        "raw": Schema.optionalKey(Raw),
      }),
      output: FAMILY_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/families/${id(args["familyId"])}`, args, projectFamily, {
            include_inactive: args["includeInactive"],
            include_deceased: args["includeDeceased"],
          });
        }),
    }),
    read(connection, {
      name: "list_groups",
      description:
        "List or search CCB groups by partial name, optionally for one campus. Returns group type, leader, and membership mode.",
      input: Schema.Struct({
        "name": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial group name." }),
        ),
        "campusId": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Only groups at this campus." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "groups": Schema.Array(GROUP_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/groups", args, "groups", projectGroup, {
            name: args["name"],
            campus_ids: args["campusId"],
          });
        }),
    }),
    read(connection, {
      name: "get_group",
      description: "Get one CCB group: description, member count, meeting day, time, area, and address.",
      input: Schema.Struct({
        "groupId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Group id from list_groups.",
        }),
        "raw": Schema.optionalKey(Raw),
      }),
      output: GROUP_DETAIL_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/groups/${id(args["groupId"])}`, args, projectGroup);
        }),
    }),
    read(connection, {
      name: "list_group_members",
      description:
        "List one CCB group's participants with role and date added. Filter by leader or member status, or partial name.",
      input: Schema.Struct({
        "groupId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Group id from list_groups.",
        }),
        "status": Schema.optionalKey(
          Schema.Literals(["all", "leader", "member"]).annotate({ description: "Participant role filter." }),
        ),
        "name": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial participant name." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "members": Schema.Array(MEMBERSHIP_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(`/groups/${id(args["groupId"])}/members`, args, "members", projectMembership, {
            status: args["status"],
            name: args["name"],
          });
        }),
    }),
    read(connection, {
      name: "list_individual_groups",
      description:
        "List the CCB groups one individual belongs to, with their role. Defaults to member and leader roles.",
      input: Schema.Struct({
        "individualId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Individual id." }),
        "includeInactive": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "List inactive groups instead of active ones." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "groups": Schema.Array(MEMBERSHIP_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(`/individuals/${id(args["individualId"])}/groups`, args, "groups", projectMembership, {
            inactive: args["includeInactive"],
          });
        }),
    }),
    read(connection, {
      name: "list_events",
      description:
        "List CCB event occurrences by name and time range. Each row's eventId and occurrence feed the attendance tools.",
      input: Schema.Struct({
        "name": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial event name." }),
        ),
        "range": Schema.optionalKey(
          Schema.Literals(["ALL", "PAST", "CURRENT", "FUTURE"]).annotate({
            description: "Time range relative to now.",
          }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "occurrences": Schema.Array(OCCURRENCE_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/events", args, "occurrences", projectOccurrence, {
            name: args["name"],
            range_type: args["range"],
          });
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
        "raw": Schema.optionalKey(Raw),
      }),
      output: EVENT_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(`/events/${id(args["eventId"])}`, args, projectEvent, {
            occurrence: compactDate(args["occurrence"]),
            attendance_info: args["withAttendance"],
          });
        }),
    }),
    read(connection, {
      name: "get_event_attendance",
      description:
        "Get one CCB event occurrence's attendance summary: met or not, totals, visitors, topic. Drops leader notes and prayer requests unless raw.",
      input: Schema.Struct({
        "eventId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Event id from list_events.",
        }),
        "occurrence": Schema.String.check(pattern("^\\d{4}-?\\d{2}-?\\d{2}$")).annotate({
          description: "Occurrence date, YYYYMMDD or YYYY-MM-DD, from list_events.",
        }),
        "raw": Schema.optionalKey(Raw),
      }),
      output: ATTENDANCE_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          return yield* one(
            `/events/${id(args["eventId"])}/attendance/${compactDate(args["occurrence"])}`,
            args,
            projectAttendance,
          );
        }),
    }),
    read(connection, {
      name: "list_event_attendees",
      description: "List who attended one CCB event occurrence. Returns individual ids and names.",
      input: Schema.Struct({
        "eventId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Event id from list_events.",
        }),
        "occurrence": Schema.String.check(pattern("^\\d{4}-?\\d{2}-?\\d{2}$")).annotate({
          description: "Occurrence date, YYYYMMDD or YYYY-MM-DD, from list_events.",
        }),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "attendees": Schema.Array(ATTENDEE_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(
            `/events/${id(args["eventId"])}/attendance/${compactDate(args["occurrence"])}/attendees`,
            args,
            "attendees",
            projectAttendee,
          );
        }),
    }),
    read(connection, {
      name: "list_forms",
      description:
        "List or search CCB forms by partial title, status, or campus. Returns form ids for list_form_responses.",
      input: Schema.Struct({
        "title": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Partial form title." }),
        ),
        "status": Schema.optionalKey(
          Schema.Literals(["ACTIVE", "SCHEDULED", "UNPUBLISHED", "EXPIRED", "ARCHIVED"]).annotate({
            description: "Form status.",
          }),
        ),
        "campusId": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Only forms at this campus." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "forms": Schema.Array(FORM_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/forms", args, "forms", projectForm, {
            title: args["title"],
            status: args["status"],
            campus_id: args["campusId"],
          });
        }),
    }),
    read(connection, {
      name: "list_form_responses",
      description:
        "List one CCB form's responses with answers by question id and payment status. Drops payment details unless raw.",
      input: Schema.Struct({
        "formId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Form id from list_forms." }),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "responses": Schema.Array(RESPONSE_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(`/forms/${id(args["formId"])}/responses`, args, "responses", projectResponse);
        }),
    }),
    read(connection, {
      name: "list_processes",
      description:
        "List CCB processes (assimilation and follow-up pipelines) by name or status. Returns process ids for list_queues.",
      input: Schema.Struct({
        "name": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Process name search." }),
        ),
        "status": Schema.optionalKey(
          Schema.Literals(["HIDDEN", "ACTIVE", "ARCHIVED"]).annotate({ description: "Process status." }),
        ),
        "managedByMe": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Only processes the connection's individual manages." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "processes": Schema.Array(PROCESS_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/processes", args, "processes", projectProcess, {
            name: args["name"],
            statuses: args["status"],
            managed_by_me: args["managedByMe"],
          });
        }),
    }),
    read(connection, {
      name: "list_queues",
      description: "List CCB process queues, optionally for one process, with assigned and unassigned counts.",
      input: Schema.Struct({
        "processId": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Only queues in this process." }),
        ),
        "search": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Queue name search." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "queues": Schema.Array(QUEUE_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/queues", args, "queues", projectQueue, {
            process_ids: args["processId"],
            search_term: args["search"],
          });
        }),
    }),
    read(connection, {
      name: "list_queue_individuals",
      description:
        "List people in CCB process queues the connection can see, by status or assignment. CCB offers no per-queue filter here; filter on queueId.",
      input: Schema.Struct({
        "status": Schema.optionalKey(
          Schema.Literals(["NOT_STARTED", "WAITING", "IN_PROCESS", "DONE"]).annotate({ description: "Queue status." }),
        ),
        "assignment": Schema.optionalKey(
          Schema.Literals(["ASSIGNED_TO_ME", "UNASSIGNED"]).annotate({ description: "Omit for both." }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "queueIndividuals": Schema.Array(QUEUE_INDIVIDUAL_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list("/queues_individuals", args, "queueIndividuals", projectQueueIndividual, {
            statuses: args["status"],
            assignment: args["assignment"],
          });
        }),
    }),
    read(connection, {
      name: "list_scheduling_categories",
      description:
        "List CCB scheduling categories (serving ministries) with teams and organizer. Category ids feed list_schedules.",
      input: Schema.Struct({
        "search": Schema.optionalKey(
          Schema.String.check(isMinChars(1), isMaxChars(200)).annotate({ description: "Category name search." }),
        ),
        "status": Schema.optionalKey(
          Schema.Literals(["ACTIVE", "ARCHIVED", "ACTIVE_AND_ARCHIVED"]).annotate({
            description: "Defaults to CCB's own (active).",
          }),
        ),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "categories": Schema.Array(CATEGORY_SCHEMA) }),
      run: (args) =>
        Effect.gen(function* () {
          const { body } = yield* request({
            method: "GET",
            path: "/scheduling/categories",
            query: { search_term: args["search"], status: args["status"] },
          });
          const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
          return { categories: args["raw"] === true ? rows : rows.map(projectCategory) };
        }),
    }),
    read(connection, {
      name: "list_schedules",
      description:
        "List one CCB scheduling category's schedules with events and assignment metrics. CCB allows one call per two seconds here.",
      input: Schema.Struct({
        "categoryId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Category id from list_scheduling_categories.",
        }),
        "after": Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}$")).annotate({
            description: "Only schedules ending after this date, YYYY-MM-DD.",
          }),
        ),
        "before": Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}$")).annotate({
            description: "Only schedules ending before this date, YYYY-MM-DD.",
          }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "schedules": Schema.Array(SCHEDULE_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(
            `/scheduling/categories/${id(args["categoryId"])}/schedules`,
            args,
            "schedules",
            projectSchedule,
            {
              after: args["after"],
              before: args["before"],
              withMetrics: true,
            },
          );
        }),
    }),
    read(connection, {
      name: "list_individual_assignments",
      description: "List one CCB individual's serving assignments with status, schedule, and event ids.",
      input: Schema.Struct({
        "individualId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Individual id." }),
        "startDate": Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}$")).annotate({
            description: "Earliest assignment date, YYYY-MM-DD.",
          }),
        ),
        "endDate": Schema.optionalKey(
          Schema.String.check(pattern("^\\d{4}-\\d{2}-\\d{2}$")).annotate({
            description: "Latest assignment date, YYYY-MM-DD.",
          }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "assignments": Schema.Array(ASSIGNMENT_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(
            `/individuals/${id(args["individualId"])}/assignments`,
            args,
            "assignments",
            projectAssignment,
            {
              start_date: args["startDate"],
              end_date: args["endDate"],
            },
          );
        }),
    }),
    read(connection, {
      name: "list_individual_notes",
      description:
        "List the notes on one CCB individual that the connection may read, with sharing level and context. Pastoral content; reduce before returning.",
      input: Schema.Struct({
        "individualId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Individual id." }),
        "context": Schema.optionalKey(
          Schema.Literals(["GROUP", "DEPARTMENT", "PROCESS_QUEUE", "GENERAL"]).annotate({
            description: "Only notes in this context.",
          }),
        ),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "notes": Schema.Array(NOTE_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(`/individuals/${id(args["individualId"])}/notes`, args, "notes", projectNote, {
            context: args["context"],
            include_creator: true,
          });
        }),
    }),
    read(connection, {
      name: "get_giving_metrics",
      description:
        "Get gift counts by period for one CCB individual or family, over at most 12 months. Counts only; v2 exposes no amounts or transactions.",
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
        "raw": Schema.optionalKey(Raw),
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
          if (args["raw"] === true) return { periods: rows as JsonRecord[] };
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
    read(connection, {
      name: "list_individual_pledges",
      description: "List one CCB individual's pledges: fund, pledged, paid, and expected amounts, and recurrence.",
      input: Schema.Struct({
        "individualId": Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Individual id." }),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
        "raw": Schema.optionalKey(Raw),
      }),
      output: Schema.Struct({ "pledges": Schema.Array(PLEDGE_SCHEMA), "page": PAGE_SCHEMA }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list(`/individuals/${id(args["individualId"])}/pledges`, args, "pledges", projectPledge);
        }),
    }),
    read(connection, {
      name: "ccb_api_get",
      description:
        "Call any CCB v2 GET endpoint and return its body, less the sensitive fields this connection drops. Use named reads first; they project and page.",
      input: Schema.Struct({
        "path": Schema.String.check(isMinChars(2), isMaxChars(512), pattern("^/[^?#]*$")).annotate({
          description:
            "Path below the API origin beginning with '/', such as /campuses. No query string; no /oauth paths.",
        }),
        "query": Schema.optionalKey(
          Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])).annotate({
            description: "Query parameters by name, one value each, such as { per_page: 50 }.",
          }),
        ),
      }),
      output: RESULT_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          const scalars = hatchQuery(args["query"]);
          const { body, headers } = yield* request({ method: "GET", path: hatchPath(args["path"]), query: scalars });
          const page = typeof scalars["page"] === "number" ? scalars["page"] : 1;
          const per = typeof scalars["per_page"] === "number" ? scalars["per_page"] : DEFAULT_PER_PAGE;
          return {
            result: body ?? null,
            ...defined({
              page:
                Array.isArray(body) && (headers.has("x-page") || headers.has("x-next-page"))
                  ? pageInfo(headers, page, per, body.length)
                  : undefined,
            }),
          };
        }),
    }),
    read(connection, {
      name: "ccb_api_search",
      description:
        "Run a CCB advanced search (POST /search/{domain}/results) and return its rows, less dropped sensitive fields. Read-only; individuals allows one call per five seconds.",
      review:
        "CCB advanced search POSTs return matching records without changing them; the published v2 search results operations are read-only.",
      input: Schema.Struct({
        "domain": Schema.String.check(pattern("^[a-z_]{1,40}$")).annotate({
          description:
            "Search domain: assignments, categories, department_detail, groups, individual_event_attendance, individual_groups, individuals, organizers, positions, schedules, schedules_totals, scheduling_files, scheduling_individuals, songs, volunteers.",
        }),
        "body": Schema.Record(Schema.String, Schema.Unknown).annotate({
          description: "Search body as CCB documents it for the domain, e.g. { configuration, filters }.",
        }),
        "page": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
            description: "1-based page number; pass page.nextPage from the previous result.",
          }),
        ),
        "perPage": Schema.optionalKey(PerPage),
      }),
      output: RESULT_OUTPUT,
      run: (args) =>
        Effect.gen(function* () {
          if (!(SEARCH_DOMAINS as readonly string[]).includes(args["domain"])) {
            return yield* fail(
              new ConnectorCallError(
                "invalid_args",
                `CCB has no advanced search domain "${String(args["domain"]).slice(0, 40)}"; use one of ${SEARCH_DOMAINS.join(", ")}.`,
              ),
            );
          }
          const paging = pageQuery(args, defaultPerPage);
          const { body, headers } = yield* request({
            method: "POST",
            path: `/search/${args["domain"]}/results`,
            query: paging,
            body: args["body"],
          });
          return {
            result: body ?? null,
            page: pageInfo(headers, paging.page, paging.per_page, asArray(body).length),
          };
        }),
    }),
  ];
  if (resolveScopes(options).some((scope) => !scope.startsWith("read:")))
    tools.push(
      write(connection, {
        name: "ccb_api_mutate",
        description:
          "Call any CCB v2 JSON POST, PUT, PATCH, or DELETE endpoint. The approval-gated hatch for every write; no file uploads.",
        destructive: true,
        writeSteps: { write: "once" },
        input: Schema.Struct({
          "method": Schema.Literals(["POST", "PUT", "PATCH", "DELETE"]).annotate({
            description: "HTTP method the endpoint documents.",
          }),
          "path": Schema.String.check(isMinChars(2), isMaxChars(512), pattern("^/[^?#]*$")).annotate({
            description:
              "Path below the API origin beginning with '/', such as /campuses. No query string; no /oauth paths.",
          }),
          "query": Schema.optionalKey(
            Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])).annotate({
              description: "Query parameters by name, one value each, such as { per_page: 50 }.",
            }),
          ),
          "body": Schema.optionalKey(
            Schema.Union([
              Schema.Record(Schema.String, Schema.Unknown),
              Schema.Array(Schema.Unknown),
              Schema.String,
              Schema.Finite,
              Schema.Boolean,
              Schema.Null,
            ]).annotate({ description: "JSON body exactly as CCB documents it. Omit when the endpoint takes none." }),
          ),
        }),
        output: RESULT_OUTPUT,
        run: (args) =>
          Effect.gen(function* () {
            const { body } = yield* request({
              method: args["method"],
              path: hatchPath(args["path"]),
              query: hatchQuery(args["query"]),
              ...(args["body"] !== undefined ? { body: args["body"] } : {}),
            });
            return { result: body ?? null };
          }),
      }),
    );
  return tools.map(legacyQueryOrder);
}
const DAY_MS = 86_400_000;
const fail = (error: ConnectorCallError) => Effect.fail(new Refusal({ error }));

// Use the exact legacy JSON Schema pattern, including its escape spelling.
const pattern = (source: string) =>
  Schema.makeFilter((value: string) => new RegExp(source).test(value), { toJsonSchema: () => ({ pattern: source }) });

/** Step-1 byte shim: integer literals retain their integer type; legacy query descriptions precede additionalProperties.
 * Schema still owns both contracts; remove this keyword-order adapter in step 2. */
function legacyQueryOrder(tool: ApiTool): ApiTool {
  const root = tool.inputSchema as { properties?: Record<string, Record<string, unknown>> };
  const perPage = root.properties?.["perPage"];
  if (perPage && Array.isArray(perPage["enum"]) && perPage["enum"].every(Number.isInteger)) perPage["type"] = "integer";
  const query = root.properties?.["query"];
  if (
    query?.["type"] === "object" &&
    query["description"] !== undefined &&
    typeof query["additionalProperties"] === "object"
  ) {
    const { additionalProperties, description, ...rest } = query;
    root.properties!["query"] = { ...rest, description, additionalProperties };
  }
  return tool;
}
