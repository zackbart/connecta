---
{
  "name": "calendar",
  "instructionsHeading": "Connection instructions"
}
---

## Calendars, events and ids

`primary` is the connected user's own calendar; other calendar ids come from
`list_calendars` and are often email addresses. An event id belongs to one
calendar: read, change or delete it with the same `calendarId` it was listed
from. A recurring series has one id; with `singleEvents` (the default) each
occurrence is its own row with an instance id and the series' id in
`recurringEventId`. Change one occurrence by its instance id and the whole
series by the series id.

## Times and time zones

Timed events use RFC 3339 `dateTime` with an offset; all-day events use a
`date`, and their `end` date is exclusive (a one-day event on 2026-11-20 ends
on 2026-11-21). Read the user's zone from `list_calendars` or the event before
turning "tomorrow at 9" into an instant; never assume UTC. A recurring timed
event needs `start.timeZone` so its occurrences follow daylight saving.

## Availability

`query_free_busy` returns busy intervals, never titles. Only a row with
`status: "ok"` is known. `error` (with reasons such as `notFound` or
`groupTooBig`) and `missing` mean availability is unknown, not free: say so
rather than treating it as available. A group email lists its `members`, each
with its own status and busy intervals. A free/busy result does not reserve
the slot; create the event right after checking.

<!-- when: writes -->
## Invitations and notifications

Guests are emailed only as `sendUpdates` says; when it is omitted, Google
applies its default for the API. Ask before notifying people outside the
user's organization. `respond_to_event` changes only the user's own response;
it cannot answer for another guest. An `update_event` guest change that fails
`conflict` raced another edit and was not applied: read the event and retry. Deleting or moving an event the user
organizes affects every guest's copy. A Google Meet link from `addGoogleMeet`
can be pending at first: read the event again before sharing the link.

A write whose outcome is unknown may have applied: list the calendar around
the intended time and look for the event before creating it again.
<!-- end -->
