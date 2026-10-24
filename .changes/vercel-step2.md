---
type: changed
breaking: true
---

Standardize Vercel's API tools for 0.35.0. Replace `delete_project_env_var`
with `vercel_api_write` using DELETE `/v9/projects/{projectId}/env/{envVarId}`;
both are destructive and use the host's write route. Other tool names remain.
Replace hatch `select` with `fields`, `list_teams.until` with `cursor`, and runtime
log `maxRows` with `limit`. Named lists return `items` and `page`; `defaultTeamId`
is connection context. Hatch `page.next` becomes signed `page.nextCursor`, passed
unchanged in `query[page.param]` (`page.in` is `query`). Search defaults to six
hits, allows eight, and pages within 16 KiB; details page within 32 KiB.

Named reads accept narrowing `fields`. Log truncation uses dot-path arrays,
replacing boolean `truncated` and row `textTruncated`; runtime `stopped` remains
the collection reason. Unexpected HTML/text/binary acknowledgements for JSON-only
operations now fail; dispatched writes report an unknown outcome without replay.
Undocumented upload text acknowledgements (`data.contentType`/`data.bytes`) retire.
HTTP 409 uses generic `connector_call_failed`, absent a reviewed conflict meaning.

The Vercel pin is updated to reviewed bytes `4a06e85c2848`: four nondeprecated
operations added, no removals, eight changed request contracts. API-key quota
responses withhold the entire API-key subtree. Configured `teamId` remains a
routing default with intentional teamId/slug/null overrides, enforced consistently
across named tools, hatches and uploads; token permissions remain the access boundary.

Raw environment upserts with only `failed[]` now raise `invalid_args` instead of
returning successful hatch data; upsert/update-by-id guidance remains. Partial
hatch batches retain both `created` and `failed`. Partial named upserts report
created ids and failed variables; missing acknowledgements report unknown outcome
without replay. Documented billing JSONL, sandbox command NDJSON and log stream
media still parse into rows. Artifact downloads are explicitly refused because
they serve binary bytes despite the JSON contract. Audit-event `drainUrl` is
withheld entirely, including secret path components and query tokens. URL-shaped
continuations retain page data while refusing continuation.
