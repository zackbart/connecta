// Google Calendar's vendor on the provider kit: the methods the named tools
// send, the full indexed inventory for the manifest and hatch, the product
// facts the shared Google table words its failures with, and the value-safety
// resolver over the index.
import { Schema } from "effect";
import { del, get, patch, post } from "../../http/vendor.js";
import { googleConnectionErrors, googleErrors, type GoogleProduct } from "../_shared/google/kit.js";
import { indexedVendor } from "../_shared/rest/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { calendarIndex } from "./lib/hatch.js";
import { CALENDAR_SCOPES } from "./lib/constants.js";
import { CALENDAR_VALUE_SAFETY } from "./safety.js";

export const CALENDAR: GoogleProduct = {
  provider: "Google Calendar",
  api: "Google Calendar API",
  scopes: CALENDAR_SCOPES,
  // Google answers 404 alike for an event or calendar that does not exist and
  // one this user cannot see, so a 404 is not proof of absence.
  notFound: "ambiguous",
};

const CalendarId = { calendarId: Schema.String };
const EventId = { ...CalendarId, eventId: Schema.String };

const listCalendars = get("listCalendars", "/users/me/calendarList", { success: Schema.Unknown });

const OPERATIONS = [
  listCalendars,
  get("listEvents", "/calendars/:calendarId/events", { params: CalendarId, success: Schema.Unknown }),
  get("getEvent", "/calendars/:calendarId/events/:eventId", { params: EventId, success: Schema.Unknown }),
  post("queryFreeBusy", "/freeBusy", { payload: Schema.Unknown, success: Schema.Unknown }),
  post("insertEvent", "/calendars/:calendarId/events", {
    params: CalendarId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("quickAddEvent", "/calendars/:calendarId/events/quickAdd", { params: CalendarId, success: Schema.Unknown }),
  patch("patchEvent", "/calendars/:calendarId/events/:eventId", {
    params: EventId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("moveEvent", "/calendars/:calendarId/events/:eventId/move", { params: EventId, success: Schema.Unknown }),
  del("deleteEvent", "/calendars/:calendarId/events/:eventId", { params: EventId, success: Schema.Unknown }),
] as const;

const indexed = indexedVendor("Google Calendar", calendarIndex, OPERATIONS);
/** Every indexed Calendar method, published under `/calendar/v3` as Google's Discovery document spells them. */
export const CalendarApi = {
  ...indexed,
  manifestBase: "/calendar/v3",
  indexed: {
    ...indexed.indexed!,
    operations: calendarIndex.ops.map((op) => `${op.method} /calendar/v3${op.path}`).sort(),
  },
};

export const errors = googleErrors(CALENDAR, { standard: true });
/** {@link errors}, worded for the connection's access mode. */
export const connectionErrors = googleConnectionErrors(CALENDAR, "calendar", errors);

const values = valueSafety(CALENDAR_VALUE_SAFETY, () => calendarIndex);
export const safety = {
  reviewed: {
    resolve: (method: string, path: string) => {
      const op = calendarIndex.resolve(method, path).op;
      return { method: op.method, template: op.path };
    },
    redact: (data: unknown, op: { method: string; template: string }) => values.redact(data, op.method, op.template),
    withholds: (op: { method: string; template: string }) => values.withholds(op.method, op.template),
    withholdsErrors: (op: { method: string; template: string }) =>
      values.withholdsErrors(
        calendarIndex.ops.find((entry) => entry.method === op.method && entry.path === op.template)!,
      ),
  },
  sensitiveFields: { names: [], choice: "drop" },
} as const;

/**
 * Delegation has no operator credential to test: the key is a deployment
 * secret read at construction. This probe is never run, because the
 * connection declares no credential.
 */
export const probe = {
  operation: listCalendars,
  request: {},
  describe: () => "Google Calendar delegation has no credential to test.",
};
