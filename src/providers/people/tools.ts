// People projections and contact, group, other-contact and directory tools on
// the standard provider kit.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import type { ArgumentProblems } from "../../http/argument-problems.js";
import { fieldsContract, selectFields } from "../../http/fields.js";
import { Integer, isMaxChars, isMinChars } from "../../http/json-schema.js";
import { Budget, type CallServices } from "../../http/services.js";
import { list, read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { Operation } from "../../runtime/call.js";
import { redactBeforeCut, redactSentSecrets } from "../../sent-secrets.js";
import type { ConnectorContext } from "../../types.js";
import { asArray, asRecord, compact } from "../_shared/json.js";
import { googleClient, googleFailureMessage, googleOutcomeOf, type GoogleRequest } from "../_shared/google/kit.js";
import { jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { PEOPLE_SENSITIVE_FIELDS } from "./lib/constants.js";
import { peopleIndex } from "./lib/hatch.js";

type JsonRecord = Record<string, any>;

/** Every person field Google's masks accept, less app-private clientData. */
const PERSON_FIELDS = [
  "addresses",
  "ageRanges",
  "biographies",
  "birthdays",
  "calendarUrls",
  "coverPhotos",
  "emailAddresses",
  "events",
  "externalIds",
  "genders",
  "imClients",
  "interests",
  "locales",
  "locations",
  "memberships",
  "metadata",
  "miscKeywords",
  "names",
  "nicknames",
  "occupations",
  "organizations",
  "phoneNumbers",
  "photos",
  "relations",
  "sipAddresses",
  "skills",
  "urls",
  "userDefined",
] as const;
/** The only fields Google's "Other contacts" masks accept. */
const OTHER_CONTACT_FIELDS = ["emailAddresses", "metadata", "names", "phoneNumbers", "photos"] as const;
/** What resolving a person needs, and all a default read asks for. */
const DEFAULT_FIELDS = ["names", "emailAddresses", "phoneNumbers", "organizations"] as const;
const DEFAULT_OTHER_FIELDS = ["names", "emailAddresses", "phoneNumbers"] as const;
const DIRECTORY_SOURCES = ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE", "DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT"];

/** Google caps one search at 30 results; the named tools keep that. */
const MAX_SEARCH = 30;
/** Connecta's page cap, narrower than Google's 1,000, so a page stays one readable result. */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
/** A listed text value is cut here; get_person returns it whole. */
const LIST_TEXT_CHARS = 1_000;
/** A single person's text value, before it would crowd out the rest. */
const GET_TEXT_CHARS = 20_000;
/** Resource names in one batch read; Google's own maximum is 200. */
const MAX_BATCH = 200;
/** Members one group read lists; Google returns none unless asked. */
const MAX_MEMBERS = 1_000;
/** Contacts one membership change may name; Google's own maximum is 1,000. */
const MAX_MEMBER_CHANGES = 1_000;

// --- Schemas ----------------------------------------------------------------------

const pattern = (source: string) =>
  Schema.makeFilter((value: string) => new RegExp(source).test(value), { toJsonSchema: () => ({ pattern: source }) });
const string = (description: string, max = 256) =>
  Schema.String.check(isMinChars(1), isMaxChars(max)).annotate({ description });
const optional = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Schema.optionalKey(value)])));

const personName = (description: string) => string(description, 64).check(pattern("^people/[A-Za-z0-9_-]+$"));
const contactName = personName("Contact resource name, e.g. people/c123, from a search or list.");
const groupName = string("Group resource name from list_contact_groups, e.g. contactGroups/myContacts.", 96).check(
  pattern("^contactGroups/[A-Za-z0-9_-]+$"),
);
const etag = string("Current etag from the latest read; a stale one is refused.", 512).check(pattern("^\\S+$"));
const Truncated = Schema.Array(Schema.String);
/** Google's searches return one capped page with no continuation. */
const TerminalPage = Schema.Struct({
  hasMore: Schema.Literal(false).annotate({
    description: "Always false: a search returns one page; narrow the query.",
  }),
});
const Entries = Schema.Array(Schema.Unknown);

