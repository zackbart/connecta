---
{
  "name": "planning-center",
  "instructionsHeading": "Organization instructions",
  "content": "published"
}
---

<!-- fragment: heading -->
# Planning Center usage

Planning Center Online church management — <!-- endfragment -->

<!-- fragment: purpose -->
 — for: <!-- endfragment -->

<!-- fragment: identity -->


## Identity first

- A person id is the join key across every product: the id `search_people` returns is the person id (`personId` argument, `person_id` field) for <!-- endfragment -->

<!-- fragment: conventions -->
. Resolve ids with list tools; never guess one.
- A person id that used to resolve and now answers `not_found` was most likely merged. Read `/people/v2/person_mergers` with `where[person_to_remove_id]` and follow `person_to_keep_id`.
- `get_me` names the user this token acts as. Every read and write runs with that user's permissions, product by product; a `provider_permission_denied` means an administrator must grant that user access to the product or record.

## Results and paging

- Records keep Planning Center's own snake_case attribute names; a relationship appears as `<relationship>_id`. Pass `raw: true` for the untouched JSON:API resources and `included`; `get_me` and `list_webhook_subscriptions` have no raw mode.
- Lists page by offset: `perPage` up to 100, then pass `page.nextOffset` back as `offset` while `page.hasMore` is true. `page.totalCount` answers "how many" without paging — request `perPage: 1`.
- A bare date in a date filter is the organization's local day; pass a full timestamp for exact bounds. Name filters are exact; end one with `%` for a prefix match.
<!-- endfragment -->

<!-- fragment: plans -->
- `get_plan` fetches the plan, its items, and its team in one call and sets `itemsTruncated`/`teamMembersTruncated` past 100 rows; page the rest with `pco_api_get`.
<!-- endfragment -->

<!-- fragment: writes -->

## What each product lets the API write

<!-- endfragment -->

<!-- fragment: people -->
- People: full read/write. `update_person` with `status: inactive` archives reversibly; a DELETE is permanent and only reachable through `pco_api_mutate`. `run_list` can fire list automations.
<!-- endfragment -->

<!-- fragment: people_without_lists -->
- People: full read/write, except lists. `update_person` with `status: inactive` archives reversibly; a DELETE is permanent and only reachable through `pco_api_mutate`.
<!-- endfragment -->

<!-- fragment: services -->
- Services: full read/write. A plan's dates come from its plan times. Scheduling needs a team.
<!-- endfragment -->

<!-- fragment: groups -->
- Groups: memberships and group settings are writable; groups cannot be created, and events and attendance are read-only.
<!-- endfragment -->

<!-- fragment: check_ins_registrations -->
- Check-Ins and Registrations: read-only. Nobody can be checked in or registered through the API.
<!-- endfragment -->

<!-- fragment: check_ins -->
- Check-Ins: read-only. Nobody can be checked in through the API.
<!-- endfragment -->

<!-- fragment: registrations -->
- Registrations: read-only. Nobody can be registered through the API.
<!-- endfragment -->

<!-- fragment: calendar -->
- Calendar: events, instances, and times are read-only; tags, resources, rooms, and folders are writable through `pco_api_mutate`.
<!-- endfragment -->

<!-- fragment: giving -->
- Giving: the named tools only read, amounts in integer cents. Creating or editing donations, refunds, and committing a batch move money and go through `pco_api_mutate`.
<!-- endfragment -->

<!-- fragment: publishing_api -->
- Publishing and the `api` product (organization, OAuth applications, personal access tokens) have no named tools; use the hatches.
<!-- endfragment -->

<!-- fragment: publishing -->
- Publishing has no named tools; use the hatches.
<!-- endfragment -->

<!-- fragment: api -->
- The `api` product (organization, OAuth applications, personal access tokens) has no named tools; use the hatches.
<!-- endfragment -->

<!-- fragment: hatches -->

## The hatches

- `pco_api_get` reaches any GET; `pco_api_mutate` any POST, PATCH, or DELETE, always approval-gated. Paths start `/<app>/v2`, exactly as Planning Center documents them; the connector owns host, auth, content type, and the `X-PCO-API-Version` header.
- Bodies are JSON:API documents: `{"data":{"type":"Email","attributes":{...}}}`. `null` clears an attribute; an omitted key is left alone.
- Each product is pinned to a reviewed API version: <!-- endfragment -->

<!-- fragment: pins -->
. Pass `version` only for an endpoint those versions lack.
- Query parameters are name/value pairs with literal brackets: `where[status]`, `include`, `order`, `filter`, `fields[Person]`. Every list response's `meta` names the `can_query_by`, `can_order_by`, and `can_include` values for that endpoint; an unknown `where` key is ignored rather than refused.
- File uploads go to a separate host (upload.planningcenteronline.com), which this connection does not reach.
<!-- endfragment -->

