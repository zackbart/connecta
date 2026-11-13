// Calendar projections and workflows on the standard provider kit.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { Integer, isMaxChars, isMinChars } from "../../http/json-schema.js";
import type { ArgumentProblems } from "../../http/argument-problems.js";
import { list, read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { Operation } from "../../runtime/call.js";
import { redactSentSecrets } from "../../sent-secrets.js";
import type { ConnectorContext } from "../../types.js";
import { googleClient, type GoogleRequest, type GoogleRequestOptions } from "../_shared/google/kit.js";
import { clampText } from "../_shared/google/result-size.js";
import { asArray, asRecord, compact } from "../_shared/json.js";
import { calendarIndex } from "./lib/hatch.js";

/** Google's own page maximum is 2,500 events and 250 calendars; a listed row is small, so 50 stays in budget. */
const MAX_EVENT_PAGE = 50;
const MAX_CALENDAR_PAGE = 100;
/** A listed title or location is held to this many JSON bytes; get_event returns more. */
const LIST_TEXT_BYTES = 1024;
/** get_event's description bound, in JSON bytes. */
const DESCRIPTION_BYTES = 32 * 1024;
const DETAIL_TEXT_BYTES = 4 * 1024;
/** Attendees one get_event returns; a longer list is reported in truncated. */
const MAX_ATTENDEES = 200;
/** Calendars one free/busy query names; Google's documented maximum is 50. */
const MAX_FREE_BUSY_CALENDARS = 50;
/** Attendees one write may name; Google limits an event's guest list separately. */
const MAX_NEW_ATTENDEES = 100;

type JsonRecord = Record<string, any>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

const contextOf = Effect.gen(function* () {
  const operation = yield* Effect.serviceOption(Operation);
  if (Option.isNone(operation) || !operation.value)
    return yield* Effect.die(new Error("Missing Calendar call context."));
  return operation.value;
});

const knownFailures = Effect.catchDefect((error: unknown) =>
  error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
);

// --- Schemas ----------------------------------------------------------------------

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description });
const optional = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Schema.optionalKey(value)])));

/** RFC 3339 with an explicit offset, as Google requires for timeMin, timeMax and dateTime. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const dateTime = (description: string) =>
  described(Schema.String.check(Schema.isPattern(DATE_TIME)), `${description} RFC 3339 with an offset.`);

const optionalCalendarId = Schema.optionalKey(
  described(
    Schema.String.check(isMinChars(1), isMaxChars(1024)),
    "Calendar id from list_calendars; omit for the user's primary calendar.",
  ),
);
const eventId = described(
  Schema.String.check(isMinChars(1), isMaxChars(1024)),
  "Event id from list_events; an instance id for one occurrence of a recurring event.",
);
const sendUpdates = Schema.optionalKey(
  described(
    Schema.Literals(["all", "externalOnly", "none"]),
    "Who Google emails about this change; omit for Google's default.",
  ),
);
const timeZone = described(
  Schema.String.check(isMinChars(1), isMaxChars(100)),
  "IANA time zone, such as Europe/Zurich.",
);

// Formats are checked in each tool's check, so the compact render stays small.
const When = Schema.Struct({
  dateTime: Schema.optionalKey(described(Schema.String, "Timed start or end, RFC 3339 with an offset.")),
  date: Schema.optionalKey(described(Schema.String, "All-day date, YYYY-MM-DD.")),
  timeZone: Schema.optionalKey(described(Schema.String, "IANA time zone, such as Europe/Zurich.")),
});
const NewAttendee = Schema.Struct({
  email: described(Schema.String.check(isMinChars(3), isMaxChars(320)), "Guest email address."),
  optional: Schema.optionalKey(described(Schema.Boolean, "Whether attendance is optional.")),
});
const Reminders = Schema.Struct({
  useDefault: described(Schema.Boolean, "Use the calendar's default reminders."),
  overrides: Schema.optionalKey(
    described(
      Schema.Array(
        Schema.Struct({
          method: described(Schema.Literals(["email", "popup"]), "How the reminder is delivered."),
          minutes: described(
            Integer.check(Schema.isBetween({ minimum: 0, maximum: 40320 })),
            "Minutes before the start.",
          ),
        }),
      ).check(Schema.isMaxLength(5)),
      "Up to 5 reminders; only with useDefault false.",
    ),
  ),
});

/** Event fields a create or update may set. */
const editable = {
  summary: Schema.optionalKey(described(Schema.String.check(isMaxChars(1024)), "Title.")),
  description: Schema.optionalKey(described(Schema.String.check(isMaxChars(8192)), "Description; HTML allowed.")),
  location: Schema.optionalKey(described(Schema.String.check(isMaxChars(1024)), "Free-text location.")),
  start: Schema.optionalKey(described(When, "Start: dateTime or an all-day date.")),
  end: Schema.optionalKey(described(When, "End, exclusive, of the same kind as start.")),
  recurrence: Schema.optionalKey(
    described(
      Schema.Array(Schema.String.check(isMinChars(1), isMaxChars(1024))).check(Schema.isMaxLength(20)),
      "RFC 5545 RRULE, EXRULE, RDATE or EXDATE lines.",
    ),
  ),
  reminders: Schema.optionalKey(described(Reminders, "Reminder settings.")),
  visibility: Schema.optionalKey(
    described(Schema.Literals(["default", "public", "private", "confidential"]), "Who sees the details."),
  ),
  transparency: Schema.optionalKey(
    described(Schema.Literals(["opaque", "transparent"]), "opaque blocks free/busy time; transparent does not."),
  ),
  addGoogleMeet: Schema.optionalKey(described(Schema.Boolean, "true adds a new Google Meet link.")),
};

