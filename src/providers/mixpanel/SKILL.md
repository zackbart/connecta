---
{
  "name": "mixpanel",
  "instructionsHeading": "Account instructions"
}
---

<!-- fragment: guide_0 -->
 endpoint. A project created in another residency is not reachable from here at all, so an empty result may mean wrong connector rather than no data.<!-- endfragment -->

<!-- fragment: guide_1 -->


- Start with `Get-Projects`, then use `Get-Business-Context` for the selected project before interpreting its events or metrics.
- Resolve ids before acting; never guess one. `Get-Projects` yields the project id every other call is scoped by, and `List-Dashboards`, `List-Cohorts`, `List-Metrics`, `List-Experiments`, and `List-Feature-Flags` yield the ids their `Get-`, `Update-`, and `Delete-` counterparts expect.
- Discover names with `Get-Events`, `List-Properties`, and `Get-Property-Values`; do not guess event or property spelling.
- `Get-Business-Context` requires either `project_id` or `organization_id`. Its schema marks both optional, but the hosted tool rejects a call with neither.
- `Get-Property-Values` requires `properties` or the deprecated `property` alias. Event property values also require `event`; prefer `properties` and never send both property forms with conflicting values.
- `List-Properties` accepts `names` or `query`, never both. Use exact `names` for known properties and `query` for substring discovery.
- One analysis is one `execute_code` program: fetch `Get-Query-Schema` once, run every `Run-Query` of the analysis in that program, and return the reduced table. The schema is tens of kilobytes and the same for every report type, so re-fetching it per query buys nothing. Never return raw `Run-Query` output.
- Insights, funnels, and retention answer aggregate questions. A per-user ordered event timeline, or a sequence question such as "event A with no later event B", is not answerable with `Run-Query` in a reasonable number of calls, and this hosted catalog has no per-`distinct_id` event timeline — `Get-User-Replays-Data` covers one user's replays with their events only where session replay is enabled and present. If the deployment exposes a Mixpanel export or activity-feed connector, use that; if it does not, tell the user the question is out of reach here rather than approximating it with hourly buckets and hundreds of empty rows.
- `false` on a boolean property may be an absent property: Mixpanel renders a missing value as `false` in boolean breakdowns, and server-imported events often lack client-side properties entirely. Confirm the property is present with `List-Properties` or `Get-Property-Values` before treating `false` as a signal, and say when a conclusion rests on that ambiguity.
- Breakdown responses nest `$overall` and per-segment series objects. Flatten to one row per complete breakdown combination inside `execute_code` before returning, and drop `$overall` unless the question asks for the total.
- Use `Get-Report` when the request names an existing saved report. Use `Run-Query` for a new question.
- This account's tool list is not a fixed set. Mixpanel gates parts of its MCP catalog by plan and beta enrollment — experiments, feature flags, session replay, and issue triage are the usual absentees — so search this connector for what it actually exposes rather than assuming a documented tool is here.
- Mixpanel meters MCP traffic per user per hour, shared with everything else that credential does. Reuse discovery results within a run and avoid speculative fan-out.
- An `auth_required` failure means this connector's Mixpanel authorization is missing or expired: run `authorize_connector` for this connector id, then retry the same call unchanged. A rejected argument or a plan restriction comes back in Mixpanel's own words instead — read it rather than re-authorizing.
- Treat every create, update, edit, merge, dismiss, duplicate, or delete operation as a write. Connecta routes the maintained write catalog through `call_destructive_tool`; newly added tools also fail closed until classified.
<!-- endfragment -->