/** A projected person: field entries keep their values; Google's per-entry metadata becomes `primary`. */
const PersonRecord = optional({
  resourceName: Schema.String,
  etag: Schema.String,
  ...Object.fromEntries(PERSON_FIELDS.map((field) => [field, field === "metadata" ? Schema.Unknown : Entries])),
  truncated: Truncated,
}) as unknown as Schema.Struct<Record<string, Schema.optionalKey<Schema.Top>>>;
const GroupRecord = optional({
  resourceName: Schema.String,
  etag: Schema.String,
  name: Schema.String,
  formattedName: Schema.String,
  groupType: Schema.String,
  memberCount: Integer,
  memberResourceNames: Schema.Array(Schema.String),
  truncated: Truncated,
});

const PERSON_ITEM_FIELDS = fieldsContract("item", PersonRecord, "It only narrows each person.");

/**
 * A person-field selection. The allowed names are checked in `check` rather
 * than as a schema enum, which would not fit the catalog's constraint budget.
 */
function fieldsInput(choices: readonly string[], defaults: readonly string[], what: string) {
  return {
    choices,
    input: Schema.optionalKey(
      Schema.Array(string("A field name.", 32).check(pattern("^[a-zA-Z]+$")))
        .check(Schema.isMinLength(1), Schema.isMaxLength(choices.length))
        .annotate({
          description: `${what} fields to read, e.g. ["names","emailAddresses"]; default ${defaults.join(", ")}.`,
        }),
    ),
  };
}

/** Record every requested field this connection cannot read, naming only the allowed set. */
function fieldProblems(
  problems: ArgumentProblems,
  requested: readonly string[] | undefined,
  selection: ReturnType<typeof fieldsInput>,
): void {
  requested?.forEach((field, index) => {
    if (!selection.choices.includes(field))
      problems.add(`/personFields/${index}`, `one of ${selection.choices.join(", ")}`);
  });
}

const contactFields = {
  name: Schema.optionalKey(
    Schema.Struct({
      givenName: Schema.optionalKey(string("Given (first) name.", 200)),
      familyName: Schema.optionalKey(string("Family (last) name.", 200)),
      middleName: Schema.optionalKey(string("Middle name.", 200)),
      honorificPrefix: Schema.optionalKey(string("Prefix, e.g. Dr.", 50)),
      honorificSuffix: Schema.optionalKey(string("Suffix, e.g. Jr.", 50)),
    }).annotate({ description: "The contact's one name." }),
  ),
  emailAddresses: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        value: string("Email address.", 320),
        type: Schema.optionalKey(string("home, work, other, or a custom label.", 64)),
      }),
    )
      .check(Schema.isMaxLength(50))
      .annotate({ description: "Every email address the contact keeps; [] clears them." }),
  ),
  phoneNumbers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        value: string("Phone number as written.", 64),
        type: Schema.optionalKey(string("mobile, home, work, other, or a custom label.", 64)),
      }),
    )
      .check(Schema.isMaxLength(50))
      .annotate({ description: "Every phone number the contact keeps; [] clears them." }),
  ),
  organizations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(string("Company or organization.", 200)),
        title: Schema.optionalKey(string("Job title.", 200)),
        department: Schema.optionalKey(string("Department.", 200)),
      }),
    )
      .check(Schema.isMaxLength(10))
      .annotate({ description: "Every organization the contact keeps; [] clears them." }),
  ),
};

/** The People mask names for the contact fields an agent sent. */
const MASKS: Readonly<Record<keyof typeof contactFields, string>> = {
  name: "names",
  emailAddresses: "emailAddresses",
  phoneNumbers: "phoneNumbers",
  organizations: "organizations",
};

function contactBody(args: JsonRecord): JsonRecord {
  return compact({
    names: args["name"] === undefined ? undefined : [args["name"]],
    emailAddresses: args["emailAddresses"],
    phoneNumbers: args["phoneNumbers"],
    organizations: args["organizations"],
  });
}

