---
{
  "name": "ccb",
  "instructionsHeading": "Church instructions"
}
---

<!-- fragment: guide_0 -->


## Resolve ids before acting

- Every record is addressed by an integer id. Read it from a list tool and
  pass it back; never guess one. `list_individuals` finds people by partial
  name, phone, or email; `familyId`, `groupId`, `eventId`, form, process,
  queue, and category ids come from their own list tools.
- Events are series with dated occurrences. `list_events` returns
  `eventId` plus `occurrence`; the attendance tools need both.
- Campus and membership-type ids resolve through `ccb_api_get` on
  `/campuses` and `/church/membership_types`.
<!-- endfragment -->

<!-- fragment: guide_1 -->

## Sensitive data stays out of results

Projections drop allergies, giving numbers and dates, attendance prayer
requests and leader notes, and form payment details; `raw: true` returns
CCB's full row. Notes, pledges, giving metrics, background checks, and
financial settings are pastoral or financial: read them inside
`execute_code` and return only the reduced answer the task needs.

Giving in v2 is counts per period (`get_giving_metrics`), pledges, scheduled
gifts, and financial settings. Transactions, batches, and amounts per gift
live only in CCB's legacy v1 XML API, which this connector does not reach.

## Paging

Lists take `page` (1-based) and `perPage` (25, 50, 75, or 100 only) and
return `page.hasMore`, `page.nextPage`, and `page.total`. Field names are
CCB's snake_case turned camelCase.

## Rate limits

CCB allows each endpoint about one call a second after a burst of 60, per API
client. This connector keeps a per-runtime 60-per-minute window per endpoint
— an approximation, not an enforcement. `get_individual` (1/s),
`list_schedules` (1 per 2 s), and individuals advanced search (1 per 5 s)
allow no burst: page a list instead of looping a get, and space those calls.
A `rate_limited` failure carries CCB's wait.

## Raw access

`ccb_api_get` reaches any GET path; `ccb_api_search` runs advanced searches,
which CCB serves as POST but are reads.<!-- endfragment -->