<!-- fragment: disabled -->
- This deployment disables some products, and the hatches refuse their paths before sending. While any product is disabled they also refuse People lists, list results, rules, and conditions, by path or `include`, because a list's conditions can draw on any product; webhook event and delivery payloads; and any change to an existing webhook subscription, whose id does not name its product. A new subscription must name a reachable product's event.
<!-- endfragment -->

<!-- fragment: limits -->

## Rate limits

Planning Center allows 100 requests per 20 seconds per user, shared by every integration running as that user. This connection admits 100 calls per 20 seconds, five at a time, per runtime — an approximation, not a guarantee. A `rate_limited` failure carries Planning Center's wait. Filter server-side and use `totalCount` rather than paging to count.
<!-- endfragment -->

<!-- fragment: published -->
# Planning Center usage

Planning Center Online church management — People, Services, Groups, Check-Ins, Calendar, Registrations, Giving, Publishing, Webhooks.

## Identity first

- A person id is the join key across every product: the id `search_people` returns is the person id (`personId` argument, `person_id` field) for Services schedules, Groups memberships, Giving donations, and Check-Ins. Resolve ids with list tools; never guess one.
- A person id that used to resolve and now answers `not_found` was most likely merged. Read `/people/v2/person_mergers` with `where[person_to_remove_id]` and follow `person_to_keep_id`.
- `get_me` names the user this token acts as. Every read and write runs with that user's permissions, product by product; a `provider_permission_denied` means an administrator must grant that user access to the product or record.

## Results and paging

- Records keep Planning Center's own snake_case attribute names; a relationship appears as `<relationship>_id`. Pass `raw: true` for the untouched JSON:API resources and `included`; `get_me` and `list_webhook_subscriptions` have no raw mode.
- Lists page by offset: `perPage` up to 100, then pass `page.nextOffset` back as `offset` while `page.hasMore` is true. `page.totalCount` answers "how many" without paging — request `perPage: 1`.
- A bare date in a date filter is the organization's local day; pass a full timestamp for exact bounds. Name filters are exact; end one with `%` for a prefix match.
- `get_plan` fetches the plan, its items, and its team in one call and sets `itemsTruncated`/`teamMembersTruncated` past 100 rows; page the rest with `pco_api_get`.

## What each product lets the API write

- People: full read/write. `update_person` with `status: inactive` archives reversibly; a DELETE is permanent and only reachable through `pco_api_mutate`. `run_list` can fire list automations.
- Services: full read/write. A plan's dates come from its plan times. Scheduling needs a team.
- Groups: memberships and group settings are writable; groups cannot be created, and events and attendance are read-only.
- Check-Ins and Registrations: read-only. Nobody can be checked in or registered through the API.
- Calendar: events, instances, and times are read-only; tags, resources, rooms, and folders are writable through `pco_api_mutate`.
- Giving: the named tools only read, amounts in integer cents. Creating or editing donations, refunds, and committing a batch move money and go through `pco_api_mutate`.
- Publishing and the `api` product (organization, OAuth applications, personal access tokens) have no named tools; use the hatches.

## The hatches

- `pco_api_get` reaches any GET; `pco_api_mutate` any POST, PATCH, or DELETE, always approval-gated. Paths start `/<app>/v2`, exactly as Planning Center documents them; the connector owns host, auth, content type, and the `X-PCO-API-Version` header.
- Bodies are JSON:API documents: `{"data":{"type":"Email","attributes":{...}}}`. `null` clears an attribute; an omitted key is left alone.
- Each product is pinned to a reviewed API version: people 2026-06-04, services 2018-11-01, groups 2023-07-10, check-ins 2025-05-28, calendar 2026-06-22, registrations 2025-05-01, giving 2019-10-18, publishing 2024-03-25, webhooks 2022-10-20, api 2026-09-24. Pass `version` only for an endpoint those versions lack.
- Query parameters are name/value pairs with literal brackets: `where[status]`, `include`, `order`, `filter`, `fields[Person]`. Every list response's `meta` names the `can_query_by`, `can_order_by`, and `can_include` values for that endpoint; an unknown `where` key is ignored rather than refused.
- File uploads go to a separate host (upload.planningcenteronline.com), which this connection does not reach.

## Rate limits

Planning Center allows 100 requests per 20 seconds per user, shared by every integration running as that user. This connection admits 100 calls per 20 seconds, five at a time, per runtime — an approximation, not a guarantee. A `rate_limited` failure carries Planning Center's wait. Filter server-side and use `totalCount` rather than paging to count.
<!-- endfragment -->
