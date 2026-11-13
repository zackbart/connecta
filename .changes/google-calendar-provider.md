---
type: added
---

A maintained Google Calendar provider, `@zackbart/connecta/providers/calendar`, in both Google modes (domain-wide delegation and OAuth) with the full `https://www.googleapis.com/auth/calendar` scope. Named tools list calendars, list and search events, read an event, query free/busy (group emails expand to members; failed or missing answers are reported as unknown, never free), create events (guests, reminders, recurrence, an optional Google Meet link), quick-add, update events while preserving other guests' responses (guest changes are sent with `If-Match` and fail `conflict` when the event changed), answer invitations with Google's participant-only update, move and delete events. Invitation emails follow each write's explicit `sendUpdates`. The hatch admits every indexed Calendar method behind a reviewed verdict and refuses only push notification channels. Conference dial-in PINs and passcodes are withheld. (#1395)
