---
{
  "name": "breeze",
  "instructionsHeading": "Church instructions"
}
---

<!-- fragment: guide_0 -->
.breezechms.com (Breeze ChMS, now Tithely Church Management): people, tags, events, attendance, forms, volunteers, and giving.

Church purpose: <!-- endfragment -->

<!-- fragment: guide_1 -->


## Sensitive data: reduce in code

People records carry home addresses, phones, birthdates, and family ties, and
giving records reveal who gives and how much — religious affiliation by proxy.
Read them inside `execute_code` and return only the counts, totals, or the
few fields the task needs. Never echo whole profiles or donor lists.

## Ids and profile fields

- Ids are numeric strings. Read them from a list tool; never guess one.
- Events have two ids: an instance id (`list_events` `id`) for one
  occurrence, and a series `eventId`. Attendance, volunteers, and
  check-in take the instance id.
- Person `details` are keyed by profile `fieldId`, not by name. Call
  `list_profile_fields` once and map ids to names in code. Multiple-choice
  values and `list_people` filters use option ids from the same call;
  join several with `-`.
- `list_people` has no name search. List without details and match names
  in code, then `get_person` the hits.
- Projections rename Breeze's snake_case fields to camelCase and drop photo
  paths and internal columns; `raw: true` returns Breeze's rows.

## Pagination

`list_people` pages by `cursor`: continue while `page.hasMore`. Breeze
reports no total, so a full page sets `hasMore` and the next may be empty.
`list_events` and `list_account_log` do not page: `truncated: true`
means narrow the date range. Other lists return everything.

## Giving

`list_contributions` and `list_funds` call endpoints Breeze removed from
its public reference in 2023 but still serves. They may change or vanish
without notice; a failure there is not your argument's fault. Amounts are
decimal strings; `totalAmount` is an exact sum. Online gifts processed by
Tithe.ly arrive through its sync, batched per deposit, so the latest days
may be missing. Read the currency from `get_account_summary`.

## Writes and the hatches

- Every write, `add_person`, `assign_tag`, and `record_check_in`
  included, follows the routing in the `usage` skill. Fetch it with
  `skills({ name: "usage" })` for guest API and trust rules.
  Those three only add, and `add_person` never deduplicates.
- `update_person` field values: text, date (M/D/YYYY), or option id in
  `response`; email, phone, address, and family_role values in `details`.
- Every Breeze call is a GET, writes included, so the hatches split by
  endpoint. `breeze_api_get` admits only reviewed read endpoints and their
  documented parameters, such as `/tags/list_folders`,
  `/events/list_event`, `/events/attendance/eligible`, `/giving/view`,
  and `/pledges/list_campaigns`; it refuses anything else. Everything else
  — event, family, volunteer, and form writes, giving writes, check-out,
  undocumented parameters — is `breeze_api_mutate`. Paths are below
  `/api`; `*_json` values may be passed as objects.
- `list_account_log` actions include person_created, person_updated,
  person_deleted, tag_assign, tag_unassign, event_created,
  attendance_deleted, form_entry_updated, contribution_added,
  contribution_updated, contribution_deleted, and batch_updated.

## Rate limits

Breeze publishes no limit and sends no rate headers; a third party reports
about 20 requests per minute. Keep loops sequential and prefer one list call
over many single reads.
<!-- endfragment -->