const Time = optional({ dateTime: Schema.String, date: Schema.String, timeZone: Schema.String });
const Attendee = optional({
  email: Schema.String,
  responseStatus: Schema.String,
  optional: Schema.Boolean,
  organizer: Schema.Boolean,
  self: Schema.Boolean,
});
const Truncated = described(Schema.Array(Schema.String), "Dot paths cut for size; read the event via the hatch.");

const EventRow = optional({
  id: Schema.String,
  status: Schema.String,
  summary: Schema.String,
  location: Schema.String,
  start: Time,
  end: Time,
  recurringEventId: Schema.String,
  organizer: Schema.String,
  attendeeCount: Integer,
  myResponseStatus: Schema.String,
  meetLink: Schema.String,
  truncated: Truncated,
});
const EventRecord = optional({
  id: Schema.String,
  calendarId: Schema.String,
  status: Schema.String,
  summary: Schema.String,
  description: Schema.String,
  location: Schema.String,
  start: Time,
  end: Time,
  recurrence: Schema.Array(Schema.String),
  recurringEventId: Schema.String,
  organizer: Schema.String,
  attendees: Schema.Array(Attendee),
  myResponseStatus: Schema.String,
  meetLink: Schema.String,
  conferenceStatus: Schema.String,
  reminders: optional({
    useDefault: Schema.Boolean,
    overrides: Schema.Array(optional({ method: Schema.String, minutes: Integer })),
  }),
  visibility: Schema.String,
  transparency: Schema.String,
  htmlLink: Schema.String,
  updated: Schema.String,
  truncated: Truncated,
});

// --- Projections ------------------------------------------------------------------

class Cuts {
  readonly paths: string[] = [];
  constructor(private readonly ctx: ConnectorContext) {}
  text(path: string, value: unknown, bytes: number): string | undefined {
    const whole = text(value);
    if (whole === undefined) return undefined;
    const cut = clampText(this.ctx, whole, bytes, (dropped) => `[… ${dropped} more characters]`);
    if (cut !== whole) this.paths.push(path);
    return cut;
  }
  get truncated(): string[] | undefined {
    return this.paths.length ? this.paths : undefined;
  }
}

function time(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  const result = compact({
    dateTime: text(record["dateTime"]),
    date: text(record["date"]),
    timeZone: text(record["timeZone"]),
  });
  return Object.keys(result).length ? result : undefined;
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length ? values : undefined;
}

