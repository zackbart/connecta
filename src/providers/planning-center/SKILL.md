---
{
  "name": "planning-center",
  "instructionsHeading": "Organization instructions"
}
---

## Identity first

The People person id joins products; names repeat, so join on `person_id`.
Memberships, scheduled people and workflow cards have their own ids. `get_me`
gives the organization's time zone: bare dates mean its local day, and exact
boundaries need an offset. Name filters are exact unless the value ends in `%`.

An old person id may be merged: read `/people/v2/person_mergers` with
`where[person_to_remove_id]` and follow `person_to_keep_id`. An empty history
does not prove no merge happened.

Pastoral data: reduce inside `execute_code` and return aggregates unless the task
needs named people. Named reads omit some fields; read the indexed record when the
task needs them.

<!-- when: people -->
## People

Workflow cards join people to a workflow and its ordered steps. Custom values and
form answers need their field records for names and types.
<!-- end -->

<!-- when: people-writes -->
An omitted attribute stays; `null` clears it. Archiving is reversible; deleting a
profile is permanent. Resolve the card id and its person id before acting on a
workflow card. Promoting completes a step; skipping moves on without completing
it. Card notes and profile notes are different records, and note categories can
notify subscribers. The API cannot submit a form on someone's behalf.
<!-- end -->

<!-- when: lists -->
Saved lists are only as fresh as their last refresh. Refreshing can fire
automations, such as adding someone to a workflow, so it is a write even for a count.
<!-- end -->

<!-- when: services -->
## Services

Resolve the service type before a dated plan; plan times define its service dates.
A cut `get_plan` section reads through its indexed items or team-members path. Item
durations are seconds. Schedule status: `C` confirmed, `U` unconfirmed, `D`
declined. Preparing a notification and sending it are different actions. Services
cannot upload a file through this connection.
<!-- end -->

<!-- when: groups -->
## Groups

Memberships distinguish leaders from members but carry no person attributes;
`include=person` supplies names, and the person id supplies contact details.
<!-- end -->

<!-- when: check-ins -->
## Check-Ins

An event recurs; its period is a dated occurrence. Period counts are the efficient
attendance answer. Date filters use the period start, not the check-in creation time.
<!-- end -->

<!-- when: calendar -->
## Calendar

Event instances expand recurrence. A booking can return a `BookedEvent` stub when
the user lacks access to its event.
<!-- end -->

<!-- when: registrations -->
## Registrations

Attendee records join to People and separate active, waitlisted and canceled attendees.
<!-- end -->

<!-- when: giving -->
## Giving

Amounts are integer cents with a currency. Designations split a donation across
funds, so never count a donation once per designation. Recurring schedules and the
donations they produce are different records. Named giving tools only read.
<!-- end -->

<!-- when: giving-writes -->
Creating, editing or refunding a donation or committing a batch changes financial
records.
<!-- end -->

<!-- when: publishing -->
## Publishing

A Church Center link and a media resource are different records; use the one the
task asks for.
<!-- end -->

<!-- when: webhooks -->
## Webhooks

Signing keys, private destinations and event payloads stay withheld; status and
event metadata remain available for audits.
<!-- end -->

<!-- when: api -->
## Organization API

Token inventory never returns values.
<!-- end -->

<!-- when: api-writes -->
Revoking a token is a write that may break another integration, including this
connection.
<!-- end -->

<!-- when: limited -->
## Product boundary

Some products are unavailable. A new webhook subscription must name a reachable
product's event. Stored workflow cards, notes, custom fields and form answers stay
readable and may contain copied information; provenance is not inferred.
<!-- end -->
