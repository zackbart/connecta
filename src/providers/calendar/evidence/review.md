# Calendar surface review

Contributor evidence for #1395. No real Workspace data calls or
service-account mints were used. The official Discovery snapshot is revision
20261109, archived verbatim under SHA-256
`36b32fe2b973560a8611ac8e72fde971ca427c643bd9f5e408ae680a9e7c4dae`.
The source revision alone is mutable; the bytes and digest are the pin.
The google-discovery-v1 conversion is derived in memory from the original
with the `/calendar/v3` root; its digest is stamped separately in
`openapi.generated.ts`. The complete source-id/normalized-key mapping is in
`x-google-discovery.mapping`.

## Scope and inventory

The connection requests exactly `https://www.googleapis.com/auth/calendar`,
the full read/write scope every one of the 38 indexed methods accepts. No
narrower scope covers sharing rules, calendar administration and events
together, and the issue's owner decision is the full scope.

All 38 source methods are indexed with no deprecations excluded. 33 carry a
reviewed execution verdict. Reads: events list/get/instances, calendars get,
calendarList list/get, acl list/get, settings list/get and colors get, plus
the read-only POST `freeBusy`. Additive writes (`write`): calendars insert,
calendarList insert, events insert/import/quickAdd. Every other mutation is
`destructive`, including acl insert, because sharing a calendar discloses
its events, `calendars.clear` and `calendars.transferOwnership`. Host
approval gates every write.

Five methods are refused before authentication: events/acl/calendarList/
settings `watch` and `channels.stop`. A push channel delivers to a webhook
address the caller supplies, which this connection can neither receive nor
confine, and registration returns a channel token. Refusal reasons and the
natural vocabulary for each method live in each summary's first sentence.

## Named tools

The vendor declaration names the nine methods the authored tools send;
the manifest and drift records cover the full index. `update_event` and
`respond_to_event` read the event first as an auxiliary read (no write step).
Calendar's patch replaces the whole attendee array, so `update_event`'s guest
change keeps every other guest's entry and response from the read, sends the
read `etag` as `If-Match`, and refuses when Google reports `attendeesOmitted`.
Per the version-resources guide, a stale ETag is HTTP 412; the shared Google
table maps it to `conflict` only for an ETag-guarded request, and nothing is
replayed. `respond_to_event` instead uses the Event resource's documented
participant-only update: `attendeesOmitted: true` with only the user's own
entry ("When updating an event, this can be used to only update the
participant's response"). Other guests are never sent, so a concurrent RSVP or
organizer edit cannot be reverted, and an omitted guest list no longer blocks
an answer. It sends no `If-Match`: with nothing else to overwrite, a guard
would only turn every other guest's reply into a spurious conflict.

`query_free_busy` keeps Google's two maps apart: `groups[id]` carries a
group's member calendar ids or its errors (such as `groupTooBig`), and each
member's busy intervals come from `calendars`. Every requested id and member
gets `status` `ok`, `error` or `missing`; only `ok` carries `busy`, so a
failure or an absent answer is never presented as free. A dispatched
write is attempted once; Google documents no idempotency key. The Meet
`createRequest.requestId` only deduplicates conference creation inside
Google and is not a replay key. `sendUpdates` is passed only when the caller
chose it, so Google's documented default applies otherwise.

List rows omit descriptions and guest lists and hold titles and locations to
1 KiB of JSON each, so a 50-row page stays inside the shared Workspace result
budget. `get_event` bounds descriptions at 32 KiB and returns at most 200
attendees, reporting cuts as `truncated` dot paths.

## Value safety

Events, attendees, responses, sharing rules, calendar list entries and
settings are the user's own calendar data. The candidates flag a conference
entry point's `accessCode`, `passcode`, `password`, `pin` and `meetingCode`,
plus `conferenceData.signature`. The first four are a third-party
conference's join secrets and are permanently redacted on every operation
that returns an Event (list, get, instances, insert, import, quickAdd,
update, patch, move). `meetingCode` is the visible path of a Google Meet link
every guest receives, and `signature` is Google's server-generated integrity
check over conference data; both are kept. `nextPageToken` and
`nextSyncToken` are continuation metadata usable only with the same grant.
Watch channel tokens are on refused operations. User-authored descriptions,
locations, attachment `fileUrl`s and `source.url` are ordinary references;
global signing-name URL defense covers free text and error bodies. No
generic URL-token parameter rule is applied to user-authored text. There is
no base64 or upload transport in this product.

`transferOwnership` was flagged by name; it returns the calendar's metadata
and mints no credential. Calendar error bodies echo request values, never a
stored secret, so reviewed operations keep Google's (sent-secret redacted)
error text.

## Paging

Named lists page with Google's `pageToken` inside a signed cursor bound to
the connection, caller, tool and arguments; the vendor token is passed
through sent-secret redaction before it is placed. The hatch pages
events list/instances, calendarList, acl and settings with the shared Google
page-token adapter.

## Errors

Standard Google errors keep reviewed reason facts, numeric Retry-After and
an ambiguous 404 (Calendar answers alike for an unknown id and one the user
cannot see). No revision-guarded conflict applies: Calendar writes are not
revision checked here. No auth-before-execution assertion is claimed.

## OAuth mode

As for every Google product (#1375, #1381), OAuth mode follows Google's
web-server authorization-code flow
(https://developers.google.com/identity/protocols/oauth2/web-server) with
S256 PKCE, body client authentication and exactly the product scope; the
token is sent only to `https://www.googleapis.com`. No revocation endpoint is
configured, because Google's revocation ends every grant the person gave the
Google Cloud project. `accounts` restrictions add `openid` and `email` and
read the ID token as
https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken
describes.
