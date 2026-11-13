// Reviewed against archived Calendar Discovery revision 20261109.
// Events, attendees, sharing rules and settings are the user's own calendar
// data. A conference entry point's accessCode, passcode, password and pin are
// the dial-in or join secrets of a third-party conference and are permanently
// withheld wherever an Event is returned; the join link, label, meetingCode
// (which is part of a Google Meet link) and the server's conference signature
// remain. Watch channel registration returns a channel token and is refused.
// User-authored descriptions, locations, attachment links and source URLs are
// ordinary references; global signing-name defense still covers free text and
// error bodies, and no generic URL credential-name rule is applied there.
import { redact, refuse, safe, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";

/** Join secrets on a conference entry point, below an Event. */
const ENTRY_SECRETS = ["accessCode", "passcode", "password", "pin"] as const;
const eventSecrets = (prefix: string) => ENTRY_SECRETS.map((name) => `${prefix}conferenceData.entryPoints[].${name}`);
const EVENT =
  "Conference dial-in and join secrets are withheld; the event, its attendees and its join link are requested user data.";
const WATCH =
  "Push notification channels deliver to a webhook this connection cannot receive, and registration returns a channel token.";

export const CALENDAR_VALUE_SAFETY = {
  title: "Google Calendar",
  embeddedUrls: {},
  operations: {
    "GET /calendars/{calendarId}/events": vendorErrors(redact(EVENT, eventSecrets("items[]."))),
    "POST /calendars/{calendarId}/events": vendorErrors(redact(EVENT, eventSecrets(""))),
    "POST /calendars/{calendarId}/events/import": vendorErrors(redact(EVENT, eventSecrets(""))),
    "POST /calendars/{calendarId}/events/quickAdd": vendorErrors(redact(EVENT, eventSecrets(""))),
    "GET /calendars/{calendarId}/events/{eventId}": vendorErrors(redact(EVENT, eventSecrets(""))),
    "PUT /calendars/{calendarId}/events/{eventId}": vendorErrors(redact(EVENT, eventSecrets(""))),
    "PATCH /calendars/{calendarId}/events/{eventId}": vendorErrors(redact(EVENT, eventSecrets(""))),
    "GET /calendars/{calendarId}/events/{eventId}/instances": vendorErrors(redact(EVENT, eventSecrets("items[]."))),
    "POST /calendars/{calendarId}/events/{eventId}/move": vendorErrors(redact(EVENT, eventSecrets(""))),
    "GET /calendars/{calendarId}/acl": vendorErrors(
      safe("Sharing rules and continuation tokens are requested data; no rule carries a credential."),
    ),
    "GET /users/me/calendarList": vendorErrors(
      safe("Calendar list entries and continuation tokens are requested data; no entry carries a credential."),
    ),
    "GET /users/me/settings": vendorErrors(
      safe("Calendar settings and continuation tokens are requested data; no setting carries a credential."),
    ),
    "POST /calendars/{calendarId}/transferOwnership": vendorErrors(
      safe("Returns the transferred calendar's metadata; no ownership credential or secret is minted or returned."),
    ),
    "POST /calendars/{calendarId}/events/watch": refuse(WATCH),
    "POST /calendars/{calendarId}/acl/watch": refuse(WATCH),
    "POST /users/me/calendarList/watch": refuse(WATCH),
    "POST /users/me/settings/watch": refuse(WATCH),
  },
  fields: {
    nextPageToken: {
      verdict: "keep",
      reason: "Opaque Calendar pagination metadata, usable only with the delegated grant; not an access credential.",
    },
    nextSyncToken: {
      verdict: "keep",
      reason: "Opaque incremental-sync position, usable only with the same grant; not an access credential.",
    },
    meetingCode: {
      verdict: "keep",
      reason: "A Google Meet meeting code is the visible path of the join link every guest receives, not a secret.",
    },
    signature: {
      verdict: "keep",
      reason: "Google's server-generated integrity signature over conference data, not an authentication credential.",
    },
  },
} as const satisfies ValueSafetyTable;