// --- Projection -------------------------------------------------------------------

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Cut text at `max` characters and say so in it, after replacing every secret the request sent. */
function capped(ctx: ConnectorContext, whole: string, max: number, remedy: string): string {
  if (whole.length <= max) return whole;
  const value = redactBeforeCut(ctx, whole);
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}\n[… ${value.length - cut.length} more characters truncated; ${remedy}]`;
}

/**
 * One person as an agent reads it: the resource name and etag, then each
 * field's entries with Google's per-entry source metadata reduced to a
 * `primary` flag. Long text is cut and its path reported in `truncated`.
 */
function projectPerson(ctx: ConnectorContext, value: unknown, maxChars: number, remedy: string): JsonRecord {
  const person = asRecord(value);
  const truncated = new Set<string>();
  const cut = (entry: unknown, path: string): unknown => {
    if (typeof entry === "string") {
      const kept = capped(ctx, entry, maxChars, remedy);
      if (kept !== entry) truncated.add(path);
      return kept;
    }
    if (Array.isArray(entry)) return entry.map((item) => cut(item, `${path}[]`));
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, cut(child, `${path}.${key}`)]));
  };
  const out: JsonRecord = {};
  for (const [field, entries] of Object.entries(person)) {
    if (field === "resourceName" || field === "etag") out[field] = entries;
    else if (field === "metadata") out[field] = cut(entries, field);
    // clientData is other applications' storage, withheld by review: the hatch shows its keys.
    else if (Array.isArray(entries) && (PERSON_FIELDS as readonly string[]).includes(field))
      out[field] = entries.map((raw) => {
        const { metadata, ...rest } = asRecord(raw);
        const kept = cut(rest, `${field}[]`) as JsonRecord;
        return asRecord(metadata)["primary"] === true ? { ...kept, primary: true } : kept;
      });
  }
  if (truncated.size) out["truncated"] = [...truncated];
  return out;
}

function projectGroup(value: unknown): JsonRecord {
  const group = asRecord(value);
  return compact({
    resourceName: text(group["resourceName"]),
    etag: text(group["etag"]),
    name: text(group["name"]),
    formattedName: text(group["formattedName"]),
    groupType: text(group["groupType"]),
    memberCount: typeof group["memberCount"] === "number" ? group["memberCount"] : undefined,
    memberResourceNames: Array.isArray(group["memberResourceNames"])
      ? asArray(group["memberResourceNames"]).filter((name): name is string => typeof name === "string")
      : undefined,
  });
}

// --- Shared call plumbing ---------------------------------------------------------

const contextOf = Effect.gen(function* () {
  const operation = yield* Effect.serviceOption(Operation);
  if (Option.isNone(operation) || !operation.value)
    return yield* Effect.die(new Error("Missing Google People call context."));
  return operation.value;
});

const refuse = (code: "invalid_args" | "connector_call_failed", message: string) =>
  Effect.fail(
    new Refusal({
      error: new ConnectorCallError(code, message, code === "connector_call_failed" ? { retryable: false } : {}),
    }),
  );

/** A page must still cross execute_code's bridge whole; say what to narrow instead of cutting rows silently. */
function fitPage<T>(rows: readonly T[]): Effect.Effect<readonly T[], Refusal> {
  return jsonBytes(rows) > RESULT_BUDGET_BYTES
    ? refuse(
        "connector_call_failed",
        `This page of people is larger than one result (${RESULT_BUDGET_BYTES} bytes). Call again with a smaller limit or fewer personFields.`,
      )
    : Effect.succeed(rows);
}

/** Google's continuation, held in a cursor only when it carries no value the request sent. */
function continuation(ctx: ConnectorContext, token: unknown, size: number) {
  if (token === undefined || token === null || token === "") return Effect.succeed(null);
  if (typeof token !== "string" || redactSentSecrets(ctx, token) !== token)
    return refuse("connector_call_failed", "Google People returned a page token this connection cannot carry.");
  return Effect.succeed(JSON.stringify({ t: token, n: size }));
}

/** The token and page size a cursor this tool issued carries. */
function resumeFrom(cursor: string | undefined, limit: number) {
  if (cursor === undefined) return Effect.succeed({ token: undefined as string | undefined, size: limit });
  let parsed: JsonRecord = {};
  try {
    parsed = asRecord(JSON.parse(cursor));
  } catch {
    parsed = {};
  }
  const { t, n } = parsed;
  return typeof t === "string" && t !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_PAGE
    ? Effect.succeed({ token: t as string | undefined, size: n as number })
    : refuse("invalid_args", "cursor is not one this tool returned. Pass page.nextCursor back unchanged.");
}

const directoryAdvice = (message: string) =>
  `${message} The Workspace directory exists only for Google Workspace accounts: a personal Google account has none, and a domain can hide its directory from users.`;

export function peopleTools({
  connection,
  options,
}: {
  connection: Connection;
  options: { readonly sensitiveFields?: "drop" | "return" };
}): ApiTool[] {
  const client = googleClient(connection, peopleIndex);
  const returned = options.sensitiveFields === "return";
  const allowed = PERSON_FIELDS.filter((field) => returned || !PEOPLE_SENSITIVE_FIELDS.includes(field));
  const personFields = fieldsInput(allowed, DEFAULT_FIELDS, "Person");
  const otherFields = fieldsInput(OTHER_CONTACT_FIELDS, DEFAULT_OTHER_FIELDS, "Other contact");
  const maskOf = (fields: readonly string[] | undefined, defaults: readonly string[]) =>
    [...new Set(fields ?? defaults)].join(",");
  const segment = (resourceName: string) => encodeURIComponent(resourceName.slice(resourceName.indexOf("/") + 1));
  const json = (request: GoogleRequest, step?: string) => client.json(request, step ? { step } : undefined);
  /** An update at the etag a read returned: a stale one maps to `conflict`. */
  const guarded = (request: GoogleRequest) => client.json(request, { revisionGuarded: true });

  /** A directory call that names the account type when Google refuses it. */
  const directory = (request: GoogleRequest) =>
    json(request).pipe(
      Effect.catch((failure: HttpFailure) => {
        const status = googleOutcomeOf(failure)?.status;
        return status === 400 || status === 403
          ? googleFailureMessage(connection, failure, directoryAdvice)
          : Effect.fail(failure);
      }),
    );

  /** A created resource may exist after an uncertain answer: say where to look before creating it again. */
  const uncertainCreate = (look: string) => (failure: HttpFailure) => {
    const outcome = googleOutcomeOf(failure);
    return outcome?.dispatched === true && outcome.phase !== "refused" && outcome.phase !== "before-send"
      ? googleFailureMessage(connection, failure, (message) => `${message} ${look}`)
      : Effect.fail(failure);
  };

  /** Search after the warm-up request Google documents, which refreshes the search cache. */
  const searched = (request: (query: string) => GoogleRequest, query: string) =>
    Effect.gen(function* () {
      yield* json(request(""), "warmup");
      yield* (yield* Budget).charge.pipe(
        Effect.catch((error) =>
          error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
        ),
      );
      return asRecord(yield* json(request(query), "search"));
    });

  const searchTool = (spec: {
    name: string;
    description: string;
    path: string;
    fields: ReturnType<typeof fieldsInput>;
    defaults: readonly string[];
    remedy: string;
  }) =>
    read(connection, {
      name: spec.name,
      description: spec.description,
      input: Schema.Struct({
        query: string("Prefix of a name, email address or phone number; whole words match from their start.", 200),
        personFields: spec.fields.input,
        limit: Schema.optionalKey(
          Integer.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH })).annotate({
            description: "Maximum matches; default 10, at most 30 (Google's cap).",
            default: 10,
          }),
        ),
        fields: Schema.optionalKey(PERSON_ITEM_FIELDS.input),
      }),
      output: Schema.Struct({ items: Schema.Array(PersonRecord), page: TerminalPage }),
      writeSteps: { warmup: "once", search: "once" },
      check: (args, problems) => {
        fieldProblems(problems, args.personFields, spec.fields);
        PERSON_ITEM_FIELDS.issues(problems, args.fields);
      },
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const readMask = maskOf(args.personFields, spec.defaults);
          const pageSize = args.limit ?? 10;
          const reply = yield* searched(
            (query) => ({ method: "GET", path: spec.path, template: spec.path, query: { query, readMask, pageSize } }),
            args.query,
          );
          const rows = yield* fitPage(
            asArray(reply["results"]).map((result) =>
              projectPerson(ctx, asRecord(result)["person"], LIST_TEXT_CHARS, "get_person reads it whole"),
            ),
          );
          return {
            items: rows.map((row) => selectFields(row, args.fields) as JsonRecord),
            page: { hasMore: false as const },
          };
        }),
    });

  /** A paged People list: Google's page token behind a cursor bound to these arguments. */
  const pagedPeople = <F extends Schema.Struct.Fields>(spec: {
    name: string;
    description: string;
    filters: F;
    selection: ReturnType<typeof fieldsInput>;
    rows: string;
    remedy: string;
    request: (args: Schema.Struct<F>["Type"], page: { token: string | undefined; size: number }) => GoogleRequest;
    send?: (request: GoogleRequest) => Effect.Effect<unknown, HttpFailure, CallServices>;
  }) =>
    list(connection, {
      name: spec.name,
      description: spec.description,
      filters: spec.filters,
      row: PersonRecord,
      limit: {
        default: DEFAULT_PAGE,
        max: MAX_PAGE,
        description: `People per page; default ${DEFAULT_PAGE}, at most ${MAX_PAGE} (connecta's cap; Google allows more).`,
      },
      cursor: "bound",
      check: (args, problems) =>
        fieldProblems(problems, (args as { readonly personFields?: readonly string[] }).personFields, spec.selection),
      page: (args, cursor) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const page = yield* resumeFrom(cursor, args.limit);
          const reply = asRecord(yield* (spec.send ?? json)(spec.request(args, page)));
          const rows = yield* fitPage(
            asArray(reply[spec.rows]).map((row) => projectPerson(ctx, row, LIST_TEXT_CHARS, spec.remedy)),
          );
          const next = yield* continuation(ctx, reply["nextPageToken"], page.size);
          return { rows, page: { hasMore: next !== null, nextCursor: next } };
        }),
    });

  const getPerson = (resourceName: string, fields: string) =>
    json({
      method: "GET",
      path: `/people/${segment(resourceName)}`,
      template: "/people/{peopleId}",
      query: { personFields: fields },
    });

  return [
    searchTool({
      name: "search_contacts",
      description:
        "Search the user's own contacts by name, email or phone prefix, returning names, emails, phones and resource names. Not other contacts or the directory.",
      path: "/people:searchContacts",
      fields: personFields,
      defaults: DEFAULT_FIELDS,
      remedy: "get_person reads it whole",
    }),
    pagedPeople({
      name: "list_contacts",
      description:
        "List the user's own contacts (My Contacts and labeled contacts), paged, with names, emails and phones. Not other contacts or the Workspace directory.",
      selection: personFields,
      filters: {
        personFields: personFields.input,
        sortOrder: Schema.optionalKey(
          Schema.Literals([
            "LAST_MODIFIED_ASCENDING",
            "LAST_MODIFIED_DESCENDING",
            "FIRST_NAME_ASCENDING",
            "LAST_NAME_ASCENDING",
          ]).annotate({
            description: "Order; Google's default is LAST_MODIFIED_ASCENDING.",
          }),
        ),
      },
      rows: "connections",
      remedy: "get_person reads it whole",
      request: (args, page) => ({
        method: "GET",
        path: "/people/me/connections",
        template: "/people/{peopleId}/connections",
        query: {
          personFields: maskOf(args.personFields, DEFAULT_FIELDS),
          sortOrder: args.sortOrder,
          pageSize: page.size,
          pageToken: page.token,
        },
      }),
    }),
    read(connection, {
      name: "get_person",
      description:
        "Get one person by resource name: a contact (people/c…), a profile id, or people/me for the signed-in user's own profile. Returns the etag updates need.",
      input: Schema.Struct({
        resourceName: personName("people/me, or a resource name from a search or list."),
        personFields: personFields.input,
      }),
      output: PersonRecord,
      fields: true,
      check: (args, problems) => fieldProblems(problems, args.personFields, personFields),
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const person = yield* getPerson(args.resourceName, maskOf(args.personFields, DEFAULT_FIELDS));
          return projectPerson(ctx, person, GET_TEXT_CHARS, "people_api_read reads it whole");
        }),
    }),
    read(connection, {
      name: "get_people",
      description:
        "Get up to 200 people by resource name in one call. Each item is a person, or its requested resourceName with the error Google gave for it.",
      input: Schema.Struct({
        resourceNames: Schema.Array(personName("A resource name, or people/me."))
          .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BATCH))
          .annotate({ description: "1–200 resource names; Google's maximum." }),
        personFields: personFields.input,
      }),
      output: optional({
        items: Schema.Array(
          optional({
            ...(PersonRecord as unknown as { fields: Schema.Struct.Fields }).fields,
            requestedResourceName: Schema.String,
            error: optional({ code: Integer, message: Schema.String }),
          }),
        ),
      }),
      fields: true,
      check: (args, problems) => fieldProblems(problems, args.personFields, personFields),
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const reply = asRecord(
            yield* json({
              method: "GET",
              path: "/people:batchGet",
              template: "/people:batchGet",
              query: {
                resourceNames: [...new Set(args.resourceNames)],
                personFields: maskOf(args.personFields, DEFAULT_FIELDS),
              },
            }),
          );
          const items = yield* fitPage(
            asArray(reply["responses"]).map((entry) => {
              const response = asRecord(entry);
              const requested = text(response["requestedResourceName"]);
              if (response["person"] !== undefined)
                return {
                  ...projectPerson(ctx, response["person"], LIST_TEXT_CHARS, "get_person reads it whole"),
                  ...(requested ? { requestedResourceName: requested } : {}),
                };
              const status = asRecord(response["status"]);
              return compact({
                requestedResourceName: requested,
                error: compact({
                  code: typeof status["code"] === "number" ? status["code"] : response["httpStatusCode"],
                  message: text(status["message"]),
                }),
              });
            }),
          );
          return { items: [...items] };
        }),
    }),
    write(connection, {
      name: "create_contact",
      description:
        "Create one contact in the user's My Contacts with a name, emails, phones and organizations. Creates a new contact every call; it never merges duplicates.",
      input: Schema.Struct(contactFields),
      output: PersonRecord,
      destructive: false,
      check: (args, problems) => {
        if (Object.keys(contactBody(args)).length === 0)
          problems.add("", "at least one of name, emailAddresses, phoneNumbers or organizations");
      },
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const created = yield* json({
            method: "POST",
            path: "/people:createContact",
            template: "/people:createContact",
            query: { personFields: DEFAULT_FIELDS.join(",") },
            body: contactBody(args),
          }).pipe(
            Effect.catch(
              uncertainCreate(
                "create_contact makes a new contact on every call: search_contacts for it, or ask the user, before creating it again.",
              ),
            ),
          );
          return projectPerson(ctx, created, GET_TEXT_CHARS, "get_person reads it whole");
        }),
    }),
    write(connection, {
      name: "update_contact",
      description:
        "Replace a contact's name, emails, phones or organizations at its current etag. Each field given replaces that whole field; fields omitted stay unchanged.",
      input: Schema.Struct({ resourceName: contactName, etag, ...contactFields }),
      output: PersonRecord,
      destructive: true,
      check: (args, problems) => {
        if (Object.keys(contactBody(args)).length === 0)
          problems.add("", "at least one of name, emailAddresses, phoneNumbers or organizations to replace");
      },
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const body = contactBody(args);
          const updatePersonFields = (Object.keys(MASKS) as (keyof typeof MASKS)[])
            .filter((key) => args[key] !== undefined)
            .map((key) => MASKS[key])
            .join(",");
          const updated = yield* guarded({
            method: "PATCH",
            path: `/people/${segment(args.resourceName)}:updateContact`,
            template: "/people/{peopleId}:updateContact",
            query: { updatePersonFields, personFields: DEFAULT_FIELDS.join(",") },
            body: { ...body, etag: args.etag },
          });
          return projectPerson(ctx, updated, GET_TEXT_CHARS, "get_person reads it whole");
        }),
    }),
    write(connection, {
      name: "delete_contact",
      description:
        "Delete one contact from the user's contacts permanently. Not for other contacts or directory profiles, which this connection cannot delete.",
      input: Schema.Struct({ resourceName: contactName }),
      output: Schema.Struct({ resourceName: Schema.String, deleted: Schema.Boolean }),
      destructive: true,
      run: (args) =>
        Effect.gen(function* () {
          yield* json({
            method: "DELETE",
            path: `/people/${segment(args.resourceName)}:deleteContact`,
            template: "/people/{peopleId}:deleteContact",
          });
          return { resourceName: args.resourceName, deleted: true };
        }),
    }),
    list(connection, {
      name: "list_contact_groups",
      description:
        "List the user's contact groups (labels), with names, types and member counts, paged. System groups such as myContacts and starred are included.",
      filters: {},
      row: GroupRecord,
      limit: {
        default: DEFAULT_PAGE,
        max: MAX_PAGE,
        description: `Groups per page; default ${DEFAULT_PAGE}, at most ${MAX_PAGE} (connecta's cap; Google allows more).`,
      },
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const page = yield* resumeFrom(cursor, args.limit);
          const reply = asRecord(
            yield* json({
              method: "GET",
              path: "/contactGroups",
              template: "/contactGroups",
              query: { groupFields: "name,groupType,memberCount", pageSize: page.size, pageToken: page.token },
            }),
          );
          const next = yield* continuation(ctx, reply["nextPageToken"], page.size);
          return {
            rows: asArray(reply["contactGroups"]).map(projectGroup),
            page: { hasMore: next !== null, nextCursor: next },
          };
        }),
    }),
    read(connection, {
      name: "get_contact_group",
      description:
        "Get one contact group (label) with its name, type, etag and up to maxMembers member resource names. Member details need get_people.",
      input: Schema.Struct({
        resourceName: groupName,
        maxMembers: Schema.optionalKey(
          Integer.check(Schema.isBetween({ minimum: 0, maximum: MAX_MEMBERS })).annotate({
            description: "Member resource names to return; default 200, at most 1000 (connecta's cap).",
            default: 200,
          }),
        ),
      }),
      output: GroupRecord,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          const maxMembers = args.maxMembers ?? 200;
          const group = projectGroup(
            yield* json({
              method: "GET",
              path: `/contactGroups/${segment(args.resourceName)}`,
              template: "/contactGroups/{contactGroupsId}",
              query: { maxMembers, groupFields: "name,groupType,memberCount,metadata" },
            }),
          );
          const members = asArray(group["memberResourceNames"]).length;
          return typeof group["memberCount"] === "number" && members < group["memberCount"] && members === maxMembers
            ? { ...group, truncated: ["memberResourceNames"] }
            : group;
        }),
    }),
    write(connection, {
      name: "create_contact_group",
      description:
        "Create one contact group (label) with a name. Creates a new group every call; add contacts with update_contact_group_members.",
      input: Schema.Struct({ name: string("Group name, unique among the user's groups.", 200) }),
      output: GroupRecord,
      destructive: false,
      run: (args) =>
        Effect.gen(function* () {
          return projectGroup(
            yield* json({
              method: "POST",
              path: "/contactGroups",
              template: "/contactGroups",
              body: { contactGroup: { name: args.name }, readGroupFields: "name,groupType,memberCount,metadata" },
            }).pipe(
              Effect.catch(
                uncertainCreate(
                  "create_contact_group makes a new group on every call: list_contact_groups for it before creating it again.",
                ),
              ),
            ),
          );
        }),
    }),
    write(connection, {
      name: "update_contact_group",
      description:
        "Rename one user-created contact group (label) at its current etag. System groups cannot be renamed.",
      input: Schema.Struct({ resourceName: groupName, etag, name: string("New group name.", 200) }),
      output: GroupRecord,
      destructive: true,
      run: (args) =>
        Effect.gen(function* () {
          return projectGroup(
            yield* guarded({
              method: "PUT",
              path: `/contactGroups/${segment(args.resourceName)}`,
              template: "/contactGroups/{contactGroupsId}",
              body: {
                contactGroup: { name: args.name, etag: args.etag },
                updateGroupFields: "name",
                readGroupFields: "name,groupType,memberCount,metadata",
              },
            }),
          );
        }),
    }),
    write(connection, {
      name: "delete_contact_group",
      description:
        "Delete one user-created contact group (label). Its contacts stay unless deleteContacts is true, which deletes every contact in it too.",
      input: Schema.Struct({
        resourceName: groupName,
        deleteContacts: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "Also delete every contact in the group permanently. Default false.",
          }),
        ),
      }),
      output: Schema.Struct({ resourceName: Schema.String, deleted: Schema.Boolean, contactsDeleted: Schema.Boolean }),
      destructive: true,
      run: (args) =>
        Effect.gen(function* () {
          yield* json({
            method: "DELETE",
            path: `/contactGroups/${segment(args.resourceName)}`,
            template: "/contactGroups/{contactGroupsId}",
            query: { deleteContacts: args.deleteContacts === true ? true : undefined },
          });
          return { resourceName: args.resourceName, deleted: true, contactsDeleted: args.deleteContacts === true };
        }),
    }),
    write(connection, {
      name: "update_contact_group_members",
      description:
        "Add contacts to and remove contacts from one contact group (label). A contact cannot leave its last group; those return in notRemovedFromLastGroup.",
      input: Schema.Struct({
        resourceName: groupName,
        add: Schema.optionalKey(
          Schema.Array(contactName)
            .check(Schema.isMaxLength(MAX_MEMBER_CHANGES))
            .annotate({ description: "Contacts to add, people/c… names; at most 1000." }),
        ),
        remove: Schema.optionalKey(
          Schema.Array(contactName)
            .check(Schema.isMaxLength(MAX_MEMBER_CHANGES))
            .annotate({ description: "Contacts to remove, people/c… names; at most 1000." }),
        ),
      }),
      output: optional({
        resourceName: Schema.String,
        notFound: Schema.Array(Schema.String),
        notRemovedFromLastGroup: Schema.Array(Schema.String),
      }),
      destructive: true,
      check: (args, problems) => {
        if (!args.add?.length && !args.remove?.length) problems.add("", "a nonempty add or remove list");
        if ((args.add?.length ?? 0) + (args.remove?.length ?? 0) > MAX_MEMBER_CHANGES)
          problems.add("", "at most 1000 contacts across add and remove");
      },
      run: (args) =>
        Effect.gen(function* () {
          const reply = asRecord(
            yield* json({
              method: "POST",
              path: `/contactGroups/${segment(args.resourceName)}/members:modify`,
              template: "/contactGroups/{contactGroupsId}/members:modify",
              body: compact({ resourceNamesToAdd: args.add, resourceNamesToRemove: args.remove }),
            }),
          );
          const names = (key: string) => asArray(reply[key]).filter((name): name is string => typeof name === "string");
          return compact({
            resourceName: args.resourceName,
            notFound: names("notFoundResourceNames").length ? names("notFoundResourceNames") : undefined,
            notRemovedFromLastGroup: names("canNotRemoveLastContactGroupResourceNames").length
              ? names("canNotRemoveLastContactGroupResourceNames")
              : undefined,
          });
        }),
    }),
    searchTool({
      name: "search_other_contacts",
      description:
        "Search other contacts, the people Gmail saved from interactions without adding them, by name, email or phone prefix. Not the user's own contacts.",
      path: "/otherContacts:search",
      fields: otherFields,
      defaults: DEFAULT_OTHER_FIELDS,
      remedy: "people_api_read reads it whole",
    }),
    pagedPeople({
      name: "list_other_contacts",
      description:
        "List other contacts, the people Gmail saved from interactions without adding them, paged with names, emails and phones. Not the user's own contacts.",
      selection: otherFields,
      filters: { personFields: otherFields.input },
      rows: "otherContacts",
      remedy: "people_api_read reads it whole",
      request: (args, page) => ({
        method: "GET",
        path: "/otherContacts",
        template: "/otherContacts",
        query: {
          readMask: maskOf(args.personFields, DEFAULT_OTHER_FIELDS),
          pageSize: page.size,
          pageToken: page.token,
        },
      }),
    }),
    write(connection, {
      name: "copy_other_contact",
      description:
        "Copy one other contact into the user's My Contacts, returning the new contact. Makes a new contact every call; the other contact remains.",
      input: Schema.Struct({
        resourceName: string("Other contact resource name, e.g. otherContacts/c123.", 64).check(
          pattern("^otherContacts/[A-Za-z0-9_-]+$"),
        ),
      }),
      output: PersonRecord,
      destructive: false,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const copied = yield* json({
            method: "POST",
            path: `/otherContacts/${segment(args.resourceName)}:copyOtherContactToMyContactsGroup`,
            template: "/otherContacts/{otherContactsId}:copyOtherContactToMyContactsGroup",
            body: { copyMask: DEFAULT_OTHER_FIELDS.join(","), readMask: DEFAULT_FIELDS.join(",") },
          }).pipe(
            Effect.catch(
              uncertainCreate(
                "copy_other_contact makes a new contact on every call: search_contacts for it before copying again.",
              ),
            ),
          );
          return projectPerson(ctx, copied, GET_TEXT_CHARS, "get_person reads it whole");
        }),
    }),
    pagedPeople({
      name: "search_directory",
      description:
        "Search the Google Workspace directory for coworkers and domain contacts by name or email prefix, paged. Fails for personal Google accounts.",
      selection: personFields,
      filters: {
        query: string("Prefix of a coworker's name or email address.", 200),
        personFields: personFields.input,
      },
      rows: "people",
      remedy: "get_person reads it whole",
      request: (args, page) => ({
        method: "GET",
        path: "/people:searchDirectoryPeople",
        template: "/people:searchDirectoryPeople",
        query: {
          query: args.query,
          readMask: maskOf(args.personFields, DEFAULT_FIELDS),
          sources: DIRECTORY_SOURCES,
          pageSize: page.size,
          pageToken: page.token,
        },
      }),
      send: directory,
    }),
    pagedPeople({
      name: "list_directory",
      description:
        "List the Google Workspace directory of coworker profiles and domain contacts, paged. Fails for personal Google accounts, which have no directory.",
      selection: personFields,
      filters: { personFields: personFields.input },
      rows: "people",
      remedy: "get_person reads it whole",
      request: (args, page) => ({
        method: "GET",
        path: "/people:listDirectoryPeople",
        template: "/people:listDirectoryPeople",
        query: {
          readMask: maskOf(args.personFields, DEFAULT_FIELDS),
          sources: DIRECTORY_SOURCES,
          pageSize: page.size,
          pageToken: page.token,
        },
      }),
      send: directory,
    }),
  ];
}
