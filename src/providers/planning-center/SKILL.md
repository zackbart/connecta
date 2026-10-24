---
{
  "name": "planning-center",
  "instructionsHeading": "Organization instructions"
}
---

## Identity first

A People person id joins records across products. Resolve people by identity,
then join on `person_id`; names can repeat. A membership, scheduled person,
workflow card and person each have their own record id.

`get_me` identifies the token's user and the organization's time zone. Bare
dates mean the organization's local day; use a timestamp with an offset for
an exact boundary. Name filters are exact unless their value ends in `%`.

An old person id may have been merged. Read `/people/v2/person_mergers` with
`where[person_to_remove_id]`, follow `person_to_keep_id`, then read that profile.
An empty history does not establish that a person was merged.

Reduce pastoral information inside `execute_code` and return aggregates unless
the task needs named people. A named projection omits some safe vendor fields;
read the indexed record when the task needs those fields.

<!-- when: people -->
## People and follow-up

Resolve a person before changing their profile. An omitted attribute leaves
the current value alone; `null` clears it. Archiving a person is reversible;
deleting a profile is permanent.

Workflow cards join people to a workflow and its ordered steps. Resolve both
the card id and its person id before acting on a card. Snoozing needs a duration;
promoting a card completes its step, while skipping moves on without completing
it. A workflow card note and a profile note are different records. Profile note
categories can notify their subscribers.

Custom field values need their field-definition records to supply names and
data types. Form answers similarly join submissions, values and fields; the
API cannot submit a form on someone's behalf.
<!-- end -->

<!-- when: lists -->
Saved People lists are live cross-product queries. Their results are only as
fresh as their last refresh. Refreshing a list can fire its automations, such
as adding a person to a workflow, and is a write even when the task is a count.
<!-- end -->

<!-- when: services -->
## Services plans and schedules

Resolve the service type before finding a dated plan. Plan times define the
service dates. `get_plan` combines the plan, order of service and scheduled
team; a cut section can be read through its indexed items or team-members path.
Item durations are seconds, so divide by 60 when reporting minutes.

Scheduling needs a team and may need a position. `C` means confirmed, `U`
unconfirmed and `D` declined. Preparing a notification and sending it are
different actions. A song item's identity comes from its song and arrangement;
musical keys are not credentials. Services cannot upload a file through this
connection.
<!-- end -->

<!-- when: groups -->
## Groups membership joins

Use a group's membership records to distinguish leaders from members. On this
API version memberships carry no person attributes; `include=person` supplies
names, and the related person id supplies contact details and other product
records. The API can change memberships and group settings, but cannot create
a group, create a meeting or record group attendance.
<!-- end -->

<!-- when: check-ins -->
## Check-Ins occurrences

An event is recurring; its event period is a dated occurrence. Period counts
are the efficient attendance answer. Individual check-ins join a person to a
period, and date filtering uses the period's start, not the check-in's creation
time. The API cannot check anyone in or out.
<!-- end -->

<!-- when: calendar -->
## Calendar occurrences

Event instances expand recurrence into occurrences. A booking can return a
`BookedEvent` stub when the user lacks access to its event. Events, instances
and times are read-only; tags, resources, rooms and folders have write APIs.
<!-- end -->

<!-- when: registrations -->
## Registrations

A signup describes a registration event. Its attendee records join back to
People and distinguish active, waitlisted and canceled attendees. This API
cannot register someone.
<!-- end -->

<!-- when: giving -->
## Giving amounts and donor joins

Amounts are integer cents with an explicit currency. A donation's designations
allocate it across funds; do not count a donation once per designation. Join
donors by person id and funds by fund id. Recurring schedules and the donations
they produce are different records. Creating/editing a donation, refunding it
or committing a batch changes financial records; named giving tools only read.
<!-- end -->

<!-- when: publishing -->
## Publishing

Episodes, channels and resources are available through the indexed API. A public
Church Center link and a media resource are different things; use the record
the task asks for. Signed download URL generation is refused because the
private link would remain withheld.
<!-- end -->

<!-- when: webhooks -->
## Webhooks

A subscription names an event and callback destination. Signing keys, private
download destinations and opaque event/delivery payloads or headers remain
withheld. Status and event metadata are available for audits.
Webhook signing-key rotation is refused: the new credential cannot be returned
or installed on the receiver through this connection.
<!-- end -->

<!-- when: api -->
## Organization API

The organization API includes application metadata and personal-access-token
inventory. Inventory records describe tokens; they do not return their values.
Revoking a token is a write and may interrupt another integration, including
this connection if its own token is revoked.
<!-- end -->

<!-- when: limited -->
## Product boundary

Some products are unavailable on this connection. People lists and their rules
are unavailable because they can query another product. Webhook payloads and
changes to existing subscriptions are unavailable because their ids do not name
their product. A new subscription must name a reachable product's event.

Stored workflow cards, notes, custom fields and form answers remain readable
when reachable: staff or automations may have copied information into them.
The connection does not infer the provenance of those stored records.
<!-- end -->

## Not available

Only reviewed product versions and indexed operations are callable. File
uploads use a separate host this connection does not reach. Credentials and
private calendar access codes cannot be recovered through a tool.