function selfResponse(event: JsonRecord): string | undefined {
  const self = asArray(event["attendees"])
    .map(asRecord)
    .find((attendee) => attendee["self"] === true);
  return text(self?.["responseStatus"]);
}

function meetLink(event: JsonRecord): string | undefined {
  return (
    text(event["hangoutLink"]) ??
    text(
      asArray(asRecord(event["conferenceData"])["entryPoints"])
        .map(asRecord)
        .find((entry) => entry["entryPointType"] === "video")?.["uri"],
    )
  );
}

function projectRow(ctx: ConnectorContext, value: unknown): JsonRecord {
  const event = asRecord(value);
  const cuts = new Cuts(ctx);
  return compact({
    id: text(event["id"]),
    status: text(event["status"]),
    summary: cuts.text("summary", event["summary"], LIST_TEXT_BYTES),
    location: cuts.text("location", event["location"], LIST_TEXT_BYTES),
    start: time(event["start"]),
    end: time(event["end"]),
    recurringEventId: text(event["recurringEventId"]),
    organizer: text(asRecord(event["organizer"])["email"]),
    attendeeCount: Array.isArray(event["attendees"]) ? event["attendees"].length : undefined,
    myResponseStatus: selfResponse(event),
    meetLink: meetLink(event),
    truncated: cuts.truncated,
  });
}

function projectEvent(ctx: ConnectorContext, value: unknown, calendar?: string): JsonRecord {
  const event = asRecord(value);
  const cuts = new Cuts(ctx);
  const attendees = asArray(event["attendees"]).map(asRecord);
  const reminders = asRecord(event["reminders"]);
  if (attendees.length > MAX_ATTENDEES || event["attendeesOmitted"] === true) cuts.paths.push("attendees");
  return compact({
    id: text(event["id"]),
    calendarId: calendar,
    status: text(event["status"]),
    summary: cuts.text("summary", event["summary"], DETAIL_TEXT_BYTES),
    description: cuts.text("description", event["description"], DESCRIPTION_BYTES),
    location: cuts.text("location", event["location"], DETAIL_TEXT_BYTES),
    start: time(event["start"]),
    end: time(event["end"]),
    recurrence: nonEmpty(asArray(event["recurrence"]).filter((line): line is string => typeof line === "string")),
    recurringEventId: text(event["recurringEventId"]),
    organizer: text(asRecord(event["organizer"])["email"]),
    attendees: nonEmpty(
      attendees.slice(0, MAX_ATTENDEES).map((attendee) =>
        compact({
          email: text(attendee["email"]),
          responseStatus: text(attendee["responseStatus"]),
          optional: attendee["optional"] === true ? true : undefined,
          organizer: attendee["organizer"] === true ? true : undefined,
          self: attendee["self"] === true ? true : undefined,
        }),
      ),
    ),
    myResponseStatus: selfResponse(event),
    meetLink: meetLink(event),
    conferenceStatus: text(
      asRecord(asRecord(asRecord(event["conferenceData"])["createRequest"])["status"])["statusCode"],
    ),
    reminders: Object.keys(reminders).length
      ? compact({
          useDefault: typeof reminders["useDefault"] === "boolean" ? reminders["useDefault"] : undefined,
          overrides: asArray(reminders["overrides"]).map((entry) =>
            compact({
              method: text(asRecord(entry)["method"]),
              minutes: typeof asRecord(entry)["minutes"] === "number" ? asRecord(entry)["minutes"] : undefined,
            }),
          ),
        })
      : undefined,
    visibility: text(event["visibility"]),
    transparency: text(event["transparency"]),
    htmlLink: text(event["htmlLink"]),
    updated: text(event["updated"]),
    truncated: cuts.truncated,
  });
}

// --- Argument checks ----------------------------------------------------------------

type When = { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };

