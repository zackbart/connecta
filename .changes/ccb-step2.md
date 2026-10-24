---
type: changed
breaking: true
---

Standardize Church Community Builder's v2 JSON/OAuth tools. Rename `ccb_api_get`
to `ccb_api_read`, `ccb_api_mutate` to `ccb_api_write`, and the old data-search
`ccb_api_search` to `search_records`; `ccb_api_search` now searches an offline
operation index and `ccb_api_details` exposes its contracts. Replace named-list
`page`/`perPage` with enum `limit` (25/50/75/100, default 25) and signed `cursor`,
return `items` and standard page metadata, remove `raw`, add validated `fields`
and standard `truncated` envelopes. Remove `list_forms`, `list_form_responses`,
`list_processes`, `list_queues`, `list_queue_individuals`,
`list_scheduling_categories`, `list_schedules`, `list_individual_assignments` and
`list_individual_pledges`; their indexed replacements and every filter/path
change are listed in the [0.35 migration guide](../documentation/provider-migration-0.35.md#church-community-builder).
Preserve write approval and read-only scope boundaries. Require canonical API
paths and documented JSON bodies, withhold private file/payment/calendar
links and OAuth credentials permanently, and classify unproven HTTP 409 meanings
as `connector_call_failed`. Legacy v1 XML remains outside the provider.
