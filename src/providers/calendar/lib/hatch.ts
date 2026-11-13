// Full frozen inventory: every indexed Calendar method has a literal reviewed
// verdict. Only push notification channels, which deliver to a webhook this
// connection cannot receive, are refused.
import { googlePageToken } from "../../../http/hatch-paging.js";
import { googleHatchBinding } from "../../_shared/google/hatch.js";
import { OperationIndex } from "../../_shared/rest/operation-index.js";
import type { Connection } from "../../../http/vendor.js";
import { openapi } from "../openapi.generated.js";

export const calendarIndex = new OperationIndex(openapi, {
  vendor: "calendar",
  title: "Google Calendar",
  pathMatching: "uri-template",
});

const WATCH =
  "Push notification channels deliver to a webhook URL this connection cannot receive, and need a channel this connection never opens; poll with list_events instead.";
const CALENDAR_REFUSALS: Readonly<Record<string, string>> = {
  "POST /calendars/{calendarId}/events/watch": WATCH,
  "POST /calendars/{calendarId}/acl/watch": WATCH,
  "POST /users/me/calendarList/watch": WATCH,
  "POST /users/me/settings/watch": WATCH,
  "POST /channels/stop": "This connection never opens a push notification channel, so it has none to stop.",
};

export function calendarBinding(connection: Connection) {
  return googleHatchBinding(connection, {
    index: calendarIndex,
    review:
      "Thirty-three reviewed Calendar JSON methods on the confined delegated connection: events, free/busy, calendars, calendar list, sharing rules, settings and colors; push notification channels refused.",
    refusal: (op) => CALENDAR_REFUSALS[`${op.method} ${op.path}`],
    refuse: (call) => CALENDAR_REFUSALS[`${call.method} ${call.op.path}`],
  });
}

export const CALENDAR_HATCH = {
  name: "calendar",
  title: "Google Calendar",
  index: calendarIndex,
  pathExample: "/calendars/primary/events",
  verdicts: {
    "POST /calendars": "write",
    "GET /calendars/{calendarId}": "read",
    "PUT /calendars/{calendarId}": "destructive",
    "PATCH /calendars/{calendarId}": "destructive",
    "DELETE /calendars/{calendarId}": "destructive",
    "GET /calendars/{calendarId}/acl": "read",
    "POST /calendars/{calendarId}/acl": "destructive",
    "POST /calendars/{calendarId}/acl/watch": "refuse",
    "GET /calendars/{calendarId}/acl/{ruleId}": "read",
    "PUT /calendars/{calendarId}/acl/{ruleId}": "destructive",
    "PATCH /calendars/{calendarId}/acl/{ruleId}": "destructive",
    "DELETE /calendars/{calendarId}/acl/{ruleId}": "destructive",
    "POST /calendars/{calendarId}/clear": "destructive",
    "GET /calendars/{calendarId}/events": "read",
    "POST /calendars/{calendarId}/events": "write",
    "POST /calendars/{calendarId}/events/import": "write",
    "POST /calendars/{calendarId}/events/quickAdd": "write",
    "POST /calendars/{calendarId}/events/watch": "refuse",
    "GET /calendars/{calendarId}/events/{eventId}": "read",
    "PUT /calendars/{calendarId}/events/{eventId}": "destructive",
    "PATCH /calendars/{calendarId}/events/{eventId}": "destructive",
    "DELETE /calendars/{calendarId}/events/{eventId}": "destructive",
    "GET /calendars/{calendarId}/events/{eventId}/instances": "read",
    "POST /calendars/{calendarId}/events/{eventId}/move": "destructive",
    "POST /calendars/{calendarId}/transferOwnership": "destructive",
    "POST /channels/stop": "refuse",
    "GET /colors": "read",
    "POST /freeBusy": "read",
    "GET /users/me/calendarList": "read",
    "POST /users/me/calendarList": "write",
    "POST /users/me/calendarList/watch": "refuse",
    "GET /users/me/calendarList/{calendarId}": "read",
    "PUT /users/me/calendarList/{calendarId}": "destructive",
    "PATCH /users/me/calendarList/{calendarId}": "destructive",
    "DELETE /users/me/calendarList/{calendarId}": "destructive",
    "GET /users/me/settings": "read",
    "POST /users/me/settings/watch": "refuse",
    "GET /users/me/settings/{setting}": "read",
  },
  named: {
    "GET /users/me/calendarList": "list_calendars",
    "GET /calendars/{calendarId}/events": "list_events",
    "GET /calendars/{calendarId}/events/{eventId}": "get_event",
    "POST /freeBusy": "query_free_busy",
    "POST /calendars/{calendarId}/events": "create_event",
    "POST /calendars/{calendarId}/events/quickAdd": "quick_add_event",
    "PATCH /calendars/{calendarId}/events/{eventId}": "update_event",
    "POST /calendars/{calendarId}/events/{eventId}/move": "move_event",
    "DELETE /calendars/{calendarId}/events/{eventId}": "delete_event",
  },
  pages: {
    "GET /users/me/calendarList": googlePageToken,
    "GET /calendars/{calendarId}/events": googlePageToken,
    "GET /calendars/{calendarId}/events/{eventId}/instances": googlePageToken,
    "GET /calendars/{calendarId}/acl": googlePageToken,
    "GET /users/me/settings": googlePageToken,
  },
  pageCursor: "argument",
} as const;