function checkWhen(problems: ArgumentProblems, path: string, when: When | undefined): "timed" | "allDay" | undefined {
  if (when === undefined) return undefined;
  if ((when.dateTime === undefined) === (when.date === undefined)) {
    problems.add(path, "exactly one of dateTime or date");
    return undefined;
  }
  if (when.timeZone !== undefined && (!when.timeZone.trim() || when.timeZone.length > 100))
    problems.add(`${path}.timeZone`, "an IANA time zone name of 1–100 characters");
  if (when.dateTime !== undefined) {
    if (DATE_TIME.test(when.dateTime) && Number.isFinite(Date.parse(when.dateTime))) return "timed";
    problems.add(`${path}.dateTime`, "RFC 3339 date-time with an offset, such as 2026-11-20T09:00:00-05:00");
    return undefined;
  }
  if (DATE.test(when.date!) && Number.isFinite(Date.parse(when.date!))) return "allDay";
  problems.add(`${path}.date`, "a date as YYYY-MM-DD");
  return undefined;
}

function checkTimes(problems: ArgumentProblems, start: When | undefined, end: When | undefined): void {
  const first = checkWhen(problems, "start", start);
  const last = checkWhen(problems, "end", end);
  if (first && last && first !== last) problems.add("end", "the same kind as start: both dateTime or both date");
  if (first === "allDay" && last === "allDay" && start!.date! >= end!.date!)
    problems.add("end.date", "a date after start.date; an all-day end is exclusive");
  if (first === "timed" && last === "timed" && Date.parse(start!.dateTime!) >= Date.parse(end!.dateTime!))
    problems.add("end.dateTime", "an instant after start.dateTime");
}

function checkEditable(problems: ArgumentProblems, args: JsonRecord): void {
  checkTimes(problems, args["start"], args["end"]);
  const reminders = args["reminders"];
  if (reminders?.useDefault === true && reminders.overrides?.length)
    problems.add("reminders.overrides", "omitted when useDefault is true");
  if (args["recurrence"]?.length && args["start"]?.dateTime !== undefined && args["start"]?.timeZone === undefined)
    problems.add("start.timeZone", "an IANA time zone for a recurring timed event");
}

function eventBody(args: JsonRecord): JsonRecord {
  return compact({
    summary: args["summary"],
    description: args["description"],
    location: args["location"],
    start: args["start"],
    end: args["end"],
    recurrence: args["recurrence"],
    reminders: args["reminders"],
    visibility: args["visibility"],
    transparency: args["transparency"],
    ...(args["addGoogleMeet"] === true
      ? {
          conferenceData: {
            createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
          },
        }
      : {}),
  });
}

// --- Tools ------------------------------------------------------------------------

export function calendarTools({ connection }: { connection: Connection }): ApiTool[] {
  const client = googleClient(connection, calendarIndex);
  const calendarPath = (id: string) => `/calendars/${encodeURIComponent(id)}`;
  const eventPath = (calendar: string, event: string) =>
    `${calendarPath(calendar)}/events/${encodeURIComponent(event)}`;
  const json = (request: GoogleRequest, options?: GoogleRequestOptions) => client.json(request, options);
  const EVENT_TEMPLATE = "/calendars/{calendarId}/events/{eventId}";
  const readEvent = (calendar: string, event: string, options?: GoogleRequestOptions) =>
    json({ method: "GET", path: eventPath(calendar, event), template: EVENT_TEMPLATE }, options);
  /** A vendor page token placed in a cursor the agent can decode, redacted first. */
  const nextOf = (ctx: ConnectorContext, listing: JsonRecord) => {
    const token = text(listing["nextPageToken"]);
    return token === undefined
      ? { hasMore: false, nextCursor: null }
      : { hasMore: true, nextCursor: redactSentSecrets(ctx, token) };
  };
  const eventResult = (ctx: ConnectorContext, reply: unknown, calendar: string) => projectEvent(ctx, reply, calendar);

  return [
    list(connection, {
      name: "list_calendars",
      description:
        "List the calendars on the user's calendar list with ids, names, access role and time zone. Not their events; use list_events with an id.",
      filters: {
        showHidden: Schema.optionalKey(described(Schema.Boolean, "Include calendars hidden from the list.")),
        minAccessRole: Schema.optionalKey(
          described(
            Schema.Literals(["freeBusyReader", "reader", "writer", "owner"]),
            "Only calendars where the user has at least this role.",
          ),
        ),
      },
      row: optional({
        id: Schema.String,
        summary: Schema.String,
        description: Schema.String,
        primary: Schema.Boolean,
        accessRole: Schema.String,
        timeZone: Schema.String,
        hidden: Schema.Boolean,
        truncated: Truncated,
      }),
      limit: {
        default: 25,
        max: MAX_CALENDAR_PAGE,
        description: `Calendars per page, default 25, at most ${MAX_CALENDAR_PAGE} (Google allows 250).`,
      },
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const listing = asRecord(
            yield* json({
              method: "GET",
              path: "/users/me/calendarList",
              template: "/users/me/calendarList",
              query: {
                maxResults: args.limit,
                pageToken: cursor,
                showHidden: args.showHidden,
                minAccessRole: args.minAccessRole,
              },
            }),
          );
          return {
            rows: asArray(listing["items"]).map((value) => {
              const entry = asRecord(value);
              const cuts = new Cuts(ctx);
              return compact({
                id: text(entry["id"]),
                summary: cuts.text("summary", entry["summaryOverride"] ?? entry["summary"], LIST_TEXT_BYTES),
                description: cuts.text("description", entry["description"], LIST_TEXT_BYTES),
                primary: entry["primary"] === true ? true : undefined,
                accessRole: text(entry["accessRole"]),
                timeZone: text(entry["timeZone"]),
                hidden: entry["hidden"] === true ? true : undefined,
                truncated: cuts.truncated,
              });
            }),
            page: nextOf(ctx, listing),
          };
        }),
    }),
    list(connection, {
      name: "list_events",
      description:
        "List or search one calendar's events in a time range, recurring events expanded to occurrences by default. Rows omit descriptions and guests; use get_event.",
      filters: {
        calendarId: optionalCalendarId,
        timeMin: Schema.optionalKey(dateTime("Events ending after this instant,")),
        timeMax: Schema.optionalKey(dateTime("Events starting before this instant,")),
        query: Schema.optionalKey(
          described(
            Schema.String.check(isMinChars(1), isMaxChars(1024)),
            "Free text matched against title, description, location and guests.",
          ),
        ),
        singleEvents: Schema.optionalKey(
          described(Schema.Boolean, "Default true: one row per occurrence; false returns recurring series."),
        ),
        orderBy: Schema.optionalKey(
          described(Schema.Literals(["startTime", "updated"]), "startTime needs singleEvents true."),
        ),
        showDeleted: Schema.optionalKey(described(Schema.Boolean, "Include cancelled events.")),
        timeZone: Schema.optionalKey(described(timeZone, "Zone for returned times; default the calendar's.")),
      },
      row: EventRow,
      limit: {
        default: 25,
        max: MAX_EVENT_PAGE,
        description: `Events per page, default 25, at most ${MAX_EVENT_PAGE} (narrower than Google's 2,500).`,
      },
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const single = args.singleEvents ?? true;
          if (args.orderBy === "startTime" && !single)
            return yield* Effect.fail(
              new Refusal({
                error: new ConnectorCallError("invalid_args", "orderBy startTime needs singleEvents true."),
              }),
            );
          if (args.timeMin && args.timeMax && Date.parse(args.timeMin) >= Date.parse(args.timeMax))
            return yield* Effect.fail(
              new Refusal({ error: new ConnectorCallError("invalid_args", "timeMax must be after timeMin.") }),
            );
          const calendar = args.calendarId ?? "primary";
          const listing = asRecord(
            yield* json({
              method: "GET",
              path: `${calendarPath(calendar)}/events`,
              template: "/calendars/{calendarId}/events",
              query: {
                maxResults: args.limit,
                pageToken: cursor,
                timeMin: args.timeMin,
                timeMax: args.timeMax,
                q: args.query,
                singleEvents: single,
                orderBy: args.orderBy,
                showDeleted: args.showDeleted,
                timeZone: args.timeZone,
              },
            }),
          );
          return { rows: asArray(listing["items"]).map((event) => projectRow(ctx, event)), page: nextOf(ctx, listing) };
        }),
    }),
    read(connection, {
      name: "get_event",
      description:
        "Get one event: times, description, location, recurrence, guests and their responses, reminders and Meet link. Conference passcodes are withheld.",
      input: Schema.Struct({
        calendarId: optionalCalendarId,
        eventId,
        timeZone: Schema.optionalKey(described(timeZone, "Zone for returned times; default the calendar's.")),
      }),
      output: EventRecord,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const calendar = args.calendarId ?? "primary";
          const reply = yield* json({
            method: "GET",
            path: eventPath(calendar, args.eventId),
            template: EVENT_TEMPLATE,
            query: { timeZone: args.timeZone },
          });
          return eventResult(ctx, reply, calendar);
        }),
    }),
    read(connection, {
      name: "query_free_busy",
      description:
        "Read busy intervals for calendars or guest emails in one time range, to find a free slot. Never event titles; private calendars report an error.",
      review: "Google's freeBusy query is a read-only POST: it returns busy intervals and changes nothing.",
      input: Schema.Struct({
        timeMin: dateTime("Range start,"),
        timeMax: dateTime("Range end,"),
        calendars: described(
          Schema.Array(Schema.String.check(isMinChars(1), isMaxChars(1024))).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(MAX_FREE_BUSY_CALENDARS),
          ),
          `Calendar ids, guest emails or group emails, 1–${MAX_FREE_BUSY_CALENDARS}.`,
        ),
        timeZone: Schema.optionalKey(described(timeZone, "Zone for returned times; default UTC.")),
      }),
      output: Schema.Struct({
        timeMin: Schema.String,
        timeMax: Schema.String,
        calendars: Schema.Array(
          optional({
            id: Schema.String,
            busy: Schema.Array(optional({ start: Schema.String, end: Schema.String })),
            errors: Schema.Array(Schema.String),
          }),
        ),
      }),
      fields: true,
      check: (args, problems) => {
        if (Date.parse(args.timeMin) >= Date.parse(args.timeMax)) problems.add("timeMax", "an instant after timeMin");
      },
      run: (args) =>
        Effect.gen(function* () {
          const reply = asRecord(
            yield* json({
              method: "POST",
              path: "/freeBusy",
              template: "/freeBusy",
              body: compact({
                timeMin: args.timeMin,
                timeMax: args.timeMax,
                timeZone: args.timeZone,
                items: args.calendars.map((id) => ({ id })),
              }),
            }),
          );
          const calendars = asRecord(reply["calendars"]);
          return {
            timeMin: text(reply["timeMin"]) ?? args.timeMin,
            timeMax: text(reply["timeMax"]) ?? args.timeMax,
            calendars: args.calendars.map((id) => {
              const entry = asRecord(calendars[id]);
              return compact({
                id,
                busy: asArray(entry["busy"]).map((range) =>
                  compact({ start: text(asRecord(range)["start"]), end: text(asRecord(range)["end"]) }),
                ),
                errors: asArray(entry["errors"])
                  .map((error) => text(asRecord(error)["reason"]))
                  .filter((reason): reason is string => reason !== undefined),
              });
            }),
          };
        }),
    }),
    write(connection, {
      name: "create_event",
      description:
        "Create one event, with guests, reminders, recurrence or a new Meet link. Sends invitations only as sendUpdates says. Not a free/busy check.",
      destructive: false,
      input: Schema.Struct({
        calendarId: optionalCalendarId,
        ...editable,
        summary: described(Schema.String.check(isMaxChars(1024)), "Title."),
        start: described(When, "Start: dateTime or an all-day date."),
        end: described(When, "End, exclusive, of the same kind as start."),
        attendees: Schema.optionalKey(
          described(Schema.Array(NewAttendee).check(Schema.isMaxLength(MAX_NEW_ATTENDEES)), "Guests to invite."),
        ),
        sendUpdates,
      }),
      output: EventRecord,
      check: (args, problems) => checkEditable(problems, args),
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const calendar = args.calendarId ?? "primary";
          const reply = yield* json({
            method: "POST",
            path: `${calendarPath(calendar)}/events`,
            template: "/calendars/{calendarId}/events",
            query: { sendUpdates: args.sendUpdates, conferenceDataVersion: args.addGoogleMeet ? 1 : undefined },
            body: compact({
              ...eventBody(args),
              attendees: args.attendees?.map((attendee) => compact({ ...attendee })),
            }),
          });
          return eventResult(ctx, reply, calendar);
        }),
    }),
    write(connection, {
      name: "quick_add_event",
      description:
        "Create one event from a sentence such as 'Lunch with Bob tomorrow at noon', parsed by Google. Invites nobody unless sendUpdates says so.",
      destructive: false,
      input: Schema.Struct({
        calendarId: optionalCalendarId,
        text: described(Schema.String.check(isMinChars(1), isMaxChars(1024)), "The event as one sentence."),
        sendUpdates,
      }),
      output: EventRecord,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const calendar = args.calendarId ?? "primary";
          const reply = yield* json({
            method: "POST",
            path: `${calendarPath(calendar)}/events/quickAdd`,
            template: "/calendars/{calendarId}/events/quickAdd",
            query: { text: args.text, sendUpdates: args.sendUpdates },
          });
          return eventResult(ctx, reply, calendar);
        }),
    }),
    write(connection, {
      name: "update_event",
      writeSteps: { event: "once", write: "once" },
      description:
        "Change an event's title, time, description, guests, reminders or recurrence; omitted fields are kept. Guests are added or removed, never replaced.",
      destructive: true,
      input: Schema.Struct({
        calendarId: optionalCalendarId,
        eventId,
        ...editable,
        addAttendees: Schema.optionalKey(
          described(Schema.Array(NewAttendee).check(Schema.isMaxLength(MAX_NEW_ATTENDEES)), "Guests to add."),
        ),
        removeAttendees: Schema.optionalKey(
          described(
            Schema.Array(Schema.String.check(isMinChars(3), isMaxChars(320))).check(
              Schema.isMaxLength(MAX_NEW_ATTENDEES),
            ),
            "Guest emails to remove.",
          ),
        ),
        sendUpdates,
      }),
      output: EventRecord,
      check: (args, problems) => {
        checkEditable(problems, args);
        if ((args.start === undefined) !== (args.end === undefined)) problems.add("end", "start and end together");
        const { calendarId: _c, eventId: _e, sendUpdates: _s, ...changes } = args;
        if (!Object.keys(changes).length) problems.add("summary", "at least one change");
      },
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const calendar = args.calendarId ?? "primary";
          const body = eventBody(args);
          if (args.addAttendees?.length || args.removeAttendees?.length) {
            // Calendar replaces the whole guest list on patch: read it, keep
            // every guest's response, and change only the named ones.
            const current = asRecord(yield* readEvent(calendar, args.eventId, { effect: "read", step: "event" }));
            if (current["attendeesOmitted"] === true)
              throw new ConnectorCallError(
                "connector_call_failed",
                "Google omitted part of this event's guest list, so it cannot be changed without losing guests; edit it in Calendar.",
                { retryable: false },
              );
            const removed = new Set((args.removeAttendees ?? []).map((email) => email.toLowerCase()));
            const kept = asArray(current["attendees"])
              .map(asRecord)
              .filter((attendee) => !removed.has(String(attendee["email"] ?? "").toLowerCase()));
            const present = new Set(kept.map((attendee) => String(attendee["email"] ?? "").toLowerCase()));
            const added = (args.addAttendees ?? [])
              .filter((attendee) => !present.has(attendee.email.toLowerCase()))
              .map((attendee) => compact({ ...attendee }));
            body["attendees"] = [...kept, ...added];
          }
          const reply = yield* json({
            method: "PATCH",
            path: eventPath(calendar, args.eventId),
            template: EVENT_TEMPLATE,
            query: { sendUpdates: args.sendUpdates, conferenceDataVersion: args.addGoogleMeet ? 1 : undefined },
            body,
          });
          return eventResult(ctx, reply, calendar);
        }).pipe(knownFailures),
    }),
    write(connection, {
      name: "respond_to_event",
      writeSteps: { event: "once", write: "once" },
      description:
        "Accept, decline or tentatively accept an invitation as the user, changing only the user's own response. Not for events the user is not invited to.",
      destructive: true,
      input: Schema.Struct({
        calendarId: optionalCalendarId,
        eventId,
        response: described(Schema.Literals(["accepted", "declined", "tentative"]), "The user's answer."),
        comment: Schema.optionalKey(described(Schema.String.check(isMaxChars(1024)), "Note to the organizer.")),
        sendUpdates,
      }),
      output: EventRecord,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const calendar = args.calendarId ?? "primary";
          const current = asRecord(yield* readEvent(calendar, args.eventId, { effect: "read", step: "event" }));
          const attendees = asArray(current["attendees"]).map(asRecord);
          const self = attendees.findIndex((attendee) => attendee["self"] === true);
          if (self < 0)
            throw new ConnectorCallError(
              "invalid_args",
              "The user is not a guest of this event, so there is no invitation to answer.",
            );
          if (current["attendeesOmitted"] === true)
            throw new ConnectorCallError(
              "connector_call_failed",
              "Google omitted part of this event's guest list, so a response cannot be saved without losing guests.",
              { retryable: false },
            );
          // Calendar replaces the whole guest list on patch; only the user's own entry changes.
          const updated = attendees.map((attendee, index) =>
            index === self
              ? compact({
                  ...attendee,
                  responseStatus: args.response,
                  comment: args.comment ?? attendee["comment"],
                })
              : attendee,
          );
          const reply = yield* json({
            method: "PATCH",
            path: eventPath(calendar, args.eventId),
            template: EVENT_TEMPLATE,
            query: { sendUpdates: args.sendUpdates },
            body: { attendees: updated },
          });
          return eventResult(ctx, reply, calendar);
        }).pipe(knownFailures),
    }),
    write(connection, {
      name: "move_event",
      description:
        "Move an event to another calendar the user can write, changing its organizer calendar. Not a time change; use update_event for that.",
      destructive: true,
      input: Schema.Struct({
        calendarId: optionalCalendarId,
        eventId,
        destination: described(
          Schema.String.check(isMinChars(1), isMaxChars(1024)),
          "Target calendar id from list_calendars.",
        ),
        sendUpdates,
      }),
      output: EventRecord,
      run: (args) =>
        Effect.gen(function* () {
          const ctx = yield* contextOf;
          const reply = yield* json({
            method: "POST",
            path: `${eventPath(args.calendarId ?? "primary", args.eventId)}/move`,
            template: "/calendars/{calendarId}/events/{eventId}/move",
            query: { destination: args.destination, sendUpdates: args.sendUpdates },
          });
          return eventResult(ctx, reply, args.destination);
        }),
    }),
    write(connection, {
      name: "delete_event",
      description:
        "Delete an event, or one occurrence by its instance id; guests are told only as sendUpdates says. A deleted event stays cancelled, not restorable here.",
      destructive: true,
      input: Schema.Struct({ calendarId: optionalCalendarId, eventId, sendUpdates }),
      output: Schema.Struct({ calendarId: Schema.String, eventId: Schema.String, deleted: Schema.Boolean }),
      run: (args) =>
        Effect.gen(function* () {
          const calendar = args.calendarId ?? "primary";
          yield* json({
            method: "DELETE",
            path: eventPath(calendar, args.eventId),
            template: EVENT_TEMPLATE,
            query: { sendUpdates: args.sendUpdates },
          });
          return { calendarId: calendar, eventId: args.eventId, deleted: true };
        }),
    }),
  ];
}
